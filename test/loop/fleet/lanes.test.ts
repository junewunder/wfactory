// fleet start --lanes N: N lanes on a machine for one run, with docs/machines.md keeping its count
// (2026-10-18: "2 lanes on tern tonight" became a committed edit to machines.md);
// and fleet stop removing a lane clone past that count once its lane has stopped, when it holds
// nothing origin lacks (a stale clone's runs/loop.log said "done" to an overseer's glob).
// Run: node --test test/loop/fleet/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { has, readOr, until, killGroup, HOST } from "../../lib/index.ts";
import { fleetFactory } from "./helpers.ts";

const f = fleetFactory("flanes");
const { F, w, fleet, setup, hold, lane, bg } = f;
const out = (args: string[]) => fleet(args).stdout;
const mf = path.join(F, "docs/machines.md");
const machines = readOr(mf);

const a = hold("g/la"), b = hold("g/lb");
let stop = "";
describe("fleet start --lanes N: that many lanes, for this run only", () => {
  let start = "";
  test("fleet start --lanes 2 on a machine the file gives 1", async () => {
    setup(["add-unit", "g/la", "--title", "Unit la"]);
    setup(["add-unit", "g/lb", "--title", "Unit lb"]);
    start = out(["start", "--lanes", "2", "--hours", "0.1", "--no-awake"]);
    await a.held(); await b.held();
    has(start, `=== ${HOST} lane 2`);
  });
  // (The owner asked for more lanes on several nights; the file kept its count, and each new
  // overseer started that until told again.)
  test("  saying in one line that the file gives another count, and the command that makes this one its count", () => {
    has(start, `=== ${HOST}: --lanes 2 is for this start only; docs/machines.md gives it 1 lane. To make 2 its count: just fleet lanes ${HOST} 2`);
  });
  test("  the machines file keeps its count", () => { assert.equal(readOr(mf), machines); });
  test("  the beat counts both lanes", () => { has(out(["beat"]), "2 busy, 0 waiting, 0 stopped"); });
  test("  naming each lane's unit by lane", () => { has(out(["beat"]), `${HOST}/2: Unit l`); });
  test("  and fleet state reaches lane 2", () => { has(out(["state"]), `=== ${HOST} lane 2`); });
  test("--lanes needs a number", () => { assert.equal(fleet(["start", "--lanes", "two"]).code, 2); });
  // A lane with nothing left looks again every few minutes: once both units have landed, the
  // lanes are stopped rather than waited for.
  test("once both units land, fleet stop stops both lanes", async () => {
    a.go(); b.go();
    await until(() => { w.git(F, "fetch", "-q", "origin"); const l = w.git(F, "log", "--format=%s", "origin/main"); return l.includes("Unit la (g/la): merged") && l.includes("Unit lb (g/lb): merged"); }, "both units landed", 180);
    stop = out(["stop"]);
    has(stop, `=== ${HOST} lane 2`);
  });
});

