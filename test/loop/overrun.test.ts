// Past the stop time: a session still running FACTORY_OVERRUN seconds (20 minutes) after the stop
// time is ended like pause asap, and the lane stops. The loop runs in this process with its
// clock mocked (inproc.ts): the moment is exact. Run: node --test test/loop/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { has, hasnt } from "../lib/index.ts";
import { hold, hmAt, hmsAt, type Run } from "./inproc.ts";
import { loopFactory } from "./factory.ts";

const f = loopFactory("overrun");
const { a, setup, state, loop, seen, onBranch } = f;

// --hours 0.01: the stop time is 36 s after the start; the session is ended at 36 s + 1200 s.
describe("past the stop time: a session still running is ended like pause asap, and the lane stops", () => {
  let r: Run, before = "", runningBefore = false;
  test("a session past the stop time is ended", async () => {
    setup("add-unit", "g/overrun", "--title", "Unit overrun");
    const h = hold(a.locks, "g/overrun");
    r = loop(["--hours", "0.01"]);
    await h.held();
    await r.at(36 + 1199);
    before = r.out(); runningBefore = h.holding();
    await r.at(36 + 1200);
    await r.end();
    has(r.out(), `${hmsAt(r.t0, 1236)} loop: past the stop time: ending the session`);
  });
  test("  not a second before FACTORY_OVERRUN (20 minutes) past it", () => {
    hasnt(before, "past the stop time");
    assert.ok(runningBefore, "the session had ended before");
  });
  test("  the session was told the stop time", () => { has(seen("card.seen"), `The lane stops at ${hmAt(r.t0, 36)}.`); });
  test("  the lane stops, saying so", () => {
    has(r.out(), `out of time: Unit overrun (g/overrun) was still running 20 min after the stop time (${hmAt(r.t0, 36)}), so it was ended; it shows as interrupted, its work pushed to its branch`);
  });
  test("  and the unit is interrupted for the next run", () => { assert.equal(state("g/overrun"), "interrupted"); });
  test("  its work so far is pushed as its branch", () => { assert.equal(onBranch("unit/g/overrun", "out/g-overrun.txt"), "work on g/overrun"); });
});
