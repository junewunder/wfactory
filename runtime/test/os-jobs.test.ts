// Jobs through src/os.ts, with real ones (systemd user units on Linux, os/darwin-job.ts's
// supervisor on macOS): started under a name in this folder with these variables, found, stopped
// with everything they started (a grandchild in a session of its own too), how a kept one ended,
// and the command run once one has; on macOS also the daemon's service and its crontab check.
// Run: node --test runtime/test/
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "os-jobs-test-")));
// (Before os.ts is read: the macOS jobs and services in a folder of this test's own.)
process.env.FACTORY_JOBS_DIR = path.join(tmp, "jobs");
process.env.FACTORY_DAEMON_UNIT_DIR = path.join(tmp, "services");
const { platform } = await import("../src/os.ts");
const mac = process.platform === "darwin";

const N = `wf-os-test-${process.pid}`;
const names: string[] = [];
const name = (s: string) => { const n = `${N}-${s}`; names.push(n); return n; };
test.after(() => {
  platform.stopJobs(...names.filter((n) => platform.jobRunning(n)));
  for (const n of names) platform.forgetJob(n);
  fs.rmSync(tmp, { recursive: true, force: true });
});
const until = async (f: () => boolean, ms = 10000) => { const t = Date.now(); while (!f() && Date.now() - t < ms) await sleep(25); return f(); };
const PATH = process.env.PATH!;
// A grandchild in a session of its own: out of the job's process group, still the job's.
const ESCAPE = `perl -MPOSIX -e 'fork and exit; POSIX::setsid(); open(my $f, ">", "esc.pid"); print $f "$$\\n"; close $f; exec "sleep", "300"'`;

test("a job runs detached in this folder with its variables, and stops with all it started", async () => {
  const n = name("run");
  const was = process.cwd();
  process.chdir(tmp);
  try { assert.equal(platform.startJob(n, { PATH, WF_JOB: "x y" }, ["sh", "-c", `echo "$WF_JOB" > env.out; pwd > pwd.out; ${ESCAPE}; exec sleep 300`]), 0); } finally { process.chdir(was); }
  assert.ok(await until(() => fs.existsSync(path.join(tmp, "esc.pid")) && fs.existsSync(path.join(tmp, "pwd.out"))));
  assert.equal(platform.jobRunning(n), true);
  assert.equal(fs.readFileSync(path.join(tmp, "env.out"), "utf8"), "x y\n");
  assert.equal(fs.readFileSync(path.join(tmp, "pwd.out"), "utf8").trim(), tmp);
  const pid = platform.jobPid(n);
  assert.ok(pid > 0);
  assert.equal(platform.processEnv(pid)?.WF_JOB, "x y");
  assert.deepEqual(platform.runningJobs(`${N}-r*`), [n]);
  assert.equal(platform.startJob(n, { PATH }, ["true"]), 1, "a second job by a running one's name");
  const esc = Number(fs.readFileSync(path.join(tmp, "esc.pid"), "utf8"));
  platform.stopJobs(n);
  assert.equal(platform.jobRunning(n), false);
  assert.ok(await until(() => platform.processEnded(pid)), "the job's own process");
  assert.ok(await until(() => platform.processEnded(esc)), "the grandchild in a session of its own");
  assert.equal(platform.jobKnown(n), false, "a job that didn't keep its result is forgotten");
});

test("a kept job that failed says how, until it's forgotten; onEnd runs either way", async () => {
  const n = name("fail");
  const end = path.join(tmp, "end.out");
  assert.equal(platform.startJob(n, { PATH }, ["sh", "-c", "exit 3"], { keepResult: true, onEnd: ["sh", "-c", `echo "$SERVICE_RESULT" >> ${end}`] }), 0);
  assert.ok(await until(() => !platform.jobRunning(n) && platform.jobResult(n) === "exit-code"), platform.jobResult(n));
  assert.equal(platform.jobKnown(n), true);
  assert.deepEqual(platform.knownJobs(`${N}-f*`), mac ? [n] : [`${n}.service`]);
  assert.ok(await until(() => fs.existsSync(end) && fs.readFileSync(end, "utf8") === "exit-code\n"));
  platform.forgetJob(n);
  assert.equal(platform.jobKnown(n), false);
  assert.equal(platform.jobResult(n), mac ? "" : "success");

  const ok = name("ok");
  assert.equal(platform.startJob(ok, { PATH }, ["true"], { keepResult: true, onEnd: ["sh", "-c", `echo "$SERVICE_RESULT" >> ${end}`] }), 0);
  assert.ok(await until(() => fs.readFileSync(end, "utf8") === "exit-code\nsuccess\n"));
  assert.ok(await until(() => !platform.jobKnown(ok)), "one that succeeded isn't kept");
});

