// Usage: pause near the 5-hour limit and resume at the reset; the week's figure is shown, never
// acted on. What factory/usage.sh reads from the transcripts and from the machine's one reading
// (FACTORY_USAGE_FILE, which every factory's lanes on the machine write and act on), and the
// loop's pause and resume. The loop runs in this process with its clock mocked (inproc.ts): it
// resumes exactly at the window's reset and its slack (FACTORY_USAGE_SLACK, 60 s), with no new
// reading.
// Run: node --test test/loop/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { has, hasnt, chomp } from "../lib/index.ts";
import { dayHm } from "../../runtime/src/sys.ts";
import { nextSecond, hmAt, hmsAt, type Run } from "./inproc.ts";
import { loopFactory } from "./factory.ts";

const f = loopFactory("usage");
const { a, setup, loop, events } = f;
const usage = (args: string[], add: NodeJS.ProcessEnv = {}) => a.run("factory/usage.sh", args, add);
const usageOut = (...args: string[]) => chomp(usage(args).stdout);
const reading = a.at("runs/zz-usage.jsonl");
// The machine's reading. A test whose reading is no newer than the last one's starts the
// machine afresh (forget): the newest reading is the one acted on, whoever read it.
const SHARED = a.envWith().FACTORY_USAGE_FILE!;
const forget = () => fs.rmSync(SHARED, { force: true });
const mtime = (p: string) => Math.floor(fs.statSync(p).mtimeMs / 1000);
const touch = (p: string, t: number) => fs.utimesSync(p, t, t);
const event = (five: number, fiveAt: number, week?: [number, number]) => JSON.stringify({ type: "rate_limit_event", rate_limit_info: { unifiedWindows: {
  five_hour: { utilization: five, resetsAt: fiveAt }, ...(week ? { seven_day: { utilization: week[0], resetsAt: week[1] } } : {}) } } });
// This factory's own newest reading, read at t (its file's time).
const put = (file: string, ev: string, t: number) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, ev + "\n"); touch(file, t); };
const WEEK = 7 * 86400;
// A week's reset just under half a week off.
const HALF = WEEK / 2 - 300;
const dayHmAt = (t: number) => dayHm(new Date(t * 1000));

// The loop's clock starts at now: the 5-hour window resets 4 s after it. The week resets 25
// hours on.
const now = nextSecond();
fs.mkdirSync(a.at("runs"), { recursive: true });
fs.writeFileSync(reading, event(0.95, now + 4, [0.5, now + 90000]) + "\n");

describe("what usage.sh reads", () => {
  test("usage show", () => { has(usageOut("show"), "5-hour window 95% used"); });
  test("  and the week's", () => { has(usageOut("show"), `week 50% used, resets ${dayHmAt(now + 90000)}`); });
  test("usage json: each window's share used and its reset, and the reading's time (its file's)", () => {
    assert.equal(usageOut("json"), `{"five_hour":{"used":0.95,"resetsAt":${now + 4}},"seven_day":{"used":0.5,"resetsAt":${now + 90000}},"asOf":${mtime(reading)}}`);
  });
  test("  and how old its reading is", () => { has(usageOut("show"), "min ago)"); });
  let asOf: unknown;
  test("  dated by the transcript line before the event", () => {
    const old = a.at("runs/zz-old.jsonl");
    fs.writeFileSync(old, `{"type":"assistant","timestamp":"${new Date((now - 3 * 3600 - 60) * 1000).toISOString().replace(/\.\d+Z$/, ".000Z")}"}\n${fs.readFileSync(reading, "utf8")}`);
    touch(reading, now - 10);
    forget();
    const show = usageOut("show");
    asOf = JSON.parse(usageOut("json")).asOf;
    fs.rmSync(old);
    has(show, "3h ago)");
  });
  test("  usage json too", () => { assert.equal(asOf, now - 3 * 3600 - 60); });
});

describe("usage: pause near the 5-hour limit and resume at the reset", () => {
  let r: Run, before = "";
  test("under 8% of the 5-hour window: the lane pauses", async () => {
    setup("add-unit", "g/three", "--title", "Unit three");
    r = loop(["--hours", "0.05"], {}, now);
    await r.until("usage pause");
    await r.flow(63);
    before = r.out();
    await r.flow(64);
    await r.end();
    has(r.out(), `${hmsAt(now, 0)} loop: usage pause: under 8% of the 5-hour window left; resuming at ${hmAt(now, 4)}`);
  });
  test("  and resumes at the reset", () => { has(r.out(), "usage resume"); });
  test("  its slack (60 s) after it, not before", () => {
    hasnt(before, "usage resume");
    has(r.out(), `${hmsAt(now, 64)} loop: usage resume: the 5-hour window reset`);
  });
  test("  then works", () => { has(r.out(), "Unit three (g/three)"); });
  test("  both reach the overseer", () => { has(events(), "usage-resume"); });
  test("  the pause is an event too", () => { has(events(), "usage-pause\tunder 8% of the 5-hour window left; lanes resume at"); });
});

