// Overseers attach: the newest one wins (the record on main), the one it replaced is told at its
// next wait, and a new one catches up from the journal (the lanes' events and the last overseer's
// notes). Run: node --test test/loop/fleet/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { has, lastLine, HOST } from "../../lib/index.ts";
import { fleetFactory } from "./helpers.ts";

const f = fleetFactory("fattach");
const { fleet, tr, ev } = f;
const out = (args: string[], add: NodeJS.ProcessEnv = {}) => fleet(args, add).stdout;

describe("overseers attach: the newest one wins, and catches up from the journal", () => {
  let o = "";
  test("fleet attach: this thread oversees the factory", () => { o = out(["attach", "--as", "ovA"]); has(o, `overseer: ovA on ${HOST}`); });
  test("  saying how it waits", () => { has(o, "just fleet wait --as ovA"); });
  test("  recorded on main", () => { has(tr(["overseer"]), `ovA on ${HOST}`); });
  test("  a second one replaces it", () => { has(out(["attach", "--as", "ovB"]), `replacing ovA on ${HOST}`); });
  let r = { code: 0, stdout: "" };
  test("  the first one's next wait exits 0", () => {
    r = fleet(["wait", "--as", "ovA", "--minutes", "0.3"], { FACTORY_WAIT_EVERY: "1" });
    assert.equal(r.code, 0);
  });
  // Last, so the end of a finished background command's output says it (2026-10-18:
  // the overseer ran \`head\` on the output file at every wake to read the reason).
  test("    saying last that it was replaced", () => { has(lastLine(r.stdout), `woke: replaced by another overseer: ovB on ${HOST}`); });
  test("    and to stop", () => { has(r.stdout, "stop here, and don't wait again"); });
  test("  as does its next check", () => {
    const c = fleet(["wait", "--check", "--as", "ovA"]);
    assert.equal(c.code, 0);
    has(lastLine(c.stdout), `woke: replaced by another overseer: ovB on ${HOST}`);
  });
  test("  saying how a timer's wake checks", () => { has(o, "just fleet wait --check --as ovA"); });
  test("  the newest one waits as usual", () => { has(out(["wait", "--as", "ovB", "--minutes", "0.05"], { FACTORY_WAIT_EVERY: "1" }), "woke: time"); });
  test("a new overseer catches up from the journal", () => {
    fleet(["note", "--as", "ovB", "told the owner the editor needs a sign-in"]);
    ev("stuck", "Gap unit (g/gap): stuck: a sign-in");
    o = out(["attach", "--as", "ovC"]);
    has(o, "stuck · Gap unit (g/gap): stuck: a sign-in");
  });
  test("  with the last one's notes", () => { has(o, "overseer ovB: told the owner the editor needs a sign-in"); });
  test("  since that one's last note", () => { has(o, "(the last overseer's last note)"); });
  test("  and a heartbeat", () => { has(o, "busy, 0 waiting"); });
});
