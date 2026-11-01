// A busy tracker lock at a lane's start: another command holds .tracker/lock past the tracker's
// wait (FACTORY_LOCK_WAIT, shortened here), the tracker exits 75, and the lane waits it out instead
// of stopping as if the data were broken. Broken data still stops it. The loop is the real
// factory/loop.sh, in the file's lane (the in-process loop's mocked clock never runs the
// tracker's own wait out). Run: node --test test/loop/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { has, hasnt, readOr, TRACKER } from "../../lib/index.ts";
import { busyTracker } from "../factory.ts";
import { laneFactory } from "./helpers.ts";

const f = laneFactory("lane-trlock");
const { a, w, setup, t } = f;
const HOST = a.envWith().FACTORY_HOST!;
// A session that records nothing and commits nothing: its unit is left for the loop to settle.
const NOTHING = `#!/usr/bin/env bash
echo '{"type":"system","subtype":"init"}'
echo '{"type":"result","is_error":false,"result":"did nothing","num_turns":1,"total_cost_usd":0.01}'
`;

describe("a busy tracker lock at the lane's start is waited out", () => {
  // The lock's holder: a live process of another command, as the tracker writes it.
  // (Unref'd and killed at exit too, so a run that skips these tests neither waits on it nor
  // leaves it behind.)
  const holder = spawn("sleep", ["600"], { stdio: "ignore" }); holder.unref();
  after(() => { holder.kill(); }); process.on("exit", () => { holder.kill(); });
  let out = "", code: number | null = null, launched = 0;
  test("the lane waits for the lock, then works a unit", async () => {
    setup("add-unit", "g/lk", "--title", "Unit behind a lock");
    // The lane's tracker state is fetched before the lock is taken: one call first makes it.
    a.run("factory/tracker", ["status"]);
    fs.mkdirSync(a.at(".tracker/lock"));
    fs.writeFileSync(a.at(".tracker/lock/pid"), `${holder.pid}`);
    launched = Math.floor(Date.now() / 1000);
    const b = f.loopBg(["--hours", "0.05"], { FACTORY_LOCK_WAIT: "1" });
    try {
      // Or the stop it used to be (after 30 s at the opening gate, then 30 s at lint --broken).
      await f.until(() => /locked by another command|data is broken/.test(b.out()), "the lane to wait for the lock", 70);
      // Held past the tracker's wait more than once, and long enough that a stop time counted
      // from after the wait would show.
      await new Promise((r) => setTimeout(r, 10000));
    } finally { fs.rmSync(a.at(".tracker/lock"), { recursive: true, force: true }); }
    const r = await b.end();
    out = r.stdout; code = r.code;
    has(out, "iteration 1: Unit behind a lock (g/lk)");
  });
  test("  and stops when nothing is left", () => { has(out, "every unit is done or dropped"); assert.equal(code, 0); });
  test("  never taking the lock for broken data", () => { hasnt(out, "data is broken"); });
  // --hours 0.05 is 180 s from the lane's start, not from after the wait (#109). (Up to 5 s for
  // the loop to start, under load; the wait was over 11.)
  test("  its stop time counts from its start, not from after the wait", () => {
    const d = Number(/(?:^|\0)FACTORY_DEADLINE=([0-9]+)/.exec(f.seen("env.seen"))?.[1]);
    assert.ok(d - launched >= 180 && d - launched <= 185, `the stop time is ${d - launched} s after the lane started`);
  });
});

// The lock busy at a claim instead: the tracker's first \`next --claim\` exits 75 as a busy lock
// does (a wrapper, so the lane's start goes through), and the lane looks again.
describe("a busy tracker lock at a claim: the lane looks again", () => {
  let out = "";
  test("the lane looks again and works the unit", () => {
    setup("add-unit", "g/lc", "--title", "Unit after a busy claim");
    const once = w.at("busy-once");
    const wrap = w.at("tracker-busy-claim.mjs");
    fs.writeFileSync(wrap, `import fs from "node:fs";
if (process.argv[2] === "next" && process.argv.includes("--claim") && !fs.existsSync(${JSON.stringify(once)})) {
  fs.writeFileSync(${JSON.stringify(once)}, "");
  console.error("the tracker is locked by another command (.tracker/lock); try again"); process.exit(75);
}
await import(${JSON.stringify(TRACKER)});
`);
    out = f.loopSh(["--hours", "0.05"], { FACTORY_TRACKER: wrap }).stdout;
    assert.ok(fs.existsSync(once), "the wrapper refused a claim");
    has(out, "iteration 1: Unit after a busy claim (g/lc)");
  });
  test("  saying why", () => { has(out, "the tracker is locked by another command (.tracker/lock); looking again"); });
  test("  not stopping with a tracker error", () => { hasnt(out, "tracker error"); });
});

