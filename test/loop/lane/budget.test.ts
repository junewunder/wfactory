// The loop's own heavy commands, the landing check, the settle's probe and refresh's, wait for
// memory in the machine's budget (heavy.ts), as `just capped` jobs do (refresh only for a probe due
// to run, and before the claim lock); a `just capped` inside the landing check runs without waiting
// on the loop's own reservation, though it still waits on others'. A stop gives the loop's turn
// back, and one that comes while it waits starts nothing. The loop is the real factory/loop.sh,
// in the file's lane, on a made-up 10G machine (a 7G budget, after the 3G reserve), its budget
// filled by a stand-in job's reservation until the test frees it. Run: node --test test/loop/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { has, readOr } from "../../lib/index.ts";
import { laneFactory } from "./helpers.ts";

// The check notes it ran, and whether in a heavy job's turn; then a `just capped` in it, which
// would wait for 4G of the 7G while the loop holds its own 4G (and give up after 2 s: exit 75).
// Held (check.hold), it says so (check.holding) and runs until it's killed.
const CHECK = `#!/usr/bin/env bash
[ ! -e "$FACTORY_LOCKS/check.hold" ] || { touch "$FACTORY_LOCKS/check.holding"; sleep 120; }
echo "check held=\${FACTORY_HEAVY_HELD:-}" >> "$FACTORY_LOCKS/check.ran"
just capped bash -c 'echo capped >> "$FACTORY_LOCKS/check.ran"'
`;
const f = laneFactory("lane-budget", "lane-budget", { check: "bash check.sh", files: { "check.sh": CHECK } });
const { a, w, setup, state, until } = f;
fs.writeFileSync(w.env.FACTORY_MEMINFO!, "MemTotal:       10485760 kB\nMemAvailable:    8388608 kB\n");
const env = { FACTORY_HEAVY_POLL: "0.2", FACTORY_HEAVY_MAX_WAIT: "2" };
const G = 1024 ** 3;
const cpu = w.env.FACTORY_CPU_LOCKS!;
fs.mkdirSync(cpu, { recursive: true });

// A stand-in job holding the whole budget (or mem bytes of it) while its process runs: free() ends
// it, once it has exited (a process not yet reaped would still count).
function fillBudget(mem = 7 * G) {
  const p = spawn("sleep", ["300"], { stdio: "ignore" });
  const id = `hog-${p.pid}`;
  fs.writeFileSync(path.join(cpu, `res-${id}.json`), JSON.stringify({ id, what: "a stand-in job", cmd: "hog", project: "other", lane: "other", root: w.top, name: "", mem, pid: p.pid, since: Date.now() }));
  const exited = once(p, "exit");
  return { id, free: async () => { p.kill(); await exited; } };
}
let hog = fillBudget();
after(async () => { await hog.free(); });
const ran = () => readOr(path.join(a.locks, "check.ran"));
// What the probe noted at each run: whether in a heavy job's turn, and who ran it.
const probed = () => readOr(path.join(a.locks, "probe.ran"));
// What waits for its turn in the budget now (heavy.ts's wait files).
const waiting = () => fs.readdirSync(cpu).filter((x) => x.startsWith("wait-")).map((x) => readOr(path.join(cpu, x))).join("\n");

describe("the landing check waits for memory in the budget", () => {
  let b: ReturnType<typeof f.loopBg>;
  test("with the budget full, the landing check waits", async () => {
    setup("add-unit", "g/one", "--title", "Unit one");
    b = f.loopBg(["--max", "1", "--no-wait"], env);
    await until(() => waiting().includes("the landing check"), "the landing check waits for its turn", 60);
  });
  test("  and hasn't run", () => { assert.equal(ran(), ""); });
  // (Said just after its wait file is written: waited for, not read at that moment.)
  test("  it says what it waits for", async () => { await b.until("memory: needs 4.0G", 10); });
  test("once memory frees, it runs", async () => {
    await hog.free();
    await until(() => ran().includes("check held="), "the landing check runs", 60);
  });
  test("  in a heavy job's turn", () => { has(ran(), "check held=1"); });
  test("  a `just capped` inside it runs without waiting on the loop's own reservation", async () => {
    await until(() => ran().includes("capped"), "the capped job in the check runs", 30);
  });
  test("  and the unit lands", async () => {
    await b.end();
    assert.equal(state("g/one"), "done");
  });
});

