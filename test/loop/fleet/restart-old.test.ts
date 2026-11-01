// fleet restart on a lane running a copy of the skill from before restarts (2026-10-18:
// "it can't restart itself", and the lane stayed on the old copy all night): it's asked
// to pause after its unit, and the machine's daemon starts it again on the new copy once it stops.
// The old copy here is this skill without src/loop.ts, its loop a stand-in that works until it's
// asked to pause. Run: node --test test/loop/fleet/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { has, readOr, until, ROOT, HOST, prop } from "../../lib/index.ts";
import { fleetFactory } from "./helpers.ts";
import { platform } from "../../../runtime/src/os.ts";
import { hm } from "../../../runtime/src/sys.ts";

const f = fleetFactory("frsold");
const { P, w, fleet, lane, laneLog, laneEvents, record } = f;
const OLD = w.at("oldskill");
fs.mkdirSync(path.join(OLD, "runtime"), { recursive: true });
for (const e of fs.readdirSync(ROOT)) if (e !== "runtime" && e !== ".git") fs.symlinkSync(path.join(ROOT, e), path.join(OLD, e));
for (const e of fs.readdirSync(path.join(ROOT, "runtime"))) if (e !== "loop.sh" && e !== "src") fs.symlinkSync(path.join(ROOT, "runtime", e), path.join(OLD, "runtime", e));
fs.writeFileSync(path.join(OLD, "runtime/loop.sh"), `#!/usr/bin/env bash
echo "$(date +%T) loop: iteration 1: Old work on the paused menu (g/old) (session 0ld0ld00)"
while [ ! -f runs/.pause ] || [ -f runs/.hold-old ]; do
  [ ! -f runs/.quit-old ] || { rm -f runs/.quit-old; echo "$(date +%T) loop: stopping: nothing workable"; exit 0; }
  sleep 0.2
done
rm -f runs/.pause
echo "$(date +%T) loop: stopping: paused at a good point (just pause)"
`, { mode: 0o755 });
const LANE = `factory-${P}-lane1`;
const skillOf = () => { const s = platform.processEnv(Number(prop(`${LANE}.service`, "MainPID")))?.FACTORY_SKILL; return s === undefined ? "" : `FACTORY_SKILL=${s}`; };

describe("fleet restart: a lane on a copy from before restarts", () => {
  test("a lane on the old copy", async () => {
    fleet(["start", "--hours", "3", "--no-awake"], { FACTORY_SKILL: OLD });
    await until(() => laneLog().includes("Old work on"), "the old loop works", 30);
    assert.equal(skillOf(), `FACTORY_SKILL=${OLD}`);
  });
  let r = { code: 0, stdout: "" };
  test("fleet restart asks it to pause after its unit", () => {
    r = fleet(["restart", HOST]);
    has(r.stdout, "asked it to pause after the unit it's on, and the machine's daemon starts it again on the newest runner once it stops");
  });
  test("  and doesn't fail", () => { assert.equal(r.code, 0); });
  test("  the daemon's record says to start it again", () => { assert.equal(JSON.parse(readOr(record(LANE))).then, "start"); });
  test("once it stops, the daemon starts it again on the new copy", async () => {
    await until(() => laneEvents().includes("\trestarted\t"), "a restarted event", 60);
    has(laneEvents(), "paused after its unit and started again on the newest runner");
  });
  test("  a new start in its log, with what was left of its time", () => {
    const starts = laneLog().split("\n").filter((l) => l.startsWith("==== ") && l.includes(" start "));
    assert.equal(starts.length, 2);
    assert.match(starts[1], /--hours (2\.9[0-9]*|3) /);
  });
  // The new run may still be starting up on a slow, loaded machine (#171): waited for.
  test("  running this copy's loop, not the old one", async () => {
    const run = () => laneLog().split("\n==== ").at(-1)!;
    await until(() => run().includes("loop: nothing workable"), "the new run's loop: nothing workable", 30);
    assert.ok(!run().includes("Old work"), "the old loop didn't run again");
  });
});

