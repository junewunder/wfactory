// CI that runs on another machine keeps nothing free here: a group pinned to another machine, its
// CI due and using the desk, holds back no unit here that uses the desk, before last call or in
// it. And a hand-run loop's checkout a stopped CI run left detached on main's commit. The loop
// runs in this process with its clock mocked (inproc.ts). Run: node --test test/loop/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { has, hasnt } from "../lib/index.ts";
import { hold, nextSecond, hmsAt, run, type Run } from "./inproc.ts";
import { loopFactory, LOOP } from "./factory.ts";

const f = loopFactory("elsewhere");
const { a, w, F, setup, t, state, loop } = f;

setup("add-group", "gx", "--title", "Group X", "--host", "otherbox", "--ci", "desk");
setup("add-unit", "gx/done", "--title", "X done"); setup("done", "gx/done", "--evidence", "x");
setup("add-group", "gy", "--title", "Group Y");
setup("add-unit", "gy/plain", "--title", "Y plain", "--priority", "5");
setup("add-unit", "gy/desk", "--title", "Y at the desk", "--uses", "desk");
setup("edit-group", "gy", "--priority", "10");

// A stop in 80 s: last call at 40; the desk unit comes up before it, at 25 s.
describe("CI that runs on another machine keeps nothing free here, before last call", () => {
  let r: Run;
  test("CI on another machine: its group's CI is due", () => { has(t("ci"), "Group X (gx): due"); });
  test("  a unit here using the desk starts before last call", async () => {
    const t0 = nextSecond();
    fs.mkdirSync(a.at("runs"), { recursive: true });
    fs.writeFileSync(a.at("runs/.stop-at"), `${t0 + 80}\n`);
    const h = hold(a.locks, "gy/plain");
    r = loop(["--hours", "1", "--last-call", "1", "--max", "2"], {}, t0);
    await h.held();
    await r.at(25);
    h.go();
    await r.end();
    fs.rmSync(a.at("runs/.stop-at"), { force: true });
    has(r.out(), `${hmsAt(t0, 25)} loop: iteration 2: Y at the desk (gy/desk)`);
  });
});

// The session holding the desk in last call: the wrap-up's grace (15 minutes) goes by, and it isn't ended.
describe("CI that runs on another machine keeps nothing free here, in last call", () => {
  let r: Run, running = false;
  test("  in last call, a session using the desk isn't told to wrap up", async () => {
    if (state("gy/desk") !== "done") setup("drop", "gy/desk", "--why", "test");
    setup("add-unit", "gy/desk2", "--title", "Y at the desk again", "--uses", "desk");
    const h = hold(a.locks, "gy/desk2");
    r = loop(["--hours", "1"]);
    await h.held();
    assert.equal(a.run("factory/oversee.sh", ["last-call"]).code, 0);
    await r.at(1);
    await r.at(1 + 900);
    running = h.holding();
    h.go();
    await r.end();
    hasnt(r.out(), "to wrap up by");
  });
  test("  (nor ended after the wrap-up time)", () => { assert.ok(running, "the session was ended"); hasnt(r.out(), "its wrap-up time is over"); });
  test("  and lands its unit", () => { has(r.out(), "last call is over"); assert.equal(state("gy/desk2"), "done"); });
  test("  the other machine's CI is left for it", () => {
    has(t("ci"), "Group X (gx): due");
    fs.rmSync(a.at("runs/.last-call"), { force: true });
    setup("edit-group", "gy", "--priority", "0"); setup("edit-group", "gx", "--ci", "none");
  });
});

// The factory's own checkout, where a loop by hand refuses to start over the owner's work.
describe("a stopped CI run can leave a hand-run loop's checkout detached on main's commit", () => {
  const git = (...args: string[]) => w.git(F, ...args);
  const owner = { dir: F, envWith: w.envWith };
  const atMain = async () => (await run(owner, [...LOOP, "--max", "0"]).end()).out;
  test("a loop starts in a clean checkout detached on main's commit", async () => {
    git("fetch", "-q", "origin"); git("checkout", "-q", "--detach", "origin/main");
    const out = await atMain();
    hasnt(out, "not starting");
    has(out, "ran its --max 0 sessions");
  });
  test("  but not while the local main has commits origin doesn't", async () => {
    git("checkout", "-q", "main"); git("reset", "-q", "--hard", "origin/main");
    fs.writeFileSync(`${F}/mine.txt`, "mine\n"); git("add", "mine.txt"); git("commit", "-qm", "the owner's own"); git("checkout", "-q", "--detach", "origin/main");
    const out = await atMain();
    git("checkout", "-q", "main"); git("reset", "-q", "--hard", "origin/main");
    has(out, "not starting in this checkout");
  });
});