// The week's figure is shown, never acted on: the owner decides how the week is spent, and holds
// the lanes back by hand to keep some of it. (A line the lanes kept under paused them on nights
// the owner wanted the week used up, and held back group CI, which uses no model, until the
// reset: docs/lessons.md.)
describe("usage: the week nearly used, or all used, doesn't stop a lane", () => {
  let out = "", t = 0, code = -1, show = "";
  test("97% of the week used: the lane works", async () => {
    t = nextSecond();
    forget(); put(reading, event(0.1, t + 9000, [0.97, t + 90000]), t - 100);
    setup("add-unit", "g/four", "--title", "Unit four");
    code = usage(["check"]).code; show = usageOut("show");
    out = (await loop(["--hours", "0.05"], {}, t).end()).out;
    has(out, "Unit four (g/four)");
  });
  test("  with no pause", () => { hasnt(out, "usage pause"); });
  test("  and check carries on", () => { assert.equal(code, 0); });
  test("  usage show still shows the week", () => { has(show, `week 97% used, resets ${dayHmAt(t + 90000)}`); });
  let all = "", allCode = -1;
  test("100% of the week used: the lane works", async () => {
    t = nextSecond();
    forget(); put(reading, event(0.1, t + 9000, [1, t + 90000]), t - 100);
    setup("add-unit", "g/five", "--title", "Unit five");
    allCode = usage(["check"]).code;
    all = (await loop(["--hours", "0.05"], {}, t).end()).out;
    has(all, "Unit five (g/five)");
  });
  test("  with no pause", () => { hasnt(all, "usage pause"); });
  test("  and check carries on", () => { assert.equal(allCode, 0); });
});

// A profile written for the line still has its row ("keep back", or the older "stop below"):
// neither is read any more.
describe("usage: a profile's old row for the week acts on nothing", () => {
  const profile = f.w.env.WFACTORY_PROFILE!;
  let out = "", code = -1;
  test("keep back 15 and stop below 20, 99% of the week used: the lane works", async () => {
    const saved = fs.readFileSync(profile, "utf8");
    const t = nextSecond();
    forget(); put(reading, event(0.1, t + 9000, [0.99, t + 90000]), t - 100);
    setup("add-unit", "g/six", "--title", "Unit six");
    fs.writeFileSync(profile, saved.replace(/^\| pause below \| 8 \|$/m, "| pause below | 8 |\n| keep back | 15 |\n| stop below | 20 |"));
    try { code = usage(["check"]).code; out = (await loop(["--hours", "0.05"], {}, t).end()).out; } finally { fs.writeFileSync(profile, saved); }
    has(out, "Unit six (g/six)");
  });
  test("  with no pause", () => { hasnt(out, "usage pause"); });
  test("  and check carries on", () => { assert.equal(code, 0); });
});

// The usual way to the pause: a unit's session carries a reading with the 5-hour window nearly used.
describe("usage: a session's own reading near the 5-hour limit pauses the lane before its next unit", () => {
  let out = "", machine = -1;
  test("the first unit works, on a reading with the window far from used", async () => {
    const t = nextSecond();
    forget(); put(reading, event(0.1, t + 9000, [0.3, t + HALF]), t - 100);
    setup("add-unit", "g/ten", "--title", "Unit ten");
    setup("add-unit", "g/eleven", "--title", "Unit eleven");
    const r = loop(["--hours", "0.05"], { FACTORY_FAKE_RL: event(0.95, t + 9000, [0.3, t + HALF]) }, t);
    await r.until("usage pause");
    await r.at(180);
    out = (await r.end()).out;
    machine = JSON.parse(fs.readFileSync(SHARED, "utf8")).rate_limit_info.unifiedWindows.five_hour.utilization;
    // Its session's transcript goes, or its reading would stay this factory's newest for the tests after.
    for (const n of fs.readdirSync(a.at("runs"))) if (n.endsWith(".jsonl") && a.at(`runs/${n}`) !== reading && fs.readFileSync(a.at(`runs/${n}`), "utf8").includes('"rate_limit_event"')) fs.rmSync(a.at(`runs/${n}`));
    has(out, "iteration 1: Unit ");
  });
  test("  its session's reading has the window nearly used: the lane pauses", () => { has(out, "usage pause: under 8% of the 5-hour window left"); });
  test("  before a second unit", () => { hasnt(out, "iteration 2"); });
  test("  and that reading is the machine's now", () => { assert.equal(machine, 0.95); });
  // (The second unit is worked by a later test's run.)
});

describe("usage: a paused lane, its setting changed", () => {
  const profile = f.w.env.WFACTORY_PROFILE!;
  let changed = "";
  test("pause below set to 0: it resumes at its next look", async () => {
    const saved = fs.readFileSync(profile, "utf8");
    const t = nextSecond();
    forget(); put(reading, event(0.95, t + 9000, [0.3, t + HALF]), t - 100);
    setup("add-unit", "g/twelve", "--title", "Unit twelve");
    const r = loop(["--hours", "1"], {}, t);
    await r.until("usage pause");
    fs.writeFileSync(profile, saved.replace(/^\| pause below \| 8 \|$/m, "| pause below | 0 |"));
    try { await r.at(60); changed = (await r.end()).out; } finally { fs.writeFileSync(profile, saved); }
    has(changed, `${hmsAt(t, 60)} loop: usage resume: the 5-hour window is no longer nearly used (a newer reading, or a changed setting)`);
  });
  test("  and works", () => { has(changed, "Unit twelve (g/twelve)"); });
});

