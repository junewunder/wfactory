// Check units: units that judge other units' fixes in the built thing (a look in the game, an
// editor pass) rather than make a change of their own. Which units are checks is the project's
// call (project.json checks.units, selectors; default tag:check). Three things follow:
//
// - A check waits for the open fixes it covers (coveredFixes): units of its group that name it
//   ({unit:<check>} in their detail or notes: "look in {unit:x-check}", "{unit:x-check} waits on
//   this"), or that its own detail names. Looking before they land shows defects already filed,
//   and the look is done again after them (lesson 32). A fix that needs the check, even through
//   other units, is left out, so this never makes a cycle.
// - A check whose reference doesn't exist yet isn't handed out (readiness): project.json
//   checks.ready is a hook, run before `next` or `claim` hands out a check, that says whether the
//   check has what it needs to be judged, and if not, which unit provides it.
// - A note that waits on CI, on a unit whose group has no CI, is refused (ciWaitText): nothing
//   would ever rebuild it.
import { spawnSync } from "node:child_process";
import { ctx } from "./ctx.ts";
import { log, touch } from "./store.ts";
import { die, list, now, shortTitle } from "./text.ts";
import { autoIds, groupTitle, matches, MAX_TITLE, name } from "./names.ts";
import { dataGroup } from "./machine.ts";
import type { Group, State, Unit } from "./types.ts";

export const checkSelectors = (T: State) => list(T.project.checks?.units ?? "tag:check");

// What every check needs worked out once per state (as derive's memo is): which units are checks,
// the units naming each one, and who reaches whom by needs. Kept with derive's memo, so it goes
// when that does (a write that changes needs or text clears it).
interface Index { check: Map<string, boolean>; namedBy: Map<string, Unit[]>; rev: Map<string, Unit[]> | null; reachers: Map<string, Set<string>>; covered: Map<string, Unit[]> }
const INDEX = new WeakMap<Map<unknown, unknown>, Index>();
const UNIT_REF = /\{unit:([^}\s]+)\}/g;
const refs = (...texts: (string | undefined)[]) => new Set(texts.flatMap((s) => [...String(s ?? "").matchAll(UNIT_REF)].map((m) => m[1])));
function index(T: State): Index {
  const key = (T._memo ||= new Map()) as Map<unknown, unknown>;
  let x = INDEX.get(key);
  if (!x) INDEX.set(key, (x = { check: new Map(), namedBy: new Map(), rev: null, reachers: new Map(), covered: new Map() }));
  return x;
}
export function isCheck(T: State, u: Unit) {
  const ix = index(T);
  let v = ix.check.get(u.id);
  if (v === undefined) ix.check.set(u.id, (v = u.kind !== "gate" && checkSelectors(T).some((s) => matches(T, s, u))));
  return v;
}
// The units of g that each ID is named by ({unit:<id>} in their detail or notes), checks and gates
// left out: built once per group.
function namedBy(T: State, g: Group, id: string): Unit[] {
  const ix = index(T), k = `${g.id}\n`;
  if (!ix.namedBy.has(k)) {
    ix.namedBy.set(k, []);
    for (const f of g.units) {
      if (f.kind === "gate" || isCheck(T, f)) continue;
      for (const r of refs(f.detail, ...(f.notes || []).map((n) => n.text))) { const kk = k + r; if (!ix.namedBy.has(kk)) ix.namedBy.set(kk, []); ix.namedBy.get(kk)!.push(f); }
    }
  }
  return ix.namedBy.get(k + id) || [];
}
const namesIt = (T: State, f: Unit, id: string) => { const g = T.groupOf.get(f.id); return !!g && namedBy(T, g, id).includes(f); };

