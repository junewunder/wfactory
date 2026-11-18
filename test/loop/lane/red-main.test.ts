// Main's own check failing in the lane's clone. That alone doesn't say main's code is broken (the
// check also reads the machine: the work/ its lanes share, a tool, the tracker's data), so the
// lane doesn't stop on it: it files a unit to find what fails and takes it next. What that
// session fixes, in main's code or outside it, lets the waiting work land, and the lane carries
// on. Only when two such sessions don't put it right is main red: the lane stops taking units,
// with its finished work pushed, and the overseer is told. Started again before main is fixed, it
// stops again; once main passes, the waiting work lands. Last call isn't cut short by it. The loop
// is the real factory/loop.sh, in the file's lane. Run: node --test test/loop/
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { has, hasnt } from "../../lib/index.ts";
import { laneFactory } from "./helpers.ts";

const f = laneFactory("lane-red-main");
const { setup, state, events, a } = f;
const run = ["--hours", "0.05"];
// (A unit with no sessions to go by needs min_unit_minutes before the stop, 45 by default; these
// loops run for three, and the unit the lane files is such a unit.)
f.proj((p) => { p.min_unit_minutes = 0; });
const broken = () => events().split("\n").filter((l) => l.split("\t")[3] === "main-broken");
// The unit the lane files (its host is the lane's name, a.n), and what its fake session does: the
// fix-hook in the lane's locks, run on that unit's branch.
const FIX = `merge/${a.n.toLowerCase()}-main-check`;
const hook = path.join(a.locks, "fix-hook");
const fixes = (script: string | null) => { if (script === null) fs.rmSync(hook, { force: true }); else fs.writeFileSync(hook, `#!/usr/bin/env bash\n${script}\n`, { mode: 0o755 }); };
const tool = path.join(a.locks, "tool-broken");

describe("main's check fails for main's code: a session fixes it, and the lane never stops", () => {
  let out = "";
  test("the lane files a unit to find what fails, and takes it next", () => {
    // The project's check fails while fail-check is in the tree, or while a tool it uses is
    // broken (tool-broken in the lane's locks, outside main's code); someone breaks main.
    f.onMain("justfile", fs.readFileSync(a.at("justfile"), "utf8").replace(/^(\s+)@true$/m, '$1@test ! -e fail-check && test ! -e "$$FACTORY_LOCKS/tool-broken"'));
    f.onMain("fail-check", "");
    setup("add-unit", "g/one", "--title", "Unit one");
    setup("add-unit", "g/two", "--title", "Unit two");
    fixes("git rm -q fail-check && git commit -qm 'main passes its check again'");
    const r = f.loopSh(run);
    out = r.stdout;
    assert.equal(r.code, 0, out);
    has(out, `filed Main's check fails on ${a.n} (${FIX}), which this lane takes next`);
    has(out, `iteration 2: Main's check fails on ${a.n} (${FIX})`);
  });
  test("  its fix lands, then the work that waited, and the lane carries on", () => {
    has(out, `unit/${FIX} merged into main`);
    has(out, "unit/g/one merged into main");
    has(out, "unit/g/two merged into main");
    assert.equal(state("g/one"), "done");
    assert.equal(state("g/two"), "done");
    assert.equal(state(FIX), "done");
  });
  test("  nobody is told main is broken, and the lane didn't stop for it", () => {
    assert.equal(broken().length, 0, events());
    hasnt(out, "main is red");
  });
});

describe("what fails is outside main's code (a tool on the machine): the same, with nothing to merge", () => {
  let out = "";
  test("a broken tool fails main's check here: a session puts it right, and the waiting work lands", () => {
    fs.writeFileSync(tool, "");
    setup("add-unit", "g/three", "--title", "Unit three");
    setup("add-unit", "g/four", "--title", "Unit four");
    fixes('rm -f "$FACTORY_LOCKS/tool-broken"');
    out = f.loopSh(run).stdout;
    has(out, `unit/${FIX} had nothing to merge`);
    has(out, "unit/g/three merged into main");
    has(out, "unit/g/four merged into main");
  });
  test("  with no stop, and nobody told main is broken", () => {
    hasnt(out, "main is red");
    assert.equal(broken().length, 0, events());
  });
  after(() => { fs.rmSync(tool, { force: true }); });
});

describe("two sessions don't put it right: main is red, and the lane stops", () => {
  let out = "";
  test("main red: the lane stops taking units", () => {
    fixes(null);
    f.onMain("fail-check", "");
    setup("add-unit", "g/five", "--title", "Unit five");
    setup("add-unit", "g/six", "--title", "Unit six");
    const r = f.loopSh(run);
    out = r.stdout;
    assert.equal(r.code, 0, out);
    has(out, "main is red: main itself fails `just check`");
  });
  test("  after the unit it filed was worked twice", () => {
    assert.equal(out.split("\n").filter((l) => l.includes(`: Main's check fails on ${a.n} (${FIX})`) && l.includes("iteration")).length, 2, out);
    assert.equal(state(FIX), "stuck");
  });
  test("  no other unit was taken", () => { assert.equal(state("g/six"), "ready"); });
  test("  its finished work is pushed, waiting", () => { assert.equal(f.onBranch("unit/g/five", "out/g-five.txt"), "work on g/five"); });
  test("  the overseer is told once, and that the sessions didn't put it right", () => {
    assert.equal(broken().length, 1, events());
    has(broken()[0], "stops taking units");
    has(broken()[0], `Main's check fails on ${a.n} (${FIX}) didn't put it right`);
    has(events(), "\tlane-stop\tmain is red");
  });
  test("  started again while main is still red, it stops again at once", () => {
    const again = f.loopSh(run).stdout;
    has(again, "main is red");
    hasnt(again, "iteration 1:");
    assert.equal(state("g/six"), "ready");
    assert.equal(broken().length, 1, events());
  });
  test("  once main passes, the waiting work lands and the lane carries on", () => {
    f.onMain("fail-check", null);
    const fixed = f.loopSh(run).stdout;
    has(fixed, "unit/g/five merged into main");
    has(fixed, "unit/g/six merged into main");
    assert.equal(state("g/five"), "done");
    assert.equal(state("g/six"), "done");
  });
  test("  and the stuck unit is dropped: there's nothing left for it to fix", () => { assert.equal(state(FIX), "dropped"); });
});

describe("main red in last call", () => {
  test("last call runs to its end, not cut short by a red main", () => {
    fs.writeFileSync(tool, "");
    setup("add-unit", "g/seven", "--title", "Unit seven");
    has(f.loopSh(run).stdout, "main is red");
    setup("add-unit", "g/eight", "--title", "Unit eight");
    fs.writeFileSync(a.at("runs/.last-call"), "");
    const out = f.loopSh(run).stdout;
    has(out, "last call is over");
    hasnt(out, "main is red:");
    assert.ok(!fs.existsSync(a.at("runs/.last-call")));
    // Last call starts units CI doesn't care about, but none while main is red: none could land.
    hasnt(out, "iteration");
    assert.equal(state("g/eight"), "ready");
  });
  after(() => { fs.rmSync(tool, { force: true }); });
});
