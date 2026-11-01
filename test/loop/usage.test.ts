// Usage: pause near the 5-hour limit and resume at the reset; the week's figure is never acted
// on. What factory/usage.sh reads from the transcripts, and the loop's pause and resume. The loop
// runs in this process with its clock mocked (inproc.ts): it resumes exactly at the reset and
// its slack (FACTORY_USAGE_SLACK, 60 s). Run: node --test test/loop/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { has, hasnt, chomp } from "../lib/index.ts";
import { nextSecond, hmAt, hmsAt, type Run } from "./inproc.ts";
import { loopFactory } from "./factory.ts";

const f = loopFactory("usage");
const { a, setup, loop, events } = f;
const usage = (...args: string[]) => a.run("factory/usage.sh", args);
const usageOut = (...args: string[]) => chomp(a.run("factory/usage.sh", args).stdout);
const reading = a.at("runs/zz-usage.jsonl");
const mtime = (p: string) => Math.floor(fs.statSync(p).mtimeMs / 1000);
const touch = (p: string, t: number) => fs.utimesSync(p, t, t);
const event = (five: number, fiveAt: number, week?: [number, number]) => JSON.stringify({ type: "rate_limit_event", rate_limit_info: { unifiedWindows: {
  five_hour: { utilization: five, resetsAt: fiveAt }, ...(week ? { seven_day: { utilization: week[0], resetsAt: week[1] } } : {}) } } });

// The loop's clock starts at now: the 5-hour window resets 4 s after it.
const now = nextSecond();
fs.mkdirSync(a.at("runs"), { recursive: true });
fs.writeFileSync(reading, event(0.95, now + 4, [0.5, now + 90000]) + "\n");

describe("what usage.sh reads", () => {
  test("usage show", () => { has(usageOut("show"), "5-hour window 95% used"); });
  test("usage json: each window's share used and its reset, and the reading's time (its file's)", () => {
    assert.equal(usageOut("json"), `{"five_hour":{"used":0.95,"resetsAt":${now + 4}},"seven_day":{"used":0.5,"resetsAt":${now + 90000}},"asOf":${mtime(reading)}}`);
  });
  test("  and how old its reading is", () => { has(usageOut("show"), "min ago)"); });
  let asOf: unknown;
  test("  dated by the transcript line before the event", () => {
    const old = a.at("runs/zz-old.jsonl");
    fs.writeFileSync(old, `{"type":"assistant","timestamp":"${new Date((now - 3 * 3600 - 60) * 1000).toISOString().replace(/\.\d+Z$/, ".000Z")}"}\n${fs.readFileSync(reading, "utf8")}`);
    touch(reading, now - 10);
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

describe("usage: the week nearly used doesn't stop a lane", () => {
  let out = "";
  test("97% of the week used: the lane works", async () => {
    fs.writeFileSync(reading, event(0.1, now + 9000, [0.97, now + 90000]) + "\n");
    setup("add-unit", "g/four", "--title", "Unit four");
    out = (await loop(["--hours", "0.05"]).end()).out;
    has(out, "Unit four (g/four)");
  });
  test("  with no usage stop or week pause", () => { hasnt(out, "usage stop"); hasnt(out, "usage pause"); hasnt(events(), "usage-stop"); });
  test("  and check carries on", () => { assert.equal(usage("check").code, 0); });
});

describe("usage json without a reading, or past its reset", () => {
  test("usage json: a window past its reset is unused, one not given is null", () => {
    fs.writeFileSync(reading, event(0.97, now - 60) + "\n");
    assert.equal(usageOut("json"), `{"five_hour":{"used":0,"resetsAt":${now - 60}},"seven_day":null,"asOf":${mtime(reading)}}`);
  });
  test("  and check carries on", () => { assert.equal(usage("check").code, 0); });
  test("usage json with no reading: nulls", () => {
    fs.rmSync(reading);
    assert.equal(usageOut("json"), '{"five_hour":null,"seven_day":null,"asOf":null}');
  });
  test("usage show with no reading says so", () => { has(usageOut("show"), "usage: not known yet"); });
});
