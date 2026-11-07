// Long jobs (factory/long.sh): start, wait, the stop time, list, log, stop, stop-all, a job the
// session left running, and a job over its memory cap. Each job is a real systemd service of
// this file's project. Run: node --test test/loop/fleet/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { linuxOnly, has, hasnt, chomp, readOr, ROOT, prop, fileHas, until } from "../../lib/index.ts";
import { fleetFactory, hog } from "./helpers.ts";

const f = fleetFactory("flong");
const { F, P, w, long, run, setup } = f;
const now = () => Math.floor(Date.now() / 1000);
const out = (args: string[], add: NodeJS.ProcessEnv = {}) => long(args, { add }).stdout;
const list = () => out(["list"]);
const { HOG, real } = hog(w.at("oombin"));
// A faked kill: once the job has ended, its stop step is told the cap killed it (as systemd's
// SERVICE_RESULT says after a real one).
const oomNote = (n: string) => { if (!real) { long(["wait", n, "--max", "30"]); long(["stopped", n, "20M"], { add: { SERVICE_RESULT: "oom-kill" } }); } };

describe("long jobs", () => {
  test("long start", () => { has(out(["start", "quick", "--", "bash", "-c", "echo working; sleep 2; echo finished"]), "started quick"); });
  let quick = "";
  test("long wait: done", () => { quick = out(["wait", "quick"]); has(quick, "done: quick finished"); });
  test("  with the last lines", () => { has(quick, "finished"); });
  test("long wait: failed, exit 1", () => {
    long(["start", "broken", "--", "bash", "-c", "echo oops; exit 3"]);
    assert.equal(long(["wait", "broken"]).code, 1);
  });
  test("  says the exit status", () => { has(out(["wait", "broken"]), "exited 3"); });
  test("  just heavy why says it was its own failure, once its service has ended", async () => {
    await until(() => w.just(["heavy", "why", "broken"], F).stdout.includes("broken: failed, exited 3"), "the job's end is recorded");
  });
  test("long start: a job that runs a while (slow)", () => { assert.equal(long(["start", "slow", "--", "sleep", "30"]).code, 0); });
  test("  the step systemd runs after it notes a kill over the cap", linuxOnly("systemd's ExecStopPost"), () => {
    has(prop(`factory-${P}-long-slow.service`, "ExecStopPost"), "stopped slow 8G");
  });
  let slow = { code: 0, stdout: "" };
  test("long wait: still running, exit 10", () => { slow = long(["wait", "slow", "--max", "2"]); assert.equal(slow.code, 10); });
  test("  and says to call wait again", () => { has(slow.stdout, "Call `just long wait slow` again"); });
  test("long start refuses a running name", () => { assert.equal(long(["start", "slow", "--", "true"]).code, 2); });
  // Near the lane's stop time, `wait` returns early: out of time, exit 11.
  let near = { code: 0, stdout: "" };
  test("long wait near the stop time: out of time, exit 11", () => {
    near = long(["wait", "slow"], { add: { FACTORY_DEADLINE: String(now() + 3), FACTORY_LONG_MARGIN: "1", FACTORY_LONG_AGAIN: "0" } });
    assert.equal(near.code, 11);
  });
  test("  and says to stop the job and note it", () => { has(near.stdout, "out of time: the lane stops at"); });
  test("  an earlier stop time the overseer set counts", () => {
    fs.writeFileSync(path.join(F, "runs/.stop-at"), `${now() + 3}\n`);
    const r = long(["wait", "slow"], { add: { FACTORY_DEADLINE: String(now() + 3600), FACTORY_LONG_MARGIN: "1", FACTORY_LONG_AGAIN: "0" } });
    assert.equal(r.code, 11);
  });
  test("  outside a loop session there's no stop time", () => {
    const r = long(["wait", "slow", "--max", "2"]);
    fs.rmSync(path.join(F, "runs/.stop-at"), { force: true });
    assert.equal(r.code, 10);
  });
  test("long start names the lane's stop time", () => {
    has(out(["start", "named", "--", "sleep", "1"], { FACTORY_DEADLINE: String(now() + 3600) }), "The lane stops at");
  });
  test("long list", () => { long(["stop", "slow"]); has(list(), "quick: exited 0"); });
  test("  a stopped job says so", () => { has(list(), "slow: stopped"); });
  test("long log: its output", () => { has(out(["log", "quick"]), "working"); });
  test("  under a line saying when it started and what", () => { has(out(["log", "quick"]), "start: bash -c echo working; sleep 2; echo finished"); });
  test("  the last N lines", () => { assert.equal(chomp(out(["log", "quick", "1"])), "finished"); });
  test("long wait: a job that never ran, exit 2", () => { assert.equal(long(["wait", "nosuch"]).code, 2); });
  test("long start: a name that isn't lowercase words and dashes, exit 2", () => { assert.equal(long(["start", "Bad_Name", "--", "true"]).code, 2); });
  test("long start: no command, exit 2", () => { assert.equal(long(["start", "nocmd", "--"]).code, 2); });
  let mm = { code: 0, stdout: "", stderr: "" };
  test("long start: a command setting MemoryMax= itself, exit 2", () => {
    mm = long(["start", "memmax", "--", "env", "MemoryMax=16G", "true"]);
    assert.equal(mm.code, 2);
  });
  test("  says to use --mem", () => { has(`${mm.stdout}${mm.stderr ?? ""}`, "--mem SIZE"); });
  test("  and inside bash -c too", () => { assert.equal(long(["start", "memmax-sh", "--", "bash", "-c", "env MemoryMax=16G true"]).code, 2); });
  test("  but a scope capped in place with systemd-run's -p MemoryMax= starts", () => {
    assert.equal(long(["start", "memmax-scope", "--light", "--", "bash", "-c", "echo systemd-run --user --scope -p MemoryMax=3G x"]).code, 0);
  });
  test("long start --light: no heavy-job slot, and done", () => {
    long(["start", "lt", "--light", "--", "bash", "-c", "echo light"]);
    has(out(["wait", "lt", "--max", "30"]), "done: lt finished");
  });
  // (Started from inside the loop's landing check, say: the loop's turn in the budget isn't its own.)
  test("long start from inside a heavy job: its own turn, and none of the loop's passed on", () => {
    long(["start", "inside", "--", "bash", "-c", "echo \"res=${FACTORY_HEAVY_RES:-} held=${FACTORY_HEAVY_HELD:-}\""], { add: { FACTORY_HEAVY_HELD: "1", FACTORY_HEAVY_RES: "the-loops" } });
    has(out(["wait", "inside", "--max", "30"]), "res= held=1");
  });
  test("long start: a script without a #! line runs, as the shell runs it", () => {
    fs.writeFileSync(w.at("plain"), "echo plain script\n", { mode: 0o755 });
    long(["start", "plain", "--", w.at("plain")]);
    has(out(["wait", "plain", "--max", "30"]), "plain script");
  });
  test("a stopped job has no exit status, even one that exits on TERM", async () => {
    // Stopped once its trap is set (it says so first).
    long(["start", "trapper", "--", "bash", "-c", 'trap "exit 5" TERM; echo trapping; sleep 300 & wait']);
    await fileHas(path.join(F, "runs/long/trapper.log"), "trapping");
    long(["stop", "trapper"]);
    has(list(), "trapper: stopped");
  });
  test("  just heavy why: stopped", async () => {
    await until(() => w.just(["heavy", "why", "trapper"], F).stdout.includes("trapper: stopped at"), "the stopped job's end is recorded");
  });
  test("a job's stop step notes nothing when it wasn't the cap", () => {
    long(["stopped", "quick", "8G"], { add: { SERVICE_RESULT: "success" } });
    assert.ok(!fs.existsSync(path.join(F, "runs/long/quick.oom")));
  });
  // stop-all: the loop's, after each session. With --tag, only what that session started.
  test("long stop-all --tag: that session's jobs", () => {
    long(["start", "ta", "--", "sleep", "300"], { add: { FACTORY_TAG: "sess-a" } });
    long(["start", "tb", "--", "sleep", "300"], { add: { FACTORY_TAG: "sess-b" } });
    long(["start", "tc", "--", "sleep", "300"], { add: { FACTORY_TAG: undefined } });
    assert.equal(chomp(out(["stop-all", "--tag", "sess-a"])), "stopped long jobs the session left running: ta");
  });
  test("  they're stopped", () => { has(list(), "ta: stopped"); });
  test("  another session's keep running", () => { has(list(), "tb: running"); });
  test("  and one no session started", () => { has(list(), "tc: running"); });
  test("  nothing left of that session's: says nothing", () => { assert.equal(chomp(out(["stop-all", "--tag", "sess-a"])), ""); });
  let all = "";
  test("long stop-all: every job of this checkout", () => { all = out(["stop-all"]); has(all, "stopped long jobs the session left running: "); });
  test("  (one)", () => { has(all, " tb"); });
  test("  (two)", () => { has(all, " tc"); });
  test("  none left running", () => { hasnt(list(), ": running"); });
});

