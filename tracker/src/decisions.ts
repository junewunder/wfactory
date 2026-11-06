// A decision's life after it's recorded: in force, lapsed (its --until has passed), replaced
// (a later decision names it in --replaces) or retired by pruning (superseded, held by the code,
// merged into another). Only one in force reaches a card; `decisions --all` lists them all.
// And the pruning pass: what it proposes to lapse, retire or narrow (`prune --propose`).
import { die, overlap, words } from "./text.ts";
import { expand, matches, name, stems } from "./names.ts";
import { derive, SETTLED } from "./status.ts";
import { readLog } from "./store.ts";
import { ended, inForce, type Ended } from "./in-force.ts";
import type { Decision, LogEntry, State, Unit } from "./types.ts";

export { ended, inForce, type Ended } from "./in-force.ts";
const nowMs = () => Date.now();

// A moment for people: the local date, and the time unless it's midnight.
export function when(iso: string) {
  const t = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  const day = `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
  return t.getHours() || t.getMinutes() ? `${day} ${p(t.getHours())}:${p(t.getMinutes())}` : day;
}
// What `decisions --all` and a decision's own text say about one no longer in force: the one
// that took its place by title, its ID after.
export function endedText(T: State, e: Ended) {
  const other = (id: string) => { const x = T.decisions.find((y) => y.id === id); return x ? name(x) : id; };
  if (e.kind === "replaced") return `replaced by ${other(e.by)}`;
  if (e.kind === "lapsed") return `lapsed ${when(e.at)}`;
  if (e.kind === "superseded") return `superseded by ${other(e.by)}`;
  if (e.kind === "merged") return `merged into ${other(e.by)}`;
  return `retired: the code holds it (${e.where})`;
}

// A decision as JSON, for a project's checks: who made it (and through which question or
// thread), and whether it still stands. An oracle's exception that cites the owner's departure
// from the reference reads this, and fails once the decision is replaced, retired or lapsed.
export function decisionJson(T: State, d: Decision) {
  const e = ended(T, d);
  return { id: d.id, title: expand(T, d.title), why: d.why ? expand(T, d.why) : "", by: d.by, at: d.at,
    question: d.question ?? null, via: d.via ?? null, scope: d.scope || [], in_force: !e, ended: e ? { ...e, text: endedText(T, e) } : null };
}

// --for-run: the run's stop time. A loop session has it (FACTORY_DEADLINE, epoch seconds); outside
// one, the tracker can't tell which run is meant or when it ends.
export function runEnd(env: NodeJS.ProcessEnv): string {
  const s = Number(env.FACTORY_DEADLINE);
  if (!env.FACTORY_DEADLINE || !Number.isFinite(s) || s <= 0) return die("--for-run needs the run's stop time, which only a lane's session knows (FACTORY_DEADLINE); outside one, give it as --until <the stop time `just fleet` shows>, e.g. --until 07:00");
  return iso(new Date(s * 1000));
}

// The units a decision's park holds now (decide --park), so a change to the decisions can say
// which it frees: those of `before` no longer parked.
export const decisionParks = (T: State) => [...T.byId.values()].filter((u) => u.record?.state === "parked" && u.record.decision && derive(T, u).s === "parked");
export function freedText(T: State, before: Unit[]) {
  T._memo = null;
  const us = before.filter((u) => derive(T, u).s !== "parked");
  return us.length ? `Released ${us.length === 1 ? "1 parked unit" : `${us.length} parked units`}: ${us.slice(0, 6).map((u) => name(u)).join(", ")}${us.length > 6 ? ` and ${us.length - 6} more` : ""}` : "";
}

const iso = (t: Date) => t.toISOString().replace(/\.\d+Z$/, "Z");
// --until: a date (it lapses at the end of that day, local time), a date and time, or a time
// (the next time the clock reads it).
// A date and time may end in Z or an offset; without one, it's local.
export function parseUntil(s: string, from = new Date()): string {
  const bad = (): never => die(`--until needs a date (2026-10-29: the end of that day), a date and time (2026-10-29T18:00) or a time (18:00: the next time the clock reads it); got "${s}"`);
  const day = (y: string, mo: string, d: string) => { const t = new Date(+y, +mo - 1, +d); return t.getFullYear() === +y && t.getMonth() === +mo - 1 && t.getDate() === +d ? t : bad(); };
  const clock = (h: string, mi: string) => +h < 24 && +mi < 60 ? [+h, +mi] : bad();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) { const t = day(m[1], m[2], m[3]); t.setDate(t.getDate() + 1); return iso(t); }
  m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (m) { const [h, mi] = clock(m[1], m[2]); const t = new Date(from); t.setHours(h, mi, 0, 0); if (t <= from) t.setDate(t.getDate() + 1); return iso(t); }
  m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:?\d{2})?$/.exec(s);
  if (!m) return bad();
  day(m[1], m[2], m[3]); clock(m[4], m[5]);
  const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4].padStart(2, "0")}:${m[5]}:${m[6] || "00"}${m[7] || ""}`);
  return Number.isNaN(t) ? bad() : iso(new Date(t));
}