// Each name a job ever had leaves its start lock: one of no job, untouched for a day, goes when
// a job starts.
test("start locks of no job, a day old, go when a job starts; the rest stay", { skip: !mac && "macOS's supervisor (systemd is Linux's)" }, async () => {
  const jobs = path.join(tmp, "jobs"), lock = (n: string) => path.join(jobs, `.${n}.start`);
  fs.mkdirSync(jobs, { recursive: true });
  const old = (Date.now() - 2 * 86400e3) / 1000;
  for (const n of ["gone-old", "kept-job", "kept-new"]) fs.writeFileSync(lock(n), "");
  for (const n of ["gone-old", "kept-job"]) fs.utimesSync(lock(n), old, old);
  fs.mkdirSync(path.join(jobs, "kept-job"));
  const n = name("sweeps");
  assert.equal(platform.startJob(n, { PATH }, ["true"]), 0);
  assert.ok(!fs.existsSync(lock("gone-old")), "a day old, of no job: gone");
  assert.ok(fs.existsSync(lock("kept-job")), "its job's folder is there: kept");
  assert.ok(fs.existsSync(lock("kept-new")), "touched within the day: kept");
  assert.ok(fs.existsSync(lock(n)), "the one just taken: kept");
  fs.rmSync(path.join(jobs, "kept-job"), { recursive: true });
});

test("a job's output goes to its log", async () => {
  const n = name("log");
  const log = path.join(tmp, "job.log");
  fs.writeFileSync(log, "before\n");
  assert.equal(platform.startJob(n, { PATH }, ["sh", "-c", "echo out; echo err >&2"], { log }), 0);
  assert.ok(await until(() => fs.readFileSync(log, "utf8").split("\n").length === 4));
  assert.deepEqual(fs.readFileSync(log, "utf8").split("\n").slice(0, 3).sort(), ["before", "err", "out"]);
});

test("a stop that the job doesn't heed ends in a kill after its stop timeout", async () => {
  const n = name("stubborn");
  assert.equal(platform.startJob(n, { PATH }, ["sh", "-c", "trap '' TERM; while :; do sleep 1; done"], { stopTimeout: 1, keepResult: true }), 0);
  assert.ok(await until(() => platform.jobPid(n) > 0));
  const t = Date.now();
  platform.stopJobs(n);
  assert.equal(platform.jobRunning(n), false);
  assert.ok(Date.now() - t < 15000);
  assert.equal(platform.jobResult(n), "timeout");
});

test("the remote check of a job, as another machine's overseer runs it", async () => {
  const n = name("remote");
  const { remote } = await import("../src/os.ts");
  const ask = () => { const [c, ...a] = remote.jobRunningCmd(n); return spawnSync(c, a, { env: process.env }).status; };
  assert.ok(remote.jobStoppedStatus.includes(ask()!));
  platform.startJob(n, { PATH }, ["sleep", "300"]);
  assert.equal(ask(), 0);
  platform.stopJobs(n);
  assert.ok(remote.jobStoppedStatus.includes(ask()!));
});

