// The daemon after the machine went down: a cut-off lane is brought back, within limits. A record
// from another run of the service manager (a reboot, a logout) is a lane the machine's going
// down cut off; the record is the one fleet start wrote, changed as a run before would have left
// it. The lane brought back works a held unit, so it's still running at each check that wants it,
// in last call too.
// Run: node --test test/loop/fleet/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { has, readOr, until, active, prop, fileHas } from "../../lib/index.ts";
import { fleetFactory } from "./helpers.ts";
import { hm } from "../../../runtime/src/sys.ts";

const f = fleetFactory("fresume");
const { P, fleet, dmn, setup, hold, lane, record, daemonUnit, laneLog, locks } = f;
const LANE = `factory-${P}-lane1`, L1 = lane(1), EVENTS = path.join(L1, "runs/events.log"), LCFILE = path.join(locks, "last-call");
let rec: Record<string, unknown> = {};
// The lane's record, as left by a run of the machine before: the daemon stopped first, the lane's
// events so far put aside, so what's read is what this daemon did.
function cutOff(deadline: number, resumes: number[], quick: number, args?: string[], more: Record<string, unknown> = {}) {
  dmn(["stop"]);
  if (fs.existsSync(EVENTS)) fs.renameSync(EVENTS, `${EVENTS}.${Date.now()}`);
  fs.mkdirSync(path.dirname(record(LANE)), { recursive: true });
  // (Started hours before: past the half of its run, where its last call may come.)
  fs.writeFileSync(record(LANE), JSON.stringify({ ...rec, manager: "another-boot/1", started: now - 4 * 3600, deadline, resumes, quick, ...(args ? { args } : {}), ...more }, null, 2) + "\n");
}
const lrec = () => { try { return JSON.parse(readOr(record(LANE))); } catch { return {}; } };
const events = () => readOr(EVENTS);
const now = Math.floor(Date.now() / 1000);

