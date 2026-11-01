// Staying awake: without --no-awake, the loop holds a logind inhibitor while it runs, and lets go
// when it ends, even killed. A stand-in systemd-inhibit notes its options and its pid, and runs
// its holder. The loop is the real factory/loop.sh, in the file's lane. Run: node --test test/loop/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { alive, has, readOr } from "../../lib/index.ts";
import { hold } from "../inproc.ts";
import { laneFactory } from "./helpers.ts";
// Linux only: logind's inhibitor (macOS's caffeinate is runtime/test/os-jobs.test.ts's).
const logind = { skip: process.platform !== "linux" && "logind's inhibitor (macOS's caffeinate: runtime/test/os-jobs.test.ts)" };

const f = laneFactory("lane-awake");
const { a, w, setup, until } = f;
const ARGS = w.at("inhibit.args"), PID = w.at("inhibit.pid");   // (and inhibit.pids: every one started)
fs.mkdirSync(w.at("inhibit"));
fs.writeFileSync(w.at("inhibit/systemd-inhibit"), `#!/usr/bin/env bash
echo $$ > ${PID}
echo $$ >> ${PID}s
printf '%s\\n' "$*" > ${ARGS}
while [ $# -gt 0 ] && [[ $1 == --* ]]; do shift; done
"$@"
`, { mode: 0o755 });
const add = { PATH: `${w.at("inhibit")}:${w.env.PATH}` };
// The loop's options but --no-awake.
const AWAKE = ["--idle-wait", "0.05", "--last-call", "0", "--max", "1", "--no-wait", "--hours", "0.05"];
const inhibitor = () => Number(readOr(PID));
// (Within half a minute: the holder looks every 20 s whether the loop is still there.)
const letGo = (what: string) => until(() => !alive(inhibitor()), what, 30);

describe("staying awake: without --no-awake, the loop holds a logind inhibitor while it runs, and lets go when it ends", logind, () => {
  let out = "";
  test("without --no-awake the loop holds an inhibitor: sleep, idle and the lid switch", () => {
    setup("add-unit", "g/awake", "--title", "Awake unit");
    out = a.run("factory/loop.sh", AWAKE, add).stdout;
    has(readOr(ARGS), "--what=sleep:idle:handle-lid-switch");
  });
  test("  blocking, as wfactory", () => { has(readOr(ARGS), "--who=wfactory"); });
  test("  saying which checkout", () => { has(readOr(ARGS), `--why=factory loop: ${a.dir.split("/").at(-1)}`); });
  test("  (block mode)", () => { has(readOr(ARGS), "--mode=block"); });
  test("  and works", () => { has(out, "iteration 1: Awake unit (g/awake)"); });
  test("  it lets go once the loop has ended", async () => { assert.ok(inhibitor() > 0); await letGo("the inhibitor is let go"); });
});

describe("staying awake, the loop killed", logind, () => {
  let running = false;
  test("  held while the loop runs", async () => {
    fs.rmSync(ARGS); fs.rmSync(PID);
    setup("add-unit", "g/awake2", "--title", "Awake two");
    const h = hold(a.locks, "g/awake2");
    const b = f.loopBg(AWAKE, add, { opts: [] });
    await b.until("iteration 1: Awake two");
    await h.held();
    running = inhibitor() > 0 && alive(inhibitor());
    process.kill(b.pid!, "SIGKILL");
    assert.ok(running);
  });
  test("  and let go when the loop is killed", async () => { await letGo("the inhibitor is let go after the kill"); });
});

// A restart starts the newest copy in place of the loop, as the same process: the holder the loop
// had would hold on beside the new loop's until the lane stops, one more at each restart.
describe("staying awake, the loop restarted", logind, () => {
  const holders = () => readOr(`${PID}s`).split("\n").filter(Boolean).map(Number);
  let b: ReturnType<typeof f.loopBg>;
  test("a restarted loop holds one inhibitor, its own", async () => {
    fs.rmSync(`${PID}s`, { force: true });
    setup("add-unit", "g/awake3", "--title", "Awake three");
    setup("add-unit", "g/awake4", "--title", "Awake four");
    const h3 = hold(a.locks, "g/awake3"), h4 = hold(a.locks, "g/awake4");
    b = f.loopBg(["--idle-wait", "0.05", "--last-call", "0", "--max", "2", "--hours", "0.05"], add, { opts: [] });
    await b.until("iteration 1: Awake three");
    await h3.held();
    fs.writeFileSync(a.at("runs/.restart"), "awake-restart 1\n");
    h3.go();
    await b.until("restarted on the newest runner");
    await h4.held();
    assert.equal(holders().length, 2, `inhibitors started: ${holders().join(" ")}`);
    await until(() => !alive(holders()[0]), "the first loop's inhibitor is let go", 30);
    assert.ok(alive(holders()[1]), "the restarted loop holds its own");
    h4.go();
  });
  test("  and lets go of it once the loop has ended", async () => { await b.end(60); await until(() => !alive(holders()[1]), "the restarted loop's inhibitor is let go", 30); });
});
