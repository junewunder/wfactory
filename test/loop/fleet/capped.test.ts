// `just capped`: a command in a memory-capped systemd scope (on macOS, under a watch); a kill over the cap says so and
// tells the overseer, whether the cap killed the command, its child, or the step around it.
// Run: node --test test/loop/fleet/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { has, hasnt, readOr, alive, ROOT } from "../../lib/index.ts";
import { platform } from "../../../runtime/src/os.ts";
import { fleetFactory, hog } from "./helpers.ts";

const f = fleetFactory("fcap");
const { F, P, w } = f;
const { HOG } = hog(w.at("oombin"));
const capped = (args: string[], add: NodeJS.ProcessEnv = {}) => w.just(["capped", ...args], F, add);
const why = (n?: string) => w.just(["heavy", "why", ...(n ? [n] : [])], F).stdout;
const oomLines = () => readOr(path.join(F, "runs/events.log")).split("\n").filter((l) => l.includes("oom-kill")).join("\n");

describe("just capped: a kill over the cap says so and tells the overseer", () => {
  test("just capped: the command's exit status", () => { assert.equal(capped(["bash", "-c", "exit 3"]).code, 3); });
  // systemd-run (254 on) reads $ in a command as its own variables unless told not to: `$$` came out as `$`.
  test("  a $ in the command reaches it as written", () => { assert.match(capped(["bash", "-c", "echo pid $$"]).stdout, /pid [0-9]+/); });
  test("  (a kill not from the cap: 137)", () => {
    fs.writeFileSync(w.at("selfkill"), "kill -9 $$\n");
    assert.equal(capped(["bash", w.at("selfkill")]).code, 137);
  });
  test("  and no oom-kill for either", () => { hasnt(oomLines(), "just capped bash"); });
  // What the faked kills stand in for: the step in the scope reads the kernel's count and the peak.
  // (On macOS the counts are the watch's, os/darwin-cap.ts.)
  test("  the step in its scope reads the kernel's kill count", () => {
    fs.writeFileSync(w.at("capped.state"), "");
    const [c, ...a] = platform.cappedCmd(`factory-${P}-capped-step`, "1G", [path.join(ROOT, "runtime/capped.sh"), "--in-scope", "sleep", "1.5"]);
    spawnSync(c, a, { cwd: F, env: w.envWith({ FACTORY_CAPPED_STATE: w.at("capped.state") }), stdio: "ignore" });
    has(readOr(w.at("capped.state")), "oom_kill 0");
  });
  test("  and the peak", () => { assert.match(readOr(w.at("capped.state")), /^peak [1-9][0-9]*$/m); });
  // That step SIGKILLed too (the kernel's pick when no one process holds the memory, as in a
  // tmpfs) can't write: it's taken for the cap, and what the command left in the scope is stopped.
  // (What it leaves is a sleep whose pid it notes, which the bash suite found by its command line.)
  let r = { code: 0, stdout: "" };
  test("  a kill of the step in the scope: 137", () => {
    fs.writeFileSync(w.at("killstep"), `sleep 31.7 &\necho $! > ${w.at("killstep.pid")}\nkill -9 $PPID\nwait\n`);
    r = capped(["--light", "bash", w.at("killstep")]);
    assert.equal(r.code, 137);
  });
  test("  taken for the cap", () => { has(r.stdout, "killed: out of memory at"); });
  test("  and what it left running is stopped", () => {
    const pid = Number(readOr(w.at("killstep.pid")));
    assert.ok(pid > 0, "the step's command noted the sleep it left");
    assert.ok(!alive(pid), `the sleep it left (pid ${pid}) still runs`);
  });
  test("just capped: a wrapper's own exit code, when the cap killed its child", () => {
    r = capped(["bash", "-c", `${HOG}; echo the sweep goes on; exit 1`], { FACTORY_MEM: "20M" });
    assert.equal(r.code, 1);
  });
  test("  still says it was the cap", () => { has(r.stdout, "killed: out of memory at 20M"); });
  test("just capped over its cap: killed (137)", () => { r = capped(HOG.split(" "), { FACTORY_MEM: "20M" }); assert.equal(r.code, 137); });
  test("  and it says it was the cap", () => { has(r.stdout, "killed: out of memory at 20M"); });
  test("  an oom-kill event for the overseer, with the cap and the peak", () => {
    has(readOr(path.join(F, "runs/events.log")), `oom-kill\tjust capped ${HOG} was killed: out of memory at 20M, peak`);
  });
  test("  just heavy why: killed at its memory cap", () => {
    capped(["--name", "capkill", ...HOG.split(" ")], { FACTORY_MEM: "20M" });
    has(why("capkill"), "capkill: killed at its memory cap (20M");
  });
  test("  a killed run's peak isn't kept as what it needs (the next cap would grow)", () => {
    const h = JSON.parse(readOr(w.at("jobs/history.json")) || "{}");
    assert.deepEqual(Object.entries(h).filter(([k]) => k.endsWith(`\t${HOG}`)).flatMap(([, v]) => (v as { peaks: number[] }).peaks), []);
  });
  // The whole machine out of memory: the kernel killed a process in the scope (oom_kill) without
  // the scope reaching its cap (oom). Faked as the hog is, whether or not kills are real.
  test("a kill when the whole machine ran out of memory: 137", () => {
    fs.writeFileSync(w.at("machinekill"), 'printf "oom 0\\noom_kill 1\\npeak 31457280\\n" >> "$FACTORY_CAPPED_STATE"; kill -9 $$\n');
    r = capped(["--name", "machine", "bash", w.at("machinekill")]);
    assert.equal(r.code, 137);
  });
  test("  says it was the machine, not the cap", () => { has(r.stdout, "killed: the whole machine ran out of memory (a machine-wide out-of-memory kill, not this job's cap of 8G"); });
  test("  an oom-kill event that says so", () => { has(oomLines(), "was killed: the whole machine ran out of memory (its cap, 8G, wasn't reached, peak 30M)"); });
  test("  and just heavy why", () => { has(why("machine"), "machine: killed when the whole machine ran out of memory (not at its cap of 8G"); });
  test("just heavy why: a job that finished", () => { capped(["--name", "fine", "true"]); has(why("fine"), "fine: finished (exit 0)"); });
  test("  one that failed on its own", () => { capped(["--name", "own", "bash", "-c", "exit 3"]); has(why("own"), "own: failed, exited 3"); });
  test("  one that crashed", () => {
    fs.writeFileSync(w.at("segv"), "kill -SEGV $$\n");
    capped(["--name", "crash", "bash", w.at("segv")]);
    has(why("crash"), "crash: crashed, ended by SIGSEGV (exit 139)");
  });
  test("  the last few, without a name", () => { has(why(), "crash: crashed"); has(why(), "fine: finished"); });
  test("  no such job", () => { assert.equal(w.just(["heavy", "why", "nosuch"], F).code, 1); });
  test("  its failed scope doesn't linger", () => {
    const u = process.platform === "darwin" ? platform.knownCapped(`factory-${P}-capped-*`).join("\n")
      : spawnSync("systemctl", ["--user", "list-units", "--all", "--plain", "--no-legend", `factory-${P}-capped-*`], { encoding: "utf8" }).stdout;
    assert.equal(u.trim(), "");
  });
});
