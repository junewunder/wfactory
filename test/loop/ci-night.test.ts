// Group CI through the night: CI on a group that still has work falls due once it has been stale
// two hours (ci_every), and the lane runs it before the group's next unit, not at last call. And
// last call comes early enough for the CI still to run here, as long as each group's took last
// time. The loop runs in this process with its clock mocked (inproc.ts). Run: node --test test/loop/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { after, describe, test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { has, hasnt } from "../lib/index.ts";
import { hold, hmAt, realSleep, waitFor, type Run } from "./inproc.ts";
import { loopFactory, order } from "./factory.ts";

const f = loopFactory("cinight");
// A lock holder spawned detached (flock and the command holding the lock with it), killed whole.
const kill = (p: ReturnType<typeof spawn> | null) => { try { if (p?.pid) process.kill(-p.pid); } catch { /* gone already */ } };
const { a, setup, t, loop } = f;

describe("CI falls due while the lane has the group's work: it runs before the group's next unit, not at last call", () => {
  let r: Run, beforeDue = "";
  test("two hours after a unit of the group was done, its CI runs before its next unit", async () => {
    setup("add-group", "gn", "--title", "Group N", "--ci", "lc");
    for (const n of ["one", "two", "three"]) setup("add-unit", `gn/${n}`, "--title", `N ${n}`);
    setup("add-group", "go", "--title", "Group O");
    setup("add-unit", "go/one", "--title", "O one");
    setup("done", "gn/one", "--evidence", "x");
    const h = hold(a.locks, "gn/two");
    // With a timed last call an hour before the stop, four hours on: CI may not wait for it.
    r = loop(["--hours", "4", "--last-call", "60", "--max", "2"]);
    await h.held();
    beforeDue = t("ci", "gn");
    // (The clock past the two hours, then the session done: it was taken while CI was stale.)
    await r.at(2 * 3600 + 120);
    h.go();
    await r.end();
  });
  test("  while it was stale the lane took the group's unit", () => { has(beforeDue, "stale: it hasn't passed yet; 2 units still to work tonight; due at "); });
  test("  then CI, then the group's next unit", () => {
    assert.equal(order(r.out(), /iteration [0-9]+: [NO] [a-z]+|ci: Group N \(gn\): lc|last call/), "N two,ci: Group N (gn): lc,N three");
  });
  test("  it passed, with work left", () => { has(r.out(), "ci: Group N (gn) passed"); });
  test("  long before last call", () => { hasnt(r.out(), "last call"); });
  test("  its time is kept, for when last call has to begin", () => { has(t("ci", "--json"), '"group":"gn"'); assert.match(t("ci", "--json"), /"secs":[0-9]+/); });
});

// No CI reserve (#159): a group whose last CI took 3 hours still to run here, and last call is
// its 60 minutes before the stop, not earlier. (It was 60 + 15 for the wrap-up + 180: half the run.)
describe("last call is last_call minutes before the stop, however long the CI still to run here took last time", () => {
  let r: Run, before = "";
  test("a group whose last CI took 3 hours: last call 60 minutes before the stop", async () => {
    setup("edit-group", "gn", "--ci", "none"); setup("drop", "go/one", "--why", "test");
    setup("add-group", "gq", "--title", "Group Q", "--ci", "lc");
    setup("add-unit", "gq/a", "--title", "Q a"); setup("done", "gq/a", "--evidence", "x");
    setup("ci-start", "gq"); setup("ci-pass", "gq", "--evidence", "same", "--secs", "10800");
    // Stale from here on, with work left for another machine, and never due by the time alone.
    setup("add-unit", "gq/b", "--title", "Q b"); setup("done", "gq/b", "--evidence", "x");
    setup("add-unit", "gq/c", "--title", "Q c", "--host", "b");
    // ci_every 0: Q is stale all night, and only last call runs its CI.
    f.editMain("tracker/project.json", (p) => { p.ci_every = 0; });
    // (Two heavy-job slots: CI's time isn't shared among them.)
    r = loop(["--hours", "6", "--last-call", "60"], { FACTORY_HEAVY: "2" });
    await r.until("waiting: nothing workable: 1 unit for another machine");
    await r.at(299 * 60);
    before = r.out();
    await r.at(300 * 60 + 10);
    await r.end();
  });
  test("  not before", () => { hasnt(before, "last call"); });
  test("  then, at last_call minutes before the stop, with no time added for CI", () => {
    has(r.out(), `loop: last call, stopping at ${hmAt(r.t0, 6 * 3600)}: no new units`);
    hasnt(r.out(), "earlier, for the CI");
  });
  test("  and its CI runs in it", () => { assert.equal(order(r.out(), /ci: Group Q \(gq\): lc|last call is over/), "ci: Group Q (gq): lc,last call is over"); });
});