describe("the daemon after the machine went down: a cut-off lane is brought back, within limits", () => {
  test("(fleet start writes the lane's record)", async () => {
    const h = hold("g/res0");
    setup(["add-unit", "g/res0", "--title", "Unit res zero"]);
    fleet(["start", "--hours", "0.05", "--no-awake"]);
    await h.held();
    rec = JSON.parse(readOr(record(LANE)));
    fleet(["stop"]);
    h.go();
    setup(["drop", "g/res0", "--why", "test"]);
    assert.equal(rec.unit, LANE);
  });
  const h1 = hold("g/res1");
  // The daemon reads the clock between its start and its event: what's left is told from then.
  let started = 0, seen = 0;
  const epochNow = () => Math.floor(Date.now() / 1000);
  test("the daemon brings back a lane the machine's going down cut off", async () => {
    setup(["add-unit", "g/res1", "--title", "Unit res one"]);
    cutOff(now + 7200, [], 0);
    started = epochNow(); dmn(["start"]);
    await fileHas(EVENTS, "\tresumed\t", 30);
    seen = epochNow();
  });
  test("  it runs again", async () => { await h1.held(); assert.ok(active(`${LANE}.service`)); });
  // 2 hours from the file's start, less what went by before the daemon looked (1.99 under load).
  test("  with what was left of its time, for the overseer", () => {
    const m = /brought back with ([0-9.]+) hours left \(until ([0-9:]+)\)/.exec(events());
    assert.ok(m, events());
    const hours = (t: number) => Math.round((now + 7200 - t) / 36) / 100;
    assert.ok(Number(m[1]) <= hours(started) && Number(m[1]) >= hours(seen), `${m[1]} hours left, told between ${hours(started)} and ${hours(seen)}`);
    assert.equal(m[2], hm(new Date((now + 7200) * 1000)));
  });
  test("  its record now this run's, with the resume", () => {
    const r = lrec();
    assert.equal(r.resumes?.length, 1, JSON.stringify(r));
    assert.notEqual(r.manager, "another-boot/1");
  });
  test("  a lane stopped on purpose (fleet stop) leaves no record", () => {
    fleet(["stop"]); h1.go();
    setup(["drop", "g/res1", "--why", "test"]);
    assert.ok(!fs.existsSync(record(LANE)));
  });
  test("  not past its stop time", async () => { cutOff(now - 60, [], 0); dmn(["start"]); await fileHas(EVENTS, "\tresume-skipped\t", 20); });
  test("    saying so", () => { has(events(), "not brought back: its stop time has passed"); });
  test("    (not started)", () => { assert.ok(!active(`${LANE}.service`)); });
  // Last call is working time (units CI won't redo, and CI), so a lane cut off in it comes back
  // into it: at the time the factory's lanes here wrote to their lock folder, else last_call's.
  const h3 = hold("g/res3");
  let log0 = 0;
  test("  in its last call too, by last_call alone", async () => {
    setup(["add-unit", "g/res3", "--title", "Unit res three"]);
    log0 = laneLog().length;
    cutOff(now + 1800, [], 0); dmn(["start"]);
    await fileHas(EVENTS, "\tresumed\t", 30);
  });
  test("    saying so", () => { has(events(), `in its last call (since ${hm(new Date((now + 1800 - 30 * 60) * 1000))})`); });
  test("    and it's in last call", async () => { await h3.held(); has(laneLog().slice(log0), "loop: last call, stopping at"); });
  test("    (stopped)", () => {
    fleet(["stop"]); h3.go(); setup(["drop", "g/res3", "--why", "test"]);
    fs.rmSync(LCFILE, { force: true });
    assert.ok(!active(`${LANE}.service`));
  });
  const h4 = hold("g/res4");
  // The last call its factory's lanes here wrote for this stop time (a minute ago: a lane that
  // carried an earlier run's on), though last_call alone says it's 90 minutes off.
  test("  by the last call its factory's lanes here wrote, though last_call alone says it's 90 minutes off", async () => {
    setup(["add-unit", "g/res4", "--title", "Unit res four"]);
    log0 = laneLog().length;
    cutOff(now + 7200, [], 0);
    fs.writeFileSync(LCFILE, JSON.stringify({ at: now - 60, deadline: now + 7200, last_call: 30, written: now - 600 }) + "\n");
    dmn(["start"]);
    await fileHas(EVENTS, "\tresumed\t", 30);
  });
  test("    saying so", () => { has(events(), `in its last call (since ${hm(new Date((now - 60) * 1000))})`); });
  test("    and it's in last call", async () => { await h4.held(); has(laneLog().slice(log0), "loop: last call, stopping at"); });
  test("    (stopped)", () => {
    fleet(["stop"]); h4.go(); setup(["drop", "g/res4", "--why", "test"]);
    fs.rmSync(LCFILE, { force: true });
    assert.ok(!active(`${LANE}.service`));
  });
  // One with no timed last call (--last-call 0) has none, whatever its factory's other lanes wrote.
  const h5 = hold("g/res5");
  test("  one with no timed last call isn't brought back into one", async () => {
    setup(["add-unit", "g/res5", "--title", "Unit res five"]);
    cutOff(now + 7200, [], 0, [...(rec.args as string[]), "--last-call", "0"]);
    // (A last call written that has begun, if it had one.)
    fs.writeFileSync(LCFILE, JSON.stringify({ at: now - 60, deadline: now + 7200, last_call: 30, written: now - 600 }) + "\n");
    dmn(["start"]);
    await fileHas(EVENTS, "\tresumed\t", 30);
    await h5.held();
    fleet(["stop"]); h5.go(); setup(["drop", "g/res5", "--why", "test"]);
    fs.rmSync(LCFILE, { force: true });
    assert.ok(!events().includes("in its last call"), events());
  });
  // One brought back or restarted before carries its run's last call on, though the file is gone
  // (a reboot empties the lock folder) and last_call alone says it's 90 minutes off.
  const h6 = hold("g/res6");
  test("  one that carries its run's last call on comes back into it", async () => {
    setup(["add-unit", "g/res6", "--title", "Unit res six"]);
    log0 = laneLog().length;
    cutOff(now + 7200, [], 0, undefined, { env: { ...(rec.env as Record<string, string>), FACTORY_LAST_CALL_AT: `${now - 60} ${now + 7200}` } });
    dmn(["start"]);
    await fileHas(EVENTS, "\tresumed\t", 30);
    await h6.held();
    fleet(["stop"]); h6.go(); setup(["drop", "g/res6", "--why", "test"]);
    has(events(), `in its last call (since ${hm(new Date((now - 60) * 1000))})`);
  });
  // Its run's half is up to its stop time, an earlier one the overseer set included: started 10
  // minutes ago, stopping in 50 (not its --hours's 2 hours), its 90-minute last call is at most 30
  // before. (With nothing written: the daemon works it out as the loop does.)
  const h7 = hold("g/res7");
  test("  its last call at most half its run before the stop time the overseer set", async () => {
    setup(["add-unit", "g/res7", "--title", "Unit res seven"]);
    cutOff(now + 7200, [], 0, [...(rec.args as string[]), "--last-call", "90"], { started: now - 600 });
    fs.writeFileSync(path.join(L1, "runs/.stop-at"), `${now + 3000}\n`);
    fs.rmSync(LCFILE, { force: true });
    dmn(["start"]);
    await fileHas(EVENTS, "\tresumed\t", 30);
    await h7.held();
    fleet(["stop"]); h7.go(); setup(["drop", "g/res7", "--why", "test"]);
    fs.rmSync(LCFILE, { force: true }); fs.rmSync(path.join(L1, "runs/.stop-at"), { force: true });
    assert.ok(!events().includes("in its last call"), events());
  });
  // The owner's last call (wrap up and publish) ends the night: the lane stays down.
  test("  not once the owner's last call had begun", async () => {
    fs.mkdirSync(path.join(L1, "runs"), { recursive: true }); fs.writeFileSync(path.join(L1, "runs/.last-call"), "");
    cutOff(now + 7200, [], 0); dmn(["start"]);
    await fileHas(EVENTS, "\tresume-skipped\t", 20);
    fs.rmSync(path.join(L1, "runs/.last-call"), { force: true });
    has(events(), "not brought back: the owner's last call (just fleet last-call) had begun");
  });
  // Down again within half an hour of a resume, twice running: not brought back a third time.
  test("  nor when the machine went down soon after the last two resumes", async () => {
    cutOff(now + 7200, [now - 120], 1); dmn(["start"]);
    await fileHas(EVENTS, "\tresume-refused\t", 20);
  });
  test("    (not started)", () => { assert.ok(!active(`${LANE}.service`)); });
  test("    and its record is gone", () => { assert.ok(!fs.existsSync(record(LANE))); });
  // A resume long before doesn't count: the machine stayed up after it.
  const h2 = hold("g/res2");
  test("  a resume hours before the machine went down starts the count again", async () => {
    setup(["add-unit", "g/res2", "--title", "Unit res two"]);
    cutOff(now + 7200, [now - 3 * 3600], 1); dmn(["start"]);
    await fileHas(EVENTS, "\tresumed\t", 30);
    assert.equal(lrec().quick, 0, JSON.stringify(lrec()));
  });
  // A logout or a shutdown stops the lanes with a signal, before the daemon: the record stays a while.
  test("  a lane ended by a signal (a logout, a shutdown) keeps its record", async () => {
    await h2.held();
    // (macOS: TERM to the job's process group, as systemctl kill sends it to the unit's.)
    if (process.platform === "darwin") { try { process.kill(-Number(prop(`${LANE}.service`, "MainPID")), "SIGTERM"); } catch {} }
    else spawnSync("systemctl", ["--user", "kill", "--signal=TERM", `${LANE}.service`]);
    await until(() => !active(`${LANE}.service`), "the lane ends on TERM", 30);
    assert.ok(fs.existsSync(record(LANE)));
  });
  test("    until the machine has stayed up a while", async () => { await until(() => !fs.existsSync(record(LANE)), "its record is dropped", 20); });
  test("the daemon exits once no lane runs and nobody waits", async () => {
    fleet(["stop"]);
    await until(() => !active(`${daemonUnit}.service`), "the daemon exits", 20);
  });
  test("  cleanly, so it isn't started again", () => { assert.equal(prop(`${daemonUnit}.service`, "Result"), "success"); });
});
