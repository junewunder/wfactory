// What last call holds back: only what would make CI here run again. A factory with no CI keeps
// starting units until the stop time; with CI on one group, that group's units wait and another
// group's start; a lane with only held-back work waits while that CI runs, then stops. And with
// no "last_call" set, last call is 30 minutes (plus the wrap-up and the CI) before the stop.
// The loop runs in this process with its clock mocked (inproc.ts). Run: node --test test/loop/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { has, hasnt } from "../lib/index.ts";
import { hold, letGo, nextHeld, nextSecond, hmAt, hmsAt, run, type Run } from "./inproc.ts";
import { loopFactory, order } from "./factory.ts";

const f = loopFactory("lcholds");
const { a, setup, t, state, loop } = f;
// Last call now, as `just fleet last-call` starts it.
const lastCallNow = () => { fs.mkdirSync(a.at("runs"), { recursive: true }); fs.writeFileSync(a.at("runs/.last-call"), ""); };
// The loop into its timed last call: a stop in 120 s with --last-call 1 (60 min, so at 60 s), and
// a unit first (Z <name>, before any other) whose session runs until then.
async function intoLastCall(name: string) {
  setup("add-group", `gz${name}`, "--title", `Group Z${name}`, "--priority", "10");
  setup("add-unit", `gz${name}/wait`, "--title", `Z ${name}`);
  const h = hold(a.locks, `gz${name}/wait`);
  // (A minute ahead of real time: what the sessions record has a real time.)
  const t0 = nextSecond() + 60;
  fs.mkdirSync(a.at("runs"), { recursive: true });
  fs.writeFileSync(a.at("runs/.stop-at"), `${t0 + 120}\n`);
  const r = loop(["--hours", "1", "--last-call", "1"], {}, t0);
  await h.held();
  await r.at(60);
  h.go();
  await r.until("loop: last call,");
  return r;
}

// A stop in 120 s with --last-call 1 (60 min): at most half the run, so last call at 60 s.
// Sessions end at 40, 60 and 100 s: the third starts at 60 s, in last call.
describe("a factory with no CI keeps starting units through last call until the stop time", () => {
  let r: Run;
  const worked: string[] = [];
  test("no CI: units start in last call", async () => {
    setup("add-group", "gp", "--title", "Group P");
    for (const n of ["one", "two", "three"]) { setup("add-unit", `gp/${n}`, "--title", `P ${n}`); hold(a.locks, `gp/${n}`); }
    // (A minute ahead of real time: what the sessions record has a real time.)
    const t0 = nextSecond() + 60;
    fs.mkdirSync(a.at("runs"), { recursive: true });
    fs.writeFileSync(a.at("runs/.stop-at"), `${t0 + 120}\n`);
    r = loop(["--hours", "1", "--last-call", "1"], {}, t0);
    const ends = [40, 60, 100];
    for (let i = 0; ; i++) {
      const k = await nextHeld(a.locks, r);
      if (k === null) break;
      worked.push(k);
      await r.at(ends[i] ?? 110);
      letGo(a.locks, k);
    }
    await r.end();
    fs.rmSync(a.at("runs/.stop-at"), { force: true });
    has(r.out(), `${hmsAt(r.t0, 60)} loop: last call, stopping at ${hmAt(r.t0, 120)}`);
  });
  test("  a unit starts in last call", () => {
    has(r.out(), `${hmsAt(r.t0, 60)} loop: iteration 3: P three`);
    assert.equal(order(r.out(), /iteration [0-9]+: P [a-z]+|loop: last call,/), "P one,P two,loop: last call,,P three");
  });
  test("  and lands", () => { assert.equal(state("gp/three"), "done"); });
  test("  every unit worked", () => { assert.deepEqual(worked, ["gp-one", "gp-two", "gp-three"]); });
  test("  nothing held back, and the log says so", () => { has(r.out(), "last call: nothing held back: no CI runs here tonight"); });
  test("  the lane stops once nothing is left", () => { has(r.out(), "last call is over: nothing workable: every unit is done or dropped"); hasnt(r.out(), "out of time"); });
});

describe("with CI on group A, last call holds back A's units and starts group B's", () => {
  let r: Run;
  test("CI on A: B's units start in last call, A's don't", async () => {
    setup("add-group", "ga", "--title", "Group A", "--ci", "lc");
    setup("add-unit", "ga/one", "--title", "A one"); setup("done", "ga/one", "--evidence", "x");
    setup("add-unit", "ga/two", "--title", "A two");
    setup("add-group", "gb", "--title", "Group B");
    for (const n of ["one", "two"]) setup("add-unit", `gb/${n}`, "--title", `B ${n}`);
    r = await intoLastCall("b");
    await r.end();
    fs.rmSync(a.at("runs/.stop-at"), { force: true });
  });
  test("  saying what it holds back", () => { has(r.out(), "last call: no unit of Group A or on its data (its CI runs here tonight) starts; other units do"); });
  test("  A's CI runs, then B's units", () => {
    assert.equal(order(r.out(), /iteration [0-9]+: [ABZ] [a-z]+|loop: last call,|ci: Group A \(ga\): lc|last call is over/), "Z b,loop: last call,,ci: Group A (ga): lc,B one,B two,last call is over");
  });
  test("  B's units land", () => { assert.equal(state("gb/one"), "done"); assert.equal(state("gb/two"), "done"); });
  test("  A's unit waits for the next run", () => { assert.equal(state("ga/two"), "ready"); });
  test("  A's CI passed", () => { has(t("ci", "ga"), "passed (lc)"); });
  test("  the stop says why", () => { has(r.out(), "last call is over: nothing workable: 1 unit of Group A or on its data, held back"); });
});

