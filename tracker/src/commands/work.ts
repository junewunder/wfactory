// The commands agents work units with: next, claim, show, find, status, the records (done, review,
// block, reopen, drop, park, note), probes and the log.
import { spawnSync } from "node:child_process";
import { ctx } from "../ctx.ts";
import { claimPid, procStart } from "../proc.ts";
import { load, loadCache, log, mutate, readLog, saveCache, hasState, touch } from "../store.ts";
import { NetError, die, list, now, parseArgs, plural, str, type Args } from "../text.ts";
import { addNote, checkEvidence, checkNote, checkText, expand, findD, findQ, groupTitle, isOpen, matches, name, rankUnits, resolve, selected } from "../names.ts";
import { beatsHere, dataGroup, landingOf, leaseAge, leasedHere, liveLease, resTitle, takeLease } from "../machine.ts";
import { applyProbe, describeProbe, probeDue, probeOf, probesFirst } from "../probes.ts";
import { ciState, ciText } from "../ci.ts";
import { applicableDecisions, card, decisionText, doneWhen, questionText, EFFECTS, hasEffects } from "../cards.ts";
import { derive, groupOrderLine, idleWhy, LABEL, lcLateWhy, pick, scopeGroups, sentence, SETTLED, type Pick } from "../status.ts";
import { C } from "./registry.ts";
import { ciWaitText, hasReadyHook, notReady, runReady } from "../checks.ts";
import type { State, Status, Unit, UnitRecord } from "../types.ts";
import { decisionJson } from "../decisions.ts";

C.next = (a) => {
  const o = parseArgs(a);
  const skip = new Set(typeof o["skip-uses"] === "string" ? list(o["skip-uses"]) : []);
  const skipGroups = new Set(typeof o["skip-groups"] === "string" ? list(o["skip-groups"]) : []);
  const group = o.group as string | undefined;   // as given: a bare --group matches no group
  const tl = str(o["time-left"]);
  if (tl && !/^[0-9]+$/.test(tl)) die(`--time-left takes seconds, not "${tl}"`);
  const lci = str(o["last-call-in"]);
  if (lci && !/^[0-9]+$/.test(lci)) die(`--last-call-in takes seconds, not "${lci}"`);
  const notNow = { units: new Set(typeof o["skip-units"] === "string" ? list(o["skip-units"]) : []), timeLeft: tl ? Number(tl) : undefined,
    lastCall: lci ? { in: Number(lci), groups: new Set(typeof o["last-call-groups"] === "string" ? list(o["last-call-groups"]) : []), uses: new Set(typeof o["last-call-uses"] === "string" ? list(o["last-call-uses"]) : []) } : undefined };
  // A check is handed out only once the project's check-ready hook says it can be judged
  // (checks.ts): one it finds not ready waits on what provides the missing reference, and `next`
  // looks again. vetted: the checks it passed this time. Past VET_TRIES hook runs, a check not
  // vetted is passed over this time (as --skip-units), never handed out unvetted.
  const vetting = { vetted: new Set<string>(), left: VET_TRIES };
  let T = load(), p = pick(T, group, skip, skipGroups, notNow);
  while (p.code === 0 && unvetted(T, p.unit, vetting.vetted)) {
    if (vetting.left <= 0) notNow.units.add(p.unit.id);
    else if (vet(p.unit.id, vetting)) break;
    T = load(); p = pick(T, group, skip, skipGroups, notNow);
  }
  // What --last-call-in passed over, for the loop's morning summary.
  const lcOut = (T0: State, q: Pick) => q.lcLate?.length ? { lc_late: q.lcLate.length, lc_why: lcLateWhy(T0, q.lcLate, q.lastCallIn!) } : {};
  if (p.code !== 0) {
    if (o.json) console.log(JSON.stringify({ code: p.code, why: idleWhy(T, p), wait: p.wait, late: p.late?.length ?? 0, ...lcOut(T, p) }));
    else console.error(idleWhy(T, p) + (p.wait ? ". Other work is still moving: look again in a few minutes." : ""));
    return p.code;
  }
  let u = p.unit, lease: { group: string; new: boolean } | null = null, picked: Pick = p;
  if (o.claim) {
    // Picked again inside the write: if another lane's claim lands first, this one looks again.
    let q;
    lease = null;
    // (A check another lane's write put first, not vetted yet: vetted outside the lock, then again.)
    try {
      for (;;) {
        let fresh: Unit | null = null;
        q = mutate((T2) => { const p2 = pick(T2, group, skip, skipGroups, notNow); if (p2.code === 0 && unvetted(T2, p2.unit, vetting.vetted)) { fresh = p2.unit; return p2; } if (p2.code === 0) { lease = claimUnit(T2, p2.unit); u = p2.unit; picked = p2; } return p2; }, { strict: true });
        if (!fresh) break;
        const id = (fresh as Unit).id;
        if (vetting.left <= 0) notNow.units.add(id); else vet(id, vetting);
      }
    } catch (e) {
      if (!(e instanceof NetError)) throw e;
      if (o.json) console.log(JSON.stringify({ code: 1, why: e.message, wait: true })); else console.error(e.message);
      return 1;
    }
    if (q.code !== 0) {
      const T2 = load();
      const again = pick(T2, group, skip, skipGroups, notNow);
      const why = again.code === 0 ? "" : idleWhy(T2, again);
      if (o.json) console.log(JSON.stringify({ code: q.code, why, wait: q.wait, late: q.late?.length ?? 0, ...(again.code === 0 ? {} : lcOut(T2, again)) }));
      else console.error(why);
      return q.code;
    }
  }
  const T3 = o.claim ? load() : T;
  const v = T3.byId.get(u.id)!;
  const c = card(T3, v, "Next: ");
  const dg = dataGroup(T3, v);
  const l = lease as { group: string; new: boolean } | null;
  if (o.json) console.log(JSON.stringify({ code: 0, id: v.id, title: v.title, model: v.model || null, host: v.host || null, branch: v.branch || v.record?.branch || `unit/${v.id}`, slow_check: (v.tags || []).includes("slow-check"), data: dg, new_lease: !!l?.new, card: c,
    decisions: applicableDecisions(T3, v).map((x) => x.id), ...lcOut(T3, picked) }));
  else console.log(c);
  return 0;
};