// Group M's CI step needs a heavy-job slot (it has never run, so it isn't known to be short), and
// another job holds the only one: it waits its turn (FACTORY_CI_TURN_WAIT, 2 s here), then the run is
// given back and the lane takes another group's unit meanwhile.
describe("CI with no turn in the machine's memory budget: given back, due again, and the lane takes other work", () => {
  let r: Run, slot: ReturnType<typeof spawn> | null = null;
  test("no turn for the CI step: the lane takes another group's unit", async () => {
    setup("drop", "gq/c", "--why", "test"); setup("edit-group", "gq", "--ci", "none");
    setup("add-group", "gm", "--title", "Group M", "--ci", "lc");
    setup("add-unit", "gm/a", "--title", "M a"); setup("done", "gm/a", "--evidence", "x");
    setup("add-group", "gz", "--title", "Group Z");
    setup("add-unit", "gz/a", "--title", "Z a");
    const cpu = f.w.env.FACTORY_CPU_LOCKS!;
    fs.mkdirSync(cpu, { recursive: true });
    // (Detached, so it's killed with its sleep, which holds the lock too: a later test needs the slot.)
    slot = spawn("flock", [path.join(cpu, "slot-1.lock"), "sleep", "120"], { stdio: "ignore", detached: true });
    await waitFor(() => fs.existsSync(path.join(cpu, "slot-1.lock")), "the slot is held");
    await realSleep(300);
    r = loop(["--hours", "1", "--max", "1"], { FACTORY_CI_TURN_WAIT: "2" });
    await r.end();
    kill(slot);
  });
  test("  the run is given back, saying why", () => { has(r.out(), "ci: Group M (gm): lc found no turn in the machine's memory budget (capped: queued "); });
  test("  it's due again, nothing recorded against it", () => { has(t("ci", "gm"), "due: "); });
  test("  and the lane worked another group's unit meanwhile", () => { has(r.out(), "iteration 1: Z a"); });
  after(() => { kill(slot); });
});

// Two machines, this one and b: Group L's CI took 90 minutes last time and is stale, but b leases
// its data, so b runs it. It doesn't move last call here (#51).
describe("CI on data another machine leases doesn't move this machine's last call", () => {
  let r: Run, before = "";
  test("Group L's data leased by b: last call 60 minutes before the stop, not 60 + 15 + 90", async () => {
    setup("edit-group", "gm", "--ci", "none");
    f.editMain("tracker/project.json", (p) => { p.store = { remote: f.w.at("store"), paths: { out: "work/out/{group}" } }; p.ci_every = 0; });
    setup("add-group", "gl", "--title", "Group L", "--ci", "lc", "--data", "x=1");
    setup("add-unit", "gl/a", "--title", "L a"); setup("done", "gl/a", "--evidence", "x");
    setup("ci-start", "gl"); setup("ci-pass", "gl", "--evidence", "same", "--secs", "5400");
    setup("add-unit", "gl/b", "--title", "L b"); setup("done", "gl/b", "--evidence", "x");
    f.a.setup(["lease", "take", "gl"], { FACTORY_HOST: "b" });
    setup("add-unit", "gz/b", "--title", "Z b", "--host", "b");
    // (b's heartbeat isn't faked: its lease is kept live all night.)
    r = loop(["--hours", "6", "--last-call", "60"], { FACTORY_LEASE_STALE: String(24 * 3600) });
    await r.until("waiting: nothing workable: 1 unit for another machine");
    await r.at(299 * 60);
    before = r.out();
    await r.at(300 * 60 + 10);
    // In last call the lane still waits for b's unit, as at any other time (#99): to the stop.
    await r.at(6 * 3600);
    await r.end();
  });
  test("  ci --json says b runs it, not this machine", () => { const c = JSON.parse(t("ci", "--json")).find((x: { group: string }) => x.group === "gl"); assert.equal(c.runs_here, false); });
  test("  not before", () => { hasnt(before, "last call"); });
  test("  then, with nothing said of CI", () => { has(r.out(), `last call, stopping at ${hmAt(r.t0, 6 * 3600)}: no new units`); });
  test("  and this machine doesn't run it", () => { hasnt(r.out(), "ci: Group L (gl): lc"); });
  after(() => {
    // (The store stays: Group L's data is on it.)
    f.a.setup(["lease", "release", "gl", "--force"]); setup("edit-group", "gl", "--ci", "none"); setup("drop", "gz/b", "--why", "test");
  });
});

