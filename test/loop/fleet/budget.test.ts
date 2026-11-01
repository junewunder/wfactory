// The machine's memory budget and short jobs beside long ones (heavy.ts): a job known to be short
// runs beside a long job holding the slot; `just capped` fails at once rather than queue for long;
// a queued long job says what it's behind; on a made-up 30G machine, an editor held with --hold, a
// drill, a command-line run inside the drill (in the drill's share) and a second drill that waits
// for the editor to stop. The jobs run until the test lets them go (a file).
// Run: node --test test/loop/fleet/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { has, hasnt, readOr, until, HOST, killPid, pidOf, cmd, lastLine } from "../../lib/index.ts";
import { fleetFactory } from "./helpers.ts";

const DARWIN = process.platform === "darwin";
const f = fleetFactory("fbudget");
const { F, P, w, long, bg } = f;
// One slot (no FACTORY_HEAVY, no Heavy column's 2), polled often.
Object.assign(w.env, { FACTORY_CPU_LOCKS: w.at("cpu-budget"), FACTORY_HEAVY_POLL: "0.2" });
delete w.env.FACTORY_HEAVY;
const JOB = w.at("job");
// job <folder> <go>: notes it runs (<folder>/running), runs until <go> is there, notes it ran.
fs.writeFileSync(JOB, `#!/usr/bin/env bash
d=$1; mkdir -p "$d"; touch "$d/running"
for _ in $(seq 1200); do [ ! -e "$2" ] || break; sleep 0.1; done
rm "$d/running"; echo ran >> "$d/ran"
`, { mode: 0o755 });
const job = (x: string) => [JOB, w.at(x), w.at(`go.${x}`)];
const go = (x: string) => fs.writeFileSync(w.at(`go.${x}`), "");
const running = (x: string) => fs.existsSync(w.at(`${x}/running`));
// The group a command runs in: its cgroup on Linux, the folder macOS's watch tells it.
const GROUP = DARWIN ? `echo "$FACTORY_GROUP"` : "cat /proc/self/cgroup";
const capped = (args: string[], add: NodeJS.ProcessEnv = {}) => w.just(["capped", ...args], F, add);
const heavy = (args: string[] = []) => w.just(["heavy", ...args], F).stdout;
// What the machine's history says of a command: run times (s) and peaks (bytes).
const history = w.at("jobs/history.json");
const seed = (cmd: string[], secs: number[], peaks: number[] = []) => {
  fs.mkdirSync(path.dirname(history), { recursive: true });
  const h = fs.existsSync(history) ? JSON.parse(readOr(history)) : {};
  h[`${P}\t${cmd.join(" ")}`] = { secs, peaks };
  fs.writeFileSync(history, JSON.stringify(h));
};
const seen = (cmd: string[]) => JSON.parse(readOr(history) || "{}")[`${P}\t${cmd.join(" ")}`];
const meminfo = (totalG: number, availG: number) =>
  fs.writeFileSync(w.env.FACTORY_MEMINFO!, `MemTotal:       ${totalG * 1048576} kB\nMemAvailable:   ${availG * 1048576} kB\n`);
const machinesRow = (heavyCol: string, reserve: string) => {
  const mf = path.join(F, "docs/machines.md");
  fs.writeFileSync(mf, readOr(mf).split("\n").map((l) => l.startsWith(`| ${HOST} |`) ? l.replace(/\| [^|]* \| [^|]* \| [^|]* \|$/, `| ${heavyCol} | ${reserve} | 0 |`) : l).join("\n"));
};

