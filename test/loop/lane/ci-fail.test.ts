// A failing CI: the group broken with evidence, ci-fix filed for the lanes, other groups carry on,
// and the overseer told (now, only when it holds back a publish and is the owner's to look at; a
// failure the lanes have the fix of is for the morning summary). A CI pass the tracker won't
// record: the run is given back, and the overseer hears. And a run that couldn't run to a verdict
// (a step out of time, killed, or not run): no failure, nothing filed. The loop is the real factory/loop.sh, in
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
// late: a step that ends as one out of time does (timeout's status, 124). shot: one killed by a signal.
// mine: a failing step that's the owner's to look at.
f.steps({ late: { cmd: "echo half way; exit 124" }, shot: { cmd: "echo building; kill -9 $$" }, mine: { cmd: "echo the upload was refused; exit 1", retries: 0, on_fail: "owner" }, unmet: { cmd: "echo looking; echo \"Group U's work here is another lane's\"; exit 79" }, broke: { cmd: "echo row one, which passes; echo row two, which passes; echo 3 files differ; exit 3", retries: 0 }, ship: { cmd: "echo published {group} v1", publish: true }, quick: { cmd: "echo quick" } });

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

// (The events this run adds.) Before: every failure that held back a publish woke the overseer to
// tell the owner now, the lanes' to fix or not (in one factory each group's CI ships, so that was
// every failure).
describe("a broken CI that holds back a publish, its fix the lanes': for the morning summary, not a wake", () => {
  let evs = "";
  test("a broken CI that holds back a publish, with a fix for the lanes", () => {
    setup("publish", "on");
    setup("edit-group", "ge", "--ci", "broke,ship"); setup("drop", "ge/ci-fix", "--why", "test"); setup("ci-retry", "ge");
    const before = events().length;
    f.loopSh(["--hours", "0.05"]);
    evs = events().slice(before);
    has(evs, "ci-broken-noship\tGroup E (ge): CI is broken, so it isn't published until it's fixed, which is the lanes' to do (for the morning summary): broke failed");
  });
  test("  no wake for the owner", () => { assert.ok(!/\tci-broken\t/.test(evs), evs); assert.ok(!evs.includes("Tell the owner now"), evs); });
  test("  naming its units not done", () => { has(evs.split("\n").filter((l) => l.includes("Its units not done")).join("\n"), "Group E (ge): CI is broken, so it isn't published"); });
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

describe("a broken CI that holds back a publish and is the owner's to look at: tell the owner now", () => {
  let evs = "";
  test("a failing step whose on_fail is owner, before a step that ships", () => {
    setup("edit-group", "ge", "--ci", "none");
    setup("add-group", "gm", "--title", "Group M", "--ci", "mine,ship");
    setup("add-unit", "gm/one", "--title", "M one"); setup("done", "gm/one", "--evidence", "x");
    const before = events().length;
    f.loopSh(["--hours", "0.05", "--no-wait"]);
    evs = events().slice(before);
    has(evs, "ci-broken\tGroup M (gm): CI is broken, so it isn't published: mine failed (exit 1, tried 1 time): the upload was refused");
  });
  test("  with the options", () => { has(evs, "Its mine step is the owner's to look at: no unit filed."); has(evs, "Tell the owner now: `just tracker ci-retry gm`"); });
  test("  and nothing filed", () => { assert.ok(!t("status", "gm").includes("gm/ci-fix")); setup("edit-group", "gm", "--ci", "none"); });
});

// A step that ran out of time got to no verdict: the group's work may be fine (a cold cache, a
// slower machine, a busy one). Before: a failure, with a fix filed for a lane to find nothing wrong.
describe("a step out of time: the run couldn't run, which is no failure; nothing is filed", () => {
  let out = "", evs = "";
  test("the step ends out of time", () => {
    setup("publish", "off");
    setup("add-group", "gt", "--title", "Group T", "--ci", "late");
    setup("add-unit", "gt/one", "--title", "T one"); setup("done", "gt/one", "--evidence", "x");
    const before = events().length;
    out = f.loopSh(["--hours", "0.05", "--no-wait"]).stdout;
    evs = events().slice(before);
    has(out, "ci: Group T (gt) couldn't run: late ran out of time after 120 min; its last line: half way");
  });
  test("  not tried again in the same run (another whole time limit for the same end)", () => { assert.ok(!out.includes("trying again"), out); });
  test("  the group isn't broken: its CI reads as couldn't run", () => { const c = t("ci", "gt"); has(c, "Group T (gt): couldn't run: late ran out of time after 120 min"); assert.ok(!c.includes("broken"), c); });
  test("  no ci-fix is filed", () => { assert.ok(!t("status", "gt").includes("gt/ci-fix")); });
  test("  the overseer hears of it for the morning summary, as no failure", () => {
    has(evs, "ci-norun\tGroup T (gt): CI couldn't run, which is no verdict on its work (nothing is filed; for the morning summary): late ran out of time after 120 min");
    assert.ok(!/\tci-broken/.test(evs), evs);
  });
  test("  the runs index says so", () => { has(fs.readFileSync(f.a.at("runs/index.tsv"), "utf8"), "Group T CI (gt)\tCI couldn't run: late ran out of time after 120 min"); });
  test("  the stop names it among the CI not passed", () => { has(f.loopSh(["--hours", "0"]).stdout, "Group T (couldn't run)"); });
  test("out of time again at its next run: a failure after all, with its fix for the lanes", () => {
    setup("ci-retry", "gt");
    const o = f.loopSh(["--hours", "0.05", "--max", "1", "--no-wait"]).stdout;
    has(o, "ci: Group T (gt) broken: late ran out of time after 120 min; its last line: half way");
    has(o, "Filed Fix Group T's CI (gt/ci-fix) for the lanes.");
    setup("edit-group", "gt", "--ci", "none");
  });
});

describe("a step killed by a signal: couldn't run too", () => {
  let out = "";
  test("the step is killed", () => {
    setup("add-group", "gk", "--title", "Group K", "--ci", "shot");
    setup("add-unit", "gk/one", "--title", "K one"); setup("done", "gk/one", "--evidence", "x");
    out = f.loopSh(["--hours", "0.05", "--no-wait"]).stdout;
    has(out, "ci: Group K (gk) couldn't run: shot was killed by signal 9");
  });
  test("  nothing filed, not broken", () => { assert.ok(!t("status", "gk").includes("gk/ci-fix")); has(t("ci", "gk"), "Group K (gk): couldn't run"); setup("edit-group", "gk", "--ci", "none"); });
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
  // Before: given back and claimed again every few minutes for as long as the condition lasted
  // (one factory's own script made the second a failure, to stop that).
  test("not run again for the same reason: kept as couldn't run, and not claimed again", () => {
    const before = events().length;
    const o = f.loopSh(["--hours", "0.05", "--no-wait"]).stdout;
    has(o, "ci: Group U (gu): unmet didn't run again, the same condition unmet: Group U's work here is another lane's; it's kept as couldn't run, nothing filed");
    has(events().slice(before), "ci-norun\tGroup U (gu): CI couldn't run, its unmet step not run twice in a row for the same reason");
    has(t("ci", "gu"), "Group U (gu): couldn't run: Group U's work here is another lane's");
  });
  test("  still no failure and no ci-fix", () => { const c = t("ci", "gu"); assert.ok(!c.includes("broken"), c); assert.ok(!t("status", "gu").includes("gu/ci-fix")); });
});
