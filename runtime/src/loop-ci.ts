// Group CI as the loop runs it. A group's CI (tracker/project.json ci.steps, `just tracker ci --help`)
// runs before any unit once it's due: the loop runs its steps as plain commands on origin's main, no
// session. One step at a time, each under its time limit, with its retries 5 minutes apart. The run
// takes every resource its steps use as it starts (ci-next offers it only once they're all free)
// and gives each back after the last step that uses it: it never waits mid-way for one. Pass or fail goes to the tracker; a failure whose step is the lanes' to fix
// files <group>/ci-fix (the tracker does that); a step that exits 79 didn't run (a condition it
// needs unmet, its last line says which): given back, due again. A run cut short (pause asap, a signal) records
// nothing: it reads as due again, and the next run starts from the first step. With data on the
// store, what a run rebuilt is copied back as it ends (store.sh clean --up), so the next run or unit
// on another machine doesn't rebuild it again.
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { g, git } from "./landing.ts";
import { log } from "./session.ts";
import { epoch, lockWithin, pwd, status } from "./sys.ts";
import { platform } from "./os.ts";
import { trOut, trWait } from "./tr.ts";
import { exists, json, killTree, list, mins, read, uniq, ymdhms, type Json } from "./loop-util.ts";
import { sessionBase } from "./loop-unit.ts";
import type { Loop } from "./loop.ts";

// ---------------------------------------------------------------- what the tracker says of CI

// The groups' CI as the tracker sees it (`tracker ci --json`), [] if it can't say.
function ciJson(): Json[] {
  const r = trWait(["ci", "--json"], log);
  if (r.code !== 0) return [];
  try { const v = JSON.parse(r.out); return Array.isArray(v) ? v : []; } catch { return []; }
}
// Due or stale, and this machine runs it tonight (`runs_here`: pinned here or nowhere, its steps'
// caps here, its data leased here or by no one). CI another machine leases the data of is its own.
const dueHere = (c: Json) => c.runs_here === true && (c.state === "due" || c.state === "stale");
// The resources CI that will run on this machine tonight needs (groups here whose CI is due or
// stale). Resources are this machine's locks: another machine's CI gains nothing.
export function ciUses() {
  return uniq(ciJson().filter(dueHere).flatMap((c) => list(c.uses)));
}
// What last call holds back (`next --skip-groups`, `--skip-uses`): the groups whose CI this machine
// runs tonight (runs_here, with steps to run), passed or not, since landing a unit of one (or one
// on its data) would make that CI run again; and the resources CI still to run here needs.
export function ciHeld() {
  const a = ciJson(), g = a.filter((c) => c.runs_here === true && list(c.steps).length > 0);
  return { groups: g.map((c) => String(c.group)), titles: g.map((c) => String(c.title ?? c.group)), uses: uniq(a.filter(dueHere).flatMap((c) => list(c.uses))) };
}
// "; CI not passed: …": the groups whose CI hasn't passed, for a stop reason the overseer reports:
// due, broken, known failing, and in last call stale (work in flight that didn't land). Outside last call a stale
// group still has work to do, and CI another lane runs now is its to report.
export function ciUnrun(inLc: boolean) {
  const r = trWait(["ci", "--json"], log);
  if (r.code !== 0) return "";
  let a: Json[];
  try { a = JSON.parse(r.out); if (!Array.isArray(a)) return ""; } catch { return ""; }
  const l = a.filter((c) => c.state === "due" || c.state === "broken" || c.state === "known" || (inLc && c.state === "stale")).map((c) => `${c.title} (${c.state})`).join(", ");
  return l ? `; CI not passed: ${l}` : "";
}

// ---------------------------------------------------------------- a run