// The units of c's group that name c, or that c's detail names: what it would cover, before
// leaving out those that need it. Other checks and gates are never covered.
function namedFixes(T: State, c: Unit): Unit[] {
  const g = T.groupOf.get(c.id);
  if (!g) return [];
  const mine = refs(c.detail);
  const out = new Set(namedBy(T, g, c.id));
  for (const id of mine) { const f = T.byId.get(id); if (f && f !== c && T.groupOf.get(id) === g && f.kind !== "gate" && !isCheck(T, f)) out.add(f); }
  out.delete(c);
  return [...out];
}
// Whether from needs to (its own needs, its group's, and what a check among them would cover),
// so a covered fix never makes a cycle. A check's covered fixes count before any are left out:
// that says "needs" of more than it will, and leaves out more rather than fewer. Worked out as
// everything that reaches to, once per to, over the needs turned around.
function reaches(T: State, from: Unit, to: string): boolean {
  const ix = index(T);
  if (!ix.rev) {
    const rev = new Map<string, Unit[]>();
    const edge = (y: string, x: Unit) => { if (!rev.has(y)) rev.set(y, []); rev.get(y)!.push(x); };
    for (const g of T.groups) for (const x of g.units) {
      for (const n of [...(g.needs || []).filter((n) => n !== x.id), ...(x.needs || [])]) edge(n, x);
      if (isCheck(T, x)) for (const f of namedFixes(T, x)) edge(f.id, x);
    }
    ix.rev = rev;
  }
  let set = ix.reachers.get(to);
  if (!set) {
    set = new Set();
    const todo = [to];
    while (todo.length) for (const x of ix.rev.get(todo.pop()!) || []) if (!set.has(x.id)) { set.add(x.id); todo.push(x.id); }
    ix.reachers.set(to, set);
  }
  return set.has(from.id);
}
// The fixes a check covers that it doesn't already need: its status waits for those not done.
export function coveredFixes(T: State, c: Unit): Unit[] {
  if (!isCheck(T, c)) return [];
  const ix = index(T);
  let v = ix.covered.get(c.id);
  if (!v) {
    const own = new Set([...(c.needs || []), ...(T.groupOf.get(c.id)?.needs || [])]);
    ix.covered.set(c.id, (v = namedFixes(T, c).filter((f) => !own.has(f.id) && !reaches(T, f, c.id))));
  }
  return v;
}

// For a check's card: the open fixes of its group that other checks' looks found (they name
// another check) and that it doesn't cover or need. A look sees the whole built thing, so one of them
// may show in this check's look too (an overnight run: a check redid its look and strips before
// finding its defect already filed by its sibling check). Listed, not waited on: whether it shows
// here is the session's call, made before the look.
export function siblingFixes(T: State, c: Unit, open: (u: Unit) => boolean): Unit[] {
  if (!isCheck(T, c)) return [];
  const g = T.groupOf.get(c.id)!;
  const others = g.units.filter((x) => x !== c && isCheck(T, x));
  const mine = new Set([...(c.needs || []), ...(g.needs || []), ...namedFixes(T, c).map((x) => x.id)]);
  return g.units.filter((f) => !mine.has(f.id) && f.kind !== "gate" && !isCheck(T, f) && open(f) && others.some((x) => namesIt(T, f, x.id)) && !reaches(T, f, c.id));
}

// ---------------------------------------------------------------- readiness

// What the hook said. needs: units that provide what's missing, each existing or to be filed.
export type Readiness = { ready: true; notRun?: boolean; why?: string } | { ready: false; why: string; needs: { id: string; title?: string; detail?: string }[] };
export const READY_TIMEOUT = 60;
export const hasReadyHook = (T: State, u: Unit) => !!T.project.checks?.ready && isCheck(T, u);

// Runs project.json checks.ready for a check, {unit} and {group} filled ({group}: its data group
// if it has one, else its group), in the repo, with FACTORY_UNIT set. Exit 0: ready. Exit 75: it
// couldn't tell here, so the check goes out as it would have without the hook. Any other exit:
// not ready, and its output says why and what provides the missing reference:
//   needs <id>                  the check waits on this unit
//   file <group>/<slug> <title> this unit is filed (unless it exists) and the check waits on it
//   detail <text>               the detail of the unit the line before files
// Its last other line is why, for the record.
export function runReady(T: State, u: Unit): Readiness {
  const cfg = T.project.checks!;
  const gid = dataGroup(T, u) || T.groupOf.get(u.id)?.id || "";
  const cmd = cfg.ready!.replaceAll("{unit}", u.id).replaceAll("{group}", gid);
  const secs = cfg.ready_timeout || READY_TIMEOUT;
  const r = spawnSync("bash", ["-c", cmd], { cwd: ctx.ROOT, encoding: "utf8", timeout: secs * 1000, maxBuffer: 8 << 20, env: { ...ctx.env, FACTORY_UNIT: u.id } });
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") return { ready: true, notRun: true, why: `its check-ready hook timed out after ${secs}s` };
  if (r.status === 0) return { ready: true };
  if (r.status === 75 || r.status === null) return { ready: true, notRun: true, why: `its check-ready hook couldn't tell here (exit ${r.status ?? r.signal})` };
  const needs: { id: string; title?: string; detail?: string }[] = [];
  const said: string[] = [];
  for (const line of (r.stdout || "").split("\n").map((l) => l.trim()).filter(Boolean)) {
    let m;
    if ((m = /^needs\s+(\S+)\s*$/.exec(line))) needs.push({ id: m[1] });
    else if ((m = /^file\s+(\S+)\s+(.+)$/.exec(line))) needs.push({ id: m[1], title: m[2].trim() });
    else if ((m = /^detail\s+(.+)$/.exec(line)) && needs.length && needs[needs.length - 1].title) needs[needs.length - 1].detail = m[1].trim();
    else said.push(line);
  }
  const err = (r.stderr || "").trim().split("\n").filter(Boolean);
  const why = (said.pop() || err.pop() || `exit ${r.status}`).slice(0, 200);
  return { ready: false, why, needs };
}

