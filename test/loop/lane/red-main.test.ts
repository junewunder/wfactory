// Main itself red (its check fails on a clean checkout of main, nothing here busy): every landing
// would fail, so the lane stops taking units, with its finished work pushed, and the overseer is
// told at once. Started again before main is fixed, it stops again; once main passes, the waiting
// work lands and the lane carries on, also when what was fixed isn't main's code (a tool). Last
// call isn't cut short by it. The loop is the real factory/loop.sh, in the file's lane.
// Run: node --test test/loop/
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { has, hasnt } from "../../lib/index.ts";
import { laneFactory } from "./helpers.ts";

const f = laneFactory("lane-red-main");
const { setup, state, events, a } = f;
const run = ["--hours", "0.05"];
const broken = () => events().split("\n").filter((l) => l.split("\t")[3] === "main-broken");

describe("a red main stops the lane", () => {
  let out = "";
  test("main red: the lane stops taking units", () => {
    // The project's check fails while fail-check is in the tree, or while a tool it uses is
    // broken (tool-broken in the lane's locks, outside main's code); someone breaks main.
    f.onMain("justfile", fs.readFileSync(a.at("justfile"), "utf8").replace(/^(\s+)@true$/m, '$1@test ! -e fail-check && test ! -e "$$FACTORY_LOCKS/tool-broken"'));
    f.onMain("fail-check", "");
    setup("add-unit", "g/one", "--title", "Unit one");
    setup("add-unit", "g/two", "--title", "Unit two");
    const r = f.loopSh(run);
    out = r.stdout;
    assert.equal(r.code, 0, out);
    has(out, "main is red: main itself fails `just check`");
  });
  test("  no more units were taken", () => { hasnt(out, "iteration 2:"); assert.equal(state("g/two"), "ready"); });
  test("  its finished work is pushed, waiting", () => { assert.equal(f.onBranch("unit/g/one", "out/g-one.txt"), "work on g/one"); });
  test("  the overseer is told at once", () => {
    assert.equal(broken().length, 1, events());
    has(broken()[0], "stops taking units");
    has(events(), "\tlane-stop\tmain is red");
  });
  test("  started again while main is still red, it stops again at once", () => {
    const again = f.loopSh(run).stdout;
    has(again, "main is red");
    hasnt(again, "iteration 1:");
    assert.equal(state("g/two"), "ready");
  });
  test("  once main passes, the waiting work lands and the lane carries on", () => {
    f.onMain("fail-check", null);
    const fixed = f.loopSh(run).stdout;
    has(fixed, "unit/g/one merged into main");
    has(fixed, "unit/g/two merged into main");
    assert.equal(state("g/one"), "done");
    assert.equal(state("g/two"), "done");
  });
});

describe("main red for a reason outside its code", () => {
  const tool = path.join(a.locks, "tool-broken");
  test("a broken tool makes main red: the lane stops", () => {
    fs.writeFileSync(tool, "");
    setup("add-unit", "g/three", "--title", "Unit three");
    setup("add-unit", "g/four", "--title", "Unit four");
    const out = f.loopSh(run).stdout;
    has(out, "main is red");
    assert.equal(state("g/four"), "ready");
  });
  test("  once the tool is fixed, a start checks main again: the waiting work lands", () => {
    fs.rmSync(tool);
    const out = f.loopSh(run).stdout;
    has(out, "unit/g/three merged into main");
    assert.equal(state("g/four"), "done");
  });
});

describe("main red in last call", () => {
  const tool = path.join(a.locks, "tool-broken");
  test("last call runs to its end, not cut short by a red main", () => {
    fs.writeFileSync(tool, "");
    setup("add-unit", "g/five", "--title", "Unit five");
    has(f.loopSh(run).stdout, "main is red");
    setup("add-unit", "g/six", "--title", "Unit six");
    fs.writeFileSync(a.at("runs/.last-call"), "");
    const out = f.loopSh(run).stdout;
    has(out, "last call is over");
    hasnt(out, "main is red:");
    assert.ok(!fs.existsSync(a.at("runs/.last-call")));
    // Last call starts units CI doesn't care about, but none while main is red: none could land.
    hasnt(out, "iteration");
    assert.equal(state("g/six"), "ready");
  });
  after(() => { fs.rmSync(tool, { force: true }); });
});
