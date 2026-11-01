// Memory caps through src/os.ts, with real kills: capped runs (a command in the foreground under
// a cap, its step's counts, the run known and forgotten, stopped with what it started) and capped
// jobs (how one killed over its cap ended, what its onEnd reads). On macOS that's os/darwin-cap.ts's
// watch; on Linux a real kill at a cap pops Plasma's "Memory Shortage Avoided", so the checks that
// kill run there only with FACTORY_TEST_OOM=1 (test/loop has the faked ones).
// Run: node --test runtime/test/
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "os-capped-test-")));
// (Before os.ts is read: the macOS jobs and capped runs in a folder of this test's own, looked at
// five times a second.)
process.env.FACTORY_JOBS_DIR = path.join(tmp, "jobs");
process.env.FACTORY_CAP_POLL = "0.2";
const { platform } = await import("../src/os.ts");
const mac = process.platform === "darwin";
const kills = mac || !!process.env.FACTORY_TEST_OOM;
const noCap = !platform.canCap() && "no memory caps here";
const noKill = (noCap || !kills) && (noCap || "a real kill at a cap (FACTORY_TEST_OOM=1)");

const N = `wf-cap-test-${process.pid}`;
const names: string[] = [];
const name = (s: string) => { const n = `${N}-${s}`; names.push(n); return n; };
test.after(() => {
  platform.stopCapped(...names.filter((n) => platform.cappedRunning(n)));
  platform.stopJobs(...names.filter((n) => platform.jobRunning(n)));
  for (const n of names) { platform.forgetCapped(n); platform.forgetJob(n); }
  fs.rmSync(tmp, { recursive: true, force: true });
});
const until = async (f: () => boolean, ms = 10000) => { const t = Date.now(); while (!f() && Date.now() - t < ms) await sleep(25); return f(); };
const PATH = process.env.PATH!;
// Memory, 10 MB more every 50 ms, until it's killed.
const HOG = ["perl", "-e", `my @x; while (1) { push @x, "a" x 10_000_000; select(undef, undef, undef, 0.05) }`];
// A capped run, as `just capped` runs one: its exit status and what its step wrote.
function capped(n: string, mem: string, cmd: string[], carryOn = false, add: NodeJS.ProcessEnv = {}) {
  const state = path.join(tmp, `${n}.state`);
  fs.writeFileSync(state, "");
  const [c, ...a] = platform.cappedCmd(n, mem, [...platform.cappedStep, ...cmd], carryOn);
  const r = spawnSync(c, a, { encoding: "utf8", cwd: tmp, env: { ...process.env, FACTORY_CAPPED_STATE: state, ...add } });
  const lines = fs.readFileSync(state, "utf8");
  const count = (k: string) => Number(new RegExp(`^${k} (\\d+)$`, "m").exec(lines)?.[1] ?? NaN);
  return { rc: r.status ?? (r.signal ? 128 + os.constants.signals[r.signal] : 1), out: r.stdout, lines, count };
}

test("a capped run: the command's own exit status and output, its step's counts, and nothing kept after", { skip: noCap }, async () => {
  const n = name("ok");
  const r = capped(n, "1G", ["sh", "-c", "echo pid $$; sleep 0.5; exit 3"]);
  assert.equal(r.rc, 3);
  assert.match(r.out, /^pid [0-9]+$/m, "a $ reaches the command as written");
  assert.equal(r.count("oom"), 0);
  assert.equal(r.count("oom_kill"), 0);
  assert.match(r.lines, /^done$/m);
  assert.ok(await until(() => !platform.cappedRunning(n)));
  assert.equal(platform.cappedOverCap(n), false);
  assert.deepEqual(platform.knownCapped(`${N}-o*`), []);
});

