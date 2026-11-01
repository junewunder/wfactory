// Group CI: a step that verifies or ships a group's finished work (a reproducibility drill, a
// publish), run on the group as a whole once it's done for the night, never a unit anyone
// reopens. A group opts in with "ci": { "steps": [...] }, naming steps defined once in
// project.json ("ci": { "steps": { "drill": { "cmd": "…" }, "publish": { "cmd": "…" } } }).
// The group keeps ci.passed (the last pass: commit, time, evidence, the steps it ran, and
// which units were done and open then, and a hash of each step's command), ci.failed (a failure since; known, if it failed again
// on the same step after its ci-fix was done), ci.running, and ci.touched (the latest change
// from outside the group to what its build makes: ci-touch, or the loop's ci.affected hook).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ctx, git } from "./ctx.ts";
import { claimPid, procStart } from "./proc.ts";
import { codeHead, log, readLog, touch } from "./store.ts";
import { now, plural } from "./text.ts";
import { addNote, expand, MAX_TITLE, name } from "./names.ts";
import { beatsHere, capsOk, hostBeatAge, claimAlive, dataGroup, dataPaths, hasStore, newerIn, heldHere, liveLease, lockHeld, resTitle, resourceBusy } from "./machine.ts";
import { derive, LABEL, scopeGroups, sentence, SETTLED } from "./status.ts";
import { fill } from "./templates.ts";
import type { CiCut, CiFail, CiRun, CiTouch, Group, State, Status, Unit } from "./types.ts";

const CI_RETRY_MS = 6 * 3600e3;
// What a ci-fix a pass settled is recorded done with (ciFixPassed).
const PASS_SETTLED = "CI passed since";
export const publishing = (T: State) => T.project.publish !== "off";
// A step that ships (publish: true, or named publish) is skipped while publishing is off.
const shipsStep = (T: State, s: string) => T.project.ci?.steps?.[s]?.publish ?? s === "publish";
export const ciSteps = (T: State, g: Group) => (g.ci?.steps || []).filter((s) => publishing(T) || !shipsStep(T, s));

// Done for the night: nothing more happens to it without the owner. Done, dropped, parked, stuck,
// waiting on the owner, or waiting on needs that are all done for the night too (in any group).
// In last call (the loop's FACTORY_LAST_CALL=1) the lanes take no new units of a group whose CI
// runs there (or on its data), so only work in flight is left: a session on it, or a finished
// branch not on main yet.
const NIGHT_DONE = new Set<Status>(["done", "dropped", "parked", "stuck", "you"]);
function nightDone(T: State, u: Unit, memo: Map<string, boolean>, seen = new Set<string>()): boolean {
  if (ctx.LAST_CALL) return !["doing", "merging"].includes(derive(T, u).s);
  if (memo.has(u.id)) return memo.get(u.id)!;
  if (seen.has(u.id)) return true; // a needs cycle can't move
  seen.add(u.id);
  const d = derive(T, u);
  const out = NIGHT_DONE.has(d.s) || (d.s === "waiting" && (d.unmet || []).every((n) => "missing" in n || nightDone(T, n, memo, seen)));
  memo.set(u.id, out);
  return out;
}
// The units a group's CI covers: its own, and those of other groups that work on its data
// (--data <group>), so finishing, reopening or adding one makes its CI stale too.
export const ciUnits = (T: State, g: Group) => [...g.units, ...T.groups.filter((x) => x !== g).flatMap((x) => x.units.filter((u) => dataGroup(T, u) === g.id))].filter((u) => u.kind !== "gate");
// Why the last pass no longer covers the group ("" if it still does), and since when: the first
// unit finished since. A unit reopened or added, or a step the pass skipped, changes no code
// until a unit is done, so it brings CI due only once the group is done for the night (Infinity).
function ciStaleWhy(T: State, g: Group, units: Unit[]): { why: string; since: number } {
  const p = g.ci!.passed;
  const at = (u: Unit) => Date.parse(u.record!.at);
  if (!p) {
    const done = units.filter((u) => derive(T, u).s === "done");
    return { why: "it hasn't passed yet", since: Math.min(...done.map(at)) };
  }
  const since = Date.parse(p.at);
  const known = new Set([...(p.done || []), ...(p.open || [])]);
  // (A ci-fix a pass settled changed no code: another group's pass settling a shared fix isn't news here.)
  const after = units.filter((u) => ["done", "review"].includes(u.record?.state ?? "") && u.record!.evidence !== PASS_SETTLED && (u.record!.at > p.at || !(p.done || []).includes(u.id)));
  if (after.length) return { why: `${after.length === 1 ? name(after[0]) : plural(after.length, "unit")} finished since it passed`, since: Math.max(since, Math.min(...after.map(at))) };
  // Work outside the group that changed its build (ci-touch) counts as a unit of its own finishing.
  const t = touchedSince(g.ci!.touched, p);
  if (t) return { why: touchText(t), since: Math.max(since, Date.parse(t.at)) };
  const reopened = units.filter((u) => (p.done || []).includes(u.id) && !["done", "dropped"].includes(u.record?.state ?? ""));
  if (reopened.length) return { why: `${reopened.length === 1 ? name(reopened[0]) : plural(reopened.length, "unit")} reopened since it passed`, since: Infinity };
  const added = units.filter((u) => !known.has(u.id) && u.record?.state !== "dropped");
  if (added.length) return { why: `${added.length === 1 ? name(added[0]) : plural(added.length, "unit")} added since it passed`, since: Infinity };
  const skipped = ciSteps(T, g).filter((s) => !(p.steps || []).includes(s));
  if (skipped.length) return { why: `its last pass didn't run ${skipped.join(", ")}`, since: Infinity };
  // A step's command changed in project.json: a tracker-only commit, which no ci.affected hook
  // sees. (A pass from before the hashes were recorded isn't compared.)
  const changed = cmdsChanged(T, g, p.cmds);
  if (changed.length) return { why: `the command of its ${changed.join(", ")} step${changed.length > 1 ? "s" : ""} changed since it passed`, since: Infinity };
  return { why: "", since };
}
// A touch (ci-touch) that's news since a run: recorded after it (the same second too, for a
// failure, as for units), and its commit not already in the commit that run tested.
function touchedSince(t: CiTouch | undefined, run: { at: string; commit?: string }, sameSecond = false): CiTouch | null {
  if (!t || (sameSecond ? t.at < run.at : t.at <= run.at)) return null;
  return t.commit && run.commit && hasCommit(run.commit, t.commit) ? null : t;
}
// Is commit a in b's history (main's clone)? Asked once per pair per command.
const ancestry = new Map<string, boolean>();
function hasCommit(b: string, a: string) {
  const k = `${a} ${b}`;
  if (!ancestry.has(k)) ancestry.set(k, git(["-C", ctx.SDIR, "merge-base", "--is-ancestor", a, b]).status === 0);
  return ancestry.get(k)!;
}
const touchText = (t: CiTouch) => `${t.why}${t.commit ? ` (${short(t.commit)})` : ""}`;
// Record that work outside g changed its build (ci-touch, ci-affected): the latest is kept. quiet:
// the caller logs it, with the other groups the same change touched (ci-affected: one line per
// reason, not per group; 2026-10-29: 757 of 30 hours' 1303 log lines were one per fighter).
export function ciTouch(T: State, g: Group, why: string, commit?: string, quiet = false) {
  g.ci!.touched = { at: now(), by: ctx.TAG, ...(commit ? { commit } : {}), why };
  T.dirty.add("group:" + g.id); T._memo = null;
  if (!quiet) log(T, "ci-touch", null, `${g.title}: CI touched: ${why}`);
}