describe("the settle's probe waits for memory in the budget", () => {
  let b: ReturnType<typeof f.loopBg>;
  test("with the budget full when the session ends, the settle's probe waits", async () => {
    setup("add-unit", "g/probed", "--title", "Probed unit", "--probe-cmd", `echo "probe held=\${FACTORY_HEAVY_HELD:-} actor=\${FACTORY_ACTOR:-}" >> ${path.join(a.locks, "probe.ran")}`);
    const h = a.hold("g/probed");
    b = f.loopBg(["--max", "1", "--no-wait"], env);
    await h.held(60);
    hog = fillBudget();
    h.go();
    await until(() => waiting().includes("Probed unit's check (g/probed)"), "the settle's probe waits for its turn", 60);
  });
  // (The session's own \`just done\` runs the probe too, outside the loop's turn.)
  test("  and hasn't run", () => { assert.doesNotMatch(probed(), /held=1/); });
  test("once memory frees, it runs, in the loop's turn", async () => {
    await hog.free();
    await until(() => probed().includes("probe held=1"), "the settle's probe runs", 60);
    await b.end();
  });
});

// The rarer settles too (#117): here "pause asap" between the claim and the session (the project's
// pre-session asks for it), which settles the unit without a session.
describe("the settle at a pause before the session waits for memory too", () => {
  let b: ReturnType<typeof f.loopBg>;
  const ran2 = () => readOr(path.join(a.locks, "probe2.ran"));
  test("with the budget full, a unit claimed and paused before its session: its settle's probe waits", async () => {
    f.onMain("factory/pre-session", "#!/usr/bin/env bash\ntouch runs/.pause-now\n");
    setup("add-unit", "g/paused", "--title", "Paused unit", "--probe-cmd", `echo "probe held=\${FACTORY_HEAVY_HELD:-}" >> ${path.join(a.locks, "probe2.ran")}`);
    hog = fillBudget();
    b = f.loopBg(["--max", "1", "--no-wait"], env);
    await until(() => waiting().includes("Paused unit's check (g/paused)"), "the settle's probe waits for its turn", 60);
  });
  test("  and hasn't run", () => { assert.equal(ran2(), ""); });
  test("once memory frees, it runs, in the loop's turn, and the lane pauses", async () => {
    await hog.free();
    await until(() => ran2().includes("probe held=1"), "the settle's probe runs", 60);
    has((await b.end()).stdout, "paused asap: Paused unit (g/paused) was claimed but not started");
    f.onMain("factory/pre-session", null);
  });
});

describe("refresh's probes wait for memory, only when one is due, and before the claim lock", () => {
  let b: ReturnType<typeof f.loopBg>;
  test("with the budget full and a probe due, the refresh waits before the claim", async () => {
    setup("add-unit", "g/inputs", "--title", "Unit with inputs", "--inputs", "out/*.txt", "--probe-cmd", `echo "refresh held=\${FACTORY_HEAVY_HELD:-}" >> ${path.join(a.locks, "refresh.ran")}`);
    hog = fillBudget();
    b = f.loopBg(["--max", "1", "--no-wait"], env);
    await until(() => waiting().includes("the tracker's probes"), "the refresh waits for its turn", 60);
  });
  test("  and hasn't run", () => { assert.equal(readOr(path.join(a.locks, "refresh.ran")), ""); });
  test("  nor holds the claim lock meanwhile", () => {
    const r = a.run("bash", ["-c", `flock -n "$FACTORY_LOCKS/claim.lock" true && echo free`]);
    has(r.stdout, "free");
  });
  test("once memory frees, it runs, in the loop's turn", async () => {
    await hog.free();
    await until(() => readOr(path.join(a.locks, "refresh.ran")).includes("refresh held=1"), "the refresh's probe runs", 60);
    await b.end();
  });
  test("with no probe due (its inputs unchanged), a full budget doesn't hold up the claim", async () => {
    setup("add-unit", "g/plain", "--title", "Plain unit");
    hog = fillBudget();
    b = f.loopBg(["--max", "1", "--no-wait"], env);
    await b.until("iteration 1: Plain unit (g/plain)", 60);
    await hog.free();
    await b.end();
  });
});

