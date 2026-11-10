// Usage: pause near the 5-hour limit and resume at the reset; pause ahead of the week's line
// and resume when the line reaches what's used. What factory/usage.sh reads from the transcripts
// and from the machine's one reading (FACTORY_USAGE_FILE, which every factory's lanes on the
// machine write and act on), and the loop's pause and resume. The loop runs in this process with
// its clock mocked (inproc.ts): it resumes exactly at the time worked out when it paused, with
// no new reading (a window's own reset is waited out FACTORY_USAGE_SLACK, 60 s, longer).
// The week's line: the share of the week gone by, less the share kept back (the profile's "keep
// back", 15 here), 7 days before the week's reset being its start.
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
// A week's reset just under half a week off: 5 minutes more than half of it has gone by, so its
// line (42.54%, with 15 kept back) reads "42.5%" whether a second earlier or later.
const HALF = WEEK / 2 - 300, GONE = WEEK - HALF;
const dayHmAt = (t: number) => dayHm(new Date(t * 1000));

// The loop's clock starts at now: the 5-hour window resets 4 s after it. The week resets 25
// hours on, so its line is at 72.3%, and the 50% used is behind it.
const now = nextSecond();
fs.mkdirSync(a.at("runs"), { recursive: true });
fs.writeFileSync(reading, event(0.95, now + 4, [0.5, now + 90000]) + "\n");