// Group D's CI is two steps, the second using the desk, which another job holds for 20 minutes:
// the run waits for it before it starts (it takes the desk as it starts), then runs. What's
// recorded for last call is the steps' own time, not the 20 minutes waited.
describe("a CI run that waited 20 minutes for a resource records only its steps' time", () => {
  let r: Run, desk: ReturnType<typeof spawn> | null = null;
  test("the desk held 20 minutes, then let go: the run waits, then passes", async () => {
    setup("add-group", "gd", "--title", "Group D", "--ci", "lc,desk");
    setup("add-unit", "gd/a", "--title", "D a"); setup("done", "gd/a", "--evidence", "x");
    setup("add-unit", "gz/c", "--title", "Z c");
    const L = a.locks;
    fs.mkdirSync(L, { recursive: true });
    desk = spawn("flock", [path.join(L, "res-desk.lock"), "sleep", "300"], { stdio: "ignore", detached: true });
    await waitFor(() => fs.existsSync(path.join(L, "res-desk.lock")), "the desk is held");
    await realSleep(300);
    // The lane works Z c while the run waits, then waits for the desk itself.
    r = loop(["--hours", "4"]);
    // (A step's wait for its end is on the loop's clock: it's moved as time passes.)
    await r.flow(120);
    await r.until("Group D (waiting for the desktop)");
    await r.at(20 * 60);
    kill(desk);
    await realSleep(300);
    await r.flow(20 * 60 + 30);
    await r.until("ci: Group D (gd) passed");
    await r.end();
  });
  test("  it waited, then ran", () => { assert.equal(order(r.out(), /Group D \(waiting for the desktop\)|ci: Group D \(gd\): lc, desk|ci: Group D \(gd\) passed/), "Group D (waiting for the desktop),ci: Group D (gd): lc, desk,ci: Group D (gd) passed"); });
  test("  its time is the step's, under a minute, not the 20 minutes waited", () => {
    const c = JSON.parse(t("ci", "--json")).find((x: { group: string }) => x.group === "gd");
    assert.ok(typeof c.secs === "number" && c.secs < 60, `secs ${c.secs}`);
  });
  after(() => { kill(desk); });
});

// Group R's CI step fails once, then passes on its retry 20 minutes later: what's recorded is the
// two tries' own time, not the 20 minutes between them.
describe("a CI run whose step was retried 20 minutes later records only its tries' time", () => {
  let r: Run;
  test("the step fails, then passes on its retry", async () => {
    setup("edit-group", "gd", "--ci", "none");
    const top = path.dirname(a.dir);
    f.editMain("tracker/project.json", (p) => { p.ci.steps.flaky = { cmd: `test -e ${top}/flaky.ok || { touch ${top}/flaky.ok; exit 1; }; echo passed this time` }; });
    setup("add-group", "gr", "--title", "Group R", "--ci", "flaky");
    setup("add-unit", "gr/a", "--title", "R a"); setup("done", "gr/a", "--evidence", "x");
    setup("add-unit", "gz/d", "--title", "Z d");
    r = loop(["--hours", "4", "--max", "1"], { FACTORY_CI_RETRY_WAIT: "1200" });
    await r.flow(60);
    await r.until("trying again in 1200s");
    await r.at(20 * 60 + 60);
    await r.flow(20 * 60 + 90);
    await r.until("ci: Group R (gr) passed");
    await r.end();
  });
  test("  its time is its tries', under a minute, not the 20 minutes between them", () => {
    const c = JSON.parse(t("ci", "--json")).find((x: { group: string }) => x.group === "gr");
    assert.ok(typeof c.secs === "number" && c.secs < 60, `secs ${c.secs}`);
  });
});
