// Heavy jobs: one at a time on a machine (docs/machines.md, Heavy), across lanes: long jobs
// and `just capped` take turns for the machine's slots; --light doesn't queue. The jobs run
// until the test lets them go (a file), so nothing waits a fixed time.
// Run: node --test test/loop/fleet/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { has, hasnt, readOr, chomp, until, alive, HOST, fileHas, killPid, pidOf } from "../../lib/index.ts";
import { fleetFactory } from "./helpers.ts";

const f = fleetFactory("fheavy");
const { F, w, long, run, bg } = f;
// This file's slots, and no FACTORY_HEAVY: the machine's own count.
Object.assign(w.env, { FACTORY_CPU_LOCKS: w.at("cpu-heavy"), FACTORY_HEAVY_POLL: "0.2" });
delete w.env.FACTORY_HEAVY;
const JOB = w.at("job");
// job <folder> <go>: runs until <go> is there (at most a minute), and notes in <folder>/overlap
// whether another job ran alongside it, in <folder>/ran that it ran.
fs.writeFileSync(JOB, `#!/usr/bin/env bash
d=$1; mkdir -p "$d"; touch "$d/running.$$"
for _ in $(seq 600); do [ -z "$(ls "$d" | grep running. | grep -v "running.$$")" ] || touch "$d/overlap"; [ ! -e "$2" ] || break; sleep 0.1; done
rm "$d/running.$$"; echo "$$" >> "$d/ran"
`, { mode: 0o755 });
const go = (x: string) => fs.writeFileSync(w.at(`go.${x}`), "");
const job = (x: string) => [JOB, w.at(x), w.at(`go.${x}`)];
const running = (x: string) => fs.existsSync(w.at(x)) && fs.readdirSync(w.at(x)).some((e) => e.startsWith("running."));
const overlap = (x: string) => fs.existsSync(w.at(`${x}/overlap`));
// (The value alone: a column the table lacks is warned about on stderr.)
const machineGet = (n: number | string) => chomp(run("bash", ["-c", `. factory/machines.sh && machine_get ${HOST} ${n} 2>/dev/null`]).stdout);
const capped = (args: string[]) => w.just(["capped", ...args], F);
const cappedBg = (args: string[]) => bg("just", ["capped", ...args]);
const restoreMachines = () => w.git(F, "checkout", "-q", "docs/machines.md");