describe("short jobs don't queue behind long ones (the slot is for jobs expected to run long)", () => {
  const SLOW = job("slow"), QUICK = job("quick");
  test("a 30-minute job holds the slot", async () => {
    seed(SLOW, [1800]); seed(QUICK, [60]);
    long(["start", "slow", "--", ...SLOW]);
    await until(() => running("slow"), "the 30-minute job runs");
    has(heavy(), "heavy slots (1, for jobs expected to run long): just long start slow");
  });
  test("  a 1-minute job of another lane starts within a minute, beside it", async () => {
    const c = bg("just", ["capped", ...QUICK]);
    await until(() => running("quick"), "the 1-minute job runs", 60);
    assert.ok(running("slow"), "the 30-minute job still runs");
    go("quick");
    hasnt((await c.end(30)).stdout, "waiting");
  });
  test("  and its run time is recorded", () => { assert.equal(seen(QUICK).secs.length, 2); });
  let r = { code: 0, stdout: "" }, took = 0;
  test("a job not known to be short: just capped fails at once, saying what it's behind", () => {
    const t = Date.now();
    r = capped(["bash", "-c", "true"]);
    took = Date.now() - t;
    assert.equal(r.code, 75);
  });
  test("  with about how long it has left", () => { has(r.stdout, "queued behind just long start slow"); has(r.stdout, "about 30 min left; use `just long start`"); });
  test("  at once", () => { assert.ok(took < 15000, `it took ${took} ms`); });
  let out = "";
  test("a long job queued behind it: just long wait says what it's behind and the time left", async () => {
    long(["start", "q2", "--", ...job("q2")]);
    await until(() => fs.existsSync(path.join(F, "runs/long/q2.queue")), "q2 queues");
    out = long(["wait", "q2", "--max", "1"]).stdout;
    has(out, "queued: q2 hasn't started");
  });
  test("  what it's behind", () => { has(out, "queued behind just long start slow"); });
  test("  and the time left", () => { assert.match(out, /about (29|30) min left/); });
  test("just heavy shows what waits, and on what", () => {
    const h = heavy();
    has(h, "waiting:");
    assert.match(h, /just long start q2 \([^)]*\): waiting for the CPU: queued behind just long start slow/);
  });
  test("  just long list too", () => { has(long(["list"]).stdout, "q2: queued"); });
  test("once the long job ends, the queued one runs", async () => {
    go("slow"); go("q2");
    has(long(["wait", "slow", "--max", "30"]).stdout, "done: slow finished");
    has(long(["wait", "q2", "--max", "30"]).stdout, "done: q2 finished");
  });
  test("just capped doesn't wait longer than its limit behind a job whose time isn't known", async () => {
    long(["start", "unk", "--", ...job("unk")]);   // (never run: its time isn't known)
    await until(() => running("unk"), "the job of unknown length holds the slot");
    const c = bg("just", ["capped", "bash", "-c", ": behind unk"], { add: { FACTORY_HEAVY_MAX_WAIT: "2" } });
    const e = await c.end(30);
    go("unk");
    long(["wait", "unk", "--max", "30"]);
    assert.equal(e.code, 75, e.stdout);
    has(e.stdout, "and still waiting (waiting for the CPU: queued behind just long start");
  });
});