// The checks before a unit lands (project.json ci.land), as the loop runs them, in order: its
// group's (or its data group's) command, then each other group's whose data it wrote here (#149):
// with a store, a group with data whose copy on this machine has a file written since the round
// began. Not a group another unit or CI run here has at work, or one with outputs here that
// haven't landed (they may be what changed it; the store's marks say), nor one too big to tell:
// those are named as skipped, as is a group
// without CI, or whose CI stands failed (no pass since) or has its ci-fix open: every unit would
// be held for a fault the fix is for. (Copied down since: the loop copies down only a unit's own
// data group, so another group copied down meanwhile was another lane's or CI's doing.) since
// (FACTORY_UNIT_SINCE): when the current round of work on it began, its first claim since it
// last landed or was reopened from done (u.round), not its latest claim: a second attempt after
// a failed check must still see what the first left. A unit claimed before rounds were
// recorded: its first claim in the log since it last landed.
export type CiLandCheck = { group: string; title: string; cmd: string; timeout: number; own: boolean };
export type CiLand = { since: string; checks: CiLandCheck[]; skipped: { group: string; why: string }[]; why?: string };
export function ciLand(T: State, u: Unit): CiLand {
  let since = u.round;
  if (!since) {
    const mine = (readLog() || []).filter((e) => e.id === u.id);
    const after = mine.slice(mine.map((e) => e.cmd).lastIndexOf("merged") + 1);
    since = after.find((e) => e.cmd === "claim")?.at || u.record?.at || now();
  }
  const land = T.project.ci?.land, r: CiLand = { since, checks: [], skipped: [] };
  if (!land?.cmd) return { ...r, why: "no ci.land in tracker/project.json" };
  const own = T.groupById.get(dataGroup(T, u) || T.groupOf.get(u.id)?.id || "");
  const one = (g: Group) => {
    if (!g.ci) { r.skipped.push({ group: g.id, why: `${g.title} has no CI` }); return; }
    if (failing(g)) { r.skipped.push({ group: g.id, why: `${g.title}'s CI ${g.ci.failed!.known ? "is known failing" : "is broken"}` }); return; }
    const fix = [T.byId.get(`${g.id}/ci-fix`), ...sharedFixes(T, g)].find((x) => x && !["done", "dropped"].includes(derive(T, x).s));
    if (fix) { r.skipped.push({ group: g.id, why: `${name(fix)} is open` }); return; }
    r.checks.push({ group: g.id, title: g.title, cmd: fill(land.cmd, { ...(g.params || {}), group: g.id }), timeout: land.timeout ?? 15, own: g === own });
  };
  if (own) one(own); else r.skipped.push({ group: "", why: "its group has no CI" });
  if (!hasStore(T)) return r;
  const cut = Date.parse(since), busy = busyGroups(T, u.id), marked = storeMarked(u.id);
  for (const g of T.groups) {
    if (!g.data || g.id === own?.id) continue;
    const w = dataPaths(T, g).map((p) => newerIn(p.local, cut, null));
    if (!w.includes(true)) {
      if (w.includes(null)) r.skipped.push({ group: g.id, why: `${g.title}: too many files here to tell whether it wrote any (over 200,000)` });
      continue;
    }
    if (busy.has(g.id) || marked.has(g.id)) r.skipped.push({ group: g.id, why: `${g.title}: another unit or CI run here has its data at work, or outputs in it waiting to land` });
    else one(g);
  }
  return r;
}
// The groups other work on this machine has at work, besides unit except (tracker busy): a unit
// claimed here or waiting here to land, or one a lane here holds the lock of (its group and its
// data group; not a merge unit, whose work is its unit's, nor the caller's own claim), and CI
// running here (but a CI step's own run, FACTORY_CI_GROUP).
export function busyGroups(T: State, except: string | null) {
  const gs = new Set<string>(), { TAG, HOST } = ctx;
  for (const u of T.byId.values()) {
    const r = u.record, ug = T.groupOf.get(u.id)?.id;
    if (u.id === except || ug === "merge") continue;
    if (r?.state === "claimed" && r.by === TAG && TAG !== "manual") continue;
    const here = r?.host === HOST && (r.state === "claimed" || derive(T, u).s === "merging");
    // its own group, and the group whose data it works in (data: mira on an effects unit)
    if (here || lockHeld("unit", u.id)) { if (ug) gs.add(ug); const dg = dataGroup(T, u); if (dg) gs.add(dg); }
  }
  for (const g of T.groups) if (g.id !== ctx.env.FACTORY_CI_GROUP && ((g.ci?.running?.host === HOST && claimAlive(T, g.ci.running)) || lockHeld("ci", g.id))) gs.add(g.id);
  return gs;
}
// The groups whose copy here the store has marked as another's (store.sh: work/.store/groups/):
// a session or CI run working on it (<g>.dirty.<lane>, its unit first), or outputs of a unit that
// haven't landed (<g>.unmerged.<unit>), other than unit u's.
function storeMarked(u: string) {
  const dir = path.join(ctx.ROOT, "work/.store/groups"), gs = new Set<string>();
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { return gs; }
  for (const n of names) {
    // (Group IDs have no dots; units and lane folders may.)
    const m = /^([^.]+)\.(dirty|unmerged)\./.exec(n);
    if (!m) continue;
    let who = "";
    try { who = fs.readFileSync(path.join(dir, n), "utf8").split("\t")[0].trim(); } catch { continue; }
    if (who !== u) gs.add(m[1]);
  }
  return gs;
}

