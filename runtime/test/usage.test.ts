// What usage.ts acts on (usageCheck): the 5-hour window, never the week, and the machine's one
// reading (newest). The week's figure is shown only: a line the lanes were held under paused them
// when the owner wanted the week spent (docs/lessons.md).
// Run: node --test runtime/test/
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { has, tempDir } from "../../test/lib/index.ts";
import { newest, sharedFile, usageCheck, usageJson, usageShow } from "../src/usage.ts";

const tmp = tempDir("usage-");
// No profile: every setting takes its default, but what a test sets.
const env = (add: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ WFACTORY_PROFILE: path.join(tmp, "no-profile.md"), FACTORY_USAGE_FILE: path.join(tmp, "usage.json"), ...add });
const WEEK_S = 7 * 86400, RESET = 1_800_000_000, START = RESET - WEEK_S, HALF = START + WEEK_S / 2;
const reading = (used: number, at = START) => ({ type: "rate_limit_event", at, rate_limit_info: { unifiedWindows: { seven_day: { utilization: used, resetsAt: RESET } } } });
const both = (five: number, fiveAt: number, week: number, e = env()) => {
  const ev = { type: "rate_limit_event", at: START, rate_limit_info: { unifiedWindows: { five_hour: { utilization: five, resetsAt: fiveAt }, seven_day: { utilization: week, resetsAt: RESET } } } };
  return usageCheck({ ev, json: usageJson(ev, HALF), now: HALF }, e);
};

describe("the week is never acted on", () => {
  test("97% or all of it used, at any time in the week: carry on", () => {
    for (const now of [START + 3600, HALF, RESET - 60]) for (const used of [0.97, 1]) {
      const json = usageJson(reading(used), now);
      assert.equal(usageCheck({ ev: reading(used), json, now }, env()).code, 0, `${used} used, ${(now - START) / 3600} h in`);
    }
  });
  test("  a profile's old rows for it (keep back, stop below) change nothing", () => {
    const f = path.join(tmp, "old-profile.md");
    fs.writeFileSync(f, "| Setting | Value |\n|---|---|\n| keep back | 15 |\n| stop below | 20 |\n");
    assert.equal(both(0.1, HALF + 3600, 0.99, env({ WFACTORY_PROFILE: f })).code, 0);
  });
  test("its json is each window and the reading's time, nothing more", () => {
    assert.deepEqual(Object.keys(usageJson(reading(0.5), HALF)), ["five_hour", "seven_day", "asOf"]);
  });
});

describe("the 5-hour pause", () => {
  test("under 8% of the window left: pause to its reset", () => {
    const c = both(0.95, HALF + 3600, 0.1);
    assert.deepEqual([c.code, c.pause?.until], [4, HALF + 3600]);
  });
  test("  check prints that time, then why", () => {
    assert.equal(both(0.95, HALF + 3600, 0.1).out, `${HALF + 3600}\nunder 8% of the 5-hour window left`);
  });
  test("  with the week all used too, the 5-hour reset is still when the lanes are back", () => {
    assert.equal(both(0.95, HALF + 3600, 1).pause?.until, HALF + 3600);
  });
  test("8% left or more: carry on", () => { assert.equal(both(0.92, HALF + 3600, 0.1).code, 0); });
  test("pause below 0 never pauses", () => { assert.equal(both(0.99, HALF + 3600, 0.1, env({ FACTORY_USAGE_PAUSE_LEFT: "0" })).code, 0); });
});

describe("what show says", () => {
  // 0.07 × 100 is 7.000000000000001 as a float: rounded up as it stood, it read 8%.
  const shown = (used: number) => /week (\d+)% used/.exec(usageShow({ ev: reading(used), json: usageJson(reading(used), HALF), now: HALF }))?.[1];
  test("a whole percent reads as itself", () => { assert.deepEqual([0.07, 0.14, 0.28, 0.55, 0.56, 0.42].map(shown), ["7", "14", "28", "55", "56", "42"]); });
  test("  a part of one rounds up", () => { assert.equal(shown(0.925), "93"); });
  test("the week: what's used and when it resets", () => {
    has(usageShow({ ev: reading(0.97), json: usageJson(reading(0.97), HALF), now: HALF }), "· week 97% used, resets ");
  });
});

describe("one reading per machine", () => {
  const e = env({ FACTORY_USAGE_FILE: path.join(tmp, "state", "wfactory", "usage.json") });
  const factory = (name: string, used: number, at: number) => {
    const root = path.join(tmp, name), f = path.join(root, "runs", "s.jsonl");
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const { at: _at, ...ev } = reading(used);
    fs.writeFileSync(f, JSON.stringify(ev) + "\n"); fs.utimesSync(f, at, at);
    return root;
  };
  const week = (ev: ReturnType<typeof newest>) => (usageJson(ev, START).seven_day as { used: number }).used;
  const one = factory("one", 0.3, START + 100), two = factory("two", 0.6, START + 200);
  const NOW = START + 300;   // (the readings' times are made up: now is given, not the clock's)
  test("a factory's own reading becomes the machine's (its folder made)", () => {
    assert.equal(week(newest(one, e, NOW)), 0.3);
    assert.equal(JSON.parse(fs.readFileSync(sharedFile(e), "utf8")).from, one);
  });
  test("a newer one, read by another factory's lanes, replaces it", () => {
    assert.equal(week(newest(two, e, NOW)), 0.6);
    assert.equal(JSON.parse(fs.readFileSync(sharedFile(e), "utf8")).from, two);
  });
  test("  and is the first factory's reading too, its own being older", () => { assert.equal(week(newest(one, e, NOW)), 0.6); });
  test("  the machine's file is left as it was", () => { assert.equal(JSON.parse(fs.readFileSync(sharedFile(e), "utf8")).from, two); });
  test("a factory with no reading of its own has the machine's", () => { assert.equal(week(newest(path.join(tmp, "none"), e, NOW)), 0.6); });
  test("a machine's file that isn't a reading is as none", () => {
    fs.writeFileSync(sharedFile(e), "{half");
    assert.equal(week(newest(one, e, NOW)), 0.3);
  });
  // The clock set back, or a file that's wrong: it would be the newest until its date came.
  test("a machine's reading dated well past now is as none", () => {
    fs.writeFileSync(sharedFile(e), JSON.stringify({ ...reading(0.99, START + 30 * 86400), from: two }));
    assert.equal(week(newest(one, e, NOW)), 0.3);
  });
  test("  one a few minutes past it (another clock's seconds) stands", () => {
    fs.writeFileSync(sharedFile(e), JSON.stringify({ ...reading(0.99, START + 500), from: two }));
    assert.equal(week(newest(one, e, NOW)), 0.99);
  });
  test("the default file is in the machine's wfactory state folder", () => {
    assert.equal(sharedFile({ XDG_STATE_HOME: "/state" }), "/state/wfactory/usage.json");
  });
});
