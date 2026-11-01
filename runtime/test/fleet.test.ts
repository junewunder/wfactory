// fleet.ts's heartbeat wording on its own: what the beat says is for the owner, given what the
// lanes say they're doing; and fleet start's --until. Run: node --test runtime/test/
import test from "node:test";
import assert from "node:assert/strict";
import { QUIET_MINUTES, dur, forYou, stake } from "../src/fleet.ts";

const MIRA = "Pilot character: Mira: Rerun Mira's states stage (mira/restamp-states) merging on wren";
const LC = (m: string, n: number, what = MIRA) => `${m} lane ${n} waiting: no CI due; last call: CI comes due here once work in flight lands (${what}); looking again every 4 min`;
const none = new Set<string>();

test("nothing waiting on the owner: nothing for you", () => {
  assert.equal(forYou(new Set(["wren"]), [], [], 0), "nothing for you");
  assert.equal(forYou(none, [], ["wren lane 1 waiting: nothing workable: 2 units in progress elsewhere; looking again every 4 min"], 0), "nothing for you");
});

test("questions are for the owner", () => {
  assert.equal(forYou(new Set(["wren"]), [], [], 3), "3 waiting on you");
});

test("every lane waits for work in flight and none is busy: the wait can't end, and the beat says on what", () => {
  const out = forYou(none, [], [LC("wren", 1), LC("tern", 1)], 0);
  assert.equal(out, `the lanes wait for work in flight to land (${MIRA}), but no lane where it is is working, so the wait won't end`);
  assert.match(forYou(none, [], [LC("wren", 1)], 2), /^2 waiting on you; the lanes wait for work in flight/);
});

test("a lane busy on another machine doesn't land it: still flagged", () => {
  assert.match(forYou(new Set(["tern"]), [], [LC("wren", 1)], 0), /the wait won't end/);
});

test("a busy lane on its machine may be landing it, and an unreachable one may be: no flag", () => {
  assert.equal(forYou(new Set(["wren"]), [], [LC("tern", 1)], 0), "nothing for you");
  assert.equal(forYou(none, ["wren"], [LC("tern", 1)], 0), "nothing for you");
});

test("a unit named without a machine, or past the first few: only no busy lane at all counts", () => {
  const nohost = "Pilot character: Mira: Rerun Mira's states stage (mira/restamp-states) merging";
  assert.equal(forYou(new Set(["tern"]), [], [LC("tern", 1, nohost)], 0), "nothing for you");
  assert.match(forYou(none, [], [LC("tern", 1, nohost)], 0), /the wait won't end/);
  const many = `${MIRA}, Two (m/two) merging on wren, Three (m/three) merging on wren and 2 more`;
  assert.equal(forYou(new Set(["tern"]), [], [LC("tern", 1, many)], 0), "nothing for you");
});

// How long a wait's timer runs (2026-10-18: 16 of 19 wakes were the 30-minute timer
// with nothing behind them): 30 minutes while something is at stake, 55 when nothing is, inside
// the hour the overseer's prompt cache lives.
const calm = { news: 0, away: 0, forYou: "nothing for you", waiting: 0, low: 0, deadlines: [] as number[], now: 1_000_000 };
test("a wait with nothing at stake: the quiet timer", () => { assert.equal(stake(calm), ""); });
test("  which wakes inside the prompt cache's hour", () => { assert.ok(QUIET_MINUTES > 30 && QUIET_MINUTES < 60); });
test("a wait with something at stake: 30, and what", () => {
  assert.equal(stake({ ...calm, away: 1 }), "a machine unreachable");
  assert.equal(stake({ ...calm, forYou: "2 waiting on you" }), "2 waiting on you");
  assert.equal(stake({ ...calm, waiting: 1 }), "a lane waiting");
  assert.equal(stake({ ...calm, low: 1 }), "memory low");
  assert.equal(stake({ ...calm, deadlines: [calm.now + 3600] }), "a stop time within the hour");
});
test("  a stop time well past the wait isn't at stake", () => { assert.equal(stake({ ...calm, deadlines: [calm.now + 3 * 3600] }), ""); });

test("the beat's lengths of time", () => {
  assert.equal(dur(40), "40 s");
  assert.equal(dur(12 * 60 + 5), "12 min");
  assert.equal(dur(3600 + 5 * 60), "1h05");
});

const hm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

test("fleet start --until: the time it stops at, taken out of the loop's options", async () => {
  const { takeUntil, hoursTo } = await import("../src/fleet-lanes.ts");
  const now = Math.trunc(Date.now() / 1000);
  const r = takeUntil(["--model", "sonnet", "--until", hm(new Date((now + 5400) * 1000)), "--max", "3"], now);
  assert.ok(typeof r !== "string");
  assert.deepEqual(r.rest, ["--model", "sonnet", "--max", "3"]);
  // To the minute: the seconds past it are dropped.
  assert.ok(r.until !== null && Math.abs(r.until - (now + 5400)) < 60, String(r.until));
  assert.deepEqual(hoursTo(now + 5400, now), ["--hours", "1.500"]);
});

test("  a time of day already past today is tomorrow's", async () => {
  const { takeUntil } = await import("../src/fleet-lanes.ts");
  const now = Math.trunc(Date.now() / 1000);
  const ago = new Date((now - 3600) * 1000);
  // Tomorrow at that time of day, by the local clock (23 hours on, or 22 or 24 over a clock change).
  const want = new Date(ago.getFullYear(), ago.getMonth(), ago.getDate() + 1, ago.getHours(), ago.getMinutes()).getTime() / 1000;
  const r = takeUntil(["--until", hm(ago)], now);
  assert.ok(typeof r !== "string" && r.until === want, JSON.stringify(r));
});

test("  without it, the options are as they were; a bad time, or --hours too, is refused", async () => {
  const { takeUntil } = await import("../src/fleet-lanes.ts");
  const now = Math.trunc(Date.now() / 1000);
  assert.deepEqual(takeUntil(["--hours", "6"], now), { rest: ["--hours", "6"], until: null });
  assert.match(takeUntil(["--until", "09:00", "--hours", "6"], now) as string, /pass one/);
  assert.match(takeUntil(["--until", "soonish"], now) as string, /needs a time/);
  assert.match(takeUntil(["--until"], now) as string, /needs a time/);
  assert.match(takeUntil(["--until", "yesterday"], now) as string, /in the past/);
});
