// How the overseer is woken: its wait, in the background, hears news as it comes; a timer's check
// (`fleet wait --check`) is the safety net, and says in one command which of three states the wait
// is in: running (one line, no lane read, nothing to post), not running (what changed since, and to
// start one), or past its time and not back (ended, then as not running). A quiet wait a timer
// checks in on watches past its 55 minutes, so the two don't both wake the overseer; without one it
// returns on time. And finished work that has waited too long for memory to land is news: the
// heartbeat says so where it said "nothing for you". One lane runs throughout, its unit held and
// its stop time hours off, so nothing is at stake unless a test makes it so.
// Run: node --test test/loop/fleet/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { has, hasnt, lastLine, lines, readOr, until, killGroup, alive, HOST } from "../../lib/index.ts";
import { fleetFactory, readNext } from "./helpers.ts";

const f = fleetFactory("fwtimer");
const { F, w, bg, fleet, ev, lane, setup, hold } = f;
const lockOf = (as: string) => path.join(F, `runs/.wait-${as}.lock`);
// fleet wait in the background, once it has taken its first look at the lane's events (an event
// logged after is news to it) and said when it's back at the latest (its lock file's third word).
async function waitFor(args: string[], as: string, add: NodeJS.ProcessEnv = {}) {
  const read = readNext(path.join(lane(1), "runs/events.log"));
  const b = bg(path.join(F, "factory/fleet.sh"), ["wait", ...args, "--as", as], { add: { FACTORY_WAIT_EVERY: "1", ...add } });
  await read();
  await until(() => readOr(lockOf(as)).trim().split(" ").length === 3, "the wait says when it's back", 30);
  return b;
}
const check = (as: string) => fleet(["wait", "--check", "--as", as]);
// When the wait for this overseer is back at the latest, in minutes from now.
const backIn = (as: string) => (Number(readOr(lockOf(as)).trim().split(" ")[2]) - Date.now() / 1000) / 60;
const held = hold("g/held");

describe("a lane to watch", () => {
  test("one lane, busy on a unit, its stop time three hours off", async () => {
    setup(["add-unit", "g/held", "--title", "Held unit"]);
    has(fleet(["start", "--hours", "3", "--no-awake"]).stdout, `=== ${HOST} lane 1`);
    await held.held();
    has(fleet(["beat"]).stdout, "1 busy, 0 waiting, 0 stopped");
  });
  // (A check counts from the attach, or the last wait or check since.)
  test("and its overseer, attached", () => { has(fleet(["attach", "--as", "ovT"]).stdout, "overseer: ovT"); });
});

describe("a timer's check while the overseer's wait runs", () => {
  let b: Awaited<ReturnType<typeof waitFor>>, r = { code: 0, stdout: "" };
  after(() => { if (b) killGroup(b.pid!); });
  test("it isn't refused: exit 0", async () => {
    b = await waitFor(["--minutes", "5"], "ovT");
    ev("stuck", "Noisy unit (g/noisy): stuck: while the wait runs");
    r = check("ovT");
    assert.equal(r.code, 0, r.stdout);
  });
  test("  one line: the wait is running, with its pid and when it's back at the latest", () => {
    assert.equal(lines(r.stdout), 1, r.stdout);
    assert.match(r.stdout, /^watching: the wait for overseer ovT is running \(pid [0-9]+, since [0-9:]+, back by [0-9:]+ at the latest\)/);
  });
  test("  and nothing to do or post", () => { has(r.stdout, "Nothing to do: end your turn, and post nothing."); });
  test("  no heartbeat, and no news of its own: those are the wait's", () => {
    hasnt(r.stdout, "busy, ");
    hasnt(r.stdout, "Noisy unit");
  });
  test("  the wait wakes for the news at once", async () => { has((await b.end(30)).stdout, "woke: news: stuck"); });
  test("a second wait is still refused, exit 2", async () => {
    b = await waitFor(["--minutes", "5"], "ovT");
    const x = fleet(["wait", "--minutes", "0.1", "--as", "ovT"]);
    assert.equal(x.code, 2);
    has(x.stdout, "a wait for overseer ovT is already running (pid");
  });
});

describe("a timer's check when the wait died", () => {
  let r = { code: 0, stdout: "" };
  test("with no wait running, it reads what changed since the overseer last heard, exit 0", async () => {
    // A summary event, so the wait watches on: what it would have told dies with it.
    const b = await waitFor(["--minutes", "5"], "ovT");
    ev("store-aside", "set aside while the wait ran");
    killGroup(b.pid!);
    await b.done;
    ev("stuck", "Unwatched unit (g/unwatched): stuck: after the wait died");
    r = check("ovT");
    assert.equal(r.code, 0, r.stdout);
    has(r.stdout, "woke: news: stuck");
    has(r.stdout, "Unwatched unit (g/unwatched)");
  });
  test("  with a heartbeat", () => { has(r.stdout, "1 busy, 0 waiting"); });
  test("  and its last line says no wait is running, and the command that starts one", () => {
    assert.equal(lastLine(r.stdout), "no wait is running for overseer ovT: act on the above, then start one in the background: just fleet wait --as ovT");
  });
  test("  with nothing changed, it still says to start one", () => {
    r = check("ovT");
    has(r.stdout, "woke: time: nothing to act on since the last check");
    has(lastLine(r.stdout), "no wait is running for overseer ovT");
  });
  test("  noted in the overseer's journal", () => { has(readOr(path.join(F, "runs/oversee.log")), "check: no wait was running; woke: time"); });
});