// A's CI is running (another lane here, as this test's process): the lane, with only A's units
// left, waits for it; once it passes, the lane stops.
describe("a lane with only held-back work left waits while CI runs, then stops", () => {
  let r: Run, before = "";
  test("only held-back work: the lane waits for the CI running, then stops", async () => {
    setup("add-unit", "ga/three", "--title", "A three"); setup("done", "ga/three", "--evidence", "x");
    setup("ci-start", "ga", "--force");
    r = await intoLastCall("c");
    await r.until("waiting: ");
    before = r.out();
    setup("ci-pass", "ga", "--evidence", "passed in another lane");
    await r.at(70);
    await r.end();
    fs.rmSync(a.at("runs/.stop-at"), { force: true });
  });
  test("  it waited, saying why", () => { has(before, "waiting: nothing workable: 1 unit of Group A or on its data, held back"); });
  test("  not stopping while CI ran", () => { hasnt(before, "last call is over"); });
  test("  then stopped", () => { has(r.out(), "last call is over"); });
  test("  A's unit still waits", () => { assert.equal(state("ga/two"), "ready"); });
});

// Group K's CI is broken, and its other unit waits on the owner: in last call nothing is left
// but the owner's, so the lane stops, naming the CI that didn't pass, for the overseer.
describe("a stop in last call with only the owner's work left names the CI not passed", () => {
  let r: Run;
  test("only the owner's work left in last call: the stop names CI not passed", async () => {
    f.editMain("tracker/project.json", (p) => { p.ci.steps.bad = { cmd: "echo it broke; exit 1", retries: 0 }; });
    setup("add-group", "gk", "--title", "Group K", "--ci", "bad");
    setup("add-unit", "gk/one", "--title", "K one"); setup("done", "gk/one", "--evidence", "x");
    setup("add-unit", "gk/q", "--title", "K question");
    setup("ask", "--title", "Should group K keep its broken step tonight?", "--context", "x", "--option", "a|A|x", "--option", "b|B|y", "--default", "a", "--blocks", "gk/q");
    for (const u of ["ga/two"]) setup("park", u, "--why", "test");
    r = await intoLastCall("k");
    await r.end();
    fs.rmSync(a.at("runs/.stop-at"), { force: true });
  });
  test("  it stops on the owner's work", () => { has(r.out(), "Only the owner's questions and gates are left"); });
  test("  naming CI not passed", () => { has(r.out(), "CI not passed: Group K (broken)"); });
  after(() => { setup("reopen", "ga/two"); for (const u of ["gk/q", "gk/ci-fix"]) setup("drop", u, "--why", "test"); setup("edit-group", "gk", "--ci", "none"); });
});

// `just fleet last-call` is the owner ending the night: no unit starts, not even one CI doesn't
// care about.
describe("the last call the owner starts (wrap up and publish) starts no unit at all", () => {
  let r: Run;
  test("just fleet last-call: no unit starts", async () => {
    setup("add-unit", "gb/three", "--title", "B three");
    lastCallNow();
    r = loop(["--hours", "1"]);
    await r.end();
  });
  test("  not even one of a group without CI", () => { hasnt(r.out(), "iteration"); assert.equal(state("gb/three"), "ready"); });
  test("  and the lane stops", () => { has(r.out(), "last call is over: no new units after `just fleet last-call`"); });
});

// No "last_call" in tracker/project.json, no --last-call: 30 minutes, though a group whose last CI
// took 90 minutes is still to run here (no CI reserve, #159).
describe("with no last_call set, last call begins 30 minutes before the stop, whatever CI is still to run", () => {
  let r: Run, before = "";
  test("default last call: 30 minutes before the stop", async () => {
    setup("drop", "ga/two", "--why", "test"); setup("drop", "gb/three", "--why", "test"); setup("edit-group", "ga", "--ci", "none");
    setup("add-group", "gq", "--title", "Group Q", "--ci", "lc");
    setup("add-unit", "gq/a", "--title", "Q a"); setup("done", "gq/a", "--evidence", "x");
    setup("ci-start", "gq"); setup("ci-pass", "gq", "--evidence", "same", "--secs", "5400");
    // Stale from here on, with work left for another machine, and never due by the time alone.
    setup("add-unit", "gq/b", "--title", "Q b"); setup("done", "gq/b", "--evidence", "x");
    setup("add-unit", "gq/c", "--title", "Q c", "--host", "b");
    f.editMain("tracker/project.json", (p) => { p.ci_every = 0; });
    // loop() would pass --last-call 0: the loop's options without it.
    r = run(f.checkout, ["--no-awake", "--idle-wait", "0.05", "--hours", "6"], { FACTORY_HEAVY: "2" });
    await r.until("waiting: nothing workable: 1 unit for another machine");
    await r.at(329 * 60);
    before = r.out();
    await r.at(330 * 60 + 10);
    await r.end();
  });
  test("  not before", () => { hasnt(before, "last call"); });
  test("  then", () => { has(r.out(), `loop: last call, stopping at ${hmAt(r.t0, 6 * 3600)}: no new units`); });
  test("  and its CI runs in it", () => { assert.equal(order(r.out(), /ci: Group Q \(gq\): lc|last call is over/), "ci: Group Q (gq): lc,last call is over"); });
});
