// Last call before the stop time the overseer set (`just fleet stop-at`): the run ends with CI
// passed, before the stop time; and out of time with CI not passed, the stop says which groups.
// The loop runs in this process with its clock mocked (inproc.ts): the sessions end at 3, 6, 9,
// 12, 14 and 15 s, so last call is seen to begin at exactly half the run (15 s), not a second
// before. Run: node --test test/loop/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { has, hasnt } from "../lib/index.ts";
import { hold, letGo, nextHeld, nextSecond, hmAt, hmsAt, type Run } from "./inproc.ts";
import { loopFactory } from "./factory.ts";

const f = loopFactory("stopat");
const { a, setup, t, state, loop } = f;
const N = ["one", "two", "three", "four", "five", "six", "seven"];

// A stop in 30 s, with --last-call 1 (60 min): last call is at most half the run, so at 15 s.
// Sessions of 3 s, then the fifth ends at 14 s (not yet last call: a sixth starts) and the sixth
// at 15 s (last call: no seventh).
describe("last call before the stop time the overseer set: the run ends with CI passed, before the stop time", () => {
  let r: Run;
  const order: string[] = [];
  test("a stop time: last call comes before it", async () => {
    // (Seconds-long sessions: no least time before last call.)
    f.editMain("tracker/project.json", (p) => { p.min_unit_minutes = 0; });
    setup("add-group", "gn", "--title", "Group N", "--ci", "lc");
    for (const n of N) { setup("add-unit", `gn/${n}`, "--title", `N ${n}`); hold(a.locks, `gn/${n}`); }
    // The clock starts a minute ahead of real time: the sessions' units are recorded done in real
    // time, and under load five of them can take longer than the 15 s the clock moves before last
    // call; a unit done at a moment the loop hasn't reached would leave CI stale for good.
    const t0 = nextSecond() + 60;
    fs.mkdirSync(a.at("runs"), { recursive: true });
    fs.writeFileSync(a.at("runs/.stop-at"), `${t0 + 30}\n`);
    r = loop(["--hours", "1", "--last-call", "1"], {}, t0);
    const ends = [3, 6, 9, 12, 14, 15];
    for (let i = 0, s = 0; ; i++) {
      const k = await nextHeld(a.locks, r);
      if (k === null) break;
      order.push(k);
      await r.at(s = ends[i] ?? s + 3);
      letGo(a.locks, k);
    }
    await r.end();
    has(r.out(), `${hmsAt(t0, 15)} loop: last call, stopping at ${hmAt(t0, 30)}`);
  });
  test("  not a second before (a unit still starts at 14 s)", () => {
    hasnt(r.out(), `${hmsAt(r.t0, 14)} loop: last call`);
    has(r.out(), `${hmsAt(r.t0, 14)} loop: iteration 6: N six`);
  });
  test("  and the lane stops once CI is done", () => { has(r.out(), "last call is over"); });
  test("  before the stop time", () => { hasnt(r.out(), "out of time"); });
  test("  the group's CI passed", () => { has(t("ci", "gn"), "passed (lc)"); });
  test("  with units left for the next run", () => { assert.equal(state("gn/seven"), "ready"); });
  test("  and units worked before it", () => {
    has(r.out(), "iteration 1: N one");
    assert.deepEqual(order, ["gn-one", "gn-two", "gn-three", "gn-four", "gn-five", "gn-six"]);
  });
});

describe("out of time with CI not passed: the stop says which groups, for the overseer", () => {
  test("out of time names the groups whose CI hasn't passed", async () => {
    fs.rmSync(a.at("runs/.stop-at"), { force: true });
    for (const n of N) if (state(`gn/${n}`) === "ready" && n !== "seven") setup("drop", `gn/${n}`, "--why", "test");
    letGo(a.locks, "gn-seven");
    setup("done", "gn/seven", "--evidence", "x");
    const out = (await loop(["--hours", "0"]).end()).out;
    has(out, "CI not passed: Group N (due)");
  });
});