describe("one memory budget per machine (a made-up 30G machine, no reserve)", () => {
  const G = 1024 ** 3;
  let editor = 0;
  after(() => { killPid(editor, "SIGKILL"); });
  test("an editor held with --hold keeps its 18G after its launcher exits", () => {
    meminfo(30, 30); machinesRow("99", "0");
    const r = capped(["--hold", "--name", "editor", "bash", "-c", `setsid sleep 300 >/dev/null 2>&1 < /dev/null & echo $! > ${w.at("editor.pid")}`], { FACTORY_MEM: "18G" });
    editor = pidOf(readOr(w.at("editor.pid")));
    assert.equal(r.code, 0);
    has(heavy(), "held until what it left running exits");
  });
  let drill: ReturnType<typeof bg>;
  test("a drill asks for 12G and gets it", async () => {
    drill = bg("just", ["capped", "--name", "drill", "bash", "-c",
      `${GROUP} > ${w.at("drill.cg")}; FACTORY_MEM=18G just capped --name cli bash -c '${GROUP} > ${w.at("cli.cg")}; until [ -e ${w.at("go.drill")} ]; do sleep 0.1; done'`],
      { add: { FACTORY_MEM: "12G" } });
    // Its whole group, not just the file: the shell makes cli.cg before cat writes into it.
    await until(() => /.\n$/.test(readOr(w.at("cli.cg"))) || drill.ended(), "the command-line run inside the drill starts");
    assert.ok(!drill.ended(), drill.out());
  });
  test("  a command-line run inside it runs in the drill's scope, under its cap", () => {
    assert.match(readOr(w.at("drill.cg")), /[a-z]/, "the drill's group");
    assert.equal(readOr(w.at("cli.cg")), readOr(w.at("drill.cg")));
  });
  test("  and counts against the drill's 12G, not a fresh 18G", () => {
    const h = heavy();
    has(h, "30G held, 0 free");
    assert.equal(h.split("\n").filter((l) => /^ +[0-9.]+[KMG] +just capped/.test(l)).length, 2, h);
  });
  let second: ReturnType<typeof bg>;
  test("a second 12G job waits", async () => {
    second = bg("just", ["capped", "--name", "second", "bash", "-c", `echo ran > ${w.at("second.ran")}`], { add: { FACTORY_MEM: "12G" } });
    await until(() => second.out().includes("memory: needs 12G"), "the second job waits for memory");
    assert.ok(!fs.existsSync(w.at("second.ran")));
  });
  test("  just heavy says it waits for memory, and what holds it", () => {
    const h = heavy();
    has(h, "waiting:");
    has(h, "memory: needs 12G, and 0 of the budget's 30G is free; held by just capped bash -c setsid sleep 300");
  });
  test("  until the editor stops", async () => {
    killPid(editor, "SIGKILL");
    await until(() => fs.existsSync(w.at("second.ran")), "the second job runs once the editor has stopped");
    assert.equal((await second.end(30)).code, 0);
  });
  test("  while the drill still runs", () => { assert.ok(!drill.ended()); });
  test("  and the editor's end is recorded (just heavy why)", () => { has(heavy(["why", "editor"]), "editor: what it left running (held until it exited) had ended by"); });
  test("the drill ends: the budget is free", async () => {
    go("drill");
    assert.equal((await drill.end(30)).code, 0);
    has(heavy(), "held by: nothing");
  });
  test("no heavy job starts while available memory is under the reserve", async () => {
    meminfo(30, 2); machinesRow("99", "3G");
    const c = bg("just", ["capped", "--name", "low", "bash", "-c", `echo ran > ${w.at("low.ran")}`]);
    await until(() => c.out().includes("2.0G available, under the reserve of 3.0G") || c.ended(), "the job waits for available memory");
    const ran = fs.existsSync(w.at("low.ran"));
    meminfo(30, 30);
    assert.ok(!ran, "it ran under the reserve");
    assert.equal((await c.end(30)).code, 0);
  });
  test("  and runs once there is (just heavy why low)", () => { has(heavy(["why", "low"]), "low: finished (exit 0)"); });
  // systemd takes a moment to see a scope go empty; a held run that left nothing must still be
  // taken for ended at once, with its own exit status (tried a few times, to meet that moment).
  test("a held run that leaves nothing running: its own end is recorded", () => {
    for (let i = 0; i < 5; i++) {
      assert.equal(capped(["--hold", "--name", `heldfail${i}`, "bash", "-c", "exit 3"]).code, 3);
      has(heavy(["why", `heldfail${i}`]), `heldfail${i}: failed, exited 3`);
    }
    hasnt(heavy(), "held until");
  });
  // A held run's scope is stopped whole at a kill, so systemd records it (Result oom-kill), which
  // a shim on PATH stands in for: a real kill pops Plasma's notification. (macOS's watch kills for
  // real: what the held run left grows past a small cap.)
  test("a held run killed at its cap: just heavy why says so", async () => {
    meminfo(30, 30); machinesRow("99", "0");
    const left = DARWIN ? `perl -e 'my @x; while (1) { push @x, "a" x 5_000_000 if -e "${w.at("ed2.go")}"; select(undef, undef, undef, 0.05) }'` : "sleep 300";
    const cap = DARWIN ? "60M" : "2G";
    capped(["--hold", "--name", "ed2", "bash", "-c", `setsid ${left} >/dev/null 2>&1 < /dev/null & echo $! > ${w.at("ed2.pid")}`], { FACTORY_MEM: cap });
    const pid = pidOf(readOr(w.at("ed2.pid")));
    assert.ok(pid > 0, "the held run left what it started");
    let PATH = w.env.PATH;
    if (DARWIN) fs.writeFileSync(w.at("ed2.go"), "");
    else {
      fs.mkdirSync(w.at("oomshim"), { recursive: true });
      const real = lastLine(cmd("bash", ["-c", "command -v systemctl"], { cwd: w.top, env: w.env }).stdout);
      fs.writeFileSync(w.at("oomshim/systemctl"), `#!/usr/bin/env bash\ncase "$*" in *"show -p Result "*) echo oom-kill ;; *) exec ${real} "$@" ;; esac\n`, { mode: 0o755 });
      PATH = `${w.at("oomshim")}:${PATH}`;
      killPid(pid, "SIGKILL");
    }
    const why = () => w.just(["heavy", "why", "ed2"], F, { PATH }).stdout;
    await until(() => !why().includes("running"), "the held run's end is noticed");
    has(why(), `ed2: killed at its memory cap (${cap})`);
  });
  test("a job's measured peaks set its next share: the last 3 plus 20%", async () => {
    const cmd = ["bash", "-c", `until [ -e ${w.at("go.peak")} ]; do sleep 0.1; done`];
    seed(cmd, [], [10 * G, 5 * G]);
    const c = bg("just", ["capped", ...cmd]);
    await until(() => /^ +12G +just capped bash -c until/m.test(heavy()), "it holds 12G", 30);
    go("peak");
    await c.end(30);
  });
});