describe("a long job the session left running is stopped when the session ends", () => {
  let loopOut = "";
  test("a long job the session left running is stopped after it", () => {
    setup(["add-unit", "g/longleft", "--title", "Leaves a long job running"]);
    long(["start", "mine", "--", "sleep", "300"], { add: { FACTORY_TAG: undefined } });
    loopOut = run(path.join(F, "factory/loop.sh"), ["--no-awake", "--idle-wait", "0.05", "--last-call", "0", "--max", "1", "--no-wait"], { add: { FACTORY_FAKE_LONG: "1" } }).stdout;
    has(loopOut, "stopped long jobs the session left running: leftover");
  });
  test("  it isn't running", () => { hasnt(list(), "leftover: running"); });
  test("  a job someone else started in the checkout keeps running", () => { has(list(), "mine: running"); long(["stop", "mine"]); });
  // (The bash suite, test-loop.sh, checked these two after its earlier loops; this loop is the one here.)
  test("a loop points its checkout's recipes at the copy it runs", () => { assert.equal(fs.readlinkSync(path.join(F, ".tracker/skill")), ROOT); });
  test("just long is pre-approved for sessions", () => { has(readOr(path.join(f.locks, "args.seen")), "Bash(just long:*)"); });
});

describe("a job over its memory cap: the kernel kills it, and the overseer hears of it", () => {
  let r = { code: 0, stdout: "" };
  test("long wait: a job over its cap failed", () => {
    long(["start", "hog", "--mem", "20M", "--", ...HOG.split(" ")]); oomNote("hog");
    r = long(["wait", "hog", "--max", "30"]);
    assert.equal(r.code, 1);
  });
  test("  and says it was the cap", () => { has(r.stdout, "hog was killed: out of memory at 20M"); });
  const events = () => readOr(path.join(F, "runs/events.log"));
  test("  an oom-kill event for the overseer", () => { has(events(), `oom-kill\tjust long start hog (${HOG}) was killed: out of memory at 20M, peak`); });
  test("  a job's own failure isn't one", () => { hasnt(events().split("\n").filter((l) => l.includes("oom-kill")).join("\n"), "long start broken"); });
  test("  a job behind a wrapper with its own exit code too", () => {
    long(["start", "hogwrap", "--mem", "20M", "--", "bash", "-c", `${HOG}; echo the sweep goes on; exit 1`]); oomNote("hogwrap");
    has(out(["wait", "hogwrap", "--max", "30"]), "hogwrap was killed: out of memory at 20M");
  });
});

