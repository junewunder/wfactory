// Group CI: a group that runs dry gets its CI before any other unit, on main with the group's work,
// recorded with the step's output as evidence; a reopened unit in a passed group gets CI again
// after it. The loop is the real factory/loop.sh, in the file's lane. Run: node --test test/loop/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { has, hasnt, lines, readOr } from "../../lib/index.ts";
import { laneFactory } from "./helpers.ts";
import { order } from "../factory.ts";

const f = laneFactory("lane-ci");
const { a, w, setup, t } = f;
const ciLog = w.at("ci.log");
// drill: notes the group and what out/<group>-two.txt holds (A's work on main), in ci.log.
f.steps({ drill: { cmd: `echo "{group}: $(cat out/{group}-two.txt 2>/dev/null)" >> ${ciLog}; echo drilled {group}` } });

describe("group CI: a group that runs dry gets its CI before any other unit", () => {
  let out = "";
  test("a group that runs dry gets its CI before any other unit", () => {
    setup("add-group", "ga", "--title", "Group A", "--ci", "drill");
    setup("add-unit", "ga/one", "--title", "A one"); setup("add-unit", "ga/two", "--title", "A two");
    setup("add-group", "gb", "--title", "Group B");
    setup("add-unit", "gb/one", "--title", "B one"); setup("add-unit", "gb/two", "--title", "B two");
    out = f.loopSh(["--hours", "0.05"], { FACTORY_CI_RETRY_WAIT: "1" }).stdout;
    assert.equal(order(out, /iteration [0-9]+: [AB] (one|two)|ci: Group A \(ga\): drill/), "A one,A two,ci: Group A (ga): drill,B one,B two");
  });
  test("  on main, with A's work on it", () => { has(readOr(ciLog), "ga: work on ga/two"); });
  test("  passed, with the step's output as evidence", () => { has(t("ci", "ga"), "passed (drill)"); });
  test("  evidence", () => { has(JSON.parse(fs.readFileSync(path.join(t("dir"), "groups/ga.json"), "utf8")).ci.passed.evidence, "drill: drilled ga"); });
  test("  a line in runs/index.tsv", () => { has(readOr(a.at("runs/index.tsv")), "Group A CI (ga)\tCI passed"); });
  test("  no session ran for it", () => { hasnt(out, "iteration 3: Group A"); });
});

describe("a reopened unit in a passed group: CI runs again after it", () => {
  test("a reopened unit in a passed group: CI runs again after it", () => {
    setup("reopen", "ga/one");
    const out = f.loopSh(["--hours", "0.05"]).stdout;
    assert.equal(order(out, /iteration [0-9]+: A one|ci: Group A \(ga\): drill/), "A one,ci: Group A (ga): drill");
  });
  test("  twice in all", () => { assert.equal(lines(readOr(ciLog)), 2); });
});
