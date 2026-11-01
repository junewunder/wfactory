// fleet restart: two lanes mid-unit move to a newly deployed copy, each as its own unit ends; the
// daemon the deployed lanes started runs the deploy folder's current, and a deploy there restarts
// it while the lanes go on. Sessions are held (hold.<unit>) until the test lets them go.
// Run: node --test test/loop/fleet/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { has, hasnt, readOr, until, ROOT, HOST, prop, fileHas } from "../../lib/index.ts";
import { fleetFactory } from "./helpers.ts";

const f = fleetFactory("frestart", { lanes: 2 });
const { F, P, w, run, dmn, setup, hold, lane, laneLog, laneEvents, dpid, daemonUnit, locks } = f;
// Two deployed versions, both this skill (linked); the lanes start on "old".
const R = w.at("rdeploy");
for (const v of ["old", "new"]) { fs.mkdirSync(path.join(R, "versions", v), { recursive: true }); fs.symlinkSync(ROOT, path.join(R, "versions", v, "wfactory")); }
fs.symlinkSync("versions/old", path.join(R, "current"));
// Each with its Node, as deploy.sh lays them out: the daemon a deployed copy starts runs current's.
fs.mkdirSync(path.join(R, "node/bin"), { recursive: true }); fs.symlinkSync(process.execPath, path.join(R, "node/bin/node"));
for (const v of ["old", "new"]) fs.symlinkSync("../../node", path.join(R, "versions", v, "node"));
// The restart's own deploy: a stand-in for the skill checkout's deploy.sh, moving current to "new"
// once there is one (deploy-new), or offline (deploy-fail: deploy.sh still exits 0 then).
fs.mkdirSync(w.at("rskill/scripts"), { recursive: true });
fs.writeFileSync(w.at("rskill/scripts/deploy.sh"), `#!/bin/sh
[ ! -e "${w.top}/deploy-fail" ] || { echo "up to date (old); couldn't reach origin, so this is the last commit fetched"; exit 0; }
[ -e "${w.top}/deploy-new" ] || { echo "up to date (old)"; exit 0; }
ln -sfn versions/new "$FACTORY_DEPLOY/current"; echo "deployed new (was old)"
`, { mode: 0o755 });
const RF = { FACTORY_SKILL: undefined, FACTORY_DEPLOY: R, FACTORY_SKILL_CHECKOUT: w.at("rskill") };
const rf = (args: string[]) => run(path.join(F, "factory/fleet.sh"), args, { add: RF });
const running = () => rf(["state"]).stdout.split("\n").filter((l) => l.startsWith("running")).length;
const restartedEvents = () => [laneEvents(1), laneEvents(2)].join("").split("\n").filter((l) => l.includes("\trestarted\t"));
const seen = (u: string) => readOr(path.join(locks, `skill.${u}.seen`)).trim();