// How long CI may stay stale while its group still has work before it comes due: ci_every minutes.
export const ciEveryMs = (T: State) => (Number.isFinite(T.project.ci_every) ? Number(T.project.ci_every) : 120) * 60e3;
export type CiState =
  | { s: "off"; why?: string }
  | { s: "passed" }
  | { s: "stale"; why: string; left: Unit[]; at: number }
  | { s: "due"; why: string; left: Unit[] }
  | { s: "running"; run: CiRun }
  | { s: "broken"; failed: CiFail }
  | { s: "known"; failed: CiFail; why: string };
// A group's CI: off, passed, stale (changed, and the group still has work tonight), due (changed,
// and the group is done for the night, or it has been stale ci_every minutes), running, broken
// (the last run failed), known failing (it failed again after its ci-fix was done: like broken,
// it holds nothing, and nothing more is filed until something changes). Stale has `at`: when it comes due. Due CI with work left (`left`) comes
// before the group's new units (ciFirst). In last call it waits for the work in flight instead.
export function ciState(T: State, g: Group): CiState {
  const ci = g.ci;
  if (!ci) return { s: "off" };
  const units = ciUnits(T, g);
  const r = ci.running;
  if (r && claimAlive(T, r)) return { s: "running", run: r };
  // A group's needs hold its CI as they hold its units (a gate in front of a module holds its publish).
  const held = (g.needs || []).filter((n) => { const x = T.byId.get(n); return !x || !SETTLED.has(derive(T, x).s); });
  if (held.length) return { s: "off", why: `it waits on ${held.map((n) => { const x = T.byId.get(n); return x ? name(x) : n; }).join(", ")}` };
  if (!units.some((u) => derive(T, u).s === "done")) return { s: "off", why: "nothing done yet" };
  if (!ciSteps(T, g).length) return { s: "off", why: (ci.steps || []).length ? "publishing is off, and it only publishes" : "no steps" };
  const memo = new Map<string, boolean>();
  const left = units.filter((u) => !nightDone(T, u, memo));
  const lost = r ? `its last run (session ${r.by}${r.host ? " on " + r.host : ""}) stopped without a result; ` : "";
  const every = ciEveryMs(T);
  // since: when the change it's for happened; null: due now (a retry, its ci-fix done).
  const go = (why: string, since: number | null): CiState => {
    if (!left.length) return { s: "due", why: lost + why, left };
    const at = since === null ? -Infinity : since + every;
    if (!ctx.LAST_CALL && every > 0 && Date.now() >= at) return { s: "due", why: `${lost}${why}${since === null ? "" : `, ${ago(since)} ago`}`, left };
    return { s: "stale", why: lost + why, left, at: ctx.LAST_CALL || every <= 0 ? Infinity : at };
  };
  // A failure counts until a later pass (a merge of two machines' writes can keep both).
  const f = ci.failed && (!ci.passed || ci.failed.at >= ci.passed.at) ? ci.failed : null;
  if (f) {
    const head = codeHead();
    // The retry names the failure it's for, so a newer failure merged in isn't retried.
    if (f.retry === f.at) return go("a retry was asked for", null);
    // A step's command changed since (the fix may be the command itself): tried again now.
    const changed = cmdsChanged(T, g, f.cmds);
    if (changed.length) return go(`the command of its ${changed.join(", ")} step${changed.length > 1 ? "s" : ""} changed since it failed`, null);
    // A unit finished since (its ci-fix, say): try again now, not in 6 hours. Times are to the
    // second, so the same second counts: a needless retry is cheaper than 6 hours broken.
    // (Known failing judged its ci-fix's done already: that one counts only if done again.)
    // Another group's ci-fix this group's failure joined (it lists the group in also) counts as its own.
    const fixed = [...units, ...sharedFixes(T, g)].filter((u) => derive(T, u).s === "done" && u.record!.at >= f.at && !(f.known && u.tags?.includes("ci-fix") && u.record!.at <= f.at));
    // Its ci-fix, done, is what it waited for: that runs it again at once.
    if (fixed.some((u) => u.tags?.includes("ci-fix"))) return go(`${name(fixed.find((u) => u.tags?.includes("ci-fix"))!)} finished since it failed`, null);
    if (fixed.length) return go(`${fixed.length === 1 ? name(fixed[0]) : plural(fixed.length, "unit")} finished since it failed`, Math.min(...fixed.map((u) => Date.parse(u.record!.at))));
    // A change from outside the group since (shared code moved): tried again as for a unit of its own.
    const t = touchedSince(ci.touched, f, true);
    if (t) return go(`${touchText(t)} since it failed`, Date.parse(t.at));
    if (head && !(f.commit && head.startsWith(f.commit)) && Date.now() - Date.parse(f.at) >= CI_RETRY_MS) return go("main has moved since it failed", null);
    return f.known ? { s: "known", failed: f, why: f.known } : { s: "broken", failed: f };
  }
  const st = ciStaleWhy(T, g, units);
  return st.why ? go(st.why, st.since) : { s: "passed" };
}
// "2 h 10 min" since a time.
function ago(t: number) {
  const m = Math.max(0, Math.round((Date.now() - t) / 60e3));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
}
// Due CI that runs before any new unit of its group (or one working on its data), as long as a
// lane will run it: this one (a busy resource aside), or the machine it's pinned to or its data is
// leased to, or (with neither) another that can do its steps, while that machine's heartbeat is
// fresh. (A machine beats while its loop has claims, CI or leases there, so one whose lanes have
// sat idle half an hour reads as down: the units here go on, and it runs the CI at its next look.) A group's own ci-fix isn't held back (it's what a broken run waits for).
export function ciFirst(T: State, g: Group, c = ciState(T, g)) {
  if (c.s !== "due" || !c.left.length) return false;
  if (!ciHereWhy(T, g, { resources: false })) return true;
  const up = (h: string) => hostBeatAge(T, h) < ctx.STALE_MS;
  if (g.host) return g.host !== ctx.HOST && up(g.host);
  const dg = ciData(T, g), l = dg ? liveLease(T, dg) : null;
  if (l) return l.host !== ctx.HOST && up(l.host);
  const caps = [...new Set(ciPlan(T, g).flatMap((p) => p.caps))];
  if (!ctx.MCAPS.size) return true;
  return [...ctx.MCAPS].some(([h, m]) => h !== ctx.HOST && caps.every((x) => m.has(x)) && up(h));
}
export const short = (c: string | undefined) => (c ? c.slice(0, 8) : "?");
const iso = (t: number) => new Date(t).toISOString().replace(/\.\d+Z$/, "Z");
export function ciText(T: State, g: Group, c = ciState(T, g)): string {
  const p = g.ci?.passed;
  const last = p ? `; last passed ${short(p.commit)} at ${p.at}` : "";
  const cut = g.ci?.cut && (!p || g.ci.cut.at > p.at) && (!g.ci.failed || g.ci.cut.at > g.ci.failed.at) ? `; its last run was cut off (${cutText(g.ci.cut)})` : "";
  const work = (n: number) => `${plural(n, "unit")} still to ${ctx.LAST_CALL ? "land before last call ends" : "work tonight"}`;
  switch (c.s) {
    case "off": return `off${c.why ? ` (${c.why})` : ""}${last}`;
    case "passed": return `passed (${(p!.steps || []).join(", ") || "no steps"}) ${short(p!.commit)} at ${p!.at}`;
    case "stale": return `stale: ${c.why}; ${work(c.left.length)}${Number.isFinite(c.at) ? `; due at ${iso(c.at)} if it still has work then` : ""}${cut}${last}`;
    case "due": return `due: ${c.why}${c.left.length ? `; it runs before the group's other new units (${work(c.left.length)})` : ""}${cut}${last}`;
    case "running": return `running (session ${c.run.by}${c.run.host ? " on " + c.run.host : ""} since ${c.run.at})${last}`;
    case "broken": return `broken: ${expand(T, c.failed.evidence)} (at ${short(c.failed.commit)}, ${c.failed.at}). It's tried again once main moves and 6 hours pass, when a unit of the group is done or a change outside it touches it, or now with \`just tracker ci-retry ${g.id}\`${last}`;
    case "known": return `known failing: ${c.why} (${expand(T, c.failed.evidence)}, at ${short(c.failed.commit)}, ${c.failed.at}). It holds nothing; it's tried again when a unit of the group is done, once main moves and 6 hours pass, or now with \`just tracker ci-retry ${g.id}\`${last}`;
  }
}
const cutText = (x: CiCut) => `${x.step ? `at ${x.step}, ` : ""}${x.why}; started ${x.at}${x.host ? ` on ${x.host}` : ""}`;

