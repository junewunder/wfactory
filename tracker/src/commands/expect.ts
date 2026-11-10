// The scorecard's ledger of predictions (runtime/src/scorecard.ts): that a change moves one of its
// figures past a value by a date. `just scorecard expect` checks the figure's name and calls
// expect; the scorecard judges each open one once its date has passed (held or missed) and
// shows it until expect-settle closes it with a note.
import { load, log, mutate } from "../store.ts";
import { ctx } from "../ctx.ts";
import { die, now, parseArgs, str, today } from "../text.ts";
import { C } from "./registry.ts";
import type { Prediction } from "../types.ts";

const OPS = ["<=", ">=", "<", ">", "="] as const;
// "< 0.10" as an op and a number; null if it isn't one.
export function parseTest(s: string): { op: Prediction["op"]; value: number } | null {
  const m = /^\s*(<=|>=|<|>|=)\s*(-?[0-9]+(?:\.[0-9]+)?)\s*$/.exec(s);
  return m ? { op: m[1] as Prediction["op"], value: Number(m[2]) } : null;
}
const realDate = (s: string) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s); if (!m) return false; const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])); return d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]); };

// expect <name> --test "<op> <value>" --by YYYY-MM-DD --why "…": a new prediction; prints its id.
C.expect = (a) => {
  const o = parseArgs(a), name = o._[0] ?? "", test = str(o.test) ?? "", by = str(o.by) ?? "", why = (str(o.why) ?? "").replace(/\s+/g, " ").trim();
  if (!name || !test || !by || !why) die('expect <name> --test "<op> <value>" --by YYYY-MM-DD --why "…"');
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) die(`expect: "${name}" isn't a figure's name (\`just scorecard --names\` lists them)`);
  const t = parseTest(test) ?? die(`expect: --test "${test}" isn't an op and a number (${OPS.join(" ")}), as "< 0.10"`);
  if (!realDate(by)) die(`expect: --by ${by} isn't a date (YYYY-MM-DD)`);
  if (by < today()) die(`expect: --by ${by} is in the past (today is ${today()})`);
  return mutate((T) => {
    const n = T.predictions.reduce((m, p) => Math.max(m, Number(/^p(\d+)$/.exec(p.id)?.[1] ?? 0)), 0) + 1;
    const p: Prediction = { id: `p${n}`, name, op: t.op, value: t.value, by, why, at: now(), who: ctx.TAG };
    T.predictions.push(p);
    T.dirty.add("predictions");
    log(T, "expect", null, `expected ${name} ${t.op} ${t.value} by ${by}: ${why}`, { more: { p: p.id } });
    console.log(`${p.id}: ${name} ${t.op} ${t.value} by ${by}`);
    return 0;
  });
};

// expect-settle <id> --note "…": a prediction closed, once its result has been read.
C["expect-settle"] = (a) => {
  const o = parseArgs(a), id = o._[0], note = (str(o.note) ?? "").replace(/\s+/g, " ").trim();
  if (!id || !note) die('expect-settle <id> --note "…"');
  if (!load().predictions.some((p) => p.id === id)) die(`expect-settle: no prediction ${id} (\`just scorecard\` lists the open ones)`);
  return mutate((T) => {
    const p = T.predictions.find((x) => x.id === id)!;
    if (p.settled) { console.log(`${id}: settled already (${p.settled.note})`); return 0; }
    p.settled = { at: now(), note };
    T.dirty.add("predictions");
    log(T, "expect-settle", null, `settled ${id} (${p.name} ${p.op} ${p.value} by ${p.by}): ${note}`, { more: { p: id } });
    console.log(`${id}: settled`);
    return 0;
  });
};