// A wait that hangs holds its lock, so "running" alone would leave the lanes unwatched all night
// behind a check that says all is well.
describe("a timer's check when the wait is past its time and not back", () => {
  let b: Awaited<ReturnType<typeof waitFor>>, r = { code: 0, stdout: "" }, pid = 0;
  after(() => { if (b) killGroup(b.pid!); });
  test("it ends the wait", async () => {
    b = await waitFor(["--minutes", "5"], "ovT");
    // As a wait due back 20 minutes ago would have it.
    const [p, since] = readOr(lockOf("ovT")).trim().split(" ");
    pid = Number(p);
    fs.writeFileSync(lockOf("ovT"), `${p} ${since} ${Math.floor(Date.now() / 1000) - 1200}\n`);
    ev("store-aside", "set aside while the wait hung");
    r = check("ovT");
    assert.equal(r.code, 0, r.stdout);
    assert.ok(!alive(pid), "the wait's process is gone");
  });
  test("  says so", () => { assert.match(r.stdout, /the wait for overseer ovT \(pid [0-9]+\) was due back by [0-9:]+ and hadn't returned: ended/); });
  test("  reads what happened meanwhile", () => { has(r.stdout, "(1 more for the morning summary"); });
  test("  and says to start one", () => { has(lastLine(r.stdout), "start one in the background: just fleet wait --as ovT"); });
});

// The quiet wait's time (55 minutes; a few seconds here) is there to wake the overseer inside its
// prompt cache's hour. A timer's check-in did that already, so the wait watches on.
describe("a quiet wait and a timer", () => {
  test("with no timer, a quiet wait returns on its time", async () => {
    fs.rmSync(path.join(F, "runs/.tick-ovT"), { force: true });   // (the checks above: no timer's)
    const b = await waitFor([], "ovT", { FACTORY_WAIT_QUIET: "0.05" });
    const o = (await b.end(30)).stdout;
    has(o, "woke: time: 0.05 min passed with nothing to act on");
    hasnt(o, "your timer checked in");
  });
  test("a timer's check-in during it: the wait watches on past its time, and says why", async () => {
    const b = await waitFor([], "ovT", { FACTORY_WAIT_QUIET: "0.2" });
    has(check("ovT").stdout, "watching: the wait for overseer ovT is running");
    const o = (await b.end(60)).stdout;
    assert.match(o, /woke: time: [0-9]+ s passed with nothing to act on \(past 0\.2 min: your timer checked in meanwhile\)/);
    assert.ok(Number(/woke: time: ([0-9]+) s/.exec(o)![1]) > 12, o);
  });
});

// Finished work waiting too long to land (one night a landing check sat two hours behind another
// process's reservation while every check-in said the lanes were busy and nothing was for the
// owner): the loop's event wakes the wait, and the heartbeat says it while it lasts.
describe("finished work that waits too long to land", () => {
  const cpu = w.env.FACTORY_CPU_LOCKS!;
  const proj = path.basename(F);
  const sleeper = spawn("sleep", ["300"], { stdio: "ignore" });
  after(() => { sleeper.kill(); });
  // A lane's landing check waiting its turn in the budget, as heavy.ts leaves it (wait-<pid>.json).
  const waits = (mins: number, lanes = `${proj}-lane1`, own = true) => {
    fs.mkdirSync(cpu, { recursive: true });
    fs.writeFileSync(path.join(cpu, `wait-${sleeper.pid}.json`), JSON.stringify({ what: `the landing check (${lanes})`, lane: lanes, mem: 8 * 1024 ** 3,
      since: Date.now() - mins * 60_000, why: "memory: needs 8.0G, and 7.3G of the budget's 26G is free; held by editor, a standing reservation (15G, while pid 1 runs)", pid: sleeper.pid, ...(own ? { holdsLane: true } : {}) }) + "\n");
  };
  const beat = () => fleet(["beat"]).stdout;
  test("a landing check that has waited 47 minutes for memory: the heartbeat says so, not \"nothing for you\"", () => {
    waits(47);
    const o = beat();
    has(o, `the landing check (${proj}-lane1) has waited 47 min for memory on ${HOST}, and its lane's work with it`);
    hasnt(o, "nothing for you");
  });
  test("  one that has waited 5 minutes isn't said: landings take that long", () => {
    waits(5);
    has(beat(), "nothing for you");
  });
  test("  nor another project's, nor a session's own job", () => {
    waits(47, "elsewhere-lane1");
    has(beat(), "nothing for you");
    waits(47, `${proj}-lane1`, false);
    has(beat(), "nothing for you");
  });
  test("  and a wait that starts while it lasts has something at stake: 30 minutes, not 55", async () => {
    waits(47);
    const b = await waitFor([], "ovT", { FACTORY_WAIT_QUIET: "0.05" });
    const mins = backIn("ovT");
    killGroup(b.pid!);
    await b.done;
    fs.rmSync(path.join(cpu, `wait-${sleeper.pid}.json`), { force: true });
    assert.ok(mins > 28 && mins <= 30, `back in ${mins} min`);
  });
  test("the loop's landing-waits event wakes the wait", async () => {
    const b = await waitFor(["--minutes", "5"], "ovT");
    ev("landing-waits", "Unit late (g/late) is finished and hasn't landed: the landing check has waited 30 min for its turn in the machine's memory budget");
    const o = (await b.end(30)).stdout;
    has(o, "woke: news: landing-waits");
    has(o, "landing-waits · Unit late (g/late) is finished and hasn't landed");
  });
  test("  and the morning summary puts it with what went wrong", () => {
    const o = fleet(["summary"]).stdout;
    assert.ok(o.indexOf("landing-waits (1):") > 0 && o.indexOf("landing-waits (1):") < o.indexOf("The rest:"), o);
  });
});
