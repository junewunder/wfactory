// How long a unit's session usually takes, from the log: for `next --time-left`, which near the
// stop passes over a unit that won't fit in the time left (#141: a lane claimed an hour-long
// editor unit 22 times in its last 13 minutes, its session giving it back each time).
import { readLog } from "./store.ts";
import type { LogEntry, State, Unit } from "./types.ts";

// How many of the latest sessions an estimate goes by (their median).
const LATEST = 10;

// A log line of a session giving its unit back having done nothing itself (unclaim marks it; older
// lines say "given back unstarted", or kept only an earlier attempt's work).
export const gaveBackLine = (l: LogEntry) => l.cmd === "unclaim" && (l.unstarted === true || /: (given back unstarted|handed back by its session, its work kept \(an earlier attempt's\);.*)$/.test(l.text));

interface Session { id: string; from: number; to: number; unstarted: boolean; cut: boolean }
const memo = new WeakMap<State, Session[]>();

// The sessions the log shows, oldest first: from a claim to the last line its tag wrote about
// that unit (its record, a note, the loop's settle after it; not the landing, which waits on
// other things). One that gave its unit back unstarted did no work, so it isn't counted. Nor is one
// cut off (the loop's settle: it ended without recording its unit, at the stop or otherwise): how
// long it ran says only that the unit takes longer (a lane's merge cut off at the stop seven times
// in 18 minutes made a merge that runs the project's whole check look like a 2-minute job).
function sessions(T: State): Session[] {
  const m = memo.get(T);
  if (m) return m;
  const open = new Map<string, Session>(), all: Session[] = [];
  for (const l of readLog() ?? []) {
    if (!l.tag || !l.id) continue;
    const k = `${l.tag} ${l.id}`, t = Date.parse(l.at);
    if (l.cmd === "claim") { const s = { id: l.id, from: t, to: t, unstarted: false, cut: false }; open.set(k, s); all.push(s); continue; }
    const s = open.get(k);
    if (!s || ["merged", "lease", "release"].includes(l.cmd)) continue;
    s.to = t;
    if (gaveBackLine(l)) s.unstarted = true;
    if (l.cmd === "settle") s.cut = true;
  }
  const out = all.filter((s) => !s.unstarted && !s.cut && s.to > s.from);
  memo.set(T, out);
  return out;
}

const usesKey = (u: Unit) => [...new Set(u.uses || [])].sort().join(",");
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor((s.length - 1) / 2)]; };

// The usual length of u's session in seconds (the median of the latest few), from its own past
// sessions; else those of the units of its template; else those of the units using the same
// resources (an editor unit's, for one using the editor). A merge unit (a lane's "Merge main", group
// merge) goes by the other merge units' after its own, since each does the same job (merge main,
// run the project's check), and with none to go by needs the project's min_unit_minutes: it always
// runs that check. null: nothing to go by.
export function usualSecs(T: State, u: Unit): number | null {
  const ss = sessions(T);
  const merge = isMerge(T, u);
  const like = [
    (x: Unit) => x === u,
    (x: Unit) => !!u.template && x.template === u.template,
    (x: Unit) => merge && isMerge(T, x),
    (x: Unit) => !!usesKey(u) && usesKey(x) === usesKey(u),
  ];
  for (const f of like) {
    const xs = ss.filter((s) => { const x = T.byId.get(s.id); return !!x && f(x); }).slice(-LATEST);
    if (xs.length) return Math.round(median(xs.map((s) => (s.to - s.from) / 1000)));
  }
  return merge ? minUnitSecs(T) : null;
}
const isMerge = (T: State, u: Unit) => T.groupOf.get(u.id)?.id === "merge";

// The least time u's session needs, in seconds, before last call takes what it uses: its own
// --min-minutes, else its usual session, else the project's min_unit_minutes (default 45).
export const MIN_UNIT_MINUTES = 45;
function minUnitSecs(T: State) {
  const m = T.project.min_unit_minutes;
  return (typeof m === "number" && m >= 0 ? m : MIN_UNIT_MINUTES) * 60;
}
export function leastSecs(T: State, u: Unit): number {
  if (u.minMinutes) return u.minMinutes * 60;
  return usualSecs(T, u) ?? minUnitSecs(T);
}