// What became of a group's CI since a time (the start of the night), for the morning summary
// and the view: passed, failed (on what), cut off, or never started (and why it was needed);
// null if it didn't need to run. The latest of its runs since then is the one that counts.
export type CiOutcome = { s: "passed" | "failed" | "cut" | "running" | "never"; text: string };
export function ciOutcome(T: State, g: Group, since = 0): CiOutcome | null {
  const ci = g.ci;
  if (!ci) return null;
  const c = ciState(T, g);
  if (c.s === "running") return { s: "running", text: `running since ${c.run.at}${c.run.host ? ` on ${c.run.host}` : ""}` };
  const t = (x?: { at: string }) => (x && Date.parse(x.at) >= since ? Date.parse(x.at) : -1);
  // A run whose session is gone without a result (the machine went down) was cut off too.
  const lost = ci.running && !claimAlive(T, ci.running) ? { at: ci.running.at, by: ci.running.by, host: ci.running.host, why: "its lane stopped without a result" } : undefined;
  const runs = [["passed", ci.passed], ["failed", ci.failed], ["cut", ci.cut], ["cut", lost]] as const;
  // (Times are to the second: in a tie the later in this list is the later record.)
  const [k, r] = runs.reduce((best, x) => (t(x[1]) >= t(best[1]) && t(x[1]) >= 0 ? x : best), runs[0]);
  if (t(r) >= 0) {
    const passed = k === "passed" ? `passed (${(ci.passed!.steps || []).join(", ")}) at ${short(ci.passed!.commit)}, ${ci.passed!.at}` : "";
    // (Due since that pass and not run: for the view, which looks at no night, it never started.
    // Stale isn't owed a run yet: that's still a pass, changed since.)
    if (k === "passed" && c.s === "due" && !since) return { s: "never", text: `never started since it came due: ${ciText(T, g, c)}` };
    if (k === "passed" && c.s !== "passed") return { s: "passed", text: `${passed}; since then ${ciText(T, g, c)}` };
    if (k === "passed") return { s: "passed", text: passed };
    if (k === "failed") return { s: "failed", text: `failed${ci.failed!.step ? ` on ${ci.failed!.step}` : ""}: ${expand(T, ci.failed!.evidence)} (${short(ci.failed!.commit)}, ${ci.failed!.at})${ci.failed!.known ? `; known failing: ${ci.failed!.known}` : ""}` };
    return { s: "cut", text: `cut off: ${cutText(r as CiCut)}` };
  }
  if (c.s === "off" || c.s === "passed") return null;
  if (c.s === "broken") return { s: "never", text: `never started: still broken from ${c.failed.at} (${expand(T, c.failed.evidence)}), and not retried yet` };
  if (c.s === "known") return { s: "never", text: `never started: known failing since ${c.failed.at} (${c.why}), and nothing has changed since` };
  return { s: "never", text: `never started: ${ciText(T, g, c)}` };
}

