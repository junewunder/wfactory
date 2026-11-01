// A transient failure is retried; a step that ships tells the overseer: a first publish is news, a
// publish again a republish (for the morning summary), and a publish after a break news again,
// even when CI broke in the same second as the last pass. The loop is the real factory/loop.sh,
// in the file's lane. Run: node --test test/loop/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { has } from "../../lib/index.ts";
import { laneFactory } from "./helpers.ts";

const f = laneFactory("lane-retry");
const { w, setup, t, events } = f;
const n = w.at("flaky.n");
f.steps({
  // Fails the first time it runs (a network blip), passes after.
  flaky: { cmd: `n=$(cat ${n} 2>/dev/null || echo 0); echo $((n+1)) > ${n}; [ $n -ge 1 ] || { echo network blip; exit 4; }; echo ok` },
  ship: { cmd: "echo published {group} v1", publish: true },
});
const loop = () => f.loopSh(["--hours", "0.05"], { FACTORY_CI_RETRY_WAIT: "1" }).stdout;
const published = () => events().split("\n").filter((l) => l.includes("\tci-published\tGroup F")).length;

describe("a transient failure is retried; a step that ships tells the overseer", () => {
  let out = "";
  test("a step that fails once is tried again", () => {
    setup("add-group", "gf", "--title", "Group F", "--ci", "flaky,ship");
    setup("add-unit", "gf/one", "--title", "F one"); setup("done", "gf/one", "--evidence", "x");
    out = loop();
    has(out, "flaky failed (exit 4); trying again");
  });
  test("  and passes", () => { has(t("ci", "gf"), "passed (flaky, ship)"); });
  test("  a pass that published is news for the overseer", () => { has(events(), "ci-published\tGroup F (gf): CI passed and published"); });
  test("  publishing again is a republish, for the morning summary", () => {
    setup("reopen", "gf/one"); setup("done", "gf/one", "--evidence", "again");
    loop();
    has(events(), "ci-republished\tGroup F (gf): CI passed and published again");
  });
  test("  not a first publish", () => { assert.equal(published(), 1); });
  // Broken since its last publish: publishing again is news, not a republish.
  test("  a publish after a break wakes the overseer again", () => {
    setup("ci-fail", "gf", "--evidence", "broke by hand"); setup("ci-retry", "gf");
    loop();
    assert.equal(published(), 2);
  });
  // The times are to the second: a failure in the second of the last pass is still a break.
  test("  even when it broke in the same second as the last pass", () => {
    setup("ci-fail", "gf", "--evidence", "broke by hand again"); setup("ci-retry", "gf");
    // (The retry names the failure it's for: moved with it.)
    f.editMain("tracker/groups/gf.json", (g) => { g.ci.failed.at = g.ci.failed.retry = g.ci.passed.at; });
    loop();
    assert.equal(published(), 3);
  });
});