// The plan is one for every factory on the machine: the lanes of each write the newest reading
// they've read to the machine's one file, and act on the newest there.
describe("usage: two factories on one machine act on the newest reading", () => {
  const other = loopFactory("other", { lane: "b" });
  const theirs = other.a.at("runs/zz-usage.jsonl");
  let t = 0, out = "", show = "", stale = "";
  test("the other factory's lane, its 5-hour window nearly used, pauses", async () => {
    t = nextSecond();
    forget();
    // This factory's own reading is far from the limit, and older than the other's.
    put(reading, event(0.3, t + 300, [0.3, t + HALF]), t - 100);
    put(theirs, event(0.95, t + 300, [0.6, t + HALF]), t - 10);
    stale = usageOut("show");
    const r = other.loop(["--hours", "0.01"], { FACTORY_USAGE_FILE: SHARED }, t);
    await r.until("usage pause");
    await r.at(36);
    has((await r.end()).out, "usage pause: under 8% of the 5-hour window left");
  });
  test("  before it read that, this factory's own reading stood", () => { has(stale, "5-hour window 30% used"); });
  test("this factory's lane acts on it: it pauses, its own reading far from the limit", async () => {
    setup("add-unit", "g/nine", "--title", "Unit nine");
    show = usageOut("show");
    const r = loop(["--hours", "0.01"], {}, t);
    await r.until("usage pause");
    await r.at(36);
    out = (await r.end()).out;
    has(out, `usage pause: under 8% of the 5-hour window left; resuming at ${hmAt(t, 300)}`);
  });
  test("  and stops at its stop time, paused or not", () => { has(out, "out of time (--hours 0.01)"); });
  test("  and starts no session", () => { hasnt(out, "iteration 1"); });
  test("  usage show says whose lanes read it", () => { has(show, "read by b's lanes)"); has(show, "5-hour window 95% used"); });
  // A paused lane looks again each minute: the time it's due back moves with a newer reading,
  // with no resume in between, and it resumes once a reading no longer has it near the limit.
  let later = "", end = "";
  test("a paused lane, a newer reading with a later reset: it stays paused, until later", async () => {
    const r = loop(["--hours", "1"], {}, t);
    await r.until("usage pause");
    put(theirs, event(0.96, t + 600, [0.6, t + HALF]), t - 5);
    other.a.run("factory/usage.sh", ["show"], { FACTORY_USAGE_FILE: SHARED });
    await r.at(60);
    later = r.out();
    put(reading, event(0.2, t + 600, [0.6, t + HALF]), t - 1);
    await r.at(120);
    end = (await r.end()).out;
    has(later, `${hmsAt(t, 60)} loop: usage pause: under 8% of the 5-hour window left; resuming at ${hmAt(t, 600)}`);
  });
  test("  with no resume in between", () => { hasnt(later, "usage resume"); });
  test("  and the overseer hears the new time", () => { has(events(), `usage-pause\tunder 8% of the 5-hour window left; lanes resume at ${hmAt(t, 600)}`); });
  test("a reading that no longer has it near the limit: it resumes at its next look", () => {
    has(end, `${hmsAt(t, 120)} loop: usage resume: the 5-hour window is no longer nearly used (a newer reading, or a changed setting)`);
  });
  test("  and works", () => { has(end, "Unit nine (g/nine)"); });
  test("  the resume is an event", () => { has(events(), "usage-resume\tthe 5-hour window is no longer nearly used"); });
  test("  this factory's reading, the newest now, is the machine's", () => {
    assert.equal(JSON.parse(fs.readFileSync(SHARED, "utf8")).rate_limit_info.unifiedWindows.five_hour.utilization, 0.2);
  });
});

describe("usage json without a reading, or past its reset", () => {
  test("usage json: a window past its reset is unused, one not given is null", () => {
    forget();
    fs.writeFileSync(reading, event(0.97, now - 60) + "\n");
    assert.equal(usageOut("json"), `{"five_hour":{"used":0,"resetsAt":${now - 60}},"seven_day":null,"asOf":${mtime(reading)}}`);
  });
  test("  and check carries on", () => { assert.equal(usage(["check"]).code, 0); });
  test("a week past its reset is fresh: nothing used", () => {
    forget(); put(reading, event(0.1, now + 9000, [0.97, now - 60]), now - 100);
    assert.equal(JSON.parse(usageOut("json")).seven_day.used, 0);
  });
  test("usage json with no reading, here or on the machine: nulls", () => {
    fs.rmSync(reading); forget();
    assert.equal(usageOut("json"), '{"five_hour":null,"seven_day":null,"asOf":null}');
  });
  test("usage show with no reading says so", () => { has(usageOut("show"), "usage: not known yet"); });
});
