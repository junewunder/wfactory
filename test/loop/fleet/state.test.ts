// fleet state, run, pause and pause-now; oversee.sh wait, state, start (refused), stop-at, stop
// and tidy, on a lane fleet start runs as a unit. Each lane's unit is held until the test lets
// it go. Run: node --test test/loop/fleet/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { linuxOnly, has, hasnt, chomp, readOr, until, HOST, active } from "../../lib/index.ts";
import { dayHm } from "../../../runtime/src/sys.ts";
import { fleetFactory } from "./helpers.ts";

const f = fleetFactory("fstate");
const { F, P, w, bg, fleet, oversee, long, setup, tr, hold, lane, laneLog } = f;
const LANE = `factory-${P}-lane1`, L1 = lane(1);
const L = (args: string[], add: NodeJS.ProcessEnv = {}) => oversee(args, { add });
const start = () => fleet(["start", "--hours", "0.05", "--no-awake"]);

describe("fleet state, run, pause; oversee.sh wait, state and tidy on a running lane", () => {
  const fp = hold("g/fp");
  let st = "";
  test("fleet state: each lane, headed", async () => {
    setup(["add-unit", "g/fp", "--title", "Unit fp"]);
    start();
    await fp.held();
    st = fleet(["state"]).stdout;
    has(st, `=== ${HOST} lane 1`);
  });
  test("  running, by its service's name", () => { has(st, `running: ${LANE}`); });
  test("  with the end of its loop log", () => { has(st, "iteration 1: Unit fp (g/fp)"); });
  test("  and no leases without a store", () => { hasnt(st, "=== leases"); });
  test("oversee.sh wait --minutes 0 on a running loop: exit 10", () => { assert.equal(L(["wait", "--minutes", "0"]).code, 10); });
  test("  saying it's running", () => { has(L(["wait", "--minutes", "0"]).stdout, `running: ${LANE}`); });
  let s = "";
  test("oversee.sh state: running, and the log's end", () => { s = L(["state"]).stdout; has(s, `running: ${LANE}\n--- runs/loop.log`); });
  test("  its last lines", () => { has(s, "iteration 1: Unit fp (g/fp)"); });
  test("  tidy refuses while the loop runs (exit 2)", () => { assert.equal(L(["tidy"]).code, 2); });
  test("fleet run: a command in the machine's checkout", () => { assert.equal(chomp(fleet(["run", HOST, "pwd"]).stdout), F); });
  test("  with its exit status", () => { assert.equal(fleet(["run", HOST, "sh", "-c", "exit 7"]).code, 7); });
  test("  a machine that isn't in the file (exit 2)", () => { assert.equal(fleet(["run", "nosuchbox", "pwd"]).code, 2); });
  let p = "";
  test("fleet pause: each lane is asked", () => { p = fleet(["pause"]).stdout; has(p, `=== ${HOST} lane 1`); });
  test("  to stop after the unit it's on", () => { has(p, `asked ${LANE} to stop after the unit it's on`); });
  test("  (runs/.pause in its clone)", () => { assert.ok(fs.existsSync(path.join(L1, "runs/.pause"))); });
  let ow = { code: 0, stdout: "" };
  test("oversee.sh wait returns when the loop exits, exit 0", async () => {
    // The session is let go once the wait has seen the lane running (a systemctl is-active it ran
    // said so; on macOS, a ps of the job's supervisor's start that found it), so the wait is the
    // one that sees the loop exit, not a wait that started too late.
    const mac = process.platform === "darwin", tool = mac ? "ps" : "systemctl";
    const sbin = w.at("seen-bin"), seen = w.at("wait-saw-running"), real = chomp(spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout);
    fs.mkdirSync(sbin, { recursive: true });
    fs.writeFileSync(path.join(sbin, tool), mac ? `#!/bin/sh
o=$(${real} "$@"); s=$?
[ -n "$o" ] && printf '%s\n' "$o"
case " $* " in *" lstart= "*) [ $s -ne 0 ] || [ -z "$o" ] || echo running >> ${seen} ;; esac
exit $s
` : `#!/bin/sh
${real} "$@"; s=$?
case " $* " in *" is-active "*) [ $s -ne 0 ] || echo running >> ${seen} ;; esac
exit $s
`, { mode: 0o755 });
    const b = bg(path.join(L1, "factory/oversee.sh"), ["wait", "--minutes", "3"], { cwd: L1, add: { PATH: `${sbin}:${w.env.PATH}` } });
    await until(() => readOr(seen).includes("running") || b.ended(), "oversee.sh wait has seen the lane running", 30);
    assert.ok(!b.ended(), `oversee.sh wait ended before it saw the lane running:\n${b.out()}`);
    fp.go();
    ow = await b.end();
    assert.equal(ow.code, 0);
  });
  test("  saying it isn't running", () => { has(ow.stdout, `not running: ${LANE} (last result:`); });
  test("  the lane paused after its unit", () => { has(laneLog(), "paused at a good point"); });
  test("  which landed", () => { has(tr(["show", "g/fp"]), "done"); });
});

