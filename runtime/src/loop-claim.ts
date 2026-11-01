// What a lane takes next: its own merge first, then due CI, then a unit (the same while its merge
// can't move); or why it waits or stops.
// One lane on this machine picks at a time, and takes its locks before the next one looks.
import crypto from "node:crypto";
import path from "node:path";
import { log } from "./session.ts";
import { sessionBase } from "./loop-unit.ts";
import { epoch, stamp, tryLock, unlock } from "./sys.ts";
import { addMergeUnit, dropMergeUnits, mergeUnits } from "./landing.ts";
import { machineGet } from "./machines.ts";
import { TR_BUSY, tr, trWait } from "./tr.ts";
import { CiRun, ciHeld, ciNext, ciUnrun } from "./loop-ci.ts";
import { both, cat, exists, hmAt, isInt, json, list, mins, read, resTitles, rm, uniq, type Json } from "./loop-util.ts";
import type { Loop } from "./loop.ts";

// A unit the lane claimed, as `tracker next --claim --json` gave it.
export interface Claimed {
  id: string; title: string; card: string;
  model: string;        // the unit's own model, else --model's
  branch: string;       // the branch it names (a merge unit's), "" for its own
  slowCheck: boolean;
  data: string; newLease: boolean;   // its group's data on the store
  decisions: string[];
  uses: string[];       // the resources it uses
  claimedAt: string;    // when (its card is made then: what the tracker records later goes to the inbox)
  qsBefore: string[];   // the owner's open questions before its session
}
// What the lane does after a look: work the unit, look again, stop (its reason given), or exit
// on a tracker error.
export type Look = { kind: "unit"; unit: Claimed } | { kind: "again" } | { kind: "stop" } | { kind: "error" };

// The owner's open questions, by ID.
export function openQuestions(tdir: string) {
  const q = json(read(`${tdir}/questions.json`));
  return uniq((Array.isArray(q?.questions) ? q!.questions as Json[] : []).filter((x) => (x.answer ?? null) === null && (x.withdrawn ?? null) === null).map((x) => String(x.id)));
}

// How long the lane has had nothing to do, and what it said about it.
export interface Waiting { since: number; why: string; told: boolean }
function workFound(w: Waiting) {
  if (w.since) log(`waited ${Math.trunc((epoch() - w.since) / 60)} min for work`);
  w.since = 0; w.why = "";
}

// A merge unit is pinned to the lane that filed it (--lane <host>/<n>): only that lane takes it, and
// its open merge unit holds its branch back from every other. Once that lane is gone from this
// machine (the machines file gives it fewer lanes now, and its lane lock is free: it isn't running),
// this lane takes the merge unit over: pinned to it, on its list, worked from origin's copy of the
// branch (startBranch), where the lane that filed it pushed it (#134), with any commits it left
// unpushed in its clone taken in (#172). A machine with no row in the
// file says nothing of its lanes: nothing is taken over.
export function adoptMerges(l: Loop) {
  // (An empty cell, or no Lanes column, says nothing either.)
  const cellv = (machineGet(l.host, "lanes") ?? "").trim(), lanes = Number(cellv);
  if (!/^[0-9]+$/.test(cellv)) return;
  const units = (json(read(`${l.cfg.tdir}/groups/merge.json`))?.units as Json[] | undefined) ?? [];
  const base = l.checkout.replace(/-lane[0-9]+$/, "");
  for (const u of units) {
    const m = /^(.+)\/([0-9]+)$/.exec(String(u.lane ?? ""));
    if (!m || m[1] !== l.host || m[2] === l.lane || Number(m[2]) <= lanes) continue;
    if (["done", "dropped"].includes(String((u.record as Json | undefined)?.state ?? ""))) continue;
    const id = String(u.id), st = trWait(["state", id], log);
    if (st.code !== 0 || ["done", "dropped"].includes(st.out.trim())) continue;
    // Running after all (started with more lanes than the file gives, for a night): it's still its own.
    // (Lane 1 may run in the checkout itself, with no -lane1.)
    const running = (m[2] === "1" ? [`lane-${base}.lock`, `lane-${base}-lane1.lock`] : [`lane-${base}-lane${m[2]}.lock`]).some((f) => {
      const fd = tryLock(`${process.env.FACTORY_LOCKS}/${f}`);
      if (fd === null) return true;
      unlock(fd); return false;
    });
    if (running) continue;
    const me = `${l.host}/${l.lane}`, looper = { FACTORY_TAG: l.tag, FACTORY_ACTOR: "loop" };
    if (trWait(["edit", id, "--lane", me, "--title", `Merge main on ${l.host} lane ${l.lane}`], log, looper).code !== 0) { log(`tracker: couldn't take over ${id} from lane ${m[2]}`); continue; }
    trWait(["note", id, `Taken over by ${l.host} lane ${l.lane}: lane ${m[2]}, which filed it, isn't in docs/machines.md any more (${l.host} has ${lanes} lane${lanes === 1 ? "" : "s"}).`], log, looper);
    addMergeUnit(id);
    log(`${String(u.title ?? id)} (${id}) was lane ${m[2]}'s, which isn't in docs/machines.md any more: this lane takes it over, on origin's ${String(u.branch ?? "branch")}`);
    // Work that lane left unpushed in its clone, here (#172). (Lane 1 may have been the checkout itself.)
    const clone = [`${base}-lane${m[2]}`, ...(m[2] === "1" ? [base] : [])].map((d) => path.resolve("..", d)).find((d) => exists(`${d}/.git`));
    if (u.branch && clone) l.land.takeGone(String(u.branch), clone, m[2]);
  }
}