describe("what usage.sh reads", () => {
  test("usage show", () => { has(usageOut("show"), "5-hour window 95% used"); });
  test("  with where the week's line is", () => { has(usageOut("show"), `week 50% used, the line is at 72.3%; resets ${dayHmAt(now + 90000)}`); });
  // (The json's line is new with the week's line: its three older fields are as they were.)
  test("usage json: each window's share used and its reset, and the reading's time (its file's)", () => {
    const j = JSON.parse(usageOut("json"));
    delete j.line;
    assert.deepEqual(j, { five_hour: { used: 0.95, resetsAt: now + 4 }, seven_day: { used: 0.5, resetsAt: now + 90000 }, asOf: mtime(reading) });
  });
  test("  and the week's line: the share kept back, what it allows now, no pause behind it", () => {
    const { line } = JSON.parse(usageOut("json"));
    assert.equal(line.keepBack, 15);
    assert.equal(line.pausedUntil, null);
    assert.ok(Math.abs(line.allowed - ((WEEK - 90000) / WEEK) * 0.85) < 0.001, `allowed: ${line.allowed}`);
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

// Half the week gone and 50% of it used: the line is at 42.5% (half of the 85% the lanes may
// use), and reaches 50% when 0.5 / 0.85 of the week has gone by.
// (No session runs while it's paused, so the reading it resumes on is the one it paused on.)
describe("usage: ahead of the week's line, the lane pauses until the line reaches what's used", () => {
  let r: Run, t = 0, before = "", show = "", check = { code: 0, stdout: "" };
  const back = Math.ceil((0.5 / 0.85) * WEEK) - GONE;   // seconds from t: 14 h 44 min
  test("50% used with the line at 42.5%: the lane pauses", async () => {
    t = nextSecond();
    forget(); put(reading, event(0.1, t + 9000, [0.5, t + HALF]), t - 100);
    setup("add-unit", "g/five", "--title", "Unit five");
    show = usageOut("show"); check = usage(["check"]);
    r = loop(["--hours", "20"], {}, t);
    await r.until("usage pause");
    await r.at(back - 1);
    before = r.out();
    await r.at(back);
    await r.end();
    has(before, `${hmsAt(t, 0)} loop: usage pause: the week is ahead of its line (50% used, the line is at 42.5%); resuming at ${dayHmAt(t + back)}`);
  });
  test("  its event names the week and when the lanes come back", () => {
    has(events(), `usage-pause\tthe week is ahead of its line (50% used, the line is at 42.5%); lanes resume at ${dayHmAt(t + back)}`);
  });
  test("  and starts no session while paused", () => { hasnt(before, "iteration 1"); hasnt(before, "usage resume"); });
  test("  it resumes at the time worked out, with no new reading", () => {
    assert.deepEqual([mtime(reading), JSON.parse(fs.readFileSync(SHARED, "utf8")).at], [t - 100, t - 100]);
    has(r.out(), `${hmsAt(t, back)} loop: usage resume: the week's line reached what's used (50%)`);
  });
  test("  the resume is an event", () => { has(events(), `usage-resume\tthe week's line reached what's used (50%) at ${dayHmAt(t + back)}`); });
  test("  then works", () => { has(r.out(), "Unit five (g/five)"); });
  test("usage show prints the line and when the lanes resume", () => {
    has(show, `week 50% used, the line is at 42.5%: lanes pause until ${dayHmAt(t + back)}; resets ${dayHmAt(t + HALF)}`);
  });
  test("usage check: exit 4, with the time the lanes resume at and why", () => {
    assert.equal(check.code, 4);
    assert.equal(chomp(check.stdout), `${t + back}\nthe week is ahead of its line (50% used, the line is at 42.5%)`);
  });
  test("usage json: the line's pausedUntil", () => {
    forget(); put(reading, event(0.1, t + 9000, [0.5, t + HALF]), t - 100);
    assert.equal(JSON.parse(usageOut("json")).line.pausedUntil, t + back);
  });
});

// The usual way to the pause: a unit's session carries a reading that has the week ahead.
describe("usage: a session's own reading ahead of the line pauses the lane before its next unit", () => {
  let out = "", machine = -1;
  test("the first unit works, on a reading behind the line", async () => {
    const t = nextSecond();
    forget(); put(reading, event(0.1, t + 9000, [0.3, t + HALF]), t - 100);
    setup("add-unit", "g/ten", "--title", "Unit ten");
    setup("add-unit", "g/eleven", "--title", "Unit eleven");
    const r = loop(["--hours", "0.05"], { FACTORY_FAKE_RL: event(0.1, t + 9000, [0.5, t + HALF]) }, t);
    await r.until("usage pause");
    await r.at(180);
    out = (await r.end()).out;
    machine = JSON.parse(fs.readFileSync(SHARED, "utf8")).rate_limit_info.unifiedWindows.seven_day.utilization;
    // Its session's transcript goes, or its reading would stay this factory's newest for the tests after.
    for (const n of fs.readdirSync(a.at("runs"))) if (n.endsWith(".jsonl") && a.at(`runs/${n}`) !== reading && fs.readFileSync(a.at(`runs/${n}`), "utf8").includes('"rate_limit_event"')) fs.rmSync(a.at(`runs/${n}`));
    has(out, "iteration 1: Unit ");
  });
  test("  its session's reading has the week ahead: the lane pauses", () => { has(out, "usage pause: the week is ahead of its line (50% used, the line is at 42.5%)"); });
  test("  before a second unit", () => { hasnt(out, "iteration 2"); });
  test("  and that reading is the machine's now", () => { assert.equal(machine, 0.5); });
  // (The second unit is worked by the next test's run.)
});

describe("usage: on or behind the week's line, the lane works", () => {
  let out = "", t = 0, code = -1;
  test("42% used with the line at 42.5%: the lane works", async () => {
    t = nextSecond();
    forget(); put(reading, event(0.1, t + 9000, [0.42, t + HALF]), t - 100);
    setup("add-unit", "g/six", "--title", "Unit six");
    code = usage(["check"]).code;
    out = (await loop(["--hours", "0.05"], {}, t).end()).out;
    has(out, "Unit six (g/six)");
  });
  test("  with no pause", () => { hasnt(out, "usage pause"); });
  test("  and check carries on", () => { assert.equal(code, 0); });
});

// This test asserted the opposite ("97% of the week used: the lane works", with no pause and
// check carrying on) while nothing acted on the week's figure. With the week's line, 97% used a
// day before the reset is past the 85% the lanes may use at all, with 15% kept back.
describe("usage: more of the week used than the lanes may use: paused to its reset", () => {
  let r: Run, t = 0, before = "", code = -1;
  test("97% of the week used: the lane pauses", async () => {
    t = nextSecond();
    forget(); put(reading, event(0.1, t + 9000, [0.97, t + 90000]), t - 100);
    setup("add-unit", "g/four", "--title", "Unit four");
    code = usage(["check"]).code;
    r = loop(["--hours", "30"], {}, t);
    await r.until("usage pause");
    await r.at(90059);
    before = r.out();
    await r.at(90060);
    await r.end();
    has(before, `usage pause: the week is ahead of its line (97% used, the line is at 72.3%); resuming at ${dayHmAt(t + 90000)}`);
  });
  test("  and check says to pause", () => { assert.equal(code, 4); });
  test("  it stays paused to the week's reset, and its slack", () => { hasnt(before, "usage resume"); hasnt(before, "iteration 1"); });
  test("  after the reset the week is fresh: it resumes", () => { has(r.out(), `${hmsAt(t, 90060)} loop: usage resume: the week reset`); });
  test("  and works, with no new reading", () => { has(r.out(), "Unit four (g/four)"); assert.equal(mtime(reading), t - 100); });
  test("  the reset is the resume's event", () => { has(events(), `usage-resume\tthe week reset at ${dayHmAt(t + 90000)}`); });
});

describe("usage: the share kept back", () => {
  const profile = f.w.env.WFACTORY_PROFILE!, saved = fs.readFileSync(profile, "utf8");
  const keep = (row: string) => fs.writeFileSync(profile, saved.replace(/^\| keep back \| 15 \|$/m, row));
  let r: Run, t = 0, before = "", out = "", kept15 = -1;
  test("keep back 15: once 85% is used the lane pauses", async () => {
    t = nextSecond();
    forget(); put(reading, event(0.1, t + 9000, [0.85, t + 90000]), t - 100);
    setup("add-unit", "g/seven", "--title", "Unit seven");
    r = loop(["--hours", "30"], {}, t);
    await r.until("usage pause");
    await r.at(90059);
    before = r.out();
    await r.at(90060);
    await r.end();
    has(before, `usage pause: the week is ahead of its line (85% used, the line is at 72.3%); resuming at ${dayHmAt(t + 90000)}`);
  });
  test("  and stays paused to the reset", () => { hasnt(before, "usage resume"); hasnt(before, "iteration 1"); has(r.out(), `${hmsAt(t, 90060)} loop: usage resume: the week reset`); });
  // On its line with nothing kept back, the week's last share is used in its last minute.
  test("keep back 0: a lane on its line still works in the week's last minute", async () => {
    t = nextSecond();
    forget(); put(reading, event(0.1, t + 9000, [0.9999, t + 30]), t - 100);
    setup("add-unit", "g/eight", "--title", "Unit eight");
    kept15 = usage(["check"]).code;
    keep("| keep back | 0 |");
    try { out = (await loop(["--hours", "0.05"], {}, t).end()).out; } finally { fs.writeFileSync(profile, saved); }
    has(out, "Unit eight (g/eight)");
  });
  test("  with no pause", () => { hasnt(out, "usage pause"); });
  test("  where 15 kept back pauses it", () => { assert.equal(kept15, 4); });
  let changed = "";
  test("a paused lane, the share kept back changed: it resumes at its next look", async () => {
    t = nextSecond();
    forget(); put(reading, event(0.1, t + 9000, [0.5, t + HALF]), t - 100);
    setup("add-unit", "g/twelve", "--title", "Unit twelve");
    const r = loop(["--hours", "1"], {}, t);
    await r.until("usage pause");
    keep("| keep back | 0 |");
    try { await r.at(60); changed = (await r.end()).out; } finally { fs.writeFileSync(profile, saved); }
    has(changed, `${hmsAt(t, 60)} loop: usage resume: the week is no longer ahead of its line (a newer reading, or a changed setting)`);
  });
  test("  and works", () => { has(changed, "iteration 1: Unit twelve (g/twelve)"); });
  test("keep back off: the week is shown, never acted on", () => {
    forget(); put(reading, event(0.1, t + 9000, [0.97, t + 90000]), t - 100);
    keep("| keep back | off |");
    const show = usageOut("show"), code = usage(["check"]).code, line = JSON.parse(usageOut("json")).line;
    fs.writeFileSync(profile, saved);
    has(show, `week 97% used, resets ${dayHmAt(t + 90000)}`);
    assert.equal(code, 0);
    assert.equal(line, null);
  });
  test("a profile's old \"stop below\" row is read as keep back", () => {
    keep("| stop below | 20 |");
    const line = JSON.parse(usageOut("json")).line;
    fs.writeFileSync(profile, saved);
    assert.equal(line.keepBack, 20);
  });
  test("FACTORY_USAGE_KEEP_BACK goes before the profile's", () => {
    assert.equal(JSON.parse(chomp(usage(["json"], { FACTORY_USAGE_KEEP_BACK: "40" }).stdout)).line.keepBack, 40);
  });
});

// The plan is one for every factory on the machine: the lanes of each write the newest reading
// they've read to the machine's one file, and act on the newest there.
describe("usage: two factories on one machine act on the newest reading", () => {
  const other = loopFactory("other", { lane: "b" });
  const theirs = other.a.at("runs/zz-usage.jsonl");
  let t = 0, out = "", show = "", stale = "";
  test("the other factory's lane, ahead of the week's line, pauses", async () => {
    t = nextSecond();
    forget();
    // This factory's own reading is behind the line, and older than the other's.
    put(reading, event(0.1, t + 9000, [0.3, t + HALF]), t - 100);
    put(theirs, event(0.1, t + 9000, [0.6, t + HALF]), t - 10);
    stale = usageOut("show");
    const r = other.loop(["--hours", "0.01"], { FACTORY_USAGE_FILE: SHARED }, t);
    await r.until("usage pause");
    await r.at(36);
    has((await r.end()).out, "usage pause: the week is ahead of its line (60% used");
  });
  test("  before it read that, this factory's own reading stood", () => { has(stale, "week 30% used"); });
  test("this factory's lane acts on it: it pauses, its own reading behind the line", async () => {
    setup("add-unit", "g/nine", "--title", "Unit nine");
    show = usageOut("show");
    const r = loop(["--hours", "0.01"], {}, t);
    await r.until("usage pause");
    await r.at(36);
    out = (await r.end()).out;
    has(out, "usage pause: the week is ahead of its line (60% used, the line is at 42.5%)");
  });
  test("  and stops at its stop time, paused or not", () => { has(out, "out of time (--hours 0.01)"); });
  test("  and starts no session", () => { hasnt(out, "iteration 1"); });
  test("  usage show says whose lanes read it", () => { has(show, "read by b's lanes)"); has(show, "week 60% used"); });
  // A paused lane looks again each minute: the time it's due back moves with a newer reading,
  // with no resume in between, and it resumes once a reading no longer has it ahead.
  let later = "", end = "", moved = 0;
  test("a paused lane, a newer reading with more used: it stays paused, until later", async () => {
    const r = loop(["--hours", "1"], {}, t);
    await r.until("usage pause");
    put(theirs, event(0.1, t + 9000, [0.7, t + HALF]), t - 5);
    other.a.run("factory/usage.sh", ["show"], { FACTORY_USAGE_FILE: SHARED });
    await r.at(60);
    later = r.out();
    put(reading, event(0.1, t + 9000, [0.2, t + HALF]), t - 1);
    await r.at(120);
    end = (await r.end()).out;
    moved = Math.ceil((0.7 / 0.85) * WEEK) - GONE;
    has(later, `${hmsAt(t, 60)} loop: usage pause: the week is ahead of its line (70% used, the line is at 42.5%); resuming at ${dayHmAt(t + moved)}`);
  });
  test("  with no resume in between", () => { hasnt(later, "usage resume"); });
  test("  and the overseer hears the new time", () => { has(events(), `usage-pause\tthe week is ahead of its line (70% used, the line is at 42.5%); lanes resume at ${dayHmAt(t + moved)}`); });
  test("a reading that no longer has it ahead: it resumes at its next look", () => {
    has(end, `${hmsAt(t, 120)} loop: usage resume: the week is no longer ahead of its line (a newer reading, or a changed setting)`);
  });
  test("  and works", () => { has(end, "iteration 1: Unit nine (g/nine)"); });
  test("  the resume is an event naming the week", () => { has(events(), "usage-resume\tthe week is no longer ahead of its line"); });
  test("  this factory's reading, the newest now, is the machine's", () => {
    assert.equal(JSON.parse(fs.readFileSync(SHARED, "utf8")).rate_limit_info.unifiedWindows.seven_day.utilization, 0.2);
  });
});

describe("usage json without a reading, or past its reset", () => {
  test("usage json: a window past its reset is unused, one not given is null", () => {
    forget();
    fs.writeFileSync(reading, event(0.97, now - 60) + "\n");
    assert.equal(usageOut("json"), `{"five_hour":{"used":0,"resetsAt":${now - 60}},"seven_day":null,"asOf":${mtime(reading)},"line":null}`);
  });
  test("  and check carries on", () => { assert.equal(usage(["check"]).code, 0); });
  test("a week past its reset is fresh: nothing used, no pause", () => {
    forget(); put(reading, event(0.1, now + 9000, [0.97, now - 60]), now - 100);
    const j = JSON.parse(usageOut("json"));
    assert.deepEqual([j.seven_day.used, j.line.pausedUntil, usage(["check"]).code], [0, null, 0]);
  });
  test("usage json with no reading, here or on the machine: nulls", () => {
    fs.rmSync(reading); forget();
    assert.equal(usageOut("json"), '{"five_hour":null,"seven_day":null,"asOf":null,"line":null}');
  });
  test("usage show with no reading says so", () => { has(usageOut("show"), "usage: not known yet"); });
});