describe("fleet pause-now", () => {
  const fq = hold("g/fq");
  let p = "";
  test("fleet pause-now: each lane's session is ended", async () => {
    setup(["add-unit", "g/fq", "--title", "Unit fq"]);
    start();
    await fq.held();
    p = fleet(["pause-now"]).stdout;
    has(p, `ended ${LANE}'s running session`);
  });
  test("  the lane stops", async () => { await until(() => !active(`${LANE}.service`), "the lane stops", 60); });
  test("  pausing asap", () => { has(laneLog(), "paused asap: Unit fq (g/fq) was cut short"); });
  test("  its unit interrupted", () => { has(tr(["show", "g/fq"]), "interrupted"); });
  test("oversee.sh state: not running", () => {
    setup(["drop", "g/fq", "--why", "test"]);
    has(L(["state"]).stdout, `not running: ${LANE} (last result:`);
  });
});

describe("oversee.sh start, stop-at, tidy and stop", () => {
  // A start systemd refuses (a user bus ssh can't reach, a unit still stopping) fails, so fleet start says so.
  test("oversee.sh start: a start systemd refuses exits non-zero", linuxOnly("a stand-in systemd-run"), () => {
    fs.mkdirSync(w.at("failrun"));
    fs.writeFileSync(w.at("failrun/systemd-run"), '#!/bin/sh\necho "Failed to connect to bus" >&2; exit 1\n', { mode: 0o755 });
    assert.equal(L(["start", "--hours", "0.01"], { PATH: `${w.at("failrun")}:${w.env.PATH}` }).code, 1);
  });
  const at = Math.floor(Date.now() / 1000) + 7200;
  let o = "";
  test("oversee.sh stop-at: the stop time", () => {
    o = L(["stop-at", "--at", String(at)]).stdout;
    // (GNU date where there is one, so the check doesn't read the time as the code under test does.)
    const when = process.platform === "linux" ? chomp(spawnSync("date", ["-d", `@${at}`, "+%a %H:%M"], { encoding: "utf8" }).stdout) : dayHm(new Date(at * 1000));
    has(o, `${LANE} stops at ${when} (or at its --hours, if sooner), after last call`);
  });
  test("  and that it isn't running", () => { has(o, "; it isn't running now"); });
  test("  in runs/.stop-at", () => { assert.equal(chomp(readOr(path.join(L1, "runs/.stop-at"))), String(at)); });
  test("  a time that isn't epoch seconds (exit 2)", () => { assert.equal(L(["stop-at", "--at", "09:00"]).code, 2); });
  test("  no time (exit 2)", () => {
    const c = L(["stop-at"]).code;
    fs.rmSync(path.join(L1, "runs/.stop-at"), { force: true });
    assert.equal(c, 2);
  });
  test("oversee.sh tidy: a long job left running is stopped", () => {
    long(["start", "leftover", "--", "sleep", "300"], { cwd: L1 });
    // (A systemd unit's name on Linux, the job's on macOS.)
    has(L(["tidy"]).stdout, `stopped: ${LANE}-long-leftover${process.platform === "linux" ? ".service" : ""}`);
  });
  test("  (it's gone)", () => { assert.ok(!active(`${LANE}-long-leftover.service`)); });
  test("  then there's nothing left", () => { has(L(["tidy"]).stdout, `nothing left running from ${LANE}`); });
  const fr = hold("g/fr");
  test("oversee.sh stop: the loop is stopped", async () => {
    setup(["add-unit", "g/fr", "--title", "Unit fr"]);
    start();
    await fr.held();
    long(["start", "leftover2", "--", "sleep", "300"], { cwd: L1 });
    has(L(["stop"]).stdout, `not running: ${LANE}`);
  });
  test("  and its long jobs", () => { assert.ok(!active(`${LANE}-long-leftover2.service`)); });
});