// ---------------------------------------------------------------- the pruning pass

export type Kind = "lapse" | "superseded" | "narrow" | "code" | "merge";
export interface Proposal {
  d: string;
  title: string;
  by: string;
  at: string;
  kind: Kind;
  // In plain words: why the pass proposes it.
  why: string;
  // lapse: when it lapsed; superseded and merge: the decision that stays; narrow: the scope.
  until?: string;
  other?: string;
  scope?: string[];
  // A lane's own decision that only lapsed, which the overseer may apply without asking. Only a
  // lane's (its log line's actor is "loop"): the overseer and interactive sessions record the
  // owner's words under their own tags ("Last call on the laptop at 17:55"), and those are the owner's
  // to let go.
  unasked: boolean;
  // The command that applies it.
  apply: string;
}

// Words that say a decision was for a day, a night or a run, in its title (the why tells the
// story, and "today" there is often just when it was written). Words in quotes are about the
// words ("'today' instructions expire…"), not a time. A clock time alone isn't one ("Lanes stop
// at 22:00" holds every night); a last call is that run's. Each says when it ends: a day's at
// midnight; a night's or a run's at noon the next day, or the same day if said in the small hours
// (00:15 "tonight" is the night already under way).
const LAPSE: [RegExp, "day" | "night"][] = [
  [/\btoday(?:'s)?\b|\bthis (?:morning|afternoon)\b/i, "day"],
  [/\btonight(?:'s)?\b|\bthis (?:evening|night|run)\b|\bfor the night\b|\blast call\b/i, "night"],
];
// A single quote closes where no letter follows it, so "'don't upload today'" is one quote.
const unquoted = (s: string) => s.replace(/["“][^"”]*["”]/g, " ").replace(/(?<![\p{L}\p{N}])['‘](?:[^'’]|['’](?=\p{L}))*['’](?![\p{L}\p{N}])/gu, " ");
export const SMALL_HOURS = 6;
export function lapseOf(d: Decision): { words: string; until: string } | null {
  const t = unquoted(d.title);
  for (const [re, span] of LAPSE) {
    const m = re.exec(t);
    if (!m) continue;
    const at = new Date(d.at), end = new Date(at);
    if (span === "day") end.setHours(24, 0, 0, 0);
    else { end.setHours(12, 0, 0, 0); if (at.getHours() >= SMALL_HOURS) end.setDate(end.getDate() + 1); }
    return { words: m[0], until: iso(end) };
  }
  return null;
}

// Two decisions bear on the same units when a selector of one is the other's, or either is '*'.
const sharesScope = (a: Decision, b: Decision) => (a.scope || []).some((s) => s === "*" || (b.scope || []).includes(s)) || (b.scope || []).includes("*");
const sameScope = (a: Decision, b: Decision) => [...(a.scope || [])].sort().join(",") === [...(b.scope || [])].sort().join(",");
// Titles alike both ways: the share of the shorter's words in the longer, and of the longer's in
// the shorter.
const alike = (a: string, b: string) => { const A = words(a), B = words(b); if (!A.size || !B.size) return [0, 0]; let n = 0; for (const w of A) if (B.has(w)) n++; return [n / Math.min(A.size, B.size), n / Math.max(A.size, B.size)]; };
export const SUPERSEDE_AT = 0.6, MERGE_AT = 0.8;
// Words in the later one's title that say it changes the call ("Lanes now stop at 23:00"). Only
// its title: its why tells the story, and "now" is everywhere there.
const CHANGE = /\b(?:instead|no longer|now|back to|any ?more|revers\w*|overrid\w*|withdraw\w*|replac\w*|rather than)\b/i;
// A later one that names the earlier ({d:…}, or its ID) builds on it ("the same rules as …").
const cites = (b: Decision, a: Decision) => { const s = `${b.title} ${b.why}`, slug = a.id.replace(/^d\//, ""); return s.includes(a.id) || s.includes(`{d:${slug}}`); };

// The groups a decision scoped '*' names, in a {group:…} or {unit:…} reference or by title (every
// word of it, less any parenthesis; not by ID, which is often a common word: "mods", "aside").
// None if it names none, or more than NARROW_MAX: then it's about the project, not a few groups.
export const NARROW_MAX = 4;
function namedGroups(T: State, d: Decision): string[] {
  const refs = [...d.title.matchAll(/\{(unit|group):([^}\s]+)\}/g)].map(([, k, id]) => k === "group" ? id : T.groupOf.get(id)?.id).filter((x): x is string => !!x);
  const D = stems(d.title.replace(/\{[^}]*\}/g, " "));
  const tg = (g: { title: string }) => stems(g.title.replace(/\([^)]*\)/g, " "));
  const hit = T.groups.filter((g) => { const G = tg(g); return G.size > 0 && [...G].every((w) => D.has(w)); });
  // A title inside another's ("Link" in "Young Link") counts only if its words come up more
  // often than the longer titles account for ("Mario, Dr. Mario" names both).
  const count = (w: string) => [...d.title.toLowerCase().matchAll(/[a-z0-9]{3,}/g)].filter(([x]) => stems(x).has(w)).length;
  const named = hit.filter((g) => { const G = [...tg(g)], longer = hit.filter((h) => h !== g && G.every((w) => tg(h).has(w)) && tg(h).size > G.length); return !longer.length || G.some((w) => count(w) > longer.length); }).map((g) => g.id);
  const all = [...new Set([...refs, ...named])];
  return all.length <= NARROW_MAX ? all : [];
}

const cmdQuote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
export function proposals(T: State, logs: LogEntry[] = readLog() || []): Proposal[] {
  const lanes = new Set(logs.filter((l) => l.cmd === "decide" && l.actor === "loop" && typeof l.d === "string").map((l) => l.d as string));
  const live = T.decisions.filter((d) => inForce(T, d));
  const out: Proposal[] = [];
  const has = new Set<string>();
  // One the owner kept is not proposed again for the same reason (prune --keep).
  const add = (d: Decision, p: Omit<Proposal, "d" | "title" | "by" | "at" | "unasked"> & { unasked?: boolean }) => {
    if (has.has(d.id) || (d.kept || []).some((k) => k.kind === p.kind)) return;
    has.add(d.id);
    out.push({ d: d.id, title: d.title, by: d.by, at: d.at, unasked: false, ...p });
  };
  // Lapsed first: they cost nothing to take off and are the easiest calls.
  for (const d of live) {
    const l = lapseOf(d);
    if (!l || Date.parse(l.until) > nowMs()) continue;
    add(d, { kind: "lapse", until: l.until, why: `it says "${l.words}", said on ${when(d.at).slice(0, 10)}; that ended ${when(l.until)}`, unasked: d.by !== "owner" && lanes.has(d.id), apply: `just tracker prune --apply ${d.id} --lapse` });
  }
  // A later decision on the same units, worded alike, repeats it (merge) or replaces it.
  const order = live.map((d, i) => [d, i] as const).sort(([a, i], [b, j]) => a.at.localeCompare(b.at) || i - j).map(([d]) => d);
  for (let i = 0; i < order.length; i++) for (let j = i + 1; j < order.length; j++) {
    const a = order[i], b = order[j];
    if (has.has(a.id) || has.has(b.id) || !sharesScope(a, b)) continue;
    // One whose words say it changes the call is never a repeat, however alike ("Lanes now stop
    // at 23:00" after "at 22:00": the numbers aren't words).
    const [lo, hi] = alike(a.title, b.title), changes = CHANGE.test(b.title) && !cites(b, a);
    if (lo >= MERGE_AT && hi >= MERGE_AT && sameScope(a, b) && !changes && a.title.replace(/\D/g, "") === b.title.replace(/\D/g, "")) add(b, { kind: "merge", other: a.id, why: `it repeats ${name(a)}, from ${when(a.at).slice(0, 10)}, on the same units`, apply: `just tracker prune --apply ${b.id} --merge-into ${a.id}` });
    else if (lo >= SUPERSEDE_AT && hi >= SUPERSEDE_AT - 0.1 && changes && overlap(a.why, b.why) >= 0.3) add(a, { kind: "superseded", other: b.id, why: `${name(b)}, from ${when(b.at).slice(0, 10)}, is a later call on the same thing`, apply: `just tracker prune --apply ${a.id} --superseded-by ${b.id}` });
  }
  // Scoped to every unit, but about one group's.
  for (const d of live) {
    if (has.has(d.id) || !(d.scope || []).includes("*")) continue;
    const gs = namedGroups(T, d);
    if (!gs.length) continue;
    const scope = [...(d.scope || []).filter((s) => s !== "*"), ...gs.map((g) => `group:${g}`)];
    const open = [...T.byId.values()].filter((u) => u.kind !== "gate" && !SETTLED.has(derive(T, u).s)), then = open.filter((u) => scope.some((s) => matches(T, s, u))).length;
    const about = gs.map((g) => T.groupById.get(g)!.title);
    add(d, { kind: "narrow", scope, why: `it's on every unit's card, and it's about ${about.length > 1 ? about.slice(0, -1).join(", ") + " and " + about.at(-1) : about[0]}: on ${then === 1 ? "1 open unit's card" : `${then} open units' cards`} instead of ${open.length}`, apply: `just tracker prune --apply ${d.id} --narrow ${cmdQuote(scope.join(","))}` });
  }
  return out;
}

// The most decisions in force on any open unit's card (cards.ts applicableDecisions, counted
// here to keep the import one way).
export function mostOnACard(T: State) {
  const live = T.decisions.filter((d) => inForce(T, d) && (d.scope || []).length);
  let most = 0;
  for (const u of T.byId.values()) {
    if (u.kind === "gate" || SETTLED.has(derive(T, u).s)) continue;
    const n = live.filter((d) => d.scope!.some((s) => matches(T, s, u))).length;
    if (n > most) most = n;
  }
  return most;
}

export const CHECKIN_DAYS = 3, PRUNE_AT = 40;