export async function look(l: Loop): Promise<Look> {
  const o = l.o, c = l.cfg, env = process.env, w = l.waiting;
  const claimEnv = (nolease: boolean) => ({ FACTORY_LEASES: c.store ? "1" : "0", FACTORY_NO_NEW_LEASE: nolease ? "1" : "0", FACTORY_TAG: l.tag, FACTORY_SESSION: l.uuid, FACTORY_PID: String(process.pid), FACTORY_ACTOR: "loop" });
  // A merge this lane couldn't do comes before anything else it takes, once it can move. (A busy
  // lock is waited out: it isn't the merge unit gone.)
  for (const m of mergeUnits()) {
    const ms = trWait(["state", m], log);
    if (ms.code !== 0 || ["done", "dropped"].includes(ms.out.trim())) dropMergeUnits((x) => x === m);
  }
  l.uuid = crypto.randomUUID(); l.tag = l.uuid.slice(0, 8);
  const looper = { FACTORY_TAG: l.tag, FACTORY_ACTOR: "loop" };
  const qsBefore = openQuestions(c.tdir);
  // Checks run against origin's main as it is now, never a stale tree (a unit just merged
  // elsewhere would look broken).
  if (c.branches) { await l.land.pending(); l.land.toMain(); }
  if (l.mainRed()) return { kind: "stop" };
  // Main's code moved (a merge outside the lanes, say): the groups it changes get their CI touched
  // before anything is picked, so CI that's now due comes first.
  await l.affected();
  // Refresh's probes due to run wait for memory in the machine's budget (heavy.ts), before the
  // claim lock, so the wait holds up no other lane here.
  let claim: number | null = null;
  const unclaim = () => { if (claim !== null) { unlock(claim); claim = null; } };
  await l.memory(`the tracker's probes (${l.checkout})`, list(json(tr(["refresh", "--due"]).out)?.due), async (held) => {
    claim = l.locks.claimLock();
    if ((await l.stoppable(["factory/tracker", "refresh"], { out: "ignore", env: { ...sessionBase(l.cfg.tdir, l.lane), ...held, FACTORY_ACTOR: process.env.FACTORY_ACTOR } })) !== 0) log("tracker refresh failed; carrying on");
  });
  // Merge units of a lane on this machine that's gone become this lane's (under the claim lock, so
  // one lane takes each).
  if (c.branches) adoptMerges(l);
  const mus = mergeUnits(), mu = mus.length ? mus.join(", ") : null;
  const claimedAt = stamp();
  // (Something there that isn't a time: no new lease, as the bash's failed test had it.)
  const nr = cat(l.noroom);
  const nolease = nr !== null && (!isInt(nr) || epoch() < Number(nr));
  // This lane's merge first. While it can't (blocked, parked, waiting on a question), the lane takes
  // CI and other units meanwhile, as if it had none, and the merge comes first again once it can.
  let merge: Json | null = null, mergeWhy = "";
  if (mu !== null) {
    const r = tr(["next", "--claim", "--json", "--group", "merge"], claimEnv(nolease));
    if (r.code === 0) { merge = json(r.out); l.mergeTold = ""; }
    else if (r.code === TR_BUSY) { unclaim(); log("the tracker is locked by another command (.tracker/lock); looking again"); await l.pause(5); return { kind: "again" }; }
    else if (r.code !== 1 && r.code !== 3) { unclaim(); l.stop("tracker error"); process.stdout.write(r.out); process.stderr.write(r.err); return { kind: "error" }; }
    else {
      const w0 = json(r.out)?.why;
      mergeWhy = `this lane's merge${mus.length > 1 ? "s" : ""} (${mu}) can't move yet${w0 ? `: ${String(w0)}` : ""}`;
      if (mergeWhy !== l.mergeTold) { log(`${mergeWhy}; taking other work meanwhile`); l.mergeTold = mergeWhy; }
    }
  }  // Due CI comes before any unit (but after this lane's own merge).
  let ciwait = "", ciuses: string[] = [], cistart: string[] = [];
  if (!merge && epoch() >= l.ciBackoff) {
    const r = tr(["ci-next", "--claim", "--json"], claimEnv(nolease));
    if (r.code === 0) {
      workFound(w);
      const j = ciNext(json(r.out) ?? {});
      const run = new CiRun(l, j);
      if (!run.takeLocks()) { unclaim(); await l.pause(5); return { kind: "again" }; }
      unclaim();
      if (!(await run.run()) && exists("runs/.pause-now")) {
        if (c.branches) l.land.toMain();
        rm("runs/.pause", "runs/.pause-now"); l.stop(`paused asap: ${j.title}'s CI was cut short; it runs again from the start next time`); return { kind: "stop" };
      }
      if (c.branches) l.land.toMain();
      return { kind: "again" };
    }
    const civ = json(r.out);
    if (civ?.wait === true) { ciwait = String(civ.why ?? ""); ciuses = list(civ.uses); cistart = list(civ.start); }
  }
  let skipg: string[] = [], skipr: string[] = [];
  const k = l.clock;
  // Last call: no unit starts that would make CI here run again (of a group whose CI runs here, or
  // on its data), nor one using what CI still to run here needs. Everything else does, but for
  // `just fleet last-call` ("wrap up and publish": the owner ends the night there) and a red main.
  const lcNone = k.inLc && !merge ? (exists("runs/.last-call") ? "no new units after `just fleet last-call`" : l.land?.red ? `no new units while main is red (${l.land.red})` : "") : "";
  if (k.inLc && !merge && !lcNone) {
    const h = ciHeld();
    skipg = h.groups; skipr = h.uses;
    const told = [h.groups.length ? `no unit of ${h.titles.join(", ")} or on ${h.groups.length > 1 ? "their" : "its"} data (${h.groups.length > 1 ? "their" : "its"} CI runs here tonight)` : "", h.uses.length ? `no unit using ${resTitles(c.tdir, h.uses)} (CI here needs it)` : ""].filter(Boolean).join(", and ");
    if (told !== k.lcTold) { k.lcTold = told; log(`last call: ${told || "nothing held back: no CI runs here tonight"}${told ? " starts; other units do" : ""}`); }
  }
  // Due CI here waits for a resource: no unit starts with any it takes as it starts, so a free
  // one isn't taken from it while it waits on another (one queue at each, CI first).
  skipr = uniq([...skipr, ...cistart]);
  // Not a unit this lane's sessions gave back unstarted this run, nor one whose usual session
  // won't fit before the stop (#141: a lane claimed and gave back the same unit every few seconds).
  // Before a timed last call, not one last call will hold back with too little time left before
  // it (#159): the least a unit like it needs (`next --last-call-in`).
  let lcArgs: string[] = [];
  if (!k.inLc && k.lastCall > 0 && !merge) {
    const h = ciHeld();
    if (h.groups.length || h.uses.length) lcArgs = ["--last-call-in", String(Math.max(0, k.lcAt() - epoch())), ...(h.groups.length ? ["--last-call-groups", h.groups.join(",")] : []), ...(h.uses.length ? ["--last-call-uses", h.uses.join(",")] : [])];
  }
  const skipu = [...(skipg.length ? ["--skip-groups", skipg.join(",")] : []), ...(skipr.length ? ["--skip-uses", skipr.join(",")] : []),
    ...(l.gaveBack.size ? ["--skip-units", [...l.gaveBack].join(",")] : []), "--time-left", String(Math.max(0, k.deadline - epoch())), ...lcArgs];
  let code: number, nxt: Json | null;
  if (merge) { code = 0; nxt = merge; }
  else if (lcNone) { code = 1; nxt = { why: lcNone }; }
  else { const r = tr(["next", "--claim", "--json", ...skipu], claimEnv(nolease)); code = r.code; nxt = json(r.out); }
  // Units held back as too long for the time before last call: logged as their number changes,
  // and the latest goes to the morning summary once, as last call begins (loop.ts, heldBack).
  if (!merge && !lcNone && !k.inLc) {
    const lcLate = Number(nxt?.lc_late) || 0;
    if (lcLate !== l.lcHeld.n) {
      l.lcHeld.n = lcLate;
      if (lcLate > 0) { l.lcHeld.why = `${String(nxt?.lc_why)}; last call at ${hmAt(k.lcAt())}`; log(l.lcHeld.why); }
    }
  }
  let unit = "", uses: string[] = [];
  if (code === 0) {
    unit = String(nxt?.id ?? "");
    uses = list((json(read(`${c.tdir}/groups/${unit.split("/")[0]}.json`))?.units as Json[] | undefined)?.find((x) => x.id === unit)?.uses);
    // CI due here was waiting for a resource this unit wants (any its run takes as it starts),
    // which freed since: the CI gets it, one queue at the resource with CI first.
    if (ciuses.length && both(ciuses, uses).length) { trWait(["unclaim", unit, "--unstarted"], log, looper); unclaim(); return { kind: "again" }; }
    // (The built-in "heavy", the machine's heavy-job slots, isn't a lock: heavy.sh shares them.)
    const heavyBuiltin = !(json(read(`${c.tdir}/project.json`))?.resources as Json | undefined)?.heavy;
    if (!l.locks.take(unit, uses.filter((x) => !(x === "heavy" && heavyBuiltin)))) {
      // Another lane holds it after all: end this claim (it shows as interrupted, keeping
      // anything an earlier session left) and look again. The settle's probe waits for memory
      // after the claim lock goes, so the wait holds up no other lane here.
      l.locks.dropAll(); unclaim();
      await l.settle(unit, String(nxt?.title ?? unit), looper);
      await l.pause(5); return { kind: "again" };
    }
  }
  unclaim();

  if (code === 1 || code === 3) {
    const w0 = nxt?.why;
    let why = w0 === undefined || w0 === null || w0 === false ? "nothing workable" : String(w0);
    // This lane's merge waits (on the owner, say) and nothing else is left: the lane waits for it,
    // since no other lane takes it.
    if (mergeWhy) { code = 1; why = `${mergeWhy}, and nothing else to take: ${why}`; nxt = { wait: true }; }
    // CI due here waits for a resource: the lane waits for it too.
    if (ciwait) { code = 1; why = `${why}; ${ciwait}`; nxt = { wait: true }; }
    // Nothing fits in the time left, and nothing else is moving that might: the lane stops, saying so.
    if (Number(nxt?.late) > 0 && nxt?.wait !== true) { l.stop(`${k.inLc ? "last call is over: " : ""}nothing fits before the stop at ${hmAt(k.deadline)}: ${why}${ciUnrun(k.inLc)}`); return { kind: "stop" }; }
    if (code === 3) { l.stop(`${k.inLc ? "last call is over: " : ""}${why}${k.inLc ? ciUnrun(k.inLc) : ""}. Only the owner's questions and gates are left.`); return { kind: "stop" }; }
    if (!o.wait || nxt?.wait !== true) { l.stop(`${k.inLc ? "last call is over: " : ""}${why}${k.inLc ? ciUnrun(k.inLc) : ""}`); return { kind: "stop" }; }
    // Other work is still moving (another lane or machine, a busy resource): wait for it.
    if (!w.since) { w.since = epoch(); w.told = false; }
    if (why !== w.why) { log(`waiting: ${why}; looking again every ${o.idleWait} min`); w.why = why; }
    if (!w.told && epoch() - w.since >= Number(env.FACTORY_IDLE_TELL || 1800)) {
      l.event("idle", `lane ${l.lane} on ${l.host} has had nothing to do for ${Math.trunc((epoch() - w.since) / 60)} min: ${why}`); w.told = true;
    }
    l.releaseIdle();
    await l.nap(mins(o.idleWait), true);
    return { kind: "again" };
  }
  // Another command held the tracker's lock past its wait: nothing is wrong, so look again.
  if (code === TR_BUSY) { log("the tracker is locked by another command (.tracker/lock); looking again"); await l.pause(5); return { kind: "again" }; }
  if (code !== 0) { l.stop("tracker error"); const r = tr(["next"]); process.stdout.write(r.out); process.stderr.write(r.err); return { kind: "error" }; }
  workFound(w);
  return { kind: "unit", unit: {
    id: unit, title: String(nxt?.title ?? ""), card: String(nxt?.card ?? ""),
    model: (nxt?.model ? String(nxt.model) : "") || o.model, branch: nxt?.branch ? String(nxt.branch) : "",
    slowCheck: nxt?.slow_check === true, data: nxt?.data ? String(nxt.data) : "", newLease: nxt?.new_lease === true,
    decisions: Array.isArray(nxt?.decisions) ? nxt.decisions.map(String) : [], uses, claimedAt, qsBefore,
  } };
}
