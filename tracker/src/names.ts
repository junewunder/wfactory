// Naming things for people: titles first, IDs in parentheses, and text that refers to units
// as {unit:<id>} so a bare ID never reaches the owner. Also finding units, questions and
// decisions by what a command was given, and selectors.
import { ctx } from "./ctx.ts";
import { die, now, list, reEsc, shortTitle, words } from "./text.ts";
import type { Decision, Question, State, Unit } from "./types.ts";

export const MAX_TITLE = 60, MAX_NOTE = 280;

// "Title (id)" for anything with a title.
export const name = (x: { title: string; id: string } | null | undefined) => (x ? `${x.title} (${x.id})` : "(missing)");

// What a reference names. Agents write decisions and questions by their slug ({d:<slug>}) as
// often as by their ID ({d:d/<slug>}), so both find it.
const REF = /\{(unit|q|d|group):([^}\s]+)\}/g;
const refTo = (T: State, kind: string, id: string) => kind === "unit" ? T.byId.get(id) : kind === "q" ? T.questions.find((q) => q.id === id || q.id === "q/" + id) : kind === "d" ? findD(T, id) : T.groupById.get(id);
export function expand(T: State, s: unknown) {
  return String(s ?? "").replace(REF, (m, kind: string, id: string) => {
    const x = refTo(T, kind, id);
    return x ? name(x) : m;
  });
}
// The {q:…} and {d:…} references in some text that name no question or decision.
export const missingRefs = (T: State, s: string | undefined | null) => [...String(s ?? "").matchAll(REF)].filter(([, kind, id]) => (kind === "q" || kind === "d") && !refTo(T, kind, id)).map(([m]) => m);

