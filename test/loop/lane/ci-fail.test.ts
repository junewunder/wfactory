// A failing CI: the group broken with evidence, ci-fix filed for the lanes, other groups carry on,
// and the overseer told (now, when it holds back a publish). And a CI pass the tracker won't
// record: the run is given back, and the overseer hears. The loop is the real factory/loop.sh, in
// the file's lane. Run: node --test test/loop/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { has } from "../../lib/index.ts";
import { laneFactory } from "./helpers.ts";
import { refusingTracker } from "../factory.ts";

const f = laneFactory("lane-cifail");
const { w, setup, t, state, events } = f;
// broke: rows that pass, then its verdict (as a drill writes them).
// unmet: a step that finds a condition it needs unmet, and says so (exit 79).
f.steps({ unmet: { cmd: "echo looking; echo \"Group U's work here is another lane's\"; exit 79" }, broke: { cmd: "echo row one, which passes; echo row two, which passes; echo 3 files differ; exit 3", retries: 0 }, ship: { cmd: "echo published {group} v1", publish: true }, quick: { cmd: "echo quick" } });

describe("a failing CI: broken with evidence, ci-fix for the lanes, other groups carry on", () => {
  let out = "";
  test("a failing step leaves the group broken", () => {
    setup("publish", "off");
    setup("add-group", "ge", "--title", "Group E", "--ci", "broke");
    setup("add-unit", "ge/one", "--title", "E one"); setup("done", "ge/one", "--evidence", "x");
    setup("add-group", "gh", "--title", "Group H"); setup("add-unit", "gh/one", "--title", "H one");
    out = f.loopSh(["--hours", "0.05"]).stdout;
    // (By the end of the run it's known failing, below: its fix ran and didn't cure it.)
    has(t("ci", "ge"), "broke failed (exit 3, tried 1 time): 3 files differ");
  });
  // The step's verdict leads; the rows before it follow, marked, so nobody takes them for the cause.
  test("  its evidence leads with the step's verdict, the lines before it after, marked", () => {
    has(t("ci", "ge"), "broke failed (exit 3, tried 1 time): 3 files differ [the output's last lines before it: row one, which passes row two, which passes]");
  });
  test("  with the whole output in runs/", () => {
    has(JSON.parse(fs.readFileSync(path.join(t("dir"), "groups/ge.json"), "utf8")).ci.failed.evidence + t("show", "ge/ci-fix"), "runs/ci-");
  });
  test("  it files ci-fix, which a lane works", () => { has(out, "iteration 1: Fix Group E's CI (ge/ci-fix)"); });
  test("  then CI runs again at once and fails again: known failing, the fix stays done", () => {
    has(t("ci", "ge"), "known failing: broke still fails after Fix Group E's CI (ge/ci-fix)");
    assert.equal(state("ge/ci-fix"), "done");
  });
  test("  the overseer hears it once, now, with the reason", () => {
    const l = events().split("\n").filter((x) => x.includes("\tci-known-failing\t"));
    assert.equal(l.length, 1, events());
    has(l[0], "Group E (ge): Fix Group E's CI (ge/ci-fix) was done and CI failed again on broke: Group E's CI is known failing now (broke still fails after");
  });
  test("  and no stuck event", () => { assert.ok(!events().includes("\tstuck\t"), events()); });
  test("  the overseer hears of it, for the morning summary (nothing it publishes waits)", () => { has(events(), "ci-broken-noship\tGroup E (ge): CI is broken (nothing it publishes waits on it"); });
  test("  naming the units it waits on, with their state", () => { has(events(), "Its units not done: Fix Group E's CI (ge/ci-fix): ready"); });
  test("  other groups carry on", () => { assert.equal(state("gh/one"), "done"); });
  test("  out of time, the stop names it among the CI not passed", () => {
    has(f.loopSh(["--hours", "0"]).stdout, "CI not passed: Group E (known)");
  });
});