// A lane's session has no display (loop-unit.ts, NO_DISPLAY); a user service would otherwise get
// the owner's from the user manager (DISPLAY=:0 on a desktop), so the job doesn't get one either.
describe("a job started with no display gets none", () => {
  const noDisplay = { DISPLAY: undefined, XAUTHORITY: undefined, WAYLAND_DISPLAY: "/dev/null/no-display" };
  test("a job started with no display", () => {
    assert.equal(long(["start", "nodisplay", "--light", "--", "bash", "-c", "env; echo env-done; sleep 30"], { add: noDisplay }).code, 0);
  });
  test("  its service unsets DISPLAY and XAUTHORITY", linuxOnly("systemd's UnsetEnvironment (a macOS job gets only its own variables and the user's basic ones)"), () => {
    const u = prop(`factory-${P}-long-nodisplay.service`, "UnsetEnvironment");
    has(u, "DISPLAY"); has(u, "XAUTHORITY");
  });
  test("  so the job has neither, whatever the user manager has", async () => {
    await until(() => out(["log", "nodisplay"]).includes("env-done"), "the job printed its environment");
    const log = out(["log", "nodisplay", "200"]);
    long(["stop", "nodisplay"]);
    assert.doesNotMatch(log, /^DISPLAY=/m); assert.doesNotMatch(log, /^XAUTHORITY=/m);
  });
  test("  and the session's WAYLAND_DISPLAY, not the owner's", () => { has(out(["log", "nodisplay", "200"]), "WAYLAND_DISPLAY=/dev/null/no-display"); });
  test("a display the session has goes with it", () => {
    long(["start", "owndisplay", "--light", "--", "bash", "-c", "env; echo env-done"], { add: { ...noDisplay, DISPLAY: ":99" } });
    long(["wait", "owndisplay", "--max", "30"]);
    has(out(["log", "owndisplay", "200"]), "DISPLAY=:99");
  });
});
