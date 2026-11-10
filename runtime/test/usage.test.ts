// The week's line (usage.ts): the lesson it answers, the share kept back, and the machine's one
// reading. A fixed floor under the week's usage "ended weeks early and left their last share
// unused" (docs/design.md, Usage); lanes on the line reach the week's reset with the share kept
// back left, and nothing else.
// Run: node --test runtime/test/
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tempDir } from "../../test/lib/index.ts";
import { WEEK_S, keepBack, lineAt, lineReaches, newest, sharedFile, usageCheck, usageJson } from "../src/usage.ts";

const tmp = tempDir("usage-");
// No profile: every setting takes its default, but what a test sets.
const env = (add: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ WFACTORY_PROFILE: path.join(tmp, "no-profile.md"), FACTORY_USAGE_FILE: path.join(tmp, "usage.json"), ...add });
const RESET = 1_800_000_000, START = RESET - WEEK_S;
const reading = (used: number, at = START) => ({ type: "rate_limit_event", at, rate_limit_info: { unifiedWindows: { seven_day: { utilization: used, resetsAt: RESET } } } });
const paused = (used: number, now: number, keep: number) => usageCheck({ ev: reading(used), json: usageJson(reading(used), now, keep), now }, env()).pause;

describe("the week's line", () => {
  test("starts at nothing and ends at the whole week, less the share kept back", () => {
    assert.deepEqual([lineAt(RESET, START, 15), lineAt(RESET, START + WEEK_S / 2, 0), lineAt(RESET, RESET, 0), lineAt(RESET, RESET, 15)], [0, 0.5, 1, 0.85]);
  });
  test("it reaches a share used when that share of what the lanes may use has gone by", () => {
    assert.equal(lineReaches(0.425, RESET, 15), START + WEEK_S / 2);
  });
  test("  never, before the reset, for more than the lanes may use", () => {
    assert.deepEqual([lineReaches(0.85, RESET, 15), lineReaches(0.97, RESET, 15), lineReaches(1, RESET, 0)], [RESET, RESET, RESET]);
  });
  test("on the line is not ahead of it; a second before it is", () => {
    const at = lineReaches(0.5, RESET, 15);
    assert.deepEqual([paused(0.5, at, 15)?.until, paused(0.5, at - 1, 15)?.until], [undefined, at]);
  });
});

// Lanes that could use more than the week allows, a unit (0.4% of the week) at a time, looking
// every 10 minutes: they work whenever they aren't ahead of the line.
const weekOf = (keep: number) => {
  let used = 0, units = 0, lastWorked = 0;
  for (let now = START; now < RESET; now += 600) {
    if (paused(used, now, keep)) continue;
    used += 0.004; units++; lastWorked = now;
  }
  return { used, units, lastWorked };
};
describe("the lesson: a week on its line reaches its reset with the share kept back left, and nothing else", () => {
  for (const keep of [0, 15, 40]) {
    const w = weekOf(keep), may = 1 - keep / 100;
    test(`keep back ${keep}: the week ends with ${keep}% left, to within a unit`, () => {
      assert.ok(Math.abs(w.used - may) <= 0.004 + 1e-9, `used ${w.used}, of ${may}`);
    });
    test(`  and the lanes worked to the week's last hours`, () => {
      assert.ok(RESET - w.lastWorked <= 0.004 / may * WEEK_S + 600, `last worked ${(RESET - w.lastWorked) / 3600} h before the reset`);
    });
  }
  test("keep back 0: nothing is left over (the fixed floor left its last 15%)", () => { assert.ok(weekOf(0).used >= 0.996); });
});

describe("the share kept back", () => {
  const profile = (rows: string) => { const f = path.join(tmp, "profile.md"); fs.writeFileSync(f, `| Setting | Value |\n|---|---|\n${rows}`); return env({ WFACTORY_PROFILE: f }); };
  test("15 with nothing set", () => { assert.equal(keepBack(env()), 15); });
  test("the profile's keep back", () => { assert.equal(keepBack(profile("| keep back | 25 |\n")), 25); });
  test("0 keeps nothing back", () => { assert.equal(keepBack(profile("| keep back | 0 |\n")), 0); });
  test("its old name, stop below, is read as keep back", () => { assert.equal(keepBack(profile("| stop below | 20 |\n")), 20); });
  test("  keep back goes before it", () => { assert.equal(keepBack(profile("| stop below | 20 |\n| keep back | 10 |\n")), 10); });
  test("FACTORY_USAGE_KEEP_BACK goes before the profile's", () => { assert.equal(keepBack({ ...profile("| keep back | 25 |\n"), FACTORY_USAGE_KEEP_BACK: "0" }), 0); });
  test("off: the week isn't acted on", () => { assert.equal(keepBack(profile("| keep back | off |\n")), null); });
  test("  so no line, and no pause", () => {
    const now = START + 3600, json = usageJson(reading(0.97), now, null);
    assert.deepEqual([json.line, usageCheck({ ev: reading(0.97), json, now }, env()).code], [null, 0]);
  });
  test("what isn't a share is taken as 15, never as off", () => { assert.deepEqual([keepBack(env({ FACTORY_USAGE_KEEP_BACK: "lots" })), keepBack(env({ FACTORY_USAGE_KEEP_BACK: "150" }))], [15, 15]); });
  test("a percent sign is fine", () => { assert.equal(keepBack(env({ FACTORY_USAGE_KEEP_BACK: "20%" })), 20); });
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
  test("a factory's own reading becomes the machine's (its folder made)", () => {
    assert.equal(week(newest(one, e)), 0.3);
    assert.equal(JSON.parse(fs.readFileSync(sharedFile(e), "utf8")).from, one);
  });
  test("a newer one, read by another factory's lanes, replaces it", () => {
    assert.equal(week(newest(two, e)), 0.6);
    assert.equal(JSON.parse(fs.readFileSync(sharedFile(e), "utf8")).from, two);
  });
  test("  and is the first factory's reading too, its own being older", () => { assert.equal(week(newest(one, e)), 0.6); });
  test("  the machine's file is left as it was", () => { assert.equal(JSON.parse(fs.readFileSync(sharedFile(e), "utf8")).from, two); });
  test("a factory with no reading of its own has the machine's", () => { assert.equal(week(newest(path.join(tmp, "none"), e)), 0.6); });
  test("a machine's file that isn't a reading is as none", () => {
    fs.writeFileSync(sharedFile(e), "{half");
    assert.equal(week(newest(one, e)), 0.3);
  });
  test("the default file is in the machine's wfactory state folder", () => {
    assert.equal(sharedFile({ XDG_STATE_HOME: "/state" }), "/state/wfactory/usage.json");
  });
});