// What the loop runs for a group's CI: each step's command (with {group} and the group's
// params filled in), the resources it uses (the run takes every step's as it starts), its time limit and retries, what a failure does ("unit": file
// <group>/ci-fix for the lanes; "owner": raise it to the owner, file nothing), and its share of
// the machine's memory budget ("mem", also its cap; else its past peaks, uncapped).
export const CI_STEP_KEYS = ["cmd", "publish", "uses", "caps", "timeout", "retries", "on_fail", "mem"];
export interface CiPlanStep {
  step: string;
  cmd: string;
  ships: boolean;
  uses: string[];
  caps: string[];
  timeout: number;
  retries: number;
  on_fail: "unit" | "owner";
  mem?: string;
}
export function ciPlan(T: State, g: Group): CiPlanStep[] {
  return ciSteps(T, g).map((s) => {
    const d = T.project.ci?.steps?.[s] || ({} as Partial<NonNullable<NonNullable<typeof T.project.ci>["steps"]>[string]>);
    const ships = !!shipsStep(T, s);
    return { step: s, cmd: fill(d.cmd || "", { ...(g.params || {}), group: g.id }), ships,
      uses: [...new Set([...(d.uses || []), ...(g.ci!.uses || [])])], caps: d.caps || [],
      timeout: d.timeout ?? 120, retries: d.retries ?? 1, on_fail: d.on_fail || (ships ? "owner" : "unit"), ...(d.mem ? { mem: d.mem } : {}) };
  });
}
// A hash of each step's command as the group runs it (its params filled in), kept with a pass.
export const ciCmds = (T: State, g: Group, steps: string[]) => Object.fromEntries(ciPlan(T, g).filter((p) => steps.includes(p.step))
  .map((p) => [p.step, crypto.createHash("sha1").update(p.cmd).digest("hex").slice(0, 12)]));
// The steps whose command differs from the hashes a pass or failure kept (none kept: none).
const cmdsChanged = (T: State, g: Group, was: Record<string, string> | undefined) => { const now_ = ciCmds(T, g, Object.keys(was || {})); return Object.keys(now_).filter((s) => now_[s] !== was![s]); };
// The machine a group's data is leased to, if it has data on the store.
export const ciData = (T: State, g: Group) => (hasStore(T) && g.data ? g.id : null);
// The resources a run takes as it starts: every one its steps use, each kept until the last step
// that uses it. A run never waits mid-way for one (24 Oct: a publish step waited up to an hour for
// the editor while its lane did nothing); it waits before its first step, and its lane takes other
// work meanwhile.
export const ciStartUses = (T: State, g: Group, plan = ciPlan(T, g)) => [...new Set(plan.flatMap((p) => p.uses))];
// Can this lane run g's CI? "" if so, else why not. With resources: false, busy resources and
// another session here working on the group don't count (CI waits for those).
function ciHereWhy(T: State, g: Group, { resources = true } = {}) {
  const { HOST, env } = ctx;
  if (g.host ? g.host !== HOST : env.FACTORY_HOST_ONLY) return `it runs on ${g.host || "another machine"}`;
  const plan = ciPlan(T, g);
  if (!plan.every((p) => capsOk(p))) return `its steps need ${[...new Set(plan.flatMap((p) => p.caps))].join(", ")}`;
  if (lockHeld("ci", g.id)) return "another lane here is running it";
  const dg = ciData(T, g);
  if (dg) {
    const l = liveLease(T, dg);
    if (l && l.host !== HOST) return `its data is leased by ${l.host}, which runs it`;
    if (!l && (env.FACTORY_LEASES !== "1" || env.FACTORY_NO_NEW_LEASE === "1")) return env.FACTORY_LEASES === "1" ? "no room here for its data" : "its data isn't leased here (the loop runs CI)";
  }
  if (resources) { const busy = ciStartUses(T, g, plan).filter((r) => resourceBusy(T, r)); if (busy.length) return `waiting for ${busy.map((r) => resTitle(T, r)).join(" and ")}`; }
  // A session here working on the group has its outputs in work/ half-written: a step that reads
  // them (a drill) would fail on that, or the project's own guard would refuse it. CI waits for
  // the session to end. (A claim whose session is gone holds nothing: claimAlive.)
  const held = resources ? heldHere(T).get(g.id) : undefined;
  if (held?.length) return `waiting for ${held.map((u) => `${name(u)}, which session ${u.record!.by} here is working on`).join(" and ")}`;
  return "";
}
export type CiPick =
  | { code: 0; group: Group }
  | { code: 1; wait: boolean; why: string; uses?: string[]; start?: string[] };