// Hook runs one `next` makes at most (each up to checks.ready_timeout).
const VET_TRIES = 8;
const unvetted = (T: State, u: Unit, vetted: Set<string>) => !vetted.has(u.id) && hasReadyHook(T, u) && !["doing", "interrupted", "review"].includes(derive(T, u).s) && !(u.record?.state === "claimed" && u.record.handedBack);
// Runs the check-ready hook for a check, outside the tracker's lock (it may take seconds); not
// ready, the write records what it waits on. true: it may go out.
// The write records it only if the check is still as the hook saw it: another lane may have
// claimed it meanwhile (its own hook passed, or couldn't tell there).
function vet(id: string, v: { vetted: Set<string>; left: number }): boolean {
  v.left--;
  const T0 = load();
  const res = runReady(T0, resolve(T0, id));
  if (res.ready) { v.vetted.add(id); if (res.notRun) console.error(`${id}: ${res.why}; handed out as before`); return true; }
  console.error(mutate((T) => {
    const u = resolve(T, id);
    if (!unvetted(T, u, new Set()) || !["ready", "waiting", "resource"].includes(derive(T, u).s)) return `${name(u)}: not ready to judge (${res.why}), but it's ${sentence(T, u)} now; left as it is`;
    return notReady(T, u, res);
  }));
  return false;
}