// (The events this run adds.)
describe("a broken CI that holds back a publish: tell the owner now", () => {
  let evs = "";
  test("a broken CI that holds back a publish: tell the owner now", () => {
    setup("publish", "on");
    setup("edit-group", "ge", "--ci", "broke,ship"); setup("drop", "ge/ci-fix", "--why", "test"); setup("ci-retry", "ge");
    const before = events().length;
    f.loopSh(["--hours", "0.05"]);
    evs = events().slice(before);
    has(evs, "CI is broken, so it isn't published");
  });
  test("  naming its units not done", () => { has(evs.split("\n").filter((l) => l.includes("Its units not done")).join("\n"), "Group E (ge): CI is broken, so it isn't published: broke failed"); });
  test("  failing again while known failing: for the summary, not a second wake", () => {
    setup("ci-retry", "ge");
    const before = events().length;
    f.loopSh(["--hours", "0.05"]);
    const more = events().slice(before);
    has(more, "ci-known-failing-again\tGroup E (ge): CI failed again, still known failing: broke failed");
    assert.ok(!/\tci-broken\t|\tci-known-failing\t/.test(more), more);
  });
  test("  the fix not curing it is a ci-known-failing event", () => { has(evs, "ci-known-failing\tGroup E (ge): Fix Group E's CI (ge/ci-fix) was done and CI failed again on broke"); });
});

describe("a CI pass the tracker won't record (tried four times): the run is given back, and the overseer hears", () => {
  let b: ReturnType<typeof f.loopBg>;
  test("a CI run the tracker won't record: a ci-unrecorded event", async () => {
    setup("publish", "off"); setup("edit-group", "ge", "--ci", "none");
    setup("add-group", "gv", "--title", "Group V", "--ci", "quick");
    setup("add-unit", "gv/one", "--title", "V one"); setup("done", "gv/one", "--evidence", "x");
    b = f.loopBg(["--hours", "0.05"], { FACTORY_TRACKER: refusingTracker(w.at("tracker-nopass.mjs"), "ci-pass"), FACTORY_RETRY_WAIT: "0" });
    await f.until(() => events().includes("\tci-unrecorded\t"), "a ci-unrecorded event");
    f.oversee(["pause"]);
    await b.until("paused at a good point", 30);
    await b.end();
  });
  test("  saying why, and that it runs again", () => { has(events(), "gv's CI ran but the tracker wouldn't record it (tracker: refused for this test); it's due again, and runs again"); });
  test("  the run is given back: due again", () => { has(t("ci"), "Group V (gv): due"); });
});

// A step that didn't run because something it needs isn't so (exit 79): given back, due again,
// nothing filed, and the loop says why in the step's own words.
describe("a step that exits 79 (not run, a condition unmet): given back, due again, no ci-fix", () => {
  let out = "";
  test("the run is given back, the lane works another unit", () => {
    setup("edit-group", "gv", "--ci", "none");
    setup("add-group", "gu", "--title", "Group U", "--ci", "unmet");
    setup("add-unit", "gu/one", "--title", "U one"); setup("done", "gu/one", "--evidence", "x");
    setup("add-group", "gw", "--title", "Group W"); setup("add-unit", "gw/one", "--title", "W one");
    out = f.loopSh(["--hours", "0.05", "--max", "1", "--no-wait"]).stdout;
    has(out, "iteration 1: W one");
  });
  test("  saying why in the step's last line", () => { has(out, "ci: Group U (gu): unmet didn't run, a condition it needs unmet: Group U's work here is another lane's; the run is given back, due again"); });
  test("  not as a memory-budget wait", () => { assert.ok(!out.includes("memory budget"), out); });
  test("  it's due again, not broken", () => { has(t("ci", "gu"), "Group U (gu): due"); });
  test("  and no ci-fix is filed", () => { assert.ok(!t("status", "gu").includes("gu/ci-fix")); });
});