// Due CI this lane can run, best first: groups leased here, then priority, order.
export function ciPick(T: State, groupFilter?: string): CiPick {
  const rank = (g: Group) => [ciData(T, g) && liveLease(T, g.id)?.host === ctx.HOST ? 0 : 1, -(g.priority || 0), g.order ?? 0];
  const due = scopeGroups(T).filter((g) => g.ci && (!groupFilter || g.id === groupFilter) && ciState(T, g).s === "due")
    .sort((a, b) => { const A = rank(a), B = rank(b); for (let i = 0; i < A.length; i++) if (A[i] !== B[i]) return A[i] - B[i]; return 0; });
  const g = due.find((x) => !ciHereWhy(T, x));
  if (g) return { code: 0, group: g };
  const waits = due.filter((x) => !ciHereWhy(T, x, { resources: false }));
  const why = due.length ? `CI due: ${due.map((x) => `${x.title} (${ciHereWhy(T, x)})`).join("; ")}` : "no CI due";
  // In last call a lane also waits for work in flight that will make CI due here once it lands.
  const soon = ctx.LAST_CALL ? scopeGroups(T).filter((x) => x.ci && (!groupFilter || x.id === groupFilter) && ciState(T, x).s === "stale" && !ciHereWhy(T, x, { resources: false })) : [];
  // It names that work, so whoever reads the wait can tell when nothing is landing it.
  const flight = (x: Group) => {
    const c = ciState(T, x), left = c.s === "stale" ? c.left : [];
    const one = (u: Unit) => `${name(u)} ${LABEL[derive(T, u).s]}${u.record?.host ? ` on ${u.record.host}` : ""}`;
    return `${x.title}: ${left.slice(0, 3).map(one).join(", ")}${left.length > 3 ? ` and ${left.length - 3} more` : ""}`;
  };
  if (soon.length) return { code: 1, wait: true, why: `${why}; last call: CI comes due here once work in flight lands (${soon.map(flight).join("; ")})` };
  // What due CI here waiting on a busy resource takes as it starts (start: no unit starts with one
  // meanwhile, so a free one isn't taken while the CI waits on another; CI waiting only on a
  // session here keeps nothing free), and which are busy (uses: a unit that gets one as it frees
  // gives way to the CI).
  const blocked = waits.map((x) => ciStartUses(T, x)).filter((u) => u.some((r) => resourceBusy(T, r)));
  const start = [...new Set(blocked.flat())];
  return { code: 1, wait: waits.length > 0, why, uses: start.filter((r) => resourceBusy(T, r)), start };
}
export function ciRunRecord(T: State, g: Group) {
  const pid = claimPid();
  g.ci!.running = beatsHere(T, { commit: codeHead({ fresh: true }) || undefined, by: ctx.TAG, session: ctx.env.FACTORY_SESSION || ctx.env.CLAUDE_CODE_SESSION_ID || undefined, host: ctx.HOST, pid: pid || undefined, start: pid ? procStart(pid) || undefined : undefined, at: now() });
  T.dirty.add("group:" + g.id); log(T, "ci-start", null, `${g.title}: CI started (${ciSteps(T, g).join(", ")})`);
}
// CI the loop runs at this machine and its leases: running here, or due and runnable here.
export const ciKeepsLease = (T: State, g: Group) => !!g.ci && ((!!g.ci.running && claimAlive(T, g.ci.running) && g.ci.running.host === ctx.HOST) || (ciState(T, g).s === "due" && !ciHereWhy(T, g, { resources: false })));

// A group's CI failure that counts: none passed since.
const failing = (h: Group) => !!h.ci?.failed && (!h.ci.passed || h.ci.failed.at >= h.ci.passed.at);
// CI passed: an open or stuck <group>/ci-fix has nothing left to fix, so it's recorded done, dated
// to the pass (at) so it counts among what the pass covered and doesn't make CI stale again. One a
// live session is working on, or whose branch is landing, is left to that work; one parked or
// waiting on a question, to the owner; and a pass that didn't run the step that failed (steps)
// settles nothing. A shared fix (another group's that this one's failure joined, or this one's with
// others in also) is settled by the pass of the last group in it still failing: a pass says nothing
// of the others. Returns what it did, for ci-pass to say ("" if nothing).
export function ciFixPassed(T: State, g: Group, at: string, steps: string[]) {
  const step = g.ci!.failed?.step;
  if (step && !steps.includes(step)) return "";
  const own = T.byId.get(`${g.id}/ci-fix`);
  const out: string[] = [];
  for (const u of [...(own && T.groupOf.get(own.id) === g ? [own] : []), ...sharedFixes(T, g)]) {
    if (FIX_BUSY.includes(derive(T, u).s) || stillFailing(T, u, step, g)) continue;
    out.push(settle(T, u, at));
  }
  return out.join(" ");
}
// What a pass leaves a fix to: one live session's work, a branch landing, or the owner.
const FIX_BUSY: Status[] = ["done", "dropped", "merging", "review", "doing", "parked", "you"];
// Whether a group in fix u other than but (its own, and those in also) still fails on step (any step
// if it isn't known).
const stillFailing = (T: State, u: Unit, step: string | undefined, but?: Group) =>
  [T.groupOf.get(u.id), ...(u.also || []).map((id) => T.groupById.get(id))].some((h) => !!h && h !== but && failing(h) && (!step || h.ci!.failed!.step === step));