test("a capped run is told its group, which says what it holds and its cap", { skip: noCap }, async () => {
  const n = name("group");
  const out = path.join(tmp, "group.out");
  const [c, ...a] = platform.cappedCmd(n, "1G", ["sh", "-c", `echo "$FACTORY_GROUP" > ${out}; exec sleep 300`]);
  const ch = spawn(c, a, { stdio: "ignore", env: process.env });
  try {
    assert.ok(await until(() => platform.cappedRunning(n) && fs.existsSync(out)));
    const g = platform.cappedGroup(n);
    assert.ok(g);
    if (mac) assert.equal(fs.readFileSync(out, "utf8").trim(), g);
    assert.ok(await until(() => (platform.groupProcesses(g) ?? []).includes(ch.pid!)), "the command is in its group");
    assert.ok(await until(() => (platform.groupMemory(g)?.used ?? 0) > 0));
    assert.equal(platform.groupMemory(g)?.cap, 1024 ** 3);
    assert.ok(await until(() => Number(platform.groupPeak(g)) > 0));
  } finally { platform.stopCapped(n); }
  assert.ok(await until(() => ch.exitCode !== null || ch.signalCode !== null), "stopped");
  assert.equal(platform.cappedRunning(n), false);
});

test("over its cap: the run is killed, and the kill is counted and kept until it's forgotten", { skip: noKill }, async () => {
  const n = name("hog");
  const t = Date.now();
  const r = capped(n, "200M", HOG);
  assert.equal(r.rc, 137);
  assert.equal(r.count("oom"), 1);
  assert.equal(r.count("oom_kill"), 1);
  assert.ok(r.count("peak") > 150 * 2 ** 20, r.lines);
  assert.ok(await until(() => !platform.cappedRunning(n)));
  assert.equal(platform.cappedOverCap(n), true);
  assert.ok(platform.cappedEnded(n) >= t);
  if (mac) assert.deepEqual(platform.knownCapped(`${N}-h*`), [n]);
  platform.forgetCapped(n);
  assert.equal(platform.cappedOverCap(n), false);
  assert.deepEqual(platform.knownCapped(`${N}-h*`), []);
});

test("over its cap with carryOn: only the biggest is killed, and a wrapper goes on with its own exit", { skip: noKill }, async () => {
  const n = name("wrap");
  const r = capped(n, "200M", ["sh", "-c", `${HOG.slice(0, 2).join(" ")} '${HOG[2]}'; echo the sweep goes on; exit 1`], true);
  assert.equal(r.rc, 1);
  assert.match(r.out, /the sweep goes on/);
  assert.equal(r.count("oom_kill"), 1);
});

test("a stop of a capped run stops what it started, one that left its session too", { skip: noCap }, async () => {
  const n = name("stop");
  const esc = path.join(tmp, "esc.pid");
  const leave = `perl -MPOSIX -e 'fork and exit; POSIX::setsid(); open(my $f, ">", "${esc}"); print $f "$$\\n"; close $f; exec "sleep", "300"'`;
  const [c, ...a] = platform.cappedCmd(n, "1G", ["sh", "-c", `${leave}; exec sleep 300`]);
  const ch = spawn(c, a, { stdio: "ignore", env: process.env });
  assert.ok(await until(() => fs.existsSync(esc) && fs.readFileSync(esc, "utf8").endsWith("\n")));
  const pid = Number(fs.readFileSync(esc, "utf8"));
  await sleep(500);
  platform.stopCapped(n);
  assert.ok(await until(() => ch.exitCode !== null || ch.signalCode !== null), "the command");
  assert.ok(await until(() => platform.processEnded(pid)), "the process in a session of its own");
});

test("a capped job over its cap: ended oom-kill, and its onEnd reads the peak and the kill", { skip: noKill }, async () => {
  const n = name("job");
  const end = path.join(tmp, "job.end");
  const note = `echo "$SERVICE_RESULT" > ${end}`;
  // (What onEnd runs reads its group as long.ts's `stopped` does.)
  const read = `const { platform } = await import(${JSON.stringify(new URL("../src/os.ts", import.meta.url).href)}); const g = platform.myGroup(); console.log(platform.groupPeak(g), platform.groupKills(g)?.overCap);`;
  assert.equal(platform.startJob(n, { PATH }, HOG, { mem: "200M", keepResult: true, onEnd: ["sh", "-c", `${note}; "${process.execPath}" --input-type=module -e '${read}' >> ${end}`] }), 0);
  assert.ok(await until(() => !platform.jobRunning(n), 20000));
  assert.equal(platform.jobResult(n), "oom-kill");
  assert.ok(await until(() => fs.existsSync(end) && fs.readFileSync(end, "utf8").split("\n").length >= 3));
  const [result, readBack] = fs.readFileSync(end, "utf8").split("\n");
  assert.equal(result, "oom-kill");
  const [peak, over] = readBack.split(" ");
  assert.ok(Number(peak) > 150 * 2 ** 20, readBack);
  assert.equal(over, "1");
});

