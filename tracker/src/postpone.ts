// The owner's "later": an answer whose option puts the work off (ask --parks <key>). The decision
// it records postpones (Decision.postpones) and lists the units it parked (Decision.parked); while
// it's in force those units aren't offered: they show as parked, even after something clears their
// record (a reopen, a refiling). Only those, by ID: no selector is run again.
// An `unpark` of the unit after the decision is the owner bringing it back, and lifts it.
// Apart from status.ts, which asks it, so it imports nothing that imports status.ts.
import { inForce } from "./in-force.ts";
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

// Whether the postponement holds u: one of the units its answer parked, by ID (never selectors run
// again, which would take in units filed since, or every unit for '*').
export const tiedTo = (d: Decision, u: Unit) => (d.parked || []).includes(u.id);

// The postponement in force that holds u back, or null.
export function postponedBy(T: State, u: Unit): Decision | null {
  for (const d of T.decisions) {
    if (!d.postpones || !inForce(T, d) || !tiedTo(d, u)) continue;
    const back = unparkedAt(T, u.id);
    if (back && back >= d.at) continue;
    return d;
  }
  return null;
}
