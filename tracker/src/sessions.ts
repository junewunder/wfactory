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

interface Session { id: string; from: number; to: number; unstarted: boolean }
const memo = new WeakMap<State, Session[]>();

// The sessions the log shows, oldest first: from a claim to the last line its tag wrote about
// that unit (its record, a note, the loop's settle after it; not the landing, which waits on
// other things). One that gave its unit back unstarted did no work, so it isn't counted.
function sessions(T: State): Session[] {
  const m = memo.get(T);
  if (m) return m;
  const open = new Map<string, Session>(), all: Session[] = [];
  for (const l of readLog() ?? []) {
    if (!l.tag || !l.id) continue;
    const k = `${l.tag} ${l.id}`, t = Date.parse(l.at);
    if (l.cmd === "claim") { const s = { id: l.id, from: t, to: t, unstarted: false }; open.set(k, s); all.push(s); continue; }
    const s = open.get(k);
    if (!s || ["merged", "lease", "release"].includes(l.cmd)) continue;
    s.to = t;
    if (gaveBackLine(l)) s.unstarted = true;
  }
  const out = all.filter((s) => !s.unstarted && s.to > s.from);
  memo.set(T, out);
  return out;
}

const usesKey = (u: Unit) => [...new Set(u.uses || [])].sort().join(",");
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor((s.length - 1) / 2)]; };

// The usual length of u's session in seconds (the median of the latest few), from its own past
// sessions; else those of the units of its template; else those of the units using the same
// resources (an editor unit's, for one using the editor). null: nothing to go by.
export function usualSecs(T: State, u: Unit): number | null {
  const ss = sessions(T);
  const like = [
    (x: Unit) => x === u,
    (x: Unit) => !!u.template && x.template === u.template,
    (x: Unit) => !!usesKey(u) && usesKey(x) === usesKey(u),
  ];
  for (const f of like) {
    const xs = ss.filter((s) => { const x = T.byId.get(s.id); return !!x && f(x); }).slice(-LATEST);
    if (xs.length) return Math.round(median(xs.map((s) => (s.to - s.from) / 1000)));
  }
  return null;
}

// The least time u's session needs, in seconds, before last call takes what it uses: its own
// --min-minutes, else its usual session, else the project's min_unit_minutes (default 45).
export const MIN_UNIT_MINUTES = 45;
export function leastSecs(T: State, u: Unit): number {
  if (u.minMinutes) return u.minMinutes * 60;
  const usual = usualSecs(T, u);
  if (usual !== null) return usual;
  const m = T.project.min_unit_minutes;
  return (typeof m === "number" && m >= 0 ? m : MIN_UNIT_MINUTES) * 60;
}
