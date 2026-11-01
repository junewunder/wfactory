// A lane stopped by a signal whose session died first (a logout or a shutdown signals every
// process in the lane's unit at once): the loop goes on past the session's end before it handles
// its own signal, and must still stop on the signal, keeping its record for the machine's daemon
// (#74). The session here dies at once; the loop's TERM comes while it settles the unit, sent
// by the tracker wrapper. The loop is the real factory/loop.sh, in the file's lane.
// Run: node --test test/loop/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { has, hasnt, TRACKER } from "../../lib/index.ts";
import { hold } from "../inproc.ts";
import { laneFactory } from "./helpers.ts";

const f = laneFactory("lane-signal");
const { a, w, setup } = f;
const env = a.envWith();
const record = path.join(env.FACTORY_DAEMON_HOME!, "lanes", `factory-${path.basename(a.dir)}.json`);
const pidFile = path.join(a.locks, "loop.pid");

describe("a lane whose session dies before the loop's signal reaches it", () => {
  let out = "", code: number | null = null;
  test("the session dies; the loop's TERM comes as it settles the unit", () => {
    setup("add-unit", "g/sg", "--title", "Unit cut off by a logout");
    // The record the daemon brings a lane back by (oversee.sh start writes it).
    fs.mkdirSync(path.dirname(record), { recursive: true });
    fs.writeFileSync(record, JSON.stringify({ v: 1, unit: `factory-${path.basename(a.dir)}`, dir: a.dir }) + "\n");
    // The session notes the loop's pid and dies of its signal (no result).
    f.claude(`#!/usr/bin/env bash
echo "$FACTORY_PID" > ${JSON.stringify(pidFile)}
echo '{"type":"system","subtype":"init"}'
exit 143
`);
    const wrap = w.at("tracker-signal.mjs");
    fs.writeFileSync(wrap, `import fs from "node:fs";
if (process.argv[2] === "settle" && process.argv[3] === "g/sg" && !process.argv.includes("--pushed")) process.kill(Number(fs.readFileSync(${JSON.stringify(pidFile)}, "utf8")), "SIGTERM");
await import(${JSON.stringify(TRACKER)});
`);
    try { const r = f.loopSh(["--max", "1", "--hours", "0.05"], { FACTORY_TRACKER: wrap }); out = r.stdout; code = r.code; }
    finally { f.claude(); }
    assert.ok(fs.existsSync(pidFile), "the session ran");
  });
  test("  the lane stops on the signal", () => { has(f.events(), "\tlane-stop\tstopped (signal)"); assert.equal(code, 143, out); });
  test("  not on a failed session", () => { hasnt(out, "failed (exit"); });
  test("  and keeps its record, for the daemon to bring it back", () => { assert.ok(fs.existsSync(record)); });
  test("  its unit settled all the same", () => { has(out, "Unit cut off by a logout (g/sg): the session ended without recording it"); });
});

// Later still: the signal comes in the exit steps of a lane already stopping (its session failed),
// as the last lane here records that the lanes stopped.
describe("a lane already stopping when the signal comes", () => {
  let out = "";
  test("a failed session; the loop's TERM comes in its exit steps", () => {
    setup("add-unit", "g/sl", "--title", "Unit failed before a logout");
    fs.writeFileSync(record, JSON.stringify({ v: 1, unit: `factory-${path.basename(a.dir)}`, dir: a.dir }) + "\n");
    f.claude(`#!/usr/bin/env bash
echo "$FACTORY_PID" > ${JSON.stringify(pidFile)}
echo '{"type":"system","subtype":"init"}'
exit 1
`);
    const wrap = w.at("tracker-signal-late.mjs");
    fs.writeFileSync(wrap, `import fs from "node:fs";
if (process.argv[2] === "lanes-stopped") process.kill(Number(fs.readFileSync(${JSON.stringify(pidFile)}, "utf8")), "SIGTERM");
await import(${JSON.stringify(TRACKER)});
`);
    try { out = f.loopSh(["--max", "1", "--hours", "0.05"], { FACTORY_TRACKER: wrap }).stdout; }
    finally { f.claude(); }
    has(out, "failed (exit 1)");
  });
  test("  it keeps its record", () => { assert.ok(fs.existsSync(record)); });
  test("  saying the signal came", () => { has(out, "a signal came as the lane stopped: stopped (signal), its record kept"); });
});

// The same signal after a stop the lane chose (a pause): the stop stands, and the record goes, so
// the daemon doesn't bring back a lane the owner paused.
describe("a paused lane signalled in its exit steps", () => {
  let out = "";
  test("a pause; the loop's TERM comes in its exit steps", async () => {
    setup("drop", "g/sl", "--why", "test");
    setup("add-unit", "g/sp", "--title", "Unit left by a pause");
    fs.writeFileSync(record, JSON.stringify({ v: 1, unit: `factory-${path.basename(a.dir)}`, dir: a.dir }) + "\n");
    const wrap = w.at("tracker-signal-pause.mjs");
    // (The loop's pid: the lanes-stopped call's parent's, through the timeout and the stub.)
    fs.writeFileSync(wrap, `import fs from "node:fs";
import { execFileSync } from "node:child_process";
if (process.argv[2] === "lanes-stopped") {
  const ppid = (p) => Number(execFileSync("ps", ["-o", "ppid=", "-p", String(p)], { encoding: "utf8" }).trim());
  fs.writeFileSync(${JSON.stringify(pidFile)}, String(ppid(process.ppid)));
  process.kill(ppid(process.ppid), "SIGTERM");
}
await import(${JSON.stringify(TRACKER)});
`);
    fs.rmSync(pidFile, { force: true });
    // Paused while its unit works (a fresh start forgets a pause asked before it).
    const h = hold(a.locks, "g/sp");
    const b = f.loopBg(["--hours", "0.05"], { FACTORY_TRACKER: wrap });
    await h.held();
    fs.writeFileSync(a.at("runs/.pause"), "");
    h.go();
    out = (await b.end()).stdout;
    has(out, "paused at a good point");
  });
  test("  the signal reached the loop", () => { assert.ok(fs.existsSync(pidFile)); });
  test("  its record goes all the same", () => { assert.ok(!fs.existsSync(record), out); });
  test("  not saying it was kept", () => { hasnt(out, "its record kept"); });
});

describe("a lane that stops by itself drops its record", () => {
  test("the lane runs out of work", () => {
    setup("drop", "g/sg", "--why", "test"); setup("drop", "g/sp", "--why", "test");
    fs.writeFileSync(record, JSON.stringify({ v: 1, unit: `factory-${path.basename(a.dir)}`, dir: a.dir }) + "\n");
    has(f.loopSh(["--hours", "0.05"]).stdout, "every unit is done or dropped");
    assert.ok(!fs.existsSync(record));
  });
});