describe("a `just capped` inside the loop's turn takes its own beside it", () => {
  // The loop's turn, as memoryTurn gives one: a reservation of 4G, its ID passed on. The job inside
  // asks for 4G more, of the 7G budget.
  const capped = (parent: string) => a.run("just", ["capped", "--mem", "4G", "--name", "inner", "bash", "-c", "echo inner ran"], { ...env, FACTORY_HEAVY_HELD: "1", FACTORY_HEAVY_RES: parent });
  test("it runs with only the loop's own reservation held", async () => {
    const loopTurn = fillBudget(4 * G);
    try { const r = capped(loopTurn.id); assert.equal(r.code, 0, r.stdout); has(r.stdout, "inner ran"); } finally { await loopTurn.free(); }
  });
  test("  but waits for others' (and gives up, exit 75, when it would wait too long)", async () => {
    const loopTurn = fillBudget(4 * G), other = fillBudget(4 * G);
    try { const r = capped(loopTurn.id); assert.equal(r.code, 75, r.stdout); has(r.stdout, "memory: needs 4.0G, and 3.0G of the budget's 7.0G is free; held by a stand-in job (4.0G)"); } finally { await loopTurn.free(); await other.free(); }
  });
});

describe("a stop gives the loop's turn back, and one that comes while it waits starts nothing", () => {
  // The exit steps held open (factory/tidy waits for tidy.go), so the test can look meanwhile.
  const lk = (x: string) => path.join(a.locks, x);
  const TIDY = `#!/usr/bin/env bash
touch "${lk("tidy.started")}"; for _ in $(seq 600); do [ ! -e "${lk("tidy.go")}" ] || exit 0; sleep 0.1; done
`;
  const loopsTurn = () => fs.readdirSync(cpu).filter((x) => x.startsWith("res-")).some((x) => readOr(path.join(cpu, x)).includes("the landing check"));
  const checks = () => ran().split("\n").filter((x) => x.startsWith("check held=")).length;
  const stopped = async (b: ReturnType<typeof f.loopBg>) => { fs.writeFileSync(lk("tidy.go"), ""); await b.end(); for (const x of ["tidy.started", "tidy.go"]) fs.rmSync(lk(x), { force: true }); };
  test("stopped during the landing check, the loop's turn is given back in its exit steps", async () => {
    f.onMain("factory/tidy", TIDY);
    fs.writeFileSync(lk("check.hold"), "");
    setup("add-unit", "g/stop1", "--title", "Stopped in its check");
    const b = f.loopBg(["--max", "1", "--no-wait"], env);
    try {
      await until(() => fs.existsSync(lk("check.holding")), "the landing check runs", 60);
      assert.ok(loopsTurn(), "the loop holds its turn while the check runs");
      void b.stop();
      await until(() => fs.existsSync(lk("tidy.started")), "the exit steps start", 60);
      assert.ok(!loopsTurn(), "the loop's turn is given back");
    } finally { fs.rmSync(lk("check.hold"), { force: true }); fs.rmSync(lk("check.holding"), { force: true }); await stopped(b); }
  });
  test("stopped while it waits for memory, it starts no check, even once memory frees", async () => {
    setup("add-unit", "g/stop2", "--title", "Stopped waiting");
    hog = fillBudget();
    const n = checks();
    const b = f.loopBg(["--max", "1", "--no-wait"], env);
    try {
      await until(() => waiting().includes("the landing check"), "the landing check waits for its turn", 60);
      void b.stop();
      // Memory frees once the loop has taken the stop (its exit steps run): freed as the signal
      // was sent, the loop could see the memory before the signal, and rightly start the check.
      await until(() => fs.existsSync(lk("tidy.started")), "the exit steps start", 60);
      await hog.free();
      await new Promise((r) => setTimeout(r, 1500));   // (memory has been free for several of its looks)
      assert.equal(checks(), n, "no check started");
      assert.ok(!loopsTurn(), "nor a turn left held");
    } finally { await stopped(b); }
  });
});