export interface CiStep { step: string; cmd: string; timeout: number; retries: number; uses?: string[]; ships?: boolean; mem?: string }
// A run the tracker gave this lane (`tracker ci-next --claim --json`).
export interface CiNext {
  group: string; title: string; steps: CiStep[];
  data: string; newLease: boolean;
  start: string[];      // the resources taken as the run starts: every one its steps use
}
export function ciNext(j: Json): CiNext {
  return {
    group: String(j.group ?? ""), title: String(j.title ?? ""), steps: (Array.isArray(j.steps) ? j.steps : []) as CiStep[],
    data: j.data ? String(j.data) : "", newLease: j.new_lease === true, start: list(j.start),
  };
}

type Outcome = "pass" | "fail" | "memory" | "unmet" | "cut";
// What a step ended with, besides passing (0) or a step's own exit status.
const TIME_UP = 124;    // its time limit (timeout's status)
const QUEUED = 75;      // capped's exit when it found no turn in the machine's memory budget in time
// step()'s "no turn" (not an exit status: a step's own 75, the tracker's busy lock passed through,
// is its own failure, not the memory budget's; #109)
const NO_TURN = 275;
const CUT = 200;        // cut short: pause asap
// A step's own "not run": something it needs before it starts isn't so (the group's work/ busy in
// another lane, say), and its last line says what. Given back, due again, nothing filed.
const UNMET = 79;

