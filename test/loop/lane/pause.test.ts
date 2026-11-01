// Pause asap (factory/oversee.sh pause --now): the running session ends, its unit is left
// interrupted with its work pushed as its branch, and the lane stops; mid-CI, the run is cut
// short, kept as cut off, due again. (FACTORY_NOCAP: no scope to stop, so this also checks the
// loop ends the session itself.) The loop is the real factory/loop.sh, in the file's lane.
// Run: node --test test/loop/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { alive, has, lockHeld, readOr } from "../../lib/index.ts";
import { hold } from "../inproc.ts";
import { laneFactory } from "./helpers.ts";

const f = laneFactory("lane-pause");
const { a, w, setup, t, onBranch, until } = f;

describe("pause asap: the running session ends, its unit is left interrupted, the lane stops", () => {
  let b: ReturnType<typeof f.loopBg>;
  // Held until the lane has stopped (hold() made here lets go when the suite ends, not the first
  // test): let go as the first test ended, the session could record its unit done before the
  // loop had acted on the pause.
  const h = hold(a.locks, "g/six");
  test("pause asap ends the session", async () => {
    setup("add-unit", "g/six", "--title", "Unit six");
    b = f.loopBg(["--hours", "0.05"]);
    await b.until("iteration 1: Unit six");
    await h.held();
    has(f.oversee(["pause", "--now"]).stdout, "ended");
  });
  test("  the lane stops, saying so", async () => { await b.until("paused asap", 30); await b.end(); });
  test("  and the unit is interrupted for the next session", () => { has(t("show", "g/six"), "interrupted"); });
  test("  its work so far is pushed as its branch", () => { assert.equal(onBranch("unit/g/six", "out/g-six.txt"), "work on g/six"); });
  test("  and its card says so", () => { has(t("show", "g/six"), "Its work so far: branch unit/g/six (the loop checks it out for you)"); });
});

// The slow step notes its shell's pid and its sleep's, to see both stopped.
describe("pause asap mid-CI: cut short, kept as cut off, due again from the first step", () => {
  let b: ReturnType<typeof f.loopBg>, running: boolean[] = [];
  const pids = () => [w.at("slow-sh.pid"), w.at("slow.pid")].map((p) => Number(readOr(p)));
  test("pause asap cuts a CI run short", async () => {
    setup("drop", "g/six", "--why", "test");
    f.steps({ slow: { cmd: `echo $$ > ${w.at("slow-sh.pid")}; sleep 60 & echo $! > ${w.at("slow.pid")}; wait` } });
    setup("add-group", "gs", "--title", "Group S", "--ci", "slow");
    setup("add-unit", "gs/one", "--title", "S one"); setup("done", "gs/one", "--evidence", "x");
    b = f.loopBg(["--hours", "0.05"]);
    await b.until("ci: slow:");
    await until(() => pids().every((p) => p > 0), "the slow step is running");
    f.oversee(["pause", "--now"]);
    await b.until("paused asap", 30);
    // Once the loop has let go of its lock (it has ended), not once its output closes, which a
    // step left running could hold open.
    await until(() => !lockHeld(a.at("runs/.loop.lock")), "the loop has ended");
    running = pids().map(alive);
    await b.end();
  });
  test("  it's due again, not broken", () => { has(t("ci", "gs"), "due"); });
  test("  on record as cut off, at its step, for the morning summary", () => { has(t("ci", "gs"), "its last run was cut off (at slow, paused asap"); });
  test("  its step is stopped", () => { assert.deepEqual(running, [false, false]); });
});