test("a job whose supervisor was killed outright still runs, and stops", { skip: !mac && "macOS's supervisor (systemd is Linux's)" }, async () => {
  const n = name("orphan");
  assert.equal(platform.startJob(n, { PATH }, ["sleep", "300"], { stopTimeout: 2 }), 0);
  assert.ok(await until(() => platform.jobPid(n) > 0));
  const pid = platform.jobPid(n);
  process.kill(Number(fs.readFileSync(path.join(tmp, "jobs", n, "runner"), "utf8").split(" ")[0]), "SIGKILL");
  await sleep(200);
  assert.equal(platform.jobRunning(n), true, "its own process still runs");
  assert.equal(platform.jobPid(n), pid);
  assert.equal(platform.startJob(n, { PATH }, ["true"]), 1, "nor is a second one started");
  platform.stopJobs(n);
  assert.ok(await until(() => platform.processEnded(pid)));
  assert.equal(platform.jobRunning(n), false);
  assert.equal(platform.jobKnown(n), false);
});

test("a stop reaches a process that left its session under a Node one, as a lane's tools are under claude", async () => {
  const n = name("node");
  const was = process.cwd();
  process.chdir(tmp);
  // node → sh → sleep in a session of its own, sh waiting on it: the Node process passes on no
  // mark, so it's found under the job. (One whose parent exits at once can get away on macOS:
  // os/darwin-job.ts's header.)
  const leave = `perl -MPOSIX -e 'POSIX::setsid(); open(my $f, ">", "esc2.pid"); print $f "$$\\n"; close $f; exec "sleep", "300"'`;
  const js = `require("child_process").spawn("sh", ["-c", ${JSON.stringify(leave)}], { stdio: "inherit" }); setInterval(() => {}, 1000)`;
  try { assert.equal(platform.startJob(n, { PATH }, [process.execPath, "-e", js]), 0); } finally { process.chdir(was); }
  assert.ok(await until(() => fs.existsSync(path.join(tmp, "esc2.pid"))));
  const esc = Number(fs.readFileSync(path.join(tmp, "esc2.pid"), "utf8"));
  // (Seen under the job: the supervisor looks every two seconds, and at the stop.)
  await sleep(2500);
  platform.stopJobs(n);
  assert.ok(await until(() => platform.processEnded(esc)), "the process in a session of its own");
});

// A crontab of the test's own, in a file: the folder to put first on PATH.
const fakeCrontab = (bin: string, tab: string) => {
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "crontab"), `#!/bin/sh
[ -e ${tmp}/cron-broken ] && { echo "crontab: can't open" >&2; exit 1; }
[ -e ${tmp}/cron-refused ] && [ "$1" = - ] && { echo "crontab: tmp/tmp.2552: Operation not permitted" >&2; exit 1; }
case "$1" in -l) [ -e ${tab} ] && cat ${tab} || { echo "crontab: no crontab for $(id -un)" >&2; exit 1; } ;; -) cat > ${tab} ;; esac
`, { mode: 0o755 });
  return bin;
};

test("the crontab: a service's lines replaced, the rest kept as it was, and left alone when it can't be read", { skip: !mac && "macOS's service (Linux's is a systemd unit)" }, async () => {
  const { cronLines } = await import("../src/os/darwin.ts");
  const tab = path.join(tmp, "crontab.txt"), bin = fakeCrontab(path.join(tmp, "cronbin"), tab);
  const was = process.env.PATH;
  process.env.PATH = `${bin}:${was}`;
  try {
    assert.equal(cronLines("svc", ["@reboot a", "* * * * * b"]), true);
    assert.equal(fs.readFileSync(tab, "utf8"), "@reboot a # wfactory:svc\n* * * * * b # wfactory:svc\n");
    fs.writeFileSync(tab, "MAILTO=me\n\n0 1 * * * own\n@reboot old # wfactory:svc\n");
    assert.equal(cronLines("svc", ["@reboot new"]), true);
    assert.equal(fs.readFileSync(tab, "utf8"), "MAILTO=me\n\n0 1 * * * own\n@reboot new # wfactory:svc\n");
    fs.writeFileSync(path.join(tmp, "cron-broken"), "");
    assert.equal(cronLines("svc", ["@reboot newer"]), false);
    assert.equal(fs.readFileSync(tab, "utf8"), "MAILTO=me\n\n0 1 * * * own\n@reboot new # wfactory:svc\n");
  } finally { process.env.PATH = was; fs.rmSync(path.join(tmp, "cron-broken"), { force: true }); }
});

