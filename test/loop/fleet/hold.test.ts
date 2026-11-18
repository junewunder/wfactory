// fleet off and fleet on: the lanes held off while work is done by hand in their place (a sweep,
// a sprint). The hold is on main: no lane starts while it holds (fleet start and the loop refuse),
// a running one stops after its unit, and fleet on says which lanes ran and how to start them.
// (One factory's sweeps ran with the lanes "stopped; don't start them" as a line in each worker's
// brief, and its foreman remembering which machines had been running.)
// Run: node --test test/loop/fleet/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { has, hasnt, until, HOST, active } from "../../lib/index.ts";
import { fleetFactory } from "./helpers.ts";

const f = fleetFactory("fhold");
const { F, P, fleet, run, setup, tr, hold, laneLog } = f;
const LANE = `factory-${P}-lane1`;
const start = () => fleet(["start", "--hours", "0.5", "--no-awake"]);
const stopped = () => until(() => !active(`${LANE}.service`), "the lane has stopped", 60);

describe("fleet off: the lanes are held off, and stop after their unit", () => {
  const a = hold("g/ha");
  let off = { code: 0, stdout: "" };
  test("fleet off needs to know what runs in the lanes' place (exit 2)", () => {
    const r = fleet(["off"]);
    assert.equal(r.code, 2);
    has(r.stdout, "usage: fleet off --for");
  });
  test("with a lane at work: exit 3, the lane asked to stop after its unit", async () => {
    setup(["add-unit", "g/ha", "--title", "Unit ha"]);
    setup(["add-unit", "g/hb", "--title", "Unit hb"]);
    start();
    await a.held();
    off = fleet(["off", "--for", "a sweep of shared code"]);
    assert.equal(off.code, 3);
    has(off.stdout, `=== ${HOST} lane 1: asked to stop after the unit it's on`);
  });
  test("  it says what holds them off, and how that ends", () => { has(off.stdout, "the lanes are held off for a sweep of shared code"); has(off.stdout, "`just fleet on` lifts it"); });
  test("  and that a lane still runs", () => { has(off.stdout, "1 lane still running"); });
  test("  the hold is main's, with the lane that ran and its stop time", () => {
    const h = JSON.parse(tr(["lanes", "--json"]));
    assert.equal(h.for, "a sweep of shared code");
    assert.equal(h.were.length, 1);
    assert.equal(h.were[0].machine, HOST);
    assert.equal(h.were[0].lanes, 1);
    assert.ok(h.were[0].until > Date.now() / 1000, "its stop time is ahead");
  });
  test("once its unit lands the lane stops, taking no other", async () => {
    a.go();
    await stopped();
    has(laneLog(), "paused at a good point");
    has(tr(["state", "g/ha"]), "done");
    has(tr(["state", "g/hb"]), "ready");
  });
  test("fleet off again: every lane has stopped (exit 0)", () => {
    const r = fleet(["off"]);
    has(r.stdout, "every lane has stopped");
    assert.equal(r.code, 0);
  });
});

describe("while the lanes are held off, none starts", () => {
  test("fleet start refuses (exit 2), saying why", () => {
    const r = start();
    assert.equal(r.code, 2);
    has(r.stdout, "fleet: the lanes are held off for a sweep of shared code");
  });
  test("  and no lane runs", () => { assert.ok(!active(`${LANE}.service`)); });
  test("a loop by hand refuses too", () => {
    const r = run(path.join(F, "factory/loop.sh"), ["--no-awake", "--hours", "0.05", "--max", "1"]);
    assert.equal(r.code, 2);
    has(r.stdout, "the lanes are held off for a sweep of shared code");
  });
  test("  and works no unit", () => { has(tr(["state", "g/hb"]), "ready"); });
});

describe("fleet on: the hold is let go, and it says how to start what ran", () => {
  let on = { code: 0, stdout: "" };
  test("fleet on", () => { on = fleet(["on"]); assert.equal(on.code, 0); has(on.stdout, "the lanes may start again"); });
  test("  names the machine whose lane ran, with the command that starts it until its old stop time", () => {
    assert.match(on.stdout, new RegExp(`${HOST}: 1 lane ran, until \\d\\d:\\d\\d: \`just fleet start ${HOST} --until \\d\\d:\\d\\d\``));
  });
  test("  and starts nothing itself", () => { has(on.stdout, "nothing was started"); assert.ok(!active(`${LANE}.service`)); });
  test("the hold is gone", () => { assert.equal(tr(["lanes", "--json"]), "null"); });
  test("fleet on with no hold says so", () => { has(fleet(["on"]).stdout, "the lanes weren't held off"); });
});

// A lane no pause reached (its machine was unreachable when the hold was set) reads the hold
// from main between units.
describe("a lane that was never asked stops by the hold alone", () => {
  const b = hold("g/hb");
  test("the hold set while its session works", async () => {
    setup(["add-unit", "g/hc", "--title", "Unit hc"]);
    hasnt(start().stdout, "held off");
    await b.held();
    setup(["lanes", "off", "--for", "a sprint on the build"]);
    b.go();
    await stopped();
    has(laneLog(), "paused at a good point: the lanes are held off for a sprint on the build");
  });
  test("  its unit landed, and it took no other", () => { has(tr(["state", "g/hb"]), "done"); has(tr(["state", "g/hc"]), "ready"); });
  test("fleet on, with no lane recorded: it says how to start this machine's", () => {
    has(fleet(["on"]).stdout, "no lane was running when they were held off");
  });
});