test("a capped run started inside another is its own: it counts against its own cap, not the outer one's", { skip: noCap }, async () => {
  const outer = name("outer"), inner = name("inner");
  // The inner run holds 300 MB, under its own 1G cap and over the outer one's 150M, then ends.
  const hold = `my $x = "a" x 300_000_000; select(undef, undef, undef, 1.5)`;
  const innerCmd = platform.cappedCmd(inner, "1G", ["perl", "-e", hold]).map((w) => `'${w.replace(/'/g, `'\\''`)}'`).join(" ");
  const r = capped(outer, "150M", ["sh", "-c", `${innerCmd} && echo inner done`]);
  assert.equal(r.rc, 0, r.lines);
  assert.match(r.out, /inner done/);
  assert.equal(r.count("oom_kill"), 0, "the outer run killed nothing");
});

test("a stop by the handle a listing gave reaches a capped run", { skip: noCap }, async () => {
  const n = name("handle");
  const [c, ...a] = platform.cappedCmd(n, "1G", ["sleep", "300"]);
  const ch = spawn(c, a, { stdio: "ignore", env: process.env });
  assert.ok(await until(() => platform.cappedRunning(n)));
  const listed = platform.knownCapped(`${N}-handle*`);
  assert.equal(listed.length, 1);
  platform.stop(...listed);
  assert.ok(await until(() => ch.exitCode !== null || ch.signalCode !== null), "stopped");
});

// A watch killed with its run never removes the run's folder, and one from before a reboot is of no
// run: each capped run that starts sweeps those away, as systemd drops a transient unit. A kill
// over the cap not yet forgotten stays, to be asked about.
test("a capped run's folder left by a watch killed with its run, or from before a reboot, goes when the next run starts", { skip: !mac && "macOS's capped folders (Linux's are systemd scopes)" }, async () => {
  const { bootId } = await import("../src/os/darwin.ts");
  const dead = spawnSync("true").pid!;   // a pid nothing runs as now
  // (runner: false, as a watch leaves a kill over the cap; boot "": a watch that never started.)
  const left = (s: string, boot: string, kills = "", runner = true, hoursAgo = 0) => {
    const n = name(s), d = path.join(tmp, "capped", n);
    fs.mkdirSync(d, { recursive: true });
    for (const f of runner ? ["pid", "runner"] : ["pid"]) fs.writeFileSync(path.join(d, f), `${dead} 1700000000\n`);
    if (boot) fs.writeFileSync(path.join(d, "boot"), `${boot}\n`);
    if (kills) fs.writeFileSync(path.join(d, "kills"), `${kills}\n`);
    const t = Date.now() / 1000 - hoursAgo * 3600;
    fs.utimesSync(d, t, t);
    return d;
  };
  const orphan = left("orphan", bootId()), earlier = left("earlier", "an-earlier-boot", "1 1"), killed = left("killed", bootId(), "1 1");
  const earlierKilled = left("earlier-killed", "an-earlier-boot", "1 1", false), noWatch = left("no-watch", "", "", false, 2), starting = left("starting", "", "", false);
  const sweeper = name("sweeper");
  assert.equal(capped(sweeper, "1G", ["true"]).rc, 0);
  // (Its watch sweeps before its first look, and removes its own folder once the run has ended.)
  assert.ok(await until(() => !fs.existsSync(path.join(tmp, "capped", sweeper))), "the sweeping run's watch is done");
  assert.ok(!fs.existsSync(orphan), "a run and its watch both gone: swept");
  assert.ok(!fs.existsSync(earlier), "an earlier boot's: swept, kill or not");
  assert.ok(fs.existsSync(killed), "a kill over the cap this boot, not yet forgotten: kept");
  assert.ok(!fs.existsSync(earlierKilled), "an earlier boot's kill, its watch's runner removed as it ended: swept");
  assert.ok(!fs.existsSync(noWatch), "one whose watch never started, two hours on: swept");
  assert.ok(fs.existsSync(starting), "one whose watch hasn't started yet: kept");
});
