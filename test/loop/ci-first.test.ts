// One queue at a resource, CI first: a CI run takes every resource its steps use as it starts, so
// one whose later step needs the desk waits before its first step while the desk is busy (its lane
// takes other work), never mid-run. And no reserve before last call: a unit using the desk starts
// 30 min before it; at last call the wrap-up ends it within last_call_grace and CI runs. The loop
// runs in this process with its clock mocked (inproc.ts). Run: node --test test/loop/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { has, hasnt } from "../lib/index.ts";
import { hold, hmAt, hmsAt, realSleep, waitFor, type Run } from "./inproc.ts";
import { loopFactory, order } from "./factory.ts";

const f = loopFactory("ci-first");
const { a, setup, loop, seen } = f;
const kill = (p: ReturnType<typeof spawn> | null) => { if (p?.pid) { try { process.kill(-p.pid, "SIGKILL"); } catch {} } };

// Group A's CI is lc (uses nothing), then desk (uses the desk), and it's due (its one unit done).
// The desk is held by another process, as a unit in another lane here would hold it.
describe("CI whose later step uses the desk, due while the desk is busy, waits before its first step", () => {
  let r: Run, desk: ReturnType<typeof spawn> | null = null, during = "";
  test("the lane takes other work while the desk is busy, then runs the CI", async () => {
    setup("add-group", "ga", "--title", "Group A", "--ci", "lc,desk");
    setup("add-unit", "ga/one", "--title", "A one"); setup("done", "ga/one", "--evidence", "x");
    setup("add-group", "gb", "--title", "Group B");
    setup("add-unit", "gb/plain", "--title", "B plain");
    const L = a.locks;
    fs.mkdirSync(L, { recursive: true });
    desk = spawn("flock", [path.join(L, "res-desk.lock"), "sleep", "300"], { stdio: "ignore", detached: true });
    await waitFor(() => fs.existsSync(path.join(L, "res-desk.lock")), "the desk is held");
    await realSleep(300);
    const h = hold(L, "gb/plain");
    r = loop(["--hours", "4"]);
    await h.held();
    during = r.out();
    kill(desk); desk = null;
    await realSleep(300);
    h.go();
    await r.flow(60);
    await r.until("ci: Group A (ga) passed");
    await r.end();
  });
  test("  while the desk was busy, its first step didn't run", () => { hasnt(during, "ci: lc:"); });
  test("  its lane worked a unit that doesn't use the desk meanwhile", () => { has(during, "iteration 1: B plain (gb/plain)"); });
  test("  then the run took the desk as it started, and never waited mid-run", () => {
    assert.equal(order(r.out(), /iteration 1: B plain \(gb\/plain\)|ci: Group A \(ga\): lc, desk|ci: Group A \(ga\) passed/), "B plain (gb/plain),ci: Group A (ga): lc, desk,ci: Group A (ga) passed");
    hasnt(r.out(), "is busy; waiting for it");
  });
  after(() => { kill(desk); setup("edit-group", "ga", "--ci", "none"); });
});

// Group W's CI is one step using the desk and the pen; another process holds the pen. A unit
// using only the desk doesn't start while the CI waits: it would hold the desk when the pen frees,
// and the CI would wait again.
describe("CI waiting on one of its resources keeps the others free for it", () => {
  let r: Run, pen: ReturnType<typeof spawn> | null = null, during = "";
  test("a unit using the free desk waits behind the CI, which runs once the pen frees", async () => {
    f.editMain("tracker/project.json", (p) => {
      p.resources.pen = { title: "the pen" };
      p.ci.steps.two = { cmd: "echo used the desk and the pen", uses: ["desk", "pen"] };
    });
    setup("add-group", "gw", "--title", "Group W", "--ci", "two");
    setup("add-unit", "gw/one", "--title", "W one"); setup("done", "gw/one", "--evidence", "x");
    setup("add-group", "gv", "--title", "Group V");
    setup("add-unit", "gv/desk", "--title", "V at the desk", "--uses", "desk");
    const L = a.locks;
    pen = spawn("flock", [path.join(L, "res-pen.lock"), "sleep", "300"], { stdio: "ignore", detached: true });
    await waitFor(() => fs.existsSync(path.join(L, "res-pen.lock")), "the pen is held");
    await realSleep(300);
    r = loop(["--hours", "4"]);
    await r.until("waiting:");
    await r.at(60);
    during = r.out();
    kill(pen); pen = null;
    await realSleep(300);
    await r.flow(120);
    await r.until("ci: Group W (gw) passed");
    await r.until("V at the desk (gv/desk)");
    await r.end();
  });
  test("  while the pen was busy, the desk unit didn't start", () => { hasnt(during, "V at the desk (gv/desk)"); });
  test("  the lane said why", () => { has(during, "which this lane keeps free for CI"); });
  test("  once it freed, CI ran first, then the unit", () => {
    assert.equal(order(r.out(), /ci: Group W \(gw\) passed|iteration [0-9]+: V at the desk/), "ci: Group W (gw) passed,V at the desk");
  });
  after(() => { kill(pen); setup("edit-group", "gw", "--ci", "none"); });
});

// Group R's CI uses the desk, and is stale (R done is done, the rest isn't). A stop in 2 hours:
// last call at 90 min (30 before the stop). The plain unit runs to 60 min, so the desk unit starts
// 30 min before last call: its --min-minutes 30 says that's long enough.
describe("no CI reserve: a unit using the desk starts 30 min before last call, and the wrap-up ends it for CI", () => {
  let r: Run, card = "", started = "", told = "";
  test("the desk unit starts 30 min before last call; at last call it's wrapped up, then CI runs", async () => {
    setup("add-group", "gr", "--title", "Group R", "--ci", "desk");
    setup("add-unit", "gr/done", "--title", "R done"); setup("done", "gr/done", "--evidence", "x");
    setup("add-unit", "gr/ed", "--title", "R at the desk", "--uses", "desk", "--min-minutes", "30");
    setup("add-group", "gp", "--title", "Group P", "--priority", "5");
    setup("add-unit", "gp/plain", "--title", "P plain");
    const p = hold(a.locks, "gp/plain");
    r = loop(["--hours", "2", "--last-call", "30"]);
    await p.held();
    const e = hold(a.locks, "gr/ed");
    await r.at(3600);
    p.go();
    await e.held();
    started = r.out(); card = seen("card.seen");
    await r.at(5399);
    await r.at(5400);
    await r.until("to wrap up by");
    told = r.out();
    await r.at(5400 + 899);
    await r.flow(5400 + 902);
    await r.until("ci: Group R (gr) passed");
    await r.at(7200);
    await r.end();
  });
  test("  it started 30 min before last call", () => { has(started, `${hmsAt(r.t0, 3600)} loop: iteration 2: R at the desk (gr/ed)`); });
  test("  told in its prompt when the desk goes to CI", () => { has(card, `The lane stops at ${hmAt(r.t0, 7200)}. The desktop goes to CI at about ${hmAt(r.t0, 5400)} (last call)`); });
  test("  at last call it's told to wrap up", () => { has(told, `${hmsAt(r.t0, 5400)} loop: last call: told R at the desk (gr/ed) to wrap up by ${hmAt(r.t0, 5400 + 900)}`); });
  test("  ended within last_call_grace, then CI runs with the desk", () => {
    assert.equal(order(r.out(), /was ended after its wrap-up time|ci: Group R \(gr\): desk|ci: Group R \(gr\) passed/), "was ended after its wrap-up time,ci: Group R (gr): desk,ci: Group R (gr) passed");
  });
  test("  (no reserve)", () => { hasnt(r.out(), "CI reserve"); });
});