function settle(T: State, u: Unit, at: string) {
  u.record = { state: "done", by: ctx.TAG, at, evidence: PASS_SETTLED };
  touch(T, u); T._memo = null;
  log(T, "done", u.id, `${u.title}: done: CI passed since`);
  return `${name(u)} is done: CI passed since.`;
}
// One cause breaking CI in several groups (a shared file they all read) files one fix: a step
// failing on the same tested commit within SHARED_MS of another group's failure on that step joins
// that group's open ci-fix (its "also" lists the groups that joined, and its card gets each one's
// rows) instead of filing its own. The fix stays the first group's (its uses, its data lease); when
// it's done, each group in it comes due again. A group tested after main moved files its own.
const SHARED_MS = 30 * 60e3;
// A fix another group can still join: one not yet finished or set aside for the owner.
const JOINABLE = new Set<Status>(["ready", "waiting", "doing"]);
// The other groups' ci-fixes that list g: the shared fixes it's in.
export const sharedFixes = (T: State, g: Group) => T.groups.flatMap((h) => h.units.filter((u) => u.tags?.includes("ci-fix") && u.also?.includes(g.id) && T.groupOf.get(u.id) !== g));
// A shared fix's card: its own group's rows, then a paragraph per group that joined.
const JOINED = /\n\n(?=Also [^\n]*? \([^()\s]+\): its CI's )/;
const joinedBy = (x: string, gid: string) => x.startsWith("Also ") && x.includes(` (${gid}): its CI's `);
// g leaves shared fix u (its failure has another cause, or it fails another step now), and its rows
// go from the card. A fix left with no group failing its step is settled, as a pass would.
function leave(T: State, u: Unit, g: Group, step: string | undefined, why: string) {
  u.also = (u.also || []).filter((x) => x !== g.id);
  u.detail = (u.detail || "").split(JOINED).filter((x, i) => !i || !joinedBy(x, g.id)).join("\n\n");
  addNote(T, u, `${g.title} is out of this fix: ${why}.`); touch(T, u);
  log(T, "ci-split", u.id, `${u.title}: ${g.title} is out of it: ${why}`);
  if (!FIX_BUSY.includes(derive(T, u).s) && !stillFailing(T, u, step)) settle(T, u, now());
}
// The open fix of another group whose failure was this one: the same step, on the same commit,
// SHARED_MS before at most.
function sharedFixFor(T: State, g: Group, step: string, commit: string | undefined) {
  if (!commit) return null;
  for (const h of T.groups) {
    if (h === g || !h.ci) continue;
    const f = h.ci.failed, u = T.byId.get(`${h.id}/ci-fix`);
    if (!f || !u || T.groupOf.get(u.id) !== h || f.known || f.step !== step || f.commit !== commit) continue;
    if (h.ci.passed && h.ci.passed.at > f.at) continue;
    if (Date.now() - Date.parse(f.at) > SHARED_MS || !JOINABLE.has(derive(T, u).s)) continue;
    return u;
  }
  return null;
}
// A step whose failure is the lanes' to fix (on_fail "unit") files <group>/ci-fix, or reopens a
// dropped one, unless it joins another group's fix for the same failure (above). One that fails
// again on the same step after its fix was done (was: the failure before this one, the one the fix
// was for; the fix its own or a shared one) marks the failure known failing, with the fix's last
// note as why, and files nothing: a CI failure a fix didn't cure isn't the end of the world, and it
// holds nothing. Another step failing after the fix starts a new cycle. Returns what happened, for
// the loop's log. A fix done after the run started (ran) wasn't in it: CI is tried again at once,
// for the fix. alone: file the group's own fix, joining none (ci-split).
export function ciFixUnit(T: State, g: Group, step: string, commit: string | undefined, evidence: string, logPath: string | null, was?: CiFail, ran?: string, { alone = false, host = ctx.HOST } = {}) {
  const HOST = host;
  // Failing another step now than the one a shared fix it's in is for: that fix isn't its any more
  // (the step it was for passed, or wasn't reached), and this failure is judged on its own.
  for (const x of sharedFixes(T, g)) if (!["done", "dropped"].includes(derive(T, x).s) && was?.step !== step) leave(T, x, g, was?.step, `its CI fails on ${step} now`);
  const plan = ciPlan(T, g).find((p) => p.step === step);
  if ((plan?.on_fail || "unit") !== "unit") return `Its ${step} step is the owner's to look at: no unit filed.`;
  const id = `${g.id}/ci-fix`;
  // A fix takes the failed step's resources (drill and check take none; publish the editor), set
  // afresh each time it's filed or reopened, so a resource a lane added for one fix doesn't stay on.
  const uses = (u: Unit) => { if (plan?.uses?.length) u.uses = [...plan.uses]; else delete u.uses; };
  const row = `CI's ${step} step failed on ${short(commit)} (${HOST}): ${evidence}${logPath ? ` The whole output is in ${logPath} on ${HOST}.` : ""}`;
  // 29 Oct: five groups' CI broke one by one on a change to shared code, and each fix patched its
  // own group only; one fix waited 90 minutes on a whole build it didn't need.
  const detail = `${row} Find out why, fix it on your branch, run \`just check\`, and record this unit done. If the cause is in code other groups' builds share, fix it for every group it reaches, not only this one, and name them in the evidence. Rerun the failed step, not the whole build: CI runs again once it's done.`;
  // Filed or reopened for a new cycle: no other group is in it yet.
  // A shared fix done for the groups in it that haven't run since hands each its retry first, as
  // its done would have made it due at once (ciState) and reopening it takes that away.
  const fresh = (u: Unit) => {
    for (const hid of u.also || []) {
      const h = T.groupById.get(hid), hf = h?.ci?.failed;
      if (!h || h === g || !hf || !failing(h) || u.record?.state !== "done" || !(u.record.at >= hf.at)) continue;
      hf.retry = hf.at; T.dirty.add("group:" + h.id);
      log(T, "ci-retry", null, `${h.title}: CI retried: ${u.title} was done for it, and is reopened for ${g.title}'s ${step}`);
    }
    u.detail = detail; u.record = undefined; delete u.also; delete u.round; uses(u); touch(T, u);
  };
  let u = T.byId.get(id);
  const own = u && T.groupOf.get(u.id) === g ? u : undefined;
  const p = g.ci!.passed;
  // The failure the fix was done for: one on this step, since the last pass, and before the fix was
  // done (or already known failing: its fix judged). Anything else is a fix for something else.
  const forThis = (x: Unit) => !!was && was.step === step && (!p || was.at >= p.at) && (!!was.known || (!!x.record?.at && was.at <= x.record.at));
  // The fixes this failure could follow: its own (unless that one's cycle ended with a pass since:
  // the same second counts, as ciFixPassed dates the fix it settles to the pass) and shared ones.
  const ended = (x: Unit) => !!p && !!x.record?.at && p.at >= x.record.at;
  const fixes = [...(own && derive(T, own).s !== "dropped" && !ended(own) ? [own] : []), ...sharedFixes(T, g).filter((x) => !ended(x))];
  const doneFix = (pred: (x: Unit) => boolean) => fixes.find((x) => derive(T, x).s === "done" && pred(x));
  const late = ran ? doneFix((x) => !!x.record?.at && x.record.at > ran) : undefined;
  if (late) {
    g.ci!.failed!.retry = g.ci!.failed!.at;
    log(T, "ci-retry", null, `${g.title}: CI retried: ${late.title} was done after the run started`);
    return `${name(late)} was done after this run started, so the run didn't have it: CI runs again at once.`;
  }
  const cured = doneFix(forThis);
  if (cured) {
    const why = `${step} still fails after ${name(cured)}: ${lastNote(cured)}`;
    g.ci!.failed!.known = why;
    if (was?.known) return `${g.title}'s CI is still known failing (${why}).`;
    log(T, "ci-known", null, `${g.title}: CI known failing: ${why}`);
    return `${name(cured)} was done and CI failed again on ${step}: ${g.title}'s CI is known failing now (${why}). It holds nothing, and runs again when a unit of the group is done or main moves.`;
  }
  // A fix still open for it, its own or one it's in: that one has it.
  const open = fixes.find((x) => !["done", "dropped"].includes(derive(T, x).s));
  if (open) {
    // (Its own rows anew; the rows of groups that joined it stay.)
    if (open === own) open.detail = [detail, ...(open.detail || "").split(JOINED).slice(1)].join("\n\n");
    addNote(T, open, `${open === own ? "" : `${g.title}: `}CI's ${step} step failed again on ${short(commit)}.`); touch(T, open);
    return `${name(open)} is open already (${sentence(T, open)}).`;
  }
  const shared = alone ? null : sharedFixFor(T, g, step, commit);
  if (shared) {
    const h = T.groupOf.get(shared.id)!;
    shared.also = [...new Set([...(shared.also || []), g.id])];
    shared.detail = `${shared.detail}\n\nAlso ${g.title} (${g.id}): its ${row} The same fix is meant to cure it: its CI runs again too once this unit is done. If its failure has another cause, \`just tracker ci-split ${g.id}\` gives it a fix of its own.`;
    // A session already on it read its card before this: a note says there's more.
    if (derive(T, shared).s === "doing") addNote(T, shared, `${g.title}'s CI failed the same way (${step} on ${short(commit)}): its rows are on the card, and this fix is to cure it too.`);
    touch(T, shared);
    log(T, "ci-fix-shared", shared.id, `${shared.title}: ${g.title}'s CI failed the same way (${step} on ${short(commit)}); added to this fix`);
    return `${h.title}'s CI failed the same way on ${short(commit)} minutes ago: added to ${name(shared)}, not filing a fix of its own.`;
  }
  if (!u) {
    u = { id, title: `Fix ${g.title}'s CI`.length <= MAX_TITLE ? `Fix ${g.title}'s CI` : "Fix this group's CI", detail, check: "recorded", tags: ["ci-fix"] };
    uses(u);
    g.units.push(u); T.byId.set(id, u); T.groupOf.set(id, g); touch(T, u);
    log(T, "add-unit", id, `new unit: ${u.title} (CI's ${step} step failed)`);
    return `Filed ${name(u)} for the lanes.`;
  }
  fresh(u); log(T, "reopen", id, `${u.title}: back to ready: CI's ${step} step failed`);
  return `Reopened ${name(u)} for the lanes.`;
}
// ci-split: g leaves the shared fix it's in (its failure only looked like the others) and gets a
// fix of its own, for its current failure.
export function ciSplit(T: State, g: Group) {
  const f = g.ci?.failed;
  const from = sharedFixes(T, g).filter((u) => !["done", "dropped"].includes(derive(T, u).s));
  if (!from.length || !f?.step) return "";
  for (const u of from) leave(T, u, g, f.step, "its CI failure has another cause, with a fix of its own");
  return ciFixUnit(T, g, f.step, f.commit, f.evidence, f.log ?? null, undefined, undefined, { alone: true, host: f.host || ctx.HOST });
}
// What the fix's session said last: its latest note (notes are newest first), or what it recorded
// done with.
function lastNote(u: Unit) {
  const n = (u.notes || [])[0];
  const r = u.record?.evidence;
  return (n && (!r || !u.record?.at || n.at >= u.record.at) ? n.text : r) || "it left no note";
}