export function claimUnit(T: State, u: Unit) {
  const { env, TAG, HOST, ROOT } = ctx;
  const r = u.record || ({} as Partial<UnitRecord>);
  const d = derive(T, u).s;
  // An earlier attempt's work to carry on from: an interrupted claim, or one its session handed back.
  const left = d === "interrupted" || (r.state === "claimed" && !!r.handedBack);
  // On a branch, an interrupted unit's work is on its branch; without, it's what's uncommitted here.
  if (left && !r.branch && !env.FACTORY_BRANCHES) {
    const g = spawnSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8", env });
    r.dirty = (g.stdout || "").split("\n").filter(Boolean).map((l) => l.slice(3)).filter((f) => !f.startsWith("tracker/"));
  }
  const pid = claimPid();
  // A second unit a session claims (its first still claimed, or recorded and not landed yet) is
  // worked on the branch the session is on, so it lands with that branch (`merged --branch`). A
  // branch of its own would never exist, and the unit would show as merging for good. One with a
  // branch named for it (a merge unit's) or work pushed to its own branch keeps that branch.
  const own = TAG === "manual" || (left && r.pushed) ? undefined
    : [...T.byId.values()].find((x) => x !== u && x.record?.by === TAG && x.record.branch && !x.record.handedBack && ["claimed", "done", "review"].includes(x.record.state))?.record!.branch;
  const branch = env.FACTORY_BRANCHES ? u.branch || own || `unit/${u.id}` : undefined;
  // Claiming a unit in review is checking it: who worked it and their evidence stay with the
  // claim, so the checker can record it done, and a check that doesn't finish puts it back.
  const reviewing = d === "review" ? { by: r.by, at: r.at, evidence: r.evidence } : left ? r.reviewing : undefined;
  u.record = beatsHere(T, { state: "claimed", by: TAG, session: env.FACTORY_SESSION || env.CLAUDE_CODE_SESSION_ID || undefined, host: HOST, pid: pid || undefined, start: pid ? procStart(pid) || undefined : undefined, at: now(), branch, reviewing, ...(left ? { resumed: r.by, dirty: r.dirty?.length ? r.dirty : undefined, prevSession: r.session, pushed: r.pushed } : {}) } as UnitRecord);
  u.round ||= u.record.at;
  touch(T, u);
  log(T, "claim", u.id, `${u.title}: claimed${d === "review" ? ` to check ${r.by}'s work` : left ? ` (picking up after ${r.by})` : ""}`);
  // The unit's data group: leased here in the same write, so two machines can't both take it.
  const g = dataGroup(T, u);
  if (!g) return null;
  const l = liveLease(T, g);
  if (l && l.host !== HOST) die(`${name(u)} works on ${groupTitle(T, g)}'s data, which ${l.host} leases (\`just tracker leases\`)`);
  if (l) return { group: g, new: false };
  if (env.FACTORY_LEASES !== "1") die(`${name(u)} works on ${groupTitle(T, g)}'s data, which isn't leased here. The loop takes the lease and copies the data down: \`just loop --max 1\``);
  takeLease(T, g);
  return { group: g, new: true };
}

C.claim = (a) => {
  // A check its check-ready hook says can't be judged yet isn't claimed (checks.ts).
  const T0 = load(), u0 = resolve(T0, a[0]);
  if (unvetted(T0, u0, new Set()) && !vet(u0.id, { vetted: new Set(), left: 1 })) return 1;
  return claimOne(a);
};
const claimOne = (a: string[]) => mutate((T) => {
  const u = resolve(T, a[0]);
  const s = derive(T, u).s;
  if (s === "done" || s === "dropped") die(`${name(u)} is ${s}; \`just reopen ${u.id}\` first if it really needs more work`);
  if (s === "doing" && u.record!.by !== ctx.TAG) die(`${name(u)} is in progress in session ${u.record!.by}${u.record!.host ? " on " + u.record!.host : ""}`);
  claimUnit(T, u);
  console.log(`claimed ${name(u)}`);
}, { strict: true });

C.show = (a) => {
  const o = parseArgs(a);
  a = o._;
  const T = load();
  const ref = a[0] || str(o.full) || str(o["why-all"]) || die("usage: show <id> [--full | --why-all] [--json]");
  // --json on a decision: who made it and whether it still stands, for a project's checks.
  if (o.json && ref.startsWith("d/")) {
    console.log(JSON.stringify(decisionJson(T, findD(T, ref) || die(`no decision ${ref}`))));
    return 0;
  }
  // --json: one unit's status, notes and the decisions that apply, for scripts (the loop's inbox
  // hook asks this every few minutes while a session works the unit).
  if (o.json) {
    const u = resolve(T, ref);
    const d = derive(T, u);
    console.log(JSON.stringify({ id: u.id, title: u.title, status: d.s, label: sentence(T, u, d),
      notes: (u.notes || []).map((n) => ({ at: n.at, by: n.by, text: expand(T, n.text) })),
      decisions: applicableDecisions(T, u).map((x) => ({ id: x.id, title: expand(T, x.title), why: x.why ? expand(T, x.why) : "", by: x.by, at: x.at })) }));
    return 0;
  }
  if (ref.startsWith("q/")) return void console.log(questionText(T, findQ(T, ref), true));
  if (ref.startsWith("d/")) { const d = findD(T, ref) || die(`no decision ${ref}`); return void console.log(decisionText(T, d, true)); }
  const g = T.groupById.get(ref);
  // A group: its status, whichever loop LOOP names (without changing the caller's environment).
  if (g && !T.byId.get(ref)) { const env = ctx.env; ctx.env = { ...env, LOOP: "" }; try { return void C.status([ref]); } finally { ctx.env = env; } }
  console.log(card(T, resolve(T, ref), "", o["why-all"] ? "all" : !!o.full));
};

// Units by words in their title, detail or ID, best match first, so a session can find one
// without guessing its ID. --open leaves out done and dropped ones.
C.find = (a) => {
  const o = parseArgs(a);
  // --open takes no value: a word after it (find --open mira) is one of the words.
  if (typeof o.open === "string") o._.unshift(o.open);
  const q = o._.join(" ").trim() || die("usage: find <words> [--open] [-n N]");
  const T = load();
  let hits = rankUnits(T, q);
  if (o.open) hits = hits.filter(([u]) => !SETTLED.has(derive(T, u).s));
  if (!hits.length) { console.log(`No ${o.open ? "open " : ""}unit matches "${q}".`); return 0; }
  const n = Number(o.n) || 20;
  for (const [u] of hits.slice(0, n)) console.log(`- ${name(u)}: ${LABEL[derive(T, u).s]}`);
  if (hits.length > n) console.log(`(${hits.length - n} weaker matches left out; -n ${hits.length} shows them all)`);
  return 0;
};

function counts(T: State, units: Unit[]) {
  const c: Partial<Record<Status, number>> = {};
  for (const u of units) { if (u.kind === "gate") continue; const s = derive(T, u).s; c[s] = (c[s] || 0) + 1; }
  return c;
}
const ORDER: Status[] = ["done", "merging", "broken", "you", "stuck", "interrupted", "doing", "review", "ready", "resource", "waiting", "parked", "dropped"];
const fmtCounts = (c: Partial<Record<Status, number>>) => ORDER.filter((k) => c[k]).map((k) => `${c[k]} ${LABEL[k]}`).join(", ");

C.status = (a) => {
  const o = parseArgs(a);
  const T = load();
  const env = ctx.env;
  const loops = T.project.loops || {};
  if (Object.keys(loops).length && !env.LOOP && !o.all && !o._[0]) {
    console.log(`loops: ${Object.entries(loops).map(([k, l]) => `${l.title || k} (${k})`).join(", ")}. \`just status <loop>\` for one; \`just status all\` for every loop.`);
    return 0;
  }
  const groups = scopeGroups(T);
  if (o._[0] && o._[0] !== "all") {
    const g = T.groupById.get(o._[0]) || die(`no group "${o._[0]}" (${T.groups.map((x) => x.id).join(", ")})`);
    const c = counts(T, g.units);
    console.log(`${g.title} (${g.id}): ${fmtCounts(c) || "no units"}${g.host ? `  [runs on ${g.host}]` : ""}`);
    if (g.ci) console.log(`  CI: ${ciText(T, g)}`);
    for (const u of g.units) { const d = derive(T, u); if (!SETTLED.has(d.s)) console.log(`  - ${name(u)}: ${sentence(T, u, d)}`); }
    return 0;
  }
  const units = groups.flatMap((g) => g.units);
  const c = counts(T, units);
  const total = units.filter((u) => u.kind !== "gate").length;
  const head = `${T.project.title || T.project.name}${env.LOOP && env.LOOP !== "all" ? ` / ${(loops[env.LOOP] || {}).title || env.LOOP}` : ""}`;
  console.log(`${head}: ${c.done || 0} of ${total} done${c.broken ? `, ${c.broken} broken again` : ""}${c.you ? `, ${c.you} waiting on you` : ""}${c.interrupted ? `, ${c.interrupted} interrupted` : ""}`);
  if (o.all || a.includes("all")) {
    for (const g of groups) { const gc = counts(T, g.units); console.log(`  ${g.title} (${g.id}): ${fmtCounts(gc) || "no units"}${g.ci ? `; CI ${ciState(T, g).s}` : ""}`); }
  } else {
    const active = groups.filter((g) => g.units.some((u) => ["doing", "ready", "review", "interrupted", "broken"].includes(derive(T, u).s)));
    const show = active.slice(0, 5).map((g) => { const gu = g.units.filter((u) => u.kind !== "gate"); return `${g.title} (${gu.filter((u) => derive(T, u).s === "done").length}/${gu.length}${g.host ? ` on ${g.host}` : ""})`; });
    if (show.length) console.log(`Open groups: ${show.join(", ")}${active.length > 5 ? ` and ${active.length - 5} more` : ""}`);
  }
  const qs = T.questions.filter(isOpen);
  const gates = units.filter((u) => u.kind === "gate" && derive(T, u).s === "you");
  const you = [...gates.map((g) => name(g)), ...qs.map((q) => name(q))];
  if (you.length) console.log(`Waiting on you: ${you.slice(0, 4).join("; ")}${you.length > 4 ? ` and ${you.length - 4} more` : ""}`);
  const busy = units.filter((u) => derive(T, u).s === "resource");
  if (busy.length) console.log(`Waiting for a resource: ${plural(busy.length, "unit")} (${[...new Set(busy.flatMap((u) => derive(T, u).busy!))].map((x) => resTitle(T, x)).join(", ")})`);
  const ls = T.leases.filter((l) => groups.some((g) => g.id === l.id));
  if (ls.length) console.log(`Leases: ${ls.map((l) => `${groupTitle(T, l.id)} on ${l.host}${leaseAge(l) >= ctx.STALE_MS ? " (stale)" : ""}`).join(", ")}`);
  const cs = groups.filter((g) => g.ci).map((g) => [g, ciState(T, g)] as const);
  const cis = cs.map(([g, c]) => [g, c.s] as const).filter(([, s]) => ["due", "running", "broken"].includes(s));
  if (cis.length) console.log(`CI: ${["broken", "running", "due"].map((k) => { const gs = cis.filter(([, s]) => s === k); return gs.length ? `${gs.length} ${k} (${gs.slice(0, 4).map(([g]) => g.title).join(", ")}${gs.length > 4 ? ", …" : ""})` : ""; }).filter(Boolean).join(", ")}`);
  // Known failing: each group with its reason, since there's nothing in the queue to show it.
  for (const [g, c] of cs) if (c.s === "known") console.log(`CI known failing: ${g.title} (${g.id}): ${c.why}`);
  const p = pick(T);
  console.log(p.code === 0 ? `Next: ${name(p.unit)}` : `Next: ${idleWhy(T, p)}`);
  return 0;
};

C.questions = (a) => {
  const o = parseArgs(a);
  const T = load();
  // With $LOOP, only what touches that loop's units (the one-loop rule).
  const inScope = new Set(scopeGroups(T).flatMap((g) => g.units));
  const touches = (q: State["questions"][number]) => inScope.size === T.byId.size || [...inScope].some((u) => (q.blocks || []).some((s) => matches(T, s, u)) || u.record?.on === q.id);
  const qs = T.questions.filter((q) => (o.all || isOpen(q)) && touches(q));
  const gates = [...inScope].filter((u) => u.kind === "gate" && derive(T, u).s === "you");
  if (!qs.length && !gates.length) { console.log("Nothing is waiting on you."); return 0; }
  qs.forEach((q, i) => console.log(`${i + 1}. ${questionText(T, q)}\n`));
  for (const g of gates) {
    console.log(`Gate: ${name(g)}`);
    if (g.detail) console.log(`   ${expand(T, g.detail)}`);
    const after = [...T.byId.values()].filter((u) => (u.needs || []).includes(g.id));
    if (after.length) console.log(`   Holds back ${plural(after.length, "unit")}: ${after.slice(0, 4).map((u) => name(u)).join(", ")}${after.length > 4 ? " …" : ""}`);
    console.log(`   When it's fine: just pass ${g.id} [--note "…"]\n`);
  }
  return 0;
};

C.check = (a) => {
  const ref = a[0] || die("usage: check <id>  (or refresh)");
  const ran = probesFirst((T, cache, r) => { const u = resolve(T, ref); if (u.check === "computed") applyProbe(T, u, cache, true, r); });
  const out = mutate((T) => {
    const u = resolve(T, ref);
    if ((u.check || "recorded") !== "computed") die(`${name(u)} has no check the tracker runs (check: ${u.check || "recorded"}); ${doneWhen(T, u)}`);
    const cache = loadCache();
    const line = applyProbe(T, u, cache, true, ran);
    saveCache(cache);
    return line;
  });
  console.log(out);
  return 0;
};

C.refresh = (a) => {
  const o = parseArgs(a);
  const probed = (T: State) => scopeGroups(T).filter((g) => !o.group || g.id === o.group).flatMap((g) => g.units)
    // A probe on group data reads this machine's copy: only where the group is leased.
    .filter((u) => u.check === "computed" && (!dataGroup(T, u) || leasedHere(T, u)));
  // --due: the commands it would run now, nothing run or written (the loop reserves memory for them).
  if (o.due) {
    const T = load(), cache = loadCache();
    console.log(JSON.stringify({ due: [...new Set(probed(T).map((u) => probeDue(T, u, cache)).filter((c) => c !== null))] }));
    return 0;
  }
  const each = (T: State, cache: ReturnType<typeof loadCache>, ran: Parameters<typeof applyProbe>[4], out?: string[]) => {
    for (const u of probed(T)) { const l = applyProbe(T, u, cache, !!o.all, ran); if (l && !/still passes|not done yet/.test(l)) out?.push(l); }
  };
  const ran = probesFirst((T, cache, r) => each(T, cache, r));
  const lines = mutate((T) => {
    const cache = loadCache();
    const out: string[] = [];
    each(T, cache, ran, out);
    saveCache(cache);
    return out;
  });
  console.log(lines.length ? lines.join("\n") : "refresh: nothing changed");
  return 0;
};

// A claim's branch, and the machine it was worked on (its outputs wait there until the branch
// lands), and the claim's lane as the one landing it (landingOf).
const branchOf = (r: Partial<UnitRecord>) => (r.state === "claimed" && r.branch ? { branch: r.branch, host: r.host, ...landingOf(r) } : {});

// --dry-run: every check a write makes, and what it would record, with nothing written.
const write = <R>(dry: unknown, fn: (T: State) => R) => (dry ? fn(load()) : mutate(fn));
const wouldRecord = (T: State, u: Unit, what: string, text: string) => console.log(`dry run, nothing recorded: ${name(u)} would ${what}:\n  ${expand(T, text)}`);

// The unit's ID, also when --dry-run came before it and took it as its value.
const unitArg = (o: Args) => o._[0] ?? str(o["dry-run"]);

C.done = (a) => {
  const o = parseArgs(a);
  return write(o["dry-run"], (T) => {
    const u = resolve(T, unitArg(o));
    if (u.kind === "gate") die(`${name(u)} is a gate: the owner passes it (\`just pass ${u.id}\`)`);
    const c = u.check || "recorded";
    if (c === "computed") die(`${name(u)} is done when its check passes (${describeProbe(probeOf(T, u))}). Make it pass, then \`just recheck ${u.id}\`.`);
    const evidence = ciWaitText(T, u, "The evidence", checkEvidence(T, "done", str(o.evidence) || die(`done needs --evidence "…": what shows it's done (a test, a file, a screenshot path)`)));
    const r = u.record || ({} as Partial<UnitRecord>);
    const worker = r.reviewing?.by || (r.state === "claimed" || r.state === "review" ? r.by : ctx.TAG);
    const checker = str(o.checker) || ctx.TAG;
    if (c === "independent" && checker === worker) die(`${name(u)} needs an independent check, and ${checker} worked it. Have a fresh context check it (a verifier subagent, or \`just review ${u.id}\` for a later session), then pass --checker <its tag>.`);
    if (o["dry-run"]) { wouldRecord(T, u, `be done${checker !== worker ? `, checked by ${checker}` : ""}, with this evidence`, evidence); return 0; }
    u.record = { state: "done", by: worker, checker: checker !== worker ? checker : undefined, at: now(), evidence, ...branchOf(r) };
    touch(T, u); log(T, "done", u.id, `${u.title}: done${checker !== worker ? `, checked by ${checker}` : ""}`);
    console.log(`${name(u)} → done`);
    return 0;
  });
};

C.review = (a) => {
  const o = parseArgs(a);
  return write(o["dry-run"], (T) => {
    const u = resolve(T, unitArg(o));
    const evidence = ciWaitText(T, u, "The evidence", checkEvidence(T, "review", str(o.evidence) || die(`review needs --evidence "…": what the checker should look at`)));
    if (o["dry-run"]) { wouldRecord(T, u, "go to review, with this evidence", evidence); return 0; }
    const r = u.record || ({} as Partial<UnitRecord>);
    u.record = { state: "review", by: r.reviewing?.by || (r.state === "claimed" ? r.by : ctx.TAG), at: now(), evidence, ...branchOf(r) };
    touch(T, u); log(T, "review", u.id, `${u.title}: waiting for a second check`);
    console.log(`${name(u)} → in review (a later session or a verifier checks it)`);
    return 0;
  });
};

C.block = (a) => {
  const o = parseArgs(a);
  return mutate((T) => {
    const u = resolve(T, o._[0]);
    const on = str(o.on), why = str(o.why);
    if (on) {
      const q = findQ(T, on);
      if (!isOpen(q)) die(`${name(q)} is already ${q.answer ? `answered (${q.answer.key})` : "withdrawn"}; read \`just show ${q.id}\` and carry on`);
      u.record = { state: "blocked", on: q.id, by: ctx.TAG, at: now() };
      log(T, "block", u.id, `${u.title}: waiting on the owner's answer to "${q.title}"`);
      const silent = (q.options || []).filter((op) => hasEffects(op) && !EFFECTS.some((k) => selected(T, op[k] || []).includes(u)));
      if (silent.length) console.error(`note: ${q.id}'s option${silent.length > 1 ? "s" : ""} ${silent.map((x) => x.key).join(", ")} don't say what happens to ${name(u)}; if the owner picks one, it stays stuck. Ask a question of its own if that matters.`);
    } else if (why) {
      checkText(T, "--why", why);
      u.record = { state: "blocked", why, by: ctx.TAG, at: now() };
      log(T, "block", u.id, `${u.title}: stuck: ${why}`);
    } else die("block needs --on q/<slug> (a question for the owner; `just ask` makes one) or --why \"…\" (stuck on something else)");
    touch(T, u);
    console.log(`${name(u)} → ${sentence(T, u, (T._memo = null, derive(T, u)))}`);
    return 0;
  });
};

C.reopen = (a) => {
  const o = parseArgs(a);
  return mutate((T) => {
    const u = resolve(T, o._[0]);
    // Reopened from done: a new round of work (one reopened from stuck or merging carries on its own).
    if (derive(T, u).s === "done") delete u.round;
    u.record = undefined;
    // Reopened by hand (the overseer, after the review or the check before landing blocked it): the
    // review gets two more rounds, the check three more tries.
    if (u.review) u.review.fixes = 0;
    delete u.landCheck;
    const note = o.note && o.note !== true ? ciWaitText(T, u, "The note", checkNote(T, String(o.note))) : undefined;
    if (note) addNote(T, u, note);
    touch(T, u); log(T, "reopen", u.id, `${u.title}: back to ready${note ? ": " + note : ""}`);
    console.log(`${name(u)} → ready`);
    return 0;
  });
};

C.drop = (a) => {
  const o = parseArgs(a);
  return mutate((T) => {
    const u = resolve(T, o._[0]);
    const why = str(o.why) || die('drop needs --why "…"');
    checkText(T, "--why", why);
    u.record = { state: "dropped", why, by: ctx.TAG, at: now() };
    touch(T, u); log(T, "drop", u.id, `${u.title}: dropped: ${why}`);
    console.log(`${name(u)} → dropped`);
    return 0;
  });
};

// The owner sets work aside: parked units aren't offered, aren't waited on, and
// don't count as anything for the owner to do. A selector parks several at once.
C.park = (a) => {
  const o = parseArgs(a);
  return mutate((T) => {
    const sel = o._[0] || die('usage: park <id | selector> --why "…"');
    const why = typeof o.why === "string" ? checkText(T, "--why", o.why) : die('park needs --why "…": why the owner set it aside');
    const us = (resolve(T, sel, { soft: true }) ? [resolve(T, sel)] : selected(T, [sel])).filter((u) => !SETTLED.has(derive(T, u).s));
    if (!us.length) die(`nothing open matches ${sel}`);
    for (const u of us) {
      if (derive(T, u).s === "doing") die(`${name(u)} is in progress; park it once its session ends`);
      u.record = { state: "parked", why, by: ctx.ACTOR === "owner" ? "owner" : ctx.TAG, at: now() };
      touch(T, u); log(T, "park", u.id, `${u.title}: parked: ${why}`);
    }
    console.log(`parked ${us.length === 1 ? name(us[0]) : plural(us.length, "unit")}. \`just tracker unpark ${sel}\` brings ${us.length === 1 ? "it" : "them"} back.`);
    return 0;
  });
};
C.unpark = (a) => mutate((T) => {
  const sel = a[0] || die("usage: unpark <id | selector>");
  // A unit the owner put off (postpone.ts) shows as parked with its own record (or none): the
  // unpark line is what lifts it, and the record (an interrupted claim's kept work) stays.
  const us = (resolve(T, sel, { soft: true }) ? [resolve(T, sel)] : selected(T, [sel])).filter((u) => u.record?.state === "parked" || derive(T, u).s === "parked");
  if (!us.length) die(`nothing parked matches ${sel}`);
  for (const u of us) { if (u.record?.state === "parked") { u.record = undefined; touch(T, u); } log(T, "unpark", u.id, `${u.title}: back from parked`); }
  T._memo = null;
  console.log(`back to work: ${us.slice(0, 6).map((u) => `${name(u)} (${sentence(T, u)})`).join("; ")}${us.length > 6 ? ` and ${us.length - 6} more` : ""}`);
  return 0;
});

C.note = (a) => {
  // --dry-run before or after the text; one inside unquoted text is part of the note.
  const dry = a[1] === "--dry-run" || (a.length > 2 && a[a.length - 1] === "--dry-run");
  if (dry) a = a[1] === "--dry-run" ? [a[0], ...a.slice(2)] : a.slice(0, -1);
  return write(dry, (T) => {
    const u = resolve(T, a[0]);
    const text = ciWaitText(T, u, "The note", checkNote(T, a.slice(1).join(" ") || die('usage: note <id> "…"')));
    if (dry) { wouldRecord(T, u, "get this note", text); return 0; }
    addNote(T, u, text);
    touch(T, u); log(T, "note", u.id, `${u.title}: note: ${text}`);
    console.log(`noted on ${name(u)}`);
    return 0;
  });
};


C.log = (a) => {
  const o = parseArgs(a);
  const all = readLog();
  if (!all) { console.log("(no log yet)"); return 0; }
  let since = 0;
  const s = str(o.since);
  if (s) {
    const m = s.match(/^(\d+)([hdm])$/);
    since = m ? Date.now() - Number(m[1]) * { h: 3600e3, d: 86400e3, m: 60e3 }[m[2] as "h" | "d" | "m"] : Date.parse(s);
  }
  let ls = all.filter((l) => Date.parse(l.at) >= since && (!o.group || (l.id || "").startsWith(o.group + "/")));
  ls.sort((x, y) => x.at.localeCompare(y.at));
  if (!o.since) ls = ls.slice(-(Number(o.n) || 30));
  const T = hasState() ? load() : null;
  for (const l of ls) console.log(`${l.at.slice(5, 16).replace("T", " ")} ${l.actor}${l.tag && l.actor !== "owner" ? " " + l.tag : ""}${l.host ? "@" + l.host : ""}: ${T ? expand(T, l.text) : l.text}`);
  if (!ls.length) console.log("(nothing in that window)");
  return 0;
};