// A pause the overseer asks for after the restart outranks it: the lane stays stopped.
describe("fleet restart, then fleet pause, on a lane on an old copy", () => {
  test("a lane on the old copy again, asked to restart, held before it pauses", async () => {
    fleet(["stop"]);
    fs.writeFileSync(path.join(lane(1), "runs/.hold-old"), "");
    fleet(["start", "--hours", "3", "--no-awake"], { FACTORY_SKILL: OLD });
    await until(() => laneLog().split("\n==== ").at(-1)!.includes("Old work"), "the old loop works", 30);
    has(fleet(["restart", HOST]).stdout, "asked it to pause after the unit it's on");
  });
  test("fleet pause takes back the start again", () => {
    fleet(["pause"]);
    assert.equal(JSON.parse(readOr(record(LANE))).then, undefined);
  });
  test("  so once it stops, the daemon doesn't start it", async () => {
    fs.rmSync(path.join(lane(1), "runs/.hold-old"));
    await until(() => prop(`${LANE}.service`, "ActiveState") !== "active", "the old lane stopped", 30);
    await new Promise((r) => setTimeout(r, 3000));
    assert.equal(prop(`${LANE}.service`, "ActiveState") === "active", false);
    assert.ok(laneLog().split("\n==== ").at(-1)!.includes("Old work"), "no new start after it");
  });
});

// One that stops for its own reason before it pauses isn't started again, whatever its units are
// called.
describe("a lane on an old copy that stops before its pause for a restart", () => {
  test("asked to restart, it stops for its own reason instead", async () => {
    fleet(["stop"]);
    fs.writeFileSync(path.join(lane(1), "runs/.hold-old"), "");
    fleet(["start", "--hours", "3", "--no-awake"], { FACTORY_SKILL: OLD });
    await until(() => laneLog().split("\n==== ").at(-1)!.includes("Old work"), "the old loop works", 30);
    fleet(["restart", HOST]);
    fs.rmSync(path.join(lane(1), "runs/.pause"));
    fs.writeFileSync(path.join(lane(1), "runs/.quit-old"), "");
    await until(() => readOr(path.join(w.env.FACTORY_DAEMON_HOME!, "daemon.log")).includes("stopped before its pause for a restart"), "the daemon saw it", 30);
  });
  test("  the daemon doesn't start it", () => {
    assert.notEqual(prop(`${LANE}.service`, "ActiveState"), "active");
    assert.ok(laneLog().split("\n==== ").at(-1)!.includes("nothing workable"), "no new start after it");
  });
  test("  and drops its record", () => { assert.ok(!fs.existsSync(record(LANE))); });
});

// Last call is working time (units CI won't redo, and CI): a lane paused for a restart in it is
// started again, into it, by the last call its factory's lanes here wrote.
describe("fleet restart on a lane on an old copy in its last call", () => {
  const LCFILE = path.join(f.locks, "last-call");
  let at = 0;
  test("a lane on the old copy, past the last call its factory's lanes here wrote", async () => {
    fleet(["stop"]);
    fs.rmSync(path.join(lane(1), "runs/.hold-old"), { force: true });
    fleet(["start", "--hours", "3", "--no-awake"], { FACTORY_SKILL: OLD });
    await until(() => laneLog().split("\n==== ").at(-1)!.includes("Old work"), "the old loop works", 30);
    // Held before it pauses, so its record can be changed after the restart rewrote it.
    fs.writeFileSync(path.join(lane(1), "runs/.hold-old"), "");
    has(fleet(["restart", HOST]).stdout, "asked it to pause after the unit it's on");
    // Its record as if it had started hours before (past the half of its run, where its last call
    // may come), and its last call as its lanes wrote it: a minute ago.
    const rc = JSON.parse(readOr(record(LANE))), deadline = Number(rc.deadline), t = Math.floor(Date.now() / 1000);
    fs.writeFileSync(record(LANE), JSON.stringify({ ...rc, started: t - 6 * 3600 }, null, 2) + "\n");
    at = t - 60;
    fs.writeFileSync(LCFILE, JSON.stringify({ at, deadline, last_call: 30, written: t }) + "\n");
    fs.rmSync(path.join(lane(1), "runs/.hold-old"));
  });
  test("  is started again on the new copy", async () => {
    await until(() => laneEvents().split("\n").some((l) => l.includes("\trestarted\t") && l.includes("in its last call")), "a restarted event in last call", 60);
    has(laneEvents(), `in its last call (since ${hm(new Date(at * 1000))})`);
  });
  test("  into its last call", async () => {
    await until(() => laneLog().split("\n==== ").at(-1)!.includes("loop: last call, stopping at"), "the new run in last call", 30);
    fleet(["stop"]); fs.rmSync(LCFILE, { force: true });
  });
});