// Without Full Disk Access (an ssh session's, by default), macOS refuses to write the crontab:
// what's said names what to turn on.
test("the crontab refused, as macOS does without Full Disk Access: it says what to turn on", { skip: !mac && "macOS's service (Linux's is a systemd unit)" }, async () => {
  const { cronLines } = await import("../src/os/darwin.ts");
  const tab = path.join(tmp, "crontab-refused.txt"), bin = fakeCrontab(path.join(tmp, "cronbin-refused"), tab);
  const was = process.env.PATH, write = process.stderr.write;
  let said = "";
  process.env.PATH = `${bin}:${was}`;
  fs.writeFileSync(path.join(tmp, "cron-refused"), "");
  process.stderr.write = ((s: string) => { said += s; return true; }) as typeof process.stderr.write;
  try {
    assert.equal(cronLines("svc", ["@reboot a"]), false);
  } finally { process.stderr.write = write; process.env.PATH = was; fs.rmSync(path.join(tmp, "cron-refused"), { force: true }); }
  assert.ok(!fs.existsSync(tab));
  assert.match(said, /couldn't be written, so svc's lines there weren't written \(without them, nothing brings the lanes back after a restart\): crontab: tmp\/tmp.2552: Operation not permitted/);
  assert.match(said, /Full Disk Access/);
  assert.match(said, /Allow full disk access for remote users/);
});

// A deploy restarts the daemon onto the new copy; its crontab lines, which name the old copy's
// supervisor, move too, so that the old copy can be deleted.
test("the daemon's service restarted: its crontab lines name this copy's supervisor", { skip: !mac && "macOS's crontab check" }, () => {
  const n = name("moved");
  const runner = fileURLToPath(new URL("../src/os/darwin-job.ts", import.meta.url));
  const home = path.join(tmp, "home"), tab = path.join(tmp, "crontab-moved.txt"), bin = fakeCrontab(path.join(tmp, "cronbin-moved"), tab);
  const services = path.join(home, "Library", "Application Support", "wfactory", "services");
  fs.mkdirSync(services, { recursive: true });
  fs.writeFileSync(path.join(services, `${n}.json`), JSON.stringify({ name: n, description: "a test service", cmd: ["sleep", "300"], env: { PATH } }));
  fs.writeFileSync(tab, `0 1 * * * own\n@reboot /old/node /old/darwin-job.ts service x --boot # wfactory:${n}\n`);
  const was = { HOME: process.env.HOME, PATH: process.env.PATH, FACTORY_DAEMON_UNIT_DIR: process.env.FACTORY_DAEMON_UNIT_DIR };
  Object.assign(process.env, { HOME: home, PATH: `${bin}:${PATH}` });
  delete process.env.FACTORY_DAEMON_UNIT_DIR;
  try { platform.restartService(n); }
  finally { for (const [k, v] of Object.entries(was)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
  const t = fs.readFileSync(tab, "utf8");
  assert.ok(!t.includes("/old/"), t);
  assert.ok(t.includes(runner), t);
  assert.ok(t.startsWith("0 1 * * * own\n"), t);
});

test("a process's start time in any language the user reads dates in", () => {
  const was = { LANG: process.env.LANG, LC_ALL: process.env.LC_ALL };
  Object.assign(process.env, { LANG: "de_DE.UTF-8", LC_ALL: "de_DE.UTF-8" });
  try { assert.match(platform.processStart(process.pid), /^[0-9]+$/); }
  finally { for (const [k, v] of Object.entries(was)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
});

test("the daemon's service: started at boot by the crontab's check, and again only after it failed", { skip: !mac && "macOS's crontab check" }, async () => {
  const n = name("svc");
  const runner = fileURLToPath(new URL("../src/os/darwin-job.ts", import.meta.url));
  const before = spawnSync("crontab", ["-l"], { encoding: "utf8" }).stdout;
  platform.installService(n, "a test service", ["sleep", "300"], { PATH });
  assert.equal(spawnSync("crontab", ["-l"], { encoding: "utf8" }).stdout, before, "a service outside the user's own folder isn't put in the crontab");
  assert.equal(platform.serviceCmd(n), "sleep 300");
  const spec = path.join(tmp, "services", `${n}.json`);
  const check = (...a: string[]) => spawnSync(process.execPath, [runner, "service", spec, ...a], { env: process.env });
  check();
  assert.equal(platform.jobRunning(n), false, "not started outside a boot when it never failed");
  check("--boot");
  assert.ok(await until(() => platform.jobPid(n) > 0));
  // Its supervisor killed: a failure, which the next check restarts.
  const sup = Number(fs.readFileSync(path.join(tmp, "jobs", n, "runner"), "utf8").split(" ")[0]);
  process.kill(platform.jobPid(n), "SIGKILL"); process.kill(sup, "SIGKILL");
  assert.ok(await until(() => !platform.jobRunning(n)));
  check();
  assert.ok(await until(() => platform.jobPid(n) > 0), "restarted");
  platform.stopJobs(n);
  check();
  assert.equal(platform.jobRunning(n), false, "a clean stop isn't restarted");
});

test("staying awake: held while this process runs", { skip: !platform.canStayAwake() && "no way to stay awake here" }, async () => {
  const pid = platform.stayAwake("os-jobs test");
  assert.ok(pid > 0);
  assert.equal(platform.processEnded(pid), false);
  process.kill(pid);
});

// The crontab's lines run on the Node the service names (a deployed copy's current), not the one
// that wrote them: a Homebrew Node's own folder goes away when it's upgraded.
test("the crontab's lines name the Node the service runs on", async () => {
  const { serviceCronLines } = await import("../src/os/darwin.ts");
  const dir = path.join(tmp, "cron-services");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "svc.json"), JSON.stringify({ name: "svc", description: "", cmd: ["/dep/current/node/bin/node", "/dep/current/main.mjs", "daemon", "run"], env: {} }));
  const [boot, check] = serviceCronLines("svc", dir);
  assert.match(boot, /^@reboot '\/dep\/current\/node\/bin\/node' '[^']*darwin-job\.ts' 'service' '[^']*svc\.json' --boot$/);
  assert.match(check, /^\* \* \* \* \* '\/dep\/current\/node\/bin\/node' /);
  assert.ok(!boot.includes(process.execPath));
});

// macOS keeps ~/Documents, ~/Desktop and ~/Downloads from what cron starts (Node included), so a
// lane started there is told it won't come back after a restart.
test("a factory under ~/Documents, ~/Desktop or ~/Downloads is told it won't come back after a restart", async () => {
  const { bootBlocked } = await import("../src/os/darwin.ts");
  const home = path.join(tmp, "home"), was = process.env.HOME;
  for (const d of ["Documents/f", "Desktop", "Downloads/a/b", "work/f", "Documents-old/f"]) fs.mkdirSync(path.join(home, d), { recursive: true });
  fs.symlinkSync(path.join(home, "Documents", "f"), path.join(home, "linked"));
  process.env.HOME = home;
  try {
    for (const d of ["Documents/f", "Desktop", "Downloads/a/b", "linked"]) assert.match(bootBlocked(path.join(home, d)), /macOS closes to lanes brought back after a restart/, d);
    assert.match(bootBlocked(path.join(home, "Documents/f")), /under ~\/Documents/);
    for (const d of ["work/f", "Documents-old/f"]) assert.equal(bootBlocked(path.join(home, d)), "", d);
  } finally { process.env.HOME = was; }
});

// macOS's disks ignore case by default: ~/documents is ~/Documents.
test("a factory under ~/documents, in the wrong case, is told too", { skip: !mac && "macOS's disks ignore case" }, async () => {
  const { bootBlocked } = await import("../src/os/darwin.ts");
  const home = path.join(tmp, "home-case"), was = process.env.HOME;
  fs.mkdirSync(path.join(home, "Documents", "f"), { recursive: true });
  process.env.HOME = home;
  try { assert.match(bootBlocked(path.join(home, "documents", "f")), /under ~\/Documents/); } finally { process.env.HOME = was; }
});