// Bare unit IDs in text the owner may read.
// {unit:<id>} references and `code` are fine.
export function bareIds(T: State, s: string | undefined | null): string[] {
  if (!s) return [];
  const plain = String(s).replace(/\{(unit|q|d|group):[^}]+\}/g, "").replace(/`[^`]*`/g, "");
  const hits: string[] = [];
  for (const id of T.byId.keys()) if (id.includes("/") && plain.includes(id) && new RegExp(`(?<![\\w/.-])${reEsc(id)}(?![\\w/-]|\\.\\w)`).test(plain)) hits.push(id);
  return hits;
}
// Bare IDs written as {unit:<id>}, outside `code` and existing references. An ID followed by
// an extension (milo/jab.json) is a path, not the unit.
const writeIds = (T: State, s: string, hits = bareIds(T, s)) => s.split(/(`[^`]*`|\{(?:unit|q|d|group):[^}]+\})/).map((part, i) => {
  if (i % 2) return part;
  for (const id of hits) part = part.replace(new RegExp(`(?<![\\w/.{:-])${reEsc(id)}(?![\\w/}-]|\\.\\w)`, "g"), `{unit:${id}}`);
  return part;
}).join("");
// Refuse text with a bare ID, showing it fixed. The reason goes last, after the fixed text:
// callers often see only the last lines (`| tail -2`).
export function checkText<V>(T: State, what: string, s: V): V {
  if (typeof s !== "string") return s;
  const hits = bareIds(T, s);
  if (!hits.length) return s;
  return die(`  ${writeIds(T, s, hits)}\n${what} names ${hits.join(", ")} by a bare ID, which the owner would see as code; nothing was recorded. Write {unit:<id>} so it shows as a title, as above.`);
}
// Evidence and notes: bare IDs are written as {unit:<id>} for the writer, who is told.
// Refusing them cost lanes turns of resending long text, and the owner sees a title either way.
export function fixIds(T: State, what: string, s: string) {
  const hits = bareIds(T, s);
  if (!hits.length) return s;
  console.error(`${what}: wrote ${[...new Set(hits.map((id) => `${id} as {unit:${id}}`))].join(", ")}, so the owner sees ${hits.length > 1 ? "titles" : "its title"} (write {unit:<id>} yourself next time)`);
  return writeIds(T, s, hits);
}
// Evidence says what shows the unit is done: a test that passed, a file, a log or screenshot
// path. Text shorter than this, or a run of one character, is a placeholder ("x", "test",
// "ok"), and an agent that sends one to see what `done` says records the unit done with it.
// FACTORY_EVIDENCE_MIN changes the floor (the test suites set 0, to do units with a word).
export const MIN_EVIDENCE = 30;
export function checkEvidence(T: State, verb: string, s: string) {
  const set = Number(ctx.env.FACTORY_EVIDENCE_MIN), min = ctx.env.FACTORY_EVIDENCE_MIN && Number.isFinite(set) ? set : MIN_EVIDENCE;
  const t = s.trim().replace(/\s+/g, " ");
  const distinct = new Set(t.toLowerCase().match(/[\p{L}\p{N}]/gu) || []).size;
  if (min > 0 && (t.length < min || distinct < 5)) die(`${verb} needs evidence: "${t.length > 40 ? t.slice(0, 40) + "…" : t}" is ${t.length < min ? `${t.length} character${t.length === 1 ? "" : "s"}, under ${min}` : "a placeholder"}, and nothing was recorded. Say what shows it's done (a test that passed, a file, a log or screenshot path); \`--dry-run\` checks it without recording.`);
  predates(verb, t);
  return fixIds(T, "--evidence", s);
}
// Evidence that says a failure was there before the work ("pre-existing", "already failing")
// without the commit it was compared at: the easiest way for a session to close its own work,
// and unproven (18 Oct: "none of the 150 failing rows came from this sprint", and nobody had
// checked). A warning, not a refusal: the claim may be true, but it needs the rerun.
const PREDATES = /\bpre-?(?:dates?|dating|existing|existed)\b|\balready (?:broken|failing|failed|fails|red)\b|\b(?:was|were) (?:already )?(?:broken|failing) before\b|\bfail(?:s|ed|ing)? on main\b|\bnot (?:caused by|from|introduced by) (?:this|my|the) (?:change|work|unit|sprint|branch)\b|\bunrelated to (?:this|my|the) (?:change|work|unit|sprint|branch)\b/i;
const COMMIT = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b|\bHEAD[~^]/i;
function predates(verb: string, t: string) {
  const m = PREDATES.exec(t);
  if (m && !COMMIT.test(t)) console.error(`warning: the ${verb} evidence says "${m[0]}" but names no commit it was compared at. Rerun the check at the commit before the change and give that commit and both results. Without that rerun the claim is unconfirmed: say so instead, and keep the unit open.`);
}
export function checkTitle(T: State, t: string, flag = "--title") {
  if (t.length > MAX_TITLE) die(`  ${flag} "${shortTitle(t)}" --detail "${t.replace(/"/g, '\\"')}"\ntitles are at most ${MAX_TITLE} characters, and this one is ${t.length}; nothing was recorded. Say what the unit is, and put the rest in --detail, as above.`);
  return checkText(T, "the title", t);
}
// Machine-written text (a step's output) may name units by bare ID: write them as {unit:…}.
export const autoIds = (T: State, s: string) => writeIds(T, s);