// fleet stop tidies the machine: the clone past the file's count goes.
describe("fleet stop's tidy: a lane clone past the machines file's count", () => {
  test("fleet stop's tidy removes it once its lane has stopped", () => { has(stop, `removed ${lane(2)}: an orphaned lane clone`); });
  test("  it's gone", () => { assert.ok(!fs.existsSync(lane(2))); });
  test("  lane 1, in the file's count, stays", () => { assert.ok(fs.existsSync(path.join(lane(1), ".git"))); });
  test("  and the fleet watches the file's count again", () => { has(out(["beat"]), "0 busy, 0 waiting, 1 stopped"); });
  test("one with changes of its own stays, and it says so", () => {
    // A third clone, as an older count left, with work of its own.
    w.git(w.top, "clone", "-q", w.at("origin.git"), lane(3));
    fs.writeFileSync(path.join(lane(3), "notes.txt"), "mine\n");
    has(out(["stop"]), `${lane(3)}: an orphaned lane clone with changes of its own: left alone`);
    assert.ok(fs.existsSync(lane(3)));
  });
  test("  as does one with commits origin lacks", () => {
    fs.rmSync(path.join(lane(3), "notes.txt"));
    w.git(lane(3), "commit", "-q", "--allow-empty", "-m", "mine");
    has(out(["stop"]), `${lane(3)}: an orphaned lane clone with commits origin lacks (on main ): left alone`);
  });
  // A loop by hand, or another loop's lane, holds the clone's runs/.loop.lock.
  test("  as does one a loop runs in", async () => {
    w.git(w.top, "clone", "-q", w.at("origin.git"), lane(4));
    fs.mkdirSync(path.join(lane(4), "runs"));
    const holder = bg("flock", [path.join(lane(4), "runs/.loop.lock"), "sleep", "60"]);
    await until(() => spawnSync("flock", ["-n", path.join(lane(4), "runs/.loop.lock"), "true"]).status !== 0, "the lock is held", 10);
    const o = out(["stop"]);
    killGroup(holder.pid!);
    has(o, `${lane(4)}: an orphaned lane clone a loop is running in: left alone`);
  });
  test("  as does one the machine's daemon has a lane to start in", () => {
    w.git(w.top, "clone", "-q", w.at("origin.git"), lane(5));
    fs.mkdirSync(path.dirname(f.record(`factory-${f.P}-lane5`)), { recursive: true });
    fs.writeFileSync(f.record(`factory-${f.P}-lane5`), "{}\n");
    const o = out(["stop"]);
    fs.rmSync(f.record(`factory-${f.P}-lane5`));
    has(o, `${lane(5)}: an orphaned lane clone the machine's daemon will start a lane in: left alone`);
  });
  // (Lane 4 went at the last stop, once its loop let go; lane 5's record is gone now.)
  let o = "";
  test("fleet start removes one too, before it starts the lanes", () => {
    o = out(["start", "--hours", "0.02", "--no-awake"]);
    fleet(["stop"]);
    has(o, `removed ${lane(5)}: an orphaned lane clone`);
  });
  test("  and the next start without --lanes says the last one asked for more, and how to keep that", () => {
    has(o, `=== ${HOST}: the last start here asked for 2 lanes (--lanes); docs/machines.md gives it 1 lane. To make 2 its count: just fleet lanes ${HOST} 2`);
  });
});

// fleet lanes <machine> <count>: the count the owner asked for, in docs/machines.md, committed
// and pushed; a day count and a night count keep the night's clones through the day.
describe("fleet lanes: the file's count, written by the command the start names", () => {
  let said = "";
  test("fleet lanes <machine> '1, 2 at night' writes the machine's Lanes cell", () => {
    said = out(["lanes", HOST, "1, 2 at night"]);
    has(readOr(mf), `| ${HOST} |`);
    has(readOr(mf).split("\n").find((l) => l.startsWith(`| ${HOST} |`)) ?? "", "| 1, 2 at night |");
  });
  test("  says so", () => { has(said, `docs/machines.md: ${HOST} runs 1 lane by day and 2 at night (committed and pushed to origin's main)`); });
  test("  committed and pushed, so every machine's overseer reads it", () => {
    w.git(F, "fetch", "-q", "origin");
    has(w.git(F, "log", "-5", "--format=%s", "origin/main"), `docs/machines.md: ${HOST} runs 1 lane by day and 2 at night`);
    assert.equal(w.git(F, "status", "--porcelain", "--", "docs/machines.md"), "");
  });
  test("  fleet lanes alone lists each machine's", () => { has(out(["lanes"]), `${HOST}: 1 lane by day and 2 at night`); });
  test("  a count it can't read is refused", () => {
    assert.equal(fleet(["lanes", HOST, "two"]).code, 2);
    assert.equal(fleet(["lanes", "no-such-machine", "2"]).code, 2);
  });
  // The day count is lower than the night's: lane 2 is the night's, not an old count's.
  let st = "", stopped = "";
  test("fleet start starts both lanes, saying a lane past the count for the time of day waits", () => {
    st = out(["start", "--hours", "0.02", "--no-awake"]);
    stopped = out(["stop"]);
    has(st, `=== ${HOST}: 1 lane by day and 2 at night (the profile's night): all 2 start, and a lane past the count for the time of day waits between units`);
  });
  test("  each lane's loop gets the counts", () => { has(f.laneLog(2), "--lanes 1,2"); });
  test("  and fleet stop's tidy leaves the night lane's clone", () => {
    assert.ok(!stopped.includes(`removed ${lane(2)}`), stopped);
    assert.ok(fs.existsSync(path.join(lane(2), ".git")));
  });
});
