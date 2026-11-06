// The owner's "later": an answer whose option puts the work off (ask --parks <key>). The decision
// it records postpones (Decision.postpones), and while it's in force the units it's tied to aren't
// offered: they show as parked, even after something clears their record (a reopen, a refiling).
// Tied only by explicit links, never by words alike: the question was asked from the unit, or
// blocks it, or the decision's scope names it (not '*': a postponement of everything is a stop).
// An `unpark` of the unit after the decision is the owner bringing it back, and lifts it.
// Apart from status.ts, which asks it, so it imports nothing that imports status.ts.
import { inForce } from "./in-force.ts";
import { matches, selected } from "./names.ts";
import { readLog } from "./store.ts";
import type { Decision, State, Unit } from "./types.ts";

// Each unit's newest unpark, from the log and this command's own lines.
const memo = new WeakMap<State, { n: number; at: Map<string, string> }>();
function unparkedAt(T: State, id: string): string | undefined {
  let m = memo.get(T);
  if (!m || m.n !== T.logs.length) {
    const at = new Map<string, string>();
    for (const l of [...(readLog() ?? []), ...T.logs]) if (l.cmd === "unpark" && l.id && !(at.get(l.id)! >= l.at)) at.set(l.id, l.at);
    m = { n: T.logs.length, at }; memo.set(T, m);
  }
  return m.at.get(id);
}

// The decisions this one is tied to, by the links above, whether or not they postpone.
export function tiedTo(T: State, d: Decision, u: Unit) {
  const q = d.question ? T.questions.find((x) => x.id === d.question) : undefined;
  if (q && (q.asked?.unit === u.id || selected(T, q.blocks || []).includes(u))) return true;
  return (d.scope || []).some((s) => s !== "*" && matches(T, s, u));
}

// The postponement in force that holds u back, or null.
export function postponedBy(T: State, u: Unit): Decision | null {
  for (const d of T.decisions) {
    if (!d.postpones || !inForce(T, d) || !tiedTo(T, d, u)) continue;
    const back = unparkedAt(T, u.id);
    if (back && back >= d.at) continue;
    return d;
  }
  return null;
}
