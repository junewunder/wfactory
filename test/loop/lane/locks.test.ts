// A lane's locks: it holds its unit's and resources' while the session runs, so another lane on
// the machine waits for the resource, and lets go after; what the loop starts (a warm-up's editor)
// never holds the loop's locks; an index.lock a killed session left doesn't stop it. The loop is
// the real factory/loop.sh, in the file's lane. Run: node --test test/loop/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { alive, has, killPid, lockHeld, pidOf, readOr } from "../../lib/index.ts";
import { hold } from "../inproc.ts";
import { laneFactory } from "./helpers.ts";

const f = laneFactory("lane-locks");
const { a, w, setup, onMain } = f;

// The session is held through the first test (hold() lets go when the test that held it ends):
// what's seen while it works is kept for the tests after.
describe("a lane holds its unit's and resources' locks while the session runs", () => {
  let b: ReturnType<typeof f.loopBg>, unitLock = false, resLock = false, next = "";
  test("the unit's lock is held during its session", async () => {
    setup("add-unit", "g/four", "--title", "Unit four", "--uses", "desk");
    const h = hold(a.locks, "g/four");
    b = f.loopBg(["--hours", "0.05"]);
    await b.until("iteration 1: Unit four");
    await h.held();
    unitLock = lockHeld(path.join(a.locks, "unit-g__four.lock"));
    resLock = lockHeld(path.join(a.locks, "res-desk.lock"));
    setup("add-unit", "g/five", "--title", "Unit five", "--uses", "desk");
    next = a.tracker(["next", "--json"]).stdout;
    h.go();
    assert.ok(unitLock);
  });
  test("  and its resource's", () => { assert.ok(resLock); });
  test("another lane on this machine waits for the resource", () => { has(next, '"wait":true'); });
  test("  locks are released after the session", async () => {
    await b.until("every unit is done", 40);
    await b.end();
    assert.ok(!lockHeld(path.join(a.locks, "res-desk.lock")));
  });
});

describe("what the loop starts (a warm-up's editor) never holds the loop's locks", () => {
  // The warm-up leaves a process running (its pid in pre.pid), killed when the file's tests end.
  const pid = w.at("pre.pid");
  after(() => { killPid(readOr(pid)); });
  test("a process pre-session leaves running doesn't hold the loop's lock", () => {
    onMain("factory/pre-session", `#!/bin/sh\nsetsid sh -c 'echo $$ > ${pid}; exec sleep 30' >/dev/null 2>&1 &\n`);
    setup("add-unit", "g/warm", "--title", "Unit warm");
    f.loopSh(["--hours", "0.05", "--max", "1"]);
    onMain("factory/pre-session", null);
    const left = pidOf(readOr(pid));
    assert.ok(left > 0, `pre-session ran and wrote its process's pid (pre.pid: ${JSON.stringify(readOr(pid))})`);
    assert.ok(alive(left), "the warm-up's process is running");
    assert.ok(fs.existsSync(a.at("runs/.loop.lock")), "the loop took its lock");
    assert.ok(!lockHeld(a.at("runs/.loop.lock")));
  });
  test("  nor the lane's", () => {
    const lane = path.join(a.locks, `lane-${path.basename(a.dir)}.lock`);
    assert.ok(fs.existsSync(lane), `the loop took its lane lock (${lane})`);
    assert.ok(!lockHeld(lane));
  });
  test("  (another loop starts in the checkout at once)", () => {
    const r = f.loopSh(["--hours", "0.05", "--max", "0"]);
    assert.equal(r.code, 0, r.stdout);
  });
});

describe("an index.lock a killed session left doesn't stop the loop", () => {
  let out = "";
  test("a stale index.lock a killed session left is removed", () => {
    setup("add-unit", "g/il", "--title", "Unit il");
    a.git("fetch", "-q", "origin"); a.git("checkout", "-q", "-b", "unit/g/il", "origin/main");
    fs.writeFileSync(a.at("out-il.txt"), "wip\n");
    const lock = a.at(".git/index.lock"), then = new Date(Date.now() - 5 * 60e3);
    fs.writeFileSync(lock, ""); fs.utimesSync(lock, then, then);
    out = f.loopSh(["--hours", "0.05", "--max", "1"]).stdout;
    a.run("git", ["checkout", "-q", "-f", "main"]);
    has(out, "removed the index.lock");
  });
  test("  and the lane carries on", () => { has(out, "iteration 1: Unit il (g/il)"); });
});