// The merge marker (runs/.merge-unit) read while the lock is busy: the merge unit isn't gone (#109).
describe("a busy lock at the merge marker: the merge unit stays this lane's", () => {
  const mu = "merge/mk";
  let out = "";
  test("its merge unit waits on a question; the lock is busy as the lane reads its marker", () => {
    setup("add-group", "merge", "--title", "Merges the loop couldn't do by itself", "--priority", "1000");
    setup("add-unit", mu, "--title", "Merge main here", "--branch", "unit/g/mk", "--lane", `${HOST}/1`, "--check", "recorded");
    setup("ask", "--title", "Keep which side?", "--context", "test", "--option", "a | keep | keep it", "--option", "b | drop | drop it", "--default", "a", "--blocks", mu, "--id", "mk-side");
    setup("add-unit", "g/mk2", "--title", "Unit beside a merge");
    fs.mkdirSync(a.at("runs"), { recursive: true });
    fs.writeFileSync(a.at("runs/.merge-unit"), `${mu}\n`);
    out = f.loopSh(["--max", "1", "--hours", "0.05"], { FACTORY_TRACKER: busyTracker(w.at("tracker-busy-mu.mjs"), ["state", mu], 3) }).stdout;
    assert.ok(fs.existsSync(w.at("tracker-busy-mu.mjs.busy")), "the wrapper answered busy");
  });
  test("  the marker is kept", () => { assert.equal(readOr(a.at("runs/.merge-unit")).trim(), mu); });
  test("  and the lane says its merge waits", () => { has(out, `this lane's merge (${mu}) can't move yet`); });
  test("  working another unit meanwhile", () => { has(out, "iteration 1: Unit beside a merge (g/mk2)"); });
});

// The settle after a session, while the lock is busy: waited out, or the unit stays claimed by a
// session that's gone (#109).
describe("a busy lock at the settle after a session: the unit is settled", () => {
  let out = "";
  test("a session that records nothing, settled while the lock is busy", () => {
    // (The merge unit above is done with.)
    setup("drop", "merge/mk", "--why", "test"); fs.rmSync(a.at("runs/.merge-unit"), { force: true });
    setup("add-unit", "g/st", "--title", "Unit settled late");
    f.claude(NOTHING);
    try { out = f.loopSh(["--max", "1", "--hours", "0.05"], { FACTORY_TRACKER: busyTracker(w.at("tracker-busy-settle.mjs"), ["settle", "g/st"], 2) }).stdout; }
    finally { f.claude(); }
    assert.ok(fs.existsSync(w.at("tracker-busy-settle.mjs.busy")), "the wrapper answered busy");
  });
  test("  the settle went through", () => { has(out, "Unit settled late (g/st): the session ended without recording it; it shows as interrupted"); });
  test("  saying it waited", () => { has(out, "the tracker is locked by another command (.tracker/lock); waiting for it (tracker settle)"); });
  test("  the unit shows as interrupted, not in progress", () => { has(t("status", "g"), "Unit settled late (g/st): interrupted"); });
});

// CI's record while the lock is busy, more times than its tries: the result isn't lost (#109). And a
// step that exits 75 itself (a tracker call in it found the lock busy) is its own failure, not the
// memory budget's.
describe("CI and a busy lock", () => {
  let out = "";
  test("a CI pass recorded while the lock is busy, more times than the record's tries", () => {
    setup("drop", "g/st", "--why", "test");
    f.steps({ quickb: { cmd: "echo quick" }, busy75: { cmd: "echo the tracker is locked; exit 75", retries: 0 } });
    setup("add-group", "gq", "--title", "Group Q", "--ci", "quickb");
    setup("add-unit", "gq/one", "--title", "Q one"); setup("done", "gq/one", "--evidence", "x");
    out = f.loopSh(["--hours", "0.05"], { FACTORY_TRACKER: busyTracker(w.at("tracker-busy-ci.mjs"), ["ci-pass"], 6), FACTORY_RETRY_WAIT: "0" }).stdout;
    assert.ok(fs.existsSync(w.at("tracker-busy-ci.mjs.busy")), "the wrapper answered busy");
  });
  test("  it's recorded", () => { has(t("ci", "gq"), "passed"); });
  test("  not given back", () => { hasnt(out, "couldn't record gq's CI"); hasnt(f.events(), "\tci-unrecorded\t"); });
  test("a step that exits 75 fails with its own exit status, not for want of memory", () => {
    setup("add-group", "gz", "--title", "Group Z", "--ci", "busy75");
    setup("add-unit", "gz/one", "--title", "Z one"); setup("done", "gz/one", "--evidence", "x");
    out = f.loopSh(["--hours", "0.05"]).stdout;
    has(t("ci", "gz"), "busy75 failed (exit 75, tried 1 time)");
    hasnt(out, "no turn in the machine's memory budget");
  });
});

// fleet start's opening-gate check while the lock is busy: the gate isn't taken as passed (#109).
describe("a busy lock at fleet start's opening gate", () => {
  let r = { code: 0 as number | null, stdout: "" };
  test("fleet start while the gate is open and the lock busy", () => {
    setup("reopen", "opening/ready");
    try { r = a.run("factory/fleet.sh", ["start", "--hours", "0.05"], { FACTORY_TRACKER: busyTracker(w.at("tracker-busy-gate.mjs"), ["state", "opening/ready"], 2) }); }
    finally { setup("pass", "opening/ready"); }
    assert.ok(fs.existsSync(w.at("tracker-busy-gate.mjs.busy")), "the wrapper answered busy");
  });
  test("  it waits for the lock, then starts no lane", () => { assert.equal(r.code, 2, r.stdout); has(r.stdout, "fleet: the opening isn't over"); });
  test("  saying it waited", () => { has(r.stdout, "fleet: the tracker is locked by another command"); });
});

describe("broken tracker data still stops the lane", () => {
  test("a unit that needs one that isn't there: exit 2", () => {
    setup("add-unit", "g/bk", "--title", "Unit with a broken need");
    f.editMain("tracker/groups/g.json", (g) => { g.units.find((u: { id: string }) => u.id === "g/bk").needs = ["g/nowhere"]; });
    const r = f.loopSh(["--hours", "0.05"], { FACTORY_LOCK_WAIT: "1" });
    assert.equal(r.code, 2);
    has(r.stdout, "the tracker's data is broken; fix that first");
    hasnt(r.stdout, "locked by another command");
  });
});
