// A day count and a night count (docs/machines.md's Lanes "1, 2 at night", which fleet start
// passes on as --lanes): a lane past the count for the time of day works no new unit; it waits
// between units until the count takes it in. So at nightfall the extra lane starts work, and in
// the morning it finishes the unit it's on and then waits, its clone and records where they
// were, for the next night. The night is the profile's ("night", local time). The loop runs in
// this process with its clock mocked (inproc.ts), so the test moves it to nightfall and morning.
// Run: node --test test/loop/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { has, hasnt, readOr } from "../lib/index.ts";
import { hold, hmAt, hmsAt, nextSecond, run, type Run } from "./inproc.ts";
import { loopFactory, LOOP } from "./factory.ts";

const f = loopFactory("night");
const { setup, state } = f;
// Lane 2 on the same machine (host a), beside lane 1's clone.
const b = f.lane("a", { k: 2 });
const loop2 = (args: string[], t0: number) => run({ dir: b.dir, envWith: b.envWith }, [...LOOP, ...args], {}, t0);

// The clock starts on a whole minute, a minute ahead of real time; night is from its next minute
// to five minutes in.
const t0 = Math.ceil(nextSecond() / 60) * 60 + 60;
const profile = f.w.env.WFACTORY_PROFILE!;
fs.writeFileSync(profile, readOr(profile).replace("| store | none |", `| store | none |\n| night | ${hmAt(t0, 60)}-${hmAt(t0, 300)} |`));

describe("1 lane by day and 2 at night: lane 2 works at night only", () => {
  // (One test runs the loop to its end: a run still going when its test ends is stopped.)
  let r: Run, before = "", morning = "", resting = "", running = false, clone = false, index = "", done = "";
  test("by day, lane 2 waits for night, saying when it's back", async () => {
    setup("add-unit", "g/n1", "--title", "Night one");
    const h = hold(b.locks, "g/n1");
    r = loop2(["--hours", "0.25", "--lanes", "1,2"], t0);
    await r.until("loop: waiting for night");
    // Its night is a minute off: nothing starts before it.
    await r.at(59);
    before = r.out();
    // Nightfall.
    await r.at(60);
    await h.held();
    // Morning comes while its unit is still being worked.
    await r.at(300);
    morning = r.out();
    h.go();
    await r.until(`${hmsAt(t0, 300)} loop: waiting for night`);
    resting = r.out(); running = !r.ended();
    clone = fs.existsSync(`${b.dir}/.git`); index = readOr(`${b.dir}/runs/index.tsv`); done = state("g/n1");
    await r.at(900);
    await r.end();
    has(before, `${hmsAt(t0, 0)} loop: waiting for night: lane 2 works at night only (a runs 1 lane by day and 2 at night; night is ${hmAt(t0, 60)}–${hmAt(t0, 300)}); back at ${hmAt(t0, 60)}`);
  });
  test("  it takes no unit before nightfall", () => { hasnt(before, "Night one"); });
  test("  at nightfall it starts work", () => {
    has(r.out(), `${hmsAt(t0, 60)} loop: night: lane 2 is back at work`);
    has(r.out(), "Night one (g/n1)");
  });
  test("  morning doesn't cut its unit short", () => { hasnt(morning, `${hmsAt(t0, 300)} loop: waiting for night`); });
  test("  it finishes the unit, which lands", () => { assert.equal(done, "done"); });
  test("  then waits for the next night", () => {
    has(resting, `${hmsAt(t0, 300)} loop: waiting for night: lane 2 works at night only (a runs 1 lane by day and 2 at night; night is ${hmAt(t0, 60)}–${hmAt(t0, 300)}); back at ${hmAt(t0, 60)}`);
  });
  test("  still running, not stopped (nothing for a tidy to take its clone for)", () => { assert.ok(running); });
  test("  its clone and its records stay", () => {
    assert.ok(clone);
    has(index, "g/n1");
  });
  test("  and it stops at its stop time as any lane does", () => {
    has(r.out(), "out of time");
    assert.ok(fs.existsSync(`${b.dir}/.git`));
  });
});

describe("one count (a Lanes cell of one number, or fleet start --lanes N): no lane waits for the time of day", () => {
  test("lane 2 of --lanes 2 works by day", async () => {
    setup("add-unit", "g/d1", "--title", "Day one");
    const r = loop2(["--hours", "0.25", "--lanes", "2", "--no-wait"], t0 + 3600);
    const e = await r.end();
    hasnt(e.out, "waiting for night");
    has(e.out, "Day one (g/d1)");
  });
});