// A check its hook found not ready: it waits on the units the hook named (filed first where they
// don't exist), or, when the hook named none it could use, it's stuck with the hook's reason, for
// the overseer. Returns a line saying what happened.
export function notReady(T: State, u: Unit, res: Extract<Readiness, { ready: false }>): string {
  const why = autoIds(T, res.why);
  const added: Unit[] = [], refused: string[] = [];
  for (const n of res.needs) {
    let x = T.byId.get(n.id);
    if (!x && n.title) {
      const [gid, slug] = n.id.split("/");
      const g: Group | undefined = T.groupById.get(gid);
      if (!g || !slug || !/^[a-z0-9][a-z0-9.-]*$/.test(slug)) { refused.push(`${n.id} (no group "${gid}", or not a <group>/<slug> ID)`); continue; }
      const title = n.title.length > MAX_TITLE ? shortTitle(n.title).slice(0, MAX_TITLE) : n.title;
      x = { id: n.id, title, detail: autoIds(T, n.detail || `Filed by the check-ready hook for {unit:${u.id}}: ${why}`) };
      g.units.push(x); T.byId.set(x.id, x); T.groupOf.set(x.id, g); touch(T, x);
      log(T, "add-unit", x.id, `new unit: ${x.title} (the check-ready hook, for ${u.title})`);
    }
    if (!x) { refused.push(`${n.id} (no such unit; a "file" line would file it)`); continue; }
    if (x === u || reaches(T, x, u.id)) { refused.push(`${name(x)} (it needs the check)`); continue; }
    if (["done", "dropped"].includes(x.record?.state ?? "")) { refused.push(`${name(x)} (${x.record!.state} already)`); continue; }
    if ((u.needs || []).includes(x.id)) { added.push(x); continue; }
    u.needs = [...(u.needs || []), x.id]; added.push(x);
  }
  T._memo = null;
  if (added.length) {
    touch(T, u);
    log(T, "check-ready", u.id, `${u.title}: not ready to judge (${why}); waits on ${added.map((x) => x.title).join(", ")}`);
    return `${name(u)}: not ready to judge (${why}); it waits on ${added.map((x) => name(x)).join(", ")}`;
  }
  u.record = { state: "blocked", why: `its check-ready hook says it can't be judged yet, and named no unit that provides what's missing${refused.length ? ` it could use (${refused.join("; ")})` : ""}: ${why}`, by: ctx.TAG, at: now() };
  touch(T, u);
  log(T, "block", u.id, `${u.title}: stuck: not ready to judge (${why})`);
  return `${name(u)}: stuck, not ready to judge (${why})`;
}

// ---------------------------------------------------------------- notes that wait on CI

// Text that has the next attempt wait for CI ("look after her CI rebuild", "once CI has run",
// "CI's rebuild"), not text that says there's no CI.
const CI_WORD = /\bCI\b/g;
const WAITS_BEFORE = /\b(?:after|once|until|till|wait(?:s|ed|ing)?\s+(?:for|on))\b[^.;:!?\n]{0,30}$/i;
const WAITS_AFTER = /^(?:'s\s+rebuild\b|\s+rebuilds?\b|\s+has\s+(?:run|rebuilt)\b)/i;
const NOT_BEFORE = /\b(?:no|without|not|lacks?|never)\s+(?:\w+\s+)?$/i;
export function waitsOnCi(text: string) {
  for (const m of text.matchAll(CI_WORD)) {
    const before = text.slice(0, m.index), after = text.slice(m.index + 2);
    if (NOT_BEFORE.test(before)) continue;
    if (WAITS_BEFORE.test(before) || WAITS_AFTER.test(after)) return true;
  }
  return false;
}
// Refuses text (a note, evidence, a detail) on u that waits on CI when neither u's group nor the
// group whose data it works on has CI: nothing rebuilds it on its own, and the next session spends
// its first calls finding that out (lesson 32).
export function ciWaitText(T: State, u: Unit, what: string, text: string) {
  if (!waitsOnCi(text)) return text;
  const gs = [...new Set([T.groupOf.get(u.id)?.id, dataGroup(T, u)].filter((x): x is string => !!x))];
  if (!gs.length || gs.some((g) => T.groupById.get(g)?.ci)) return text;
  const titles = gs.map((g) => `${groupTitle(T, g)} (${g})`).join(" and ");
  return die(`${what} waits on CI, but ${titles} ${gs.length > 1 ? "have" : "has"} no CI (\`just tracker ci\` lists ${gs.length > 1 ? "them" : "it"} under "No CI"), so nothing rebuilds ${gs.length > 1 ? "them" : "it"} on its own; nothing was recorded. Give the command that rebuilds what the next attempt must look at instead (e.g. "after \`just <rebuild> …\`").`);
}