// The time a step waits for its turn in the memory budget, in seconds: at most its time limit.
function turnWait(minutes: number) { const w = Number(process.env.FACTORY_CI_TURN_WAIT || 480); return Math.min(minutes * 60, w >= 0 ? w : 480); }
// The last few lines of a step's output, on one line, for the tracker and the events log (at most
// max bytes, its end kept). skip: leave out that many last lines.
function ciTail(f: string, n = 5, { skip = 0, max = 400 } = {}) {
  const t = read(f);
  if (t === null) return "";
  const lines = t.split("\n"); const nl = t.endsWith("\n"); if (nl) lines.pop();
  if (skip) lines.splice(Math.max(0, lines.length - skip));
  const s = lines.slice(-n).join("\n") + (nl && lines.length ? "\n" : "");
  const one = s.replace(/\x1b/g, "").replace(/[\n\t]/g, " ").replace(/ +/g, " ").replace(/^ /, "").replace(/ $/, "");
  const b = Buffer.from(one, "utf8");
  return b.length > max ? b.subarray(b.length - max).toString("utf8") : one;
}
// What a failed step says of itself: its last line, the verdict a step script ends on (its start
// kept: that's where it says what failed), then the lines before it, marked as such. Lines a step
// wrote before its verdict (a drill's rows that passed) aren't the cause, and read as one when
// they lead.
function ciFailText(f: string) {
  const verdict = ciTail(f, 1, { max: Infinity });
  const b = Buffer.from(verdict, "utf8");
  const head = b.length > 400 ? `${b.subarray(0, 400).toString("utf8").replace(/\uFFFD$/, "")}…` : verdict;
  const before = ciTail(f, 4, { skip: 1, max: 300 });
  return `${head || "(no output)"}${before ? ` [the output's last lines before it: ${before}]` : ""}`;
}

export function ciUnclaim(l: Loop, group: string, extra: string[] = []) { trWait(["ci-unclaim", group, ...extra], log, { FACTORY_TAG: l.tag, FACTORY_ACTOR: "loop" }, () => l.stopping); }

export class CiRun {
  private l: Loop; private j: CiNext;
  private held = new Map<string, number>();     // resource → its lock, while held
  private lastUse = new Map<string, number>();  // resource → the last step that uses it
  private ranS = 0;                             // seconds the run's steps spent running (each try)
  constructor(l: Loop, j: CiNext) { this.l = l; this.j = j; }

  // The run's lock (another lane here sees it running) and the resources taken as the run starts
  // (ci-next's start: every one its steps use), under the claim lock like a unit's, so no lane claims a unit with them
  // in between. False if something is held after all (the claim is given back).
  takeLocks(): boolean {
    const { l, j } = this, L = process.env.FACTORY_LOCKS!;
    const fd = lockWithin(`${L}/ci-${j.group}.lock`, 2);
    if (fd === null) { l.locks.dropAll(); ciUnclaim(l, j.group); return false; }
    l.locks.add(fd);
    j.steps.forEach((s, k) => { for (const r of s.uses ?? []) this.lastUse.set(r, k); });
    for (const r of uniq([...j.start, ...j.steps.flatMap((s) => s.uses ?? [])])) {
      const rf = lockWithin(`${L}/res-${r}.lock`, 2);
      if (rf === null) { l.locks.dropAll(); ciUnclaim(l, j.group); log(`ci: ${r} is busy after all; looking again`); return false; }
      l.locks.add(rf); this.held.set(r, rf);
    }
    return true;
  }

  // A step: 0 = passed, TIME_UP, CUT, NO_TURN, or its exit status.
  // A step is a heavy job (runtime/capped.sh): it waits its turn in the machine's memory budget, and
  // a slot, so it runs in the next one free, not beside whatever else is running; a `just capped`
  // in it runs inside its reservation. Its share: the step's "mem" (also its cap), else its past
  // peaks (no cap). It waits for its turn up to 8 minutes, as `just capped` does
  // ($FACTORY_CI_TURN_WAIT, seconds; at most its time limit), then the run is given back and the
  // lane takes other work a while. Its time limit starts once it has its turn. How long it ran (from
  // its turn to its end, as the step's own shell times it) is added to ranS.
  private async step(cmd: string, minutes: number, logf: string, env: NodeJS.ProcessEnv, o: { name: string; mem?: string }): Promise<number> {
    const l = this.l;
    const fd = fs.openSync(logf, "w");
    let child: ChildProcess;
    // (No scopes on this machine: the step runs as it is, as sessions do then.)
    const capped = platform.canCap() ? [process.execPath, path.join(l.here, "main.mjs"), "capped", "--name", o.name.replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 40), "--"] : [];
    const tf = `${logf}.secs`;
    // (Built-ins only: in a scope that's out of memory, a process may not start.)
    const timed = ["bash", "-c", 'f=$1; shift; SECONDS=0; "$@"; rc=$?; echo "$SECONDS" > "$f"; exit $rc', "ci-step", tf];
    const argv = [...capped, ...timed, "timeout", String(minutes * 60), "bash", "-c", cmd];
    const t0 = epoch();
    try {
      child = spawn(argv[0], argv.slice(1),
        { stdio: ["ignore", fd, fd], env: { ...env, FACTORY_MEM: o.mem || "infinity", FACTORY_HEAVY_MAX_WAIT: String(turnWait(minutes)) } });
    } finally { fs.closeSync(fd); }
    l.fg = child;
    const done = new Promise<number>((resolve) => { child.on("exit", (code, signal) => resolve(status({ code, signal }))); child.on("error", () => resolve(127)); });
    let rc: number | null = null;
    void done.then((r) => { rc = r; });
    while (rc === null) {
      if (exists("runs/.pause-now")) { if (child.pid) killTree(child.pid); await done; l.fg = null; fs.rmSync(tf, { force: true }); await l.halt(); return CUT; }
      await Promise.race([sleep(1000), done]);
    }
    l.fg = null;
    // (No time from its shell: it never had its turn, or it was killed with its scope; then from here.)
    const ran = Number(read(tf)?.trim());
    if (Number.isInteger(ran) && ran >= 0) this.ranS += ran; else if (rc !== QUEUED) this.ranS += epoch() - t0;
    fs.rmSync(tf, { force: true });
    await l.halt();
    return rc === QUEUED && /^capped: queued/m.test(read(logf) ?? "") ? NO_TURN : rc;
  }

  // A result goes to the tracker, tried a few times; failing that the run is given back (it's due
  // again), never left looking as if it were still running. FACTORY_CI_EVIDENCE=loop: the evidence
  // is a step's output, so bare IDs in it are written as {unit:…} instead of refused. A busy lock
  // is waited out, not a try (#109: four tries of 30 s each lost a finished result). The tracker's
  // answer, or null.
  private async record(args: string[]): Promise<string | null> {
    const l = this.l, group = this.j.group;
    let out = "";
    const wait = Number(process.env.FACTORY_RETRY_WAIT || 3);
    for (let k = 1; k <= 4; k++) {
      // The last try with only the evidence (the group's steps may have changed during the run).
      const r = trWait(k === 4 ? args.slice(0, 4) : args, log, { FACTORY_TAG: l.tag, FACTORY_ACTOR: "loop", FACTORY_CI_EVIDENCE: "loop" });
      out = (r.out + r.err).replace(/\n+$/, "");
      if (r.code === 0) return out;
      if (k !== 4) await l.pause(k * wait);
    }
    log(`tracker: couldn't record ${group}'s CI (${out}); giving the run back`);
    l.event("ci-unrecorded", `${group}'s CI ran but the tracker wouldn't record it (${out}); it's due again, and runs again`);
    ciUnclaim(l, group);
    return null;
  }

  // The run, its locks held (takeLocks): true = recorded, false = cut short or not started.
  async run(): Promise<boolean> {
    const { l, j } = this, { group, title, steps, data: dg } = j, n = steps.length;
    const ships = steps.some((s) => !!s.ships), names = steps.map((s) => s.step);
    // Its data: a copy down unless the copy here is current. The steps rebuild main's outputs in
    // it, and the run copies them back as it ends (below).
    if (dg) {
      // Marked as worked on by the run, so no other lane puts the store's copy back, or copies it
      // back, under the run.
      const rc = await l.stoppable(["factory/store.sh", "take", dg, "--mark", "ci", String(process.pid), ...(j.newLease ? ["--new"] : [])]);
      if (rc !== 0) {
        l.locks.dropAll();
        ciUnclaim(l, group, rc === 1 ? ["--release-lease"] : []);
        if (rc === 1) { log(`ci: no room in this machine's cache for ${dg}'s data; ${title}'s CI waits`); l.noRoom(); }
        else {
          log(`ci: couldn't get ${dg}'s data ready for ${title}'s CI; looking again later`);
          l.event("store-down", `couldn't copy ${dg}'s data down to ${l.host} for ${title}'s CI; the lane tries again`);
          await l.nap(mins(l.o.idleWait));
        }
        return false;
      }
    }
    // On origin's main as it is now, detached; the commit recorded is the one tested.
    const M = l.cfg.main;
    if (l.cfg.branches) { g("fetch", "-q", "origin", M); if (!g("checkout", "-q", "-f", "--detach", `origin/${M}`)) log(`git: couldn't check out origin's ${M} for CI`); }
    const commit = git("log", "-1", "--format=%H", "HEAD", "--", ".", ":(exclude)tracker") ?? "";
    const startedAt = ymdhms(), t0 = epoch();
    log(`ci: ${title} (${group}): ${names.join(", ")} on ${commit.slice(0, 8)}`);
    let out: Outcome = "pass", rc = 0, step = "", tmo = 0, tries = 0, lf = "";
    const evid: string[] = [];
    outer: for (let k = 0; k < n; k++) {
      const s = steps[k];
      step = s.step; tmo = Number(s.timeout); let left = Number(s.retries); tries = 0;
      lf = `runs/ci-${startedAt}-${group}-${step}.log`;
      for (;;) {
        tries++; log(`ci: ${step}: ${s.cmd}`);
        l.ciNow = { group, step };
        rc = await this.step(s.cmd, tmo, lf, { ...sessionBase(l.cfg.tdir, l.lane), FACTORY_CI_GROUP: group, FACTORY_CI_STEP: step }, { name: `ci-${group}-${step}`, mem: s.mem });
        if (rc === 0) break;
        if (rc === CUT) { out = "cut"; break outer; }
        if (rc === NO_TURN) { out = "memory"; break outer; }
        if (rc === UNMET) { out = "unmet"; break outer; }
        if (left <= 0) { out = "fail"; break outer; }
        left--;
        log(`ci: ${step} failed (${rc === TIME_UP ? `out of time after ${tmo} min` : `exit ${rc}`}); trying again in ${process.env.FACTORY_CI_RETRY_WAIT || 300}s`);
        if (!(await l.nap(Number(process.env.FACTORY_CI_RETRY_WAIT || 300)))) { out = "cut"; break outer; }
      }
      evid.push(`${step}: ${ciTail(lf, 1)}`);
      // Resources go back once no later step uses them.
      for (const [r, fd] of [...this.held]) {
        if ((this.lastUse.get(r) ?? -1) <= k) { l.locks.unlock(fd); this.held.delete(r); }
      }
    }
    l.locks.dropAll();
    l.ciNow = null;
    // Its time: its steps' own, not the waits for resources or the naps between tries.
    const secs = ["--secs", String(this.ranS)];
    // What the run rebuilt goes back to the store, passed or failed: a later run (or unit) on
    // another machine would rebuild it again otherwise, and it's main's, as a pass's is, and as the
    // next run here would find it. So does a run given back after steps that ran. Not a run whose
    // last step was stopped mid-way: one cut short (pause asap, the stop time), or a failure that
    // was a step killed (out of time, or by a signal: its memory cap). What it wrote stays here,
    // in the copy's listing, and the store keeps the copy it had, not half-written outputs.
    const killed = out === "cut" || (out === "fail" && (rc === TIME_UP || rc >= 128));
    const back = async () => {
      if (!dg) return;
      const up = killed ? [] : ["--up", (commit && git("rev-parse", "--short", commit)) || commit];
      if ((await l.stoppable(["factory/store.sh", "clean", dg, "--since", String(t0), ...up])) !== 0) log(`ci: couldn't copy ${dg}'s data back after ${title}'s CI; it stays marked as unsent, so nothing deletes it, and it's tried again at each look`);
    };
    // A run given back (say: ci-unclaim) gives back the lease its claim took too: its copy back
    // goes first, while the lease is still this machine's. Any other run is recorded first, so a
    // store out of reach (or a signal mid-copy) never costs its result.
    const given = out === "memory" || out === "unmet";
    if (given) await back();
    const said = await this.say(out, { secs, commit, names, ships, step, rc, tmo, tries, lf, evid });
    fs.appendFileSync("runs/index.tsv", [startedAt, l.tag, l.o.loop, `${title} CI (${group})`, `CI ${said}`, "", "", Math.trunc((epoch() - t0) / 60)].join("\t") + "\n");
    if (!given) await back();
    if (dg) l.releaseIdle();
    return out !== "cut";
  }

  // The run's outcome, to the tracker, the log and the overseer: what the runs index says of it.
  private async say(out: Outcome, r: { secs: string[]; commit: string; names: string[]; ships: boolean; step: string; rc: number; tmo: number; tries: number; lf: string; evid: string[] }): Promise<string> {
    const { l, j } = this, { group, title, steps } = j, { secs, commit, names, ships, step, rc, tmo, tries, lf } = r;
    switch (out) {
      case "pass": {
        const e = r.evid.join("; ");
        // Published before (its last pass ran a step that ships), and not broken since: a republish,
        // for the morning summary. A publish after a break is news (the owner heard it wasn't published).
        // A pass clears the failure, so one on record broke since the last pass, even within the same
        // second (the times are to the second: comparing them took that for not broken).
        let again = false;
        if (ships) {
          const gj = json(read(`${l.cfg.tdir}/groups/${group}.json`));
          const ci = (gj?.ci ?? {}) as { passed?: { steps?: string[]; at?: string }; failed?: { at?: string } };
          const shipSteps = steps.filter((s) => s.ships).map((s) => s.step);
          again = shipSteps.some((x) => (ci.passed?.steps ?? []).includes(x)) && !ci.failed;
        }
        await this.record(["ci-pass", group, "--evidence", e, "--steps", names.join(","), ...secs, ...(commit ? ["--commit", commit] : [])]);
        log(`ci: ${title} (${group}) passed`);
        if (ships && again) l.event("ci-republished", `${title} (${group}): CI passed and published again (${names.join(", ")})`);
        else if (ships) l.event("ci-published", `${title} (${group}): CI passed and published (${names.join(", ")})`);
        return "passed";
      }
      case "fail": {
        const e = `${step} failed (${rc === TIME_UP ? `out of time after ${tmo} min` : `exit ${rc}`}, tried ${tries} time${tries === 1 ? "" : "s"}): ${ciFailText(lf)}`;
        const fix = (await this.record(["ci-fail", group, "--evidence", e, "--step", step, "--log", `${pwd()}/${lf}`, ...secs, ...(commit ? ["--commit", commit] : [])])) ?? "";
        log(`ci: ${title} (${group}) broken: ${e}`);
        log(`  ${fix}`);
        // CI runs once a group is done for the night, which a stuck unit or one waiting on the owner counts
        // as: name those, since a step failing for want of their work is their problem, not CI's.
        // Stuck ones and ones waiting on the owner first: those are the likely cause.
        const ls = trOut(["status", group]).split("\n").filter((x) => x.startsWith("  - ")).map((x) => x.slice(4));
        const firsts = ls.filter((x) => /\): (stuck|waiting on you)/.test(x)), rest = ls.filter((x) => !/\): (stuck|waiting on you)/.test(x));
        let undone = [...firsts, ...rest].slice(0, 5).join("|").replace(/\|/g, "; ");
        undone = undone ? ` Its units not done: ${undone}.` : "";
        const after = fix.includes("CI broken. ") ? fix.slice(fix.indexOf("CI broken. ") + "CI broken. ".length) : fix;
        // Still known failing: the owner heard it once (ci-known-failing); the rest are for the summary.
        if (fix.includes("is still known failing")) l.event("ci-known-failing-again", `${title} (${group}): CI failed again, still known failing: ${e}. ${after}${undone}`);
        else if (ships) l.event("ci-broken", `${title} (${group}): CI is broken, so it isn't published: ${e}. ${after}${undone} Tell the owner now: \`just tracker ci-retry ${group}\`, \`just tracker publish off\`, or fix it and push`);
        else l.event("ci-broken-noship", `${title} (${group}): CI is broken (nothing it publishes waits on it; for the morning summary): ${e}. ${after}${undone}`);
        // Failing again after its fix was done marks it known failing: news once, when it starts.
        if (fix.includes("is known failing now")) l.event("ci-known-failing", `${title} (${group}): ${after} Nothing to unstick: say it in the report, with the reason`);
        return `broken: ${step}`;
      }
      case "memory":
        // Given back, and not claimed again for a while: the lane goes on with other groups' work
        // meanwhile (this group's new units still wait for it).
        ciUnclaim(l, group);
        l.ciBackoff = epoch() + mins(l.o.idleWait);
        log(`ci: ${title} (${group}): ${step} found no turn in the machine's memory budget (${ciTail(lf, 1)}); the run is given back, due again, and the lane takes other work for ${l.o.idleWait} min`);
        return `given back at ${step}: no room in the memory budget`;
      case "unmet": {
        // As with no turn: given back, due again, and the lane takes other work a while.
        ciUnclaim(l, group);
        l.ciBackoff = epoch() + mins(l.o.idleWait);
        const why = ciTail(lf, 1) || "it gave no reason";
        log(`ci: ${title} (${group}): ${step} didn't run, a condition it needs unmet: ${why}; the run is given back, due again, and the lane takes other work for ${l.o.idleWait} min`);
        return `given back at ${step}: not run (${why})`;
      }
      case "cut": {
        const why = exists("runs/.pause-now") ? "paused asap" : epoch() >= l.clock.deadline ? "the lane's stop time came" : "the lane was stopped";
        ciUnclaim(l, group, ["--cut", why, "--step", step]);
        log(`ci: ${title} (${group}) cut short at ${step} (${why}); it's due again, from the first step`);
        return `cut short at ${step}`;
      }
    }
  }
}