const short = hold("g/rs-short"), long = hold("g/rs-long");
describe("fleet restart: two lanes mid-unit move to a newly deployed copy, each as its own unit ends", () => {
  test("fleet restart: two lanes on the old copy, each mid-unit", async () => {
    setup(["add-unit", "g/rs-short", "--title", "Unit rs short"]);
    setup(["add-unit", "g/rs-long", "--title", "Unit rs long"]);
    rf(["start", "--hours", "0.1", "--no-awake"]);
    await short.held(); await long.held();
    has(laneLog(1), "iteration 1"); has(laneLog(2), "iteration 1");
  });
  let out = { code: 0, stdout: "" };
  test("  a deploy that fails restarts nothing", () => {
    fs.writeFileSync(w.at("deploy-fail"), "");
    out = rf(["restart", HOST]);
    fs.rmSync(w.at("deploy-fail"));
    assert.equal(out.code, 3);
    for (const n of [1, 2]) assert.ok(!fs.existsSync(path.join(lane(n), "runs/.restart")), `lane ${n} was asked to restart`);
  });
  test("  and says so", () => { has(out.stdout, "nothing restarted: the newest skill isn't deployed there"); });
  const next = hold("g/rs-next");
  test("  the restart deploys the new copy first", () => {
    fs.writeFileSync(w.at("deploy-new"), "");
    setup(["add-unit", "g/rs-next", "--title", "Unit rs next"]);
    out = rf(["restart", HOST]);
    has(out.stdout, "deployed new (was old)");
  });
  // The daemon the deployed lanes started runs current's copy: the deploy restarts it at once (what
  // deploy.sh runs once current has moved), and the lanes don't notice.
  test("the daemon runs the deploy folder's current", () => {
    has(prop(`${daemonUnit}.service`, "ExecStart"), `${R}/current/wfactory/runtime/main.mjs`);
  });
  let was = 0, now = 0;
  test("  a deploy there restarts it onto the new copy", () => {
    was = dpid();
    has(dmn(["redeployed"], { FACTORY_DEPLOY: R }).stdout, "restarted the factory daemon onto it");
  });
  test("  as a new process", async () => { await until(() => { now = dpid(); return now !== 0 && now !== was; }, "a new daemon process", 10); });
  test("  and both lanes go on", () => { assert.equal(running(), 2); });
  test("  which it has records of", () => { has(dmn(["status"]).stdout, `factory-${P}-lane2: running`); });
  test("  a deploy to another folder leaves it alone", () => {
    assert.equal(dmn(["redeployed"], { FACTORY_DEPLOY: w.at("deploy") }).stdout, "");
    assert.equal(dpid(), now);
  });
  test("  both lanes are asked", () => { has(out.stdout, `=== ${HOST} lane 2`); });
  test("  and the heartbeat says a restart waits on their units", () => { has(rf(["beat"]).stdout, "(then restarts)"); });
  let S = 1, L = 2;
  test("  the lane whose unit ended first restarts on the new copy at once", async () => {
    if (!laneLog(1).includes("Unit rs short")) { S = 2; L = 1; }
    short.go();
    await fileHas(path.join(lane(S), "runs/loop.log"), "restarted on the newest runner: new (was old)");
  });
  test("  while the other is still on its unit", () => { hasnt(laneLog(L), "restarted on the newest runner"); });
  test("  (its restart still waiting for it)", () => { assert.ok(fs.existsSync(path.join(lane(L), "runs/.restart"))); });
  test("  and takes the next unit without waiting for it", async () => { await fileHas(path.join(lane(S), "runs/loop.log"), "Unit rs next"); });
  test("  which runs on the new copy", async () => {
    // The session writes which copy it runs on a moment after the loop logs its unit.
    await next.held();
    assert.equal(seen("g-rs-next"), `${R}/versions/new/wfactory`);
  });
  test("  no restarted event while a lane is still on the old copy", () => { assert.deepEqual(restartedEvents(), []); });
  test("  the other restarts when its own unit ends", async () => {
    long.go();
    await fileHas(path.join(lane(L), "runs/loop.log"), "restarted on the newest runner: new (was old)", 60);
  });
  test("  (that unit ran on the old copy to its end)", () => { assert.equal(seen("g-rs-long"), `${R}/versions/old/wfactory`); });
  // The last lane to restart logs the event, then waits for work: by then any other lane's
  // event would be there too.
  test("  one restarted event once both are on it", async () => {
    const log = () => laneLog(L), mark = "restarted on the newest runner: new (was old)";
    await until(() => log().slice(log().indexOf(mark)).includes("loop: waiting"), `lane ${L} waits for work after its restart`, 30);
    const evs = restartedEvents();
    assert.equal(evs.length, 1, `got: ${evs.join("\n")}`);
  });
  test("  saying so", () => { has(restartedEvents().join("\n"), `all 2 restarted lanes on ${HOST} are on the newest runner, new (was old)`); });
  test("  for the morning summary", () => { has(rf(["summary"]).stdout, "restarted (1):"); });
  test("  and no lane stopped for it", () => { hasnt(laneEvents(1) + laneEvents(2), "\tlane-stop\t"); });
  test("  both lanes still running", () => { assert.equal(running(), 2); });
  // A lane waiting for work restarts at once, and alone with --lane.
  test("fleet restart --lane: a waiting lane restarts at once", async () => {
    rf(["restart", HOST, "--lane", String(L)]);
    await fileHas(path.join(lane(L), "runs/loop.log"), "restarted on the newest runner: new (was new)");
  });
  test("  and is the one lane the event names", async () => {
    await fileHas(path.join(lane(L), "runs/events.log"), `lane ${L} on ${HOST} is on the newest runner, new (was new)`, 10);
  });
  test("  the other lane isn't restarted", () => { hasnt(laneLog(S), "(was new)"); });
  test("fleet beat: a lane in its exit steps shows as stopped, not busy", () => {
    const t = new Date().toTimeString().slice(0, 8);
    fs.appendFileSync(path.join(lane(S), "runs/loop.log"), `${t} loop: stopping: its exit steps (copying back, tidying)\n`);
    has(rf(["beat"]).stdout, ", 1 stopped");
  });
  test("fleet restart: a machine that isn't in the file", () => { assert.equal(f.fleet(["restart", "nosuchbox"]).code, 2); });
  test("  a lane the machine hasn't", () => { assert.equal(f.fleet(["restart", HOST, "--lane", "3"]).code, 2); });
  test("  nothing running: nothing restarted (exit 3)", () => {
    rf(["stop"]);
    assert.equal(rf(["restart", HOST]).code, 3);
  });
});