describe("heavy jobs: one at a time on a machine (docs/machines.md, Heavy), across lanes", () => {
  let hv2 = "";
  test("a second heavy job on the machine waits for the CPU", async () => {
    long(["start", "hv1", "--", ...job("h1")]);
    await until(() => running("h1"), "hv1 runs");
    long(["start", "hv2", "--", ...job("h1")]);
    await fileHas(path.join(F, "runs/long/hv2.log"), "heavy: waiting for the CPU");
    hv2 = long(["wait", "hv2", "--max", "1"]).stdout;
    has(hv2, "queued: hv2 hasn't started");
  });
  test("  and says which job it waits on", () => { has(readOr(path.join(F, "runs/long/hv2.log")), "just long start hv1"); });
  test("  as does its wait", () => { has(hv2, "queued behind just long start hv1"); });
  test("  the two run one after another, not both at once", () => {
    go("h1");
    long(["wait", "hv1", "--max", "30"]); long(["wait", "hv2", "--max", "30"]);
    assert.equal(readOr(w.at("h1/ran")).trim().split("\n").length, 2, "both ran");
    assert.ok(!overlap("h1"), "they ran at once");
  });
  let out = "";
  test("just capped waits for a long job's slot too", async () => {
    long(["start", "hv3", "--", ...job("h2")]);
    await until(() => running("h2"), "hv3 runs");
    const c = cappedBg(job("h2"));
    await until(() => c.out().includes("heavy: waiting for the CPU"), "just capped waits");
    go("h2");
    out = (await c.end()).stdout; long(["wait", "hv3", "--max", "30"]);
    has(out, "heavy: waiting for the CPU");
  });
  test("  and runs after it", () => { assert.equal(readOr(w.at("h2/ran")).trim().split("\n").length, 2, "both ran"); assert.ok(!overlap("h2")); });
  test("just capped --light doesn't wait", async () => {
    long(["start", "hv4", "--", ...job("h3")]);
    await until(() => running("h3"), "hv4 runs");
    const c = cappedBg(["--light", ...job("h3")]);
    // Both run at once (each notes the other) before they're let go.
    await until(() => overlap("h3") || c.out().includes("waiting for the CPU") || c.ended(), "the light job runs alongside, waits, or ends");
    go("h3");
    out = (await c.end()).stdout; long(["wait", "hv4", "--max", "30"]);
    hasnt(out, "waiting for the CPU");
  });
  test("  it runs alongside the heavy job", () => { assert.ok(overlap("h3")); });
  test("a heavy job's own capped step doesn't wait for its slot", () => {
    go("h4");
    long(["start", "nest", "--", "just", "capped", ...job("h4")]);
    has(long(["wait", "nest", "--max", "30"]).stdout, "done: nest finished");
  });
  test("the machines file's Heavy column", () => {
    const mf = path.join(F, "docs/machines.md");
    fs.writeFileSync(mf, readOr(mf).split("\n").map((l) => l.startsWith(`| ${HOST} |`) ? l.replace(/\| 1 \| 3G \| 0 \|$/, "| 2 | 3G | 0 |") : l).join("\n"));
    assert.equal(machineGet(8), "2");
    assert.equal(machineGet("Heavy"), "2");
  });
  test("  Heavy 2: two run at once", async () => {
    long(["start", "hv5", "--", ...job("h5")]); long(["start", "hv6", "--", ...job("h5")]);
    await until(() => overlap("h5") || [5, 6].some((n) => readOr(path.join(F, `runs/long/hv${n}.log`)).includes("waiting for the CPU")), "both run, or one waits");
    go("h5");
    long(["wait", "hv5", "--max", "30"]); long(["wait", "hv6", "--max", "30"]);
    restoreMachines();
    assert.ok(overlap("h5"));
  });
  test("something a heavy job leaves running doesn't keep its slot", () => {
    capped(["bash", "-c", `setsid sleep 31.5 >/dev/null 2>&1 & echo $! > ${w.at("left.pid")}`]);
    const pid = pidOf(readOr(w.at("left.pid")));
    after(() => { killPid(pid, "SIGKILL"); });
    assert.ok(pid > 0 && alive(pid), "what it left still runs");
    assert.equal(run("timeout", ["10", "just", "capped", "true"]).code, 0);
  });
  test("a machines file without the Heavy column: one at a time", async () => {
    const mf = path.join(F, "docs/machines.md");
    // Drop the last three columns (Heavy, Reserve, GPU), as a machines file from before them.
    fs.writeFileSync(mf, readOr(mf).split("\n").map((l) => l.startsWith("|") ? l.replace(/(?:[^|]*\|){3}$/, "") : l).join("\n"));
    assert.equal(machineGet(8), "", "the machines file still has a Heavy column");
    has(run("bash", ["-c", `. factory/machines.sh && machine_get ${HOST} Heavy`]).stdout, "table has no Heavy column; every machine gets its default (1)");
    long(["start", "hv7", "--", ...job("h7")]);
    await until(() => running("h7"), "hv7 runs");
    // (A command never run before: \`true\` has, and one known to be short runs beside it.)
    const c = cappedBg(["bash", "-c", ": h7"]);
    await until(() => c.out().includes("heavy: waiting for the CPU") || c.ended(), "just capped waits, or ends");
    go("h7");
    out = (await c.end()).stdout; long(["wait", "hv7", "--max", "30"]);
    restoreMachines();
    has(out, "heavy: waiting for the CPU");
  });
});
