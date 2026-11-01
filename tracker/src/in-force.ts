// Whether a decision is in force, or how it ended: replaced (a later decision names it in
// --replaces), retired by pruning, or lapsed (its --until has passed). Apart from decisions.ts so
// status.ts can ask it (a park a decision made holds while the decision does) without importing
// what imports status.ts.
import type { Decision, State } from "./types.ts";

export type Ended =
  | { kind: "replaced"; by: string }
  | { kind: "lapsed"; at: string }
  | { kind: "superseded"; by: string; at: string }
  | { kind: "merged"; by: string; at: string }
  | { kind: "code"; where: string; at: string };

const nowMs = () => Date.now();
export function ended(T: State, d: Decision): Ended | null {
  const r = T.decisions.find((x) => x.replaces === d.id);
  if (r) return { kind: "replaced", by: r.id };
  const x = d.retired;
  if (x) return x.kind === "code" ? { kind: "code", where: x.where || "", at: x.at } : x.kind === "merged" ? { kind: "merged", by: x.other || "", at: x.at } : { kind: "superseded", by: x.other || "", at: x.at };
  if (d.until && Date.parse(d.until) <= nowMs()) return { kind: "lapsed", at: d.until };
  return null;
}
export const inForce = (T: State, d: Decision) => !ended(T, d);