export function resolve(T: State, ref: string | undefined, opts?: { soft?: false }): Unit;
export function resolve(T: State, ref: string | undefined, opts: { soft: true }): Unit | null;
export function resolve(T: State, ref: string | undefined, { soft = false } = {}): Unit | null {
  if (!ref) die("which unit? (give its ID)");
  const u = T.byId.get(ref!);
  if (u) return u;
  if (soft) return null;
  // A guessed ID (mira/baseline) is searched for by the words after its group, as `find` would:
  // the group's own word would match every unit in it.
  const close = [...new Set([...T.byId.values()].filter((x) => x.id.includes(ref!)).concat(rankUnits(T, ref!.replace(/^[^/]*\//, "").replace(/[/.-]/g, " ")).filter(([, s]) => s >= 0.5).map(([x]) => x)))].slice(0, 5);
  return die(`no unit "${ref}".${close.length ? " Did you mean: " + close.map((x) => name(x)).join("; ") + "?" : ""} \`just find <words>\` searches the units' titles and details.`);
}
// Units ranked by how well they match some words, best first (ties in tracker order), for
// `find` and add-unit's look for one like it. A unit's words are its ID's, title's and
// detail's; title and ID count twice, so a unit named for the words beats one that only
// mentions them. The score is the share of the query's words found, 0 to 1. Word endings are
// cut roughly, so crashes, crash, crashing and crashed match, and frames and frame.
const stem = (w: string) => {
  if (w.length > 5) w = w.replace(/(?:ing|ed)$/, "");
  w = w.length > 4 && /(?:[sxz]|ch|sh)es$/.test(w) ? w.slice(0, -2) : w.length > 3 && /[^s]s$/.test(w) ? w.slice(0, -1) : w;
  return w.length > 3 ? w.replace(/e$/, "") : w;
};
export const stems = (s: string) => new Set([...words(s)].map(stem));
export function rankUnits(T: State, q: string, units: Unit[] = [...T.byId.values()]): [Unit, number][] {
  const Q = stems(q);
  if (!Q.size) return [];
  const share = (s: string) => { const W = stems(s); let n = 0; for (const w of Q) if (W.has(w)) n++; return n / Q.size; };
  return units.map((u) => { const named = share(`${u.id.replace(/[/.-]/g, " ")} ${u.title}`); return [u, (named + share(`${u.id.replace(/[/.-]/g, " ")} ${u.title} ${expand(T, u.detail)}`)) / 2] as [Unit, number]; })
    .filter(([, s]) => s > 0).sort((x, y) => y[1] - x[1]);
}
export const isOpen = (q: Question) => !q.answer && !q.withdrawn;
export const findQ = (T: State, ref: string): Question => T.questions.find((q) => q.id === ref || q.id === "q/" + ref) || die(`no question "${ref}" (tracker questions --all lists them)`);
export const findD = (T: State, ref: string): Decision | undefined => T.decisions.find((d) => d.id === ref || d.id === "d/" + ref);
export const groupTitle = (T: State, gid: string) => T.groupById.get(gid)?.title || gid;

// ---------------------------------------------------------------- selectors
//
// Selectors (--blocks, --scope): a unit ID, a glob (`*/tokens`), group:<g>, tag:<t>,
// template:<t>, or * for everything.

const globRe = (g: string) => new RegExp("^" + g.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
export function matches(T: State, sel: string, u: Unit) {
  if (sel === "*") return true;
  const [k, v] = sel.includes(":") ? [sel.slice(0, sel.indexOf(":")), sel.slice(sel.indexOf(":") + 1)] : ["", sel];
  if (k === "tag") return (u.tags || []).includes(v);
  if (k === "group") return T.groupOf.get(u.id)?.id === v;
  if (k === "template") return u.template === v;
  if (sel.includes("*")) return globRe(sel).test(u.id);
  return u.id === sel;
}
export const selected = (T: State, sels: unknown) => [...T.byId.values()].filter((u) => list(sels).some((s) => matches(T, s, u)));

// A note's length as the owner reads it: {unit:<id>} counts as the ID.
export const noteLength = (s: string) => s.replace(/\{unit:([^}\s]+)\}/g, "$1").length;
// A note for the next attempt on a unit, checked: bare IDs written as {unit:<id>}, the length
// refused on the last line, with how far over it is.
// A note's own date and author, which the card prints before it ("2026-10-23 6e0a534b: …"): copied
// from the notes an agent read, they'd print twice and cost ~20 of its characters. So is the
// session's own tag alone ("6e0a534b: …"). A date or a hash that's the note's content stays.
const escRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const stripNotePrefix = (text: string) => text
  .replace(/^\s*\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?Z?)?\s+[A-Za-z0-9_.-]+\s*:\s*/, "")
  .replace(new RegExp(`^\\s*${escRe(ctx.TAG)}\\s*:\\s*`), "");
export function checkNote(T: State, text: string) {
  text = stripNotePrefix(text);
  const n = noteLength(text);
  if (n > MAX_NOTE) die(`Keep what the next attempt must know; reasoning goes in \`just decide\`, history in the commit message.\nnotes are at most ${MAX_NOTE} characters, and this one is ${n} (${n - MAX_NOTE} over); nothing was recorded.`);
  return fixIds(T, "the note", text);
}
// Add a checked note: the newest first, three kept.
export function addNote(T: State, u: Unit, text: string) {
  u.notes = [{ at: now(), by: ctx.TAG, text }, ...(u.notes || [])].slice(0, 3);
}
