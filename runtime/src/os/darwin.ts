// What the runtime asks of the OS (src/os.ts), on macOS: ps and lsof for processes, a small
// supervisor of our own for jobs, cron for the daemon's service, caffeinate for staying awake,
// vm_stat and sysctl for memory, and perl's flock(2) for locks.
//
// Jobs aren't launchd's: launchd takes an agent only into a session at the screen (gui/<uid>),
// and only root bootstraps into the background one (user/<uid>), so an account reached over ssh
// alone can't start one. A job is instead a supervisor (os/darwin-job.ts) started detached, which
// runs the command in a process group of its own, records how it ended, stops it and everything
// it started, and runs its onEnd; its folder under the jobs folder ($FACTORY_JOBS_DIR, else
// ~/Library/Caches/wfactory/jobs) is how the job is found by name. The daemon's service is the
// same kind of job, started by the user's crontab at boot and checked every minute, since a
// LaunchAgent also loads only with a session at the screen.
//
// Memory caps: a watch over the run's processes (os/darwin-cap.ts) that kills the biggest over the
// cap, as Linux's kernel does, but looks only once a second. A capped run's group is its folder
// under the capped folder (beside the jobs folder: ~/Library/Caches/wfactory/capped); a capped
// job's, its job folder.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Os, JobOptions } from "../os.ts";
import { Watch, cappedDirs, capBytes, footprints, groupKills, groupPeak, jobsDir, pidLines, procs, startOf, totalMemory } from "./darwin-cap.ts";
export { jobsDir };
import { readTime } from "../when.ts";

const RUNNER = fileURLToPath(new URL("./darwin-job.ts", import.meta.url));
// (In the C locale: ps prints dates in the user's language otherwise, which Date can't read.)
const run = (cmd: string, args: string[], input?: string) =>
  spawnSync(cmd, args, { encoding: "utf8", input, env: { ...process.env, LC_ALL: "C" }, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], maxBuffer: 64 << 20 });
const out = (cmd: string, ...args: string[]) => { const r = run(cmd, args); return r.status === 0 ? r.stdout ?? "" : null; };
const read = (f: string) => { try { return fs.readFileSync(f, "utf8"); } catch { return null; } };
const onPath = (c: string) => (process.env.PATH ?? "").split(":").some((d) => { try { fs.accessSync(path.join(d || ".", c), fs.constants.X_OK); return true; } catch { return false; } });
const nap = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const sq = (w: string) => `'${w.replace(/'/g, `'\\''`)}'`;
const glob = (p: string) => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);

// ---------------------------------------------------------------- processes

// A process's line of `ps -o <fields>`, its words; null if it's gone.
const ps = (pid: number, fields: string) => {
  if (!(pid > 0)) return null;
  const o = out("ps", "-ww", "-o", fields, "-p", String(pid));
  return o === null || !o.trim() ? null : o.trim();
};
// A start is ps's lstart in epoch seconds (darwin-cap.ts, startOf): the one word of digits os.ts
// asks for. (Two processes given the same pid within one second aren't told apart.)
const processStart = (pid: number) => { const l = ps(pid, "lstart="); return l === null ? "" : startOf(l); };
// Every process's parent, read at once.
function parents() {
  const m = new Map<number, number>();
  for (const l of (out("ps", "-A", "-o", "pid=,ppid=") ?? "").split("\n")) {
    const [p, pp] = l.trim().split(/\s+/).map(Number);
    if (p > 0 && pp >= 0) m.set(p, pp);
  }
  return m;
}
function processTree(pid: number) {
  if (!(pid > 0)) return [];
  const kids = new Map<number, number[]>();
  const all = parents();
  if (!all.has(pid)) return [];
  for (const [p, pp] of all) kids.set(pp, [...(kids.get(pp) ?? []), p]);
  const res: number[] = [];
  const walk = (p: number) => { res.push(p); for (const c of kids.get(p) ?? []) if (c !== p) walk(c); };
  walk(pid);
  return res;
}
const processEnded = (pid: number) => {
  if (!(pid > 0)) return true;
  try { process.kill(pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EPERM") return true; }
  const st = ps(pid, "stat=");
  return st === null || st.startsWith("Z");
};

// ---------------------------------------------------------------- jobs

interface Spec {
  name: string;
  cwd: string;
  env: Record<string, string>;
  cmd: string[];
  log?: string;
  stopTimeout: number;
  keepResult: boolean;
  onEnd?: string[];
  mem?: string;
  boot: string;
}
export const jobDir = (name: string) => path.join(jobsDir(), name);
// This boot: its session's id, fixed until the machine restarts (kern.boottime isn't: the kernel
// moves it when the clock is set).
export const bootId = () => (out("sysctl", "-n", "kern.bootsessionuuid") ?? "").trim();
// A "<pid> <start>" file: the pid, while that process still runs; else 0.
export function livePid(f: string) {
  const [pid = "", st = ""] = (read(f) ?? "").trim().split(" ");
  return /^[0-9]+$/.test(pid) && st && processStart(Number(pid)) === st ? Number(pid) : 0;
}
export const pidFile = (f: string, pid: number) => fs.writeFileSync(f, `${pid} ${processStart(pid)}\n`);
const runner = (name: string) => livePid(path.join(jobDir(name), "runner"));
// The job's own process (its group's leader), while it runs.
const mainPid = (name: string) => livePid(path.join(jobDir(name), "pid"));
// Running while its supervisor or its own process does: a supervisor killed outright leaves the
// job running, still to be seen and stopped.
const jobRunning = (name: string) => runner(name) > 0 || mainPid(name) > 0;
// A job's folder from an earlier boot is gone, as a transient unit would be.
function jobSpec(name: string): Spec | null {
  const s = read(path.join(jobDir(name), "spec.json"));
  if (s === null) return null;
  try { const j = JSON.parse(s) as Spec; return j.boot === bootId() ? j : null; } catch { return null; }
}
const jobKnown = (name: string) => jobRunning(name) || (jobSpec(name) !== null && fs.existsSync(path.join(jobDir(name), "result")));
const jobNames = () => { try { return fs.readdirSync(jobsDir()).filter((n) => !n.startsWith(".")); } catch { return []; } };
// Held while a job is started, so two starts of one name can't both find it stopped. (Its time
// is set as it's opened: sweepStarts leaves a lock alone for a day after.)
function startLock(name: string) {
  fs.mkdirSync(jobsDir(), { recursive: true });
  const fd = fs.openSync(path.join(jobsDir(), `.${name}.start`), "a");
  try { const now = new Date(); fs.futimesSync(fd, now, now); } catch {}
  if (darwin.lockFd(fd, 60)) return fd;
  fs.closeSync(fd);
  return null;
}
// Start locks are one per name a job ever had: one untouched for a day, of no job, goes, while
// it's held here (and still untouched once it is: a start just taking it touched it first).
export function sweepStarts() {
  let names: string[] = [];
  try { names = fs.readdirSync(jobsDir()).filter((n) => /^\..+\.start$/.test(n)); } catch { return; }
  const old = () => Date.now() - 86400e3;
  for (const n of names) {
    const f = path.join(jobsDir(), n);
    try {
      if (fs.statSync(f).mtimeMs >= old() || fs.existsSync(jobDir(n.slice(1, -".start".length)))) continue;
      const fd = fs.openSync(f, "r");
      try { if (darwin.lockFd(fd, 0) && fs.fstatSync(fd).mtimeMs < old()) fs.rmSync(f, { force: true }); } finally { fs.closeSync(fd); }
    } catch {}
  }
}
// The variables a job gets besides its own: what a user's service manager would give it.
const BASE = ["HOME", "USER", "LOGNAME", "SHELL", "LANG", "TMPDIR"];
function startJob(name: string, env: Record<string, string>, cmd: string[], o: JobOptions = {}) {
  const lk = startLock(name);
  if (lk === null) { process.stderr.write(`${name}: another start of it didn't finish\n`); return 1; }
  try { return startLocked(name, env, cmd, o); } finally { fs.closeSync(lk); }
}
function startLocked(name: string, env: Record<string, string>, cmd: string[], o: JobOptions) {
  if (jobRunning(name)) { process.stderr.write(`${name} is already running\n`); return 1; }
  sweepStarts();
  const d = jobDir(name);
  fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(d, { recursive: true });
  const all: Record<string, string> = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
  for (const k of BASE) if (process.env[k] !== undefined) all[k] = process.env[k]!;
  Object.assign(all, env);
  for (const k of o.unset ?? []) if (!(k in env)) delete all[k];
  const spec: Spec = { name, cwd: process.cwd(), env: all, cmd, log: o.log, stopTimeout: o.stopTimeout ?? 90, keepResult: !!o.keepResult, onEnd: o.onEnd, mem: o.mem, boot: bootId() };
  fs.writeFileSync(path.join(d, "spec.json"), JSON.stringify(spec, null, 1));
  try {
    const c = spawn(process.execPath, [RUNNER, "job", d], { detached: true, stdio: "ignore", cwd: process.cwd() });
    c.on("error", () => {}); c.unref();
    if (!c.pid) return 1;
    pidFile(path.join(d, "runner"), c.pid);
  } catch { return 1; }
  // Started once it runs the command (or found it couldn't).
  for (let i = 0; i < 500 && !fs.existsSync(path.join(d, "pid")) && !fs.existsSync(path.join(d, "result")) && jobRunning(name); i++) nap(10);
  return 0;
}
// Stopping waits for each to end, as systemctl stop does: the job's stop timeout, twice (its own
// process, then what it left), and a little more. A name with * or ? is a pattern, as systemctl
// takes one (oversee's stop of a lane's long jobs). A job whose supervisor was killed is stopped
// here: TERM to its group, then KILL after the stop timeout; and forgotten, so the crontab's check
// doesn't take it for a failure.
function stopJobs(...given: string[]) {
  const names = given.flatMap((n) => /[*?]/.test(n) ? jobNames().filter((x) => glob(n).test(x) && jobRunning(x)) : [n]);
  const ends = names.map((n) => { const t = jobSpec(n)?.stopTimeout ?? 90; return { n, sup: runner(n), main: mainPid(n), t, until: Date.now() + (2 * t + 30) * 1000 }; });
  const group = (pid: number, sig: NodeJS.Signals) => { try { process.kill(-pid, sig); } catch {} try { process.kill(pid, sig); } catch {} };
  for (const e of ends) {
    if (e.sup) { try { process.kill(e.sup, "SIGTERM"); } catch {} }
    else if (e.main) group(e.main, "SIGTERM");
  }
  for (const e of ends) {
    if (e.sup) { while (!processEnded(e.sup) && Date.now() < e.until) nap(50); continue; }
    if (!e.main) continue;
    const kill = Date.now() + e.t * 1000;
    while (!processEnded(e.main) && Date.now() < kill) nap(50);
    if (!processEnded(e.main)) group(e.main, "SIGKILL");
    fs.rmSync(jobDir(e.n), { recursive: true, force: true });
  }
}
const forgetJob = (name: string) => { if (!jobRunning(name)) fs.rmSync(jobDir(name), { recursive: true, force: true }); };

// ---------------------------------------------------------------- the daemon's service

const ownServices = () => path.join(os.homedir(), "Library", "Application Support", "wfactory", "services");
const servicesDir = () => process.env.FACTORY_DAEMON_UNIT_DIR || ownServices();
export interface Service { name: string; description: string; cmd: string[]; env: Record<string, string> }
export const serviceSpec = (name: string, dir = servicesDir()): Service | null => { try { return JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), "utf8")); } catch { return null; } };
// Started as a job that keeps its result (a failed one is restarted by the crontab's check), in
// the home folder. One started by hand, or at boot (fresh), is past the check's start limit.
export function startService(name: string, dir = servicesDir(), fresh = true) {
  const s = serviceSpec(name, dir);
  if (!s) return;
  if (fresh) fs.rmSync(path.join(dir, `${name}.gave-up`), { force: true });
  forgetJob(name);
  const was = process.cwd();
  try { process.chdir(os.homedir()); startJob(name, s.env, s.cmd, { keepResult: true, log: path.join(dir, `${name}.log`) }); } finally { process.chdir(was); }
}
// Why the crontab couldn't be read or written, and what that leaves out. macOS keeps the crontab
// behind Full Disk Access: the app a command runs from needs it (a terminal), and an ssh
// session has it only when Remote Login gives it to remote users.
const cronRefused = (name: string, what: string, stderr: string) => {
  const err = stderr.trim();
  const fda = /not permitted/i.test(err) ? `\nwfactory: macOS lets only a program with Full Disk Access change the crontab. Give it to the app you run this from (System Settings › Privacy & Security › Full Disk Access), or over ssh turn on "Allow full disk access for remote users" (System Settings › General › Sharing › Remote Login, the ⓘ), then start the lanes again.` : "";
  process.stderr.write(`wfactory: the crontab couldn't be ${what}, so ${name}'s lines there weren't written (without them, nothing brings the lanes back after a restart): ${err}${fda}\n`);
  return false;
};
// The user's crontab, its lines for this service (marked "# wfactory:<name>") replaced, the rest
// as it was. Not written when it couldn't be read: only "no crontab for <user>" means none.
// Whether it's so now.
export function cronLines(name: string, lines: string[]) {
  const tag = `# wfactory:${name}`;
  const r = run("crontab", ["-l"]);
  if (r.status !== 0 && !/no crontab/i.test(r.stderr ?? "")) return cronRefused(name, "read", r.stderr ?? "");
  const was = r.status === 0 ? r.stdout ?? "" : "";
  const kept = (was.endsWith("\n") ? was.slice(0, -1) : was).split("\n").filter((l, i, a) => !l.endsWith(tag) && !(l === "" && a.length === 1));
  const now = [...kept, ...lines.map((l) => `${l} ${tag}`)].join("\n") + "\n";
  if (now === was) return true;
  const w = run("crontab", ["-"], now);
  if (w.status !== 0) return cronRefused(name, "written", w.stderr ?? "");
  return true;
}

// Its lines: started at boot, and checked every minute (restarted if it failed), by this copy's
// supervisor, on the Node the service runs on (the deployed current's, a path no upgrade of
// Homebrew's Node takes away), else this one.
export function serviceCronLines(name: string, dir = ownServices()) {
  const node = serviceSpec(name, dir)?.cmd[0] || process.execPath;
  const check = [node, RUNNER, "service", path.join(dir, `${name}.json`)].map(sq).join(" ");
  return [`@reboot ${check} --boot`, `* * * * * ${check}`];
}
const serviceCron = (name: string) => cronLines(name, serviceCronLines(name));

// macOS keeps these folders from what cron starts, and holds Node responsible, not cron: a lane
// under one is refused when the daemon brings it back after a restart, even with Full Disk Access
// given to cron (seen on macOS 27). Node itself would need it, again for each Node it deploys.
// (The native realpath: it gives the case on disk, so ~/documents is caught too.)
const CLOSED = ["Documents", "Desktop", "Downloads"];
export function bootBlocked(dir: string) {
  let real = dir;
  try { real = fs.realpathSync.native(dir); } catch {}
  const home = (() => { try { return fs.realpathSync.native(os.homedir()); } catch { return os.homedir(); } })();
  const f = CLOSED.find((c) => real === path.join(home, c) || real.startsWith(path.join(home, c) + path.sep));
  return f ? `this factory is under ~/${f}, which macOS closes to lanes brought back after a restart: if the Mac goes down, start them again by hand, or move the factory outside ~/Documents, ~/Desktop and ~/Downloads` : "";
}

// ---------------------------------------------------------------- memory

// vm_stat's counts of pages, and its page size.
function vmStat() {
  const t = out("vm_stat") ?? "";
  const page = Number(/page size of (\d+) bytes/.exec(t)?.[1] ?? 0);
  const n = (k: string) => Number(new RegExp(`^Pages ${k}:\\s+(\\d+)`, "m").exec(t)?.[1] ?? NaN);
  return { page, free: n("free"), inactive: n("inactive"), speculative: n("speculative"), purgeable: n("purgeable") };
}
// What can be handed out without paging: free pages, and those the system drops first (inactive,
// speculative, purgeable).
function available() {
  const v = vmStat();
  const x = (v.free + v.inactive + v.speculative + v.purgeable) * v.page;
  return Number.isFinite(x) && v.page > 0 ? x : null;
}
// A file in /proc/meminfo's format, the tests' made-up machine.
const meminfo = (f: string, k: string) => { const t = read(f); const kb = t && new RegExp(`^${k}:\\s+(\\d+)`, "m").exec(t)?.[1]; return kb ? Number(kb) * 1024 : null; };

// ---------------------------------------------------------------- capped runs

const cappedDir = (name: string) => path.join(cappedDirs(), name);
const cappedNames = () => { try { return fs.readdirSync(cappedDirs()).filter((n) => !n.startsWith(".")); } catch { return []; } };
// Its command (the top of its group) runs, or something else in the group does while its watch
// does. (Not just the watch: it takes up to a second to see the group has emptied.)
function cappedRunning(name: string) {
  const d = cappedDir(name);
  if (livePid(path.join(d, "pid")) > 0) return true;
  return livePid(path.join(d, "runner")) > 0 && (groupNow(d)?.live.length ?? 0) > 0;
}
// The cap killed something in it.
const cappedKilled = (name: string) => (groupKills(cappedDir(name))?.overCap ?? 0) > 0;
// Running, or ended with a kill over its cap, this boot, until it's forgotten.
const cappedKnown = (name: string) => cappedRunning(name) ||
  (cappedKilled(name) && !fs.existsSync(path.join(cappedDir(name), "forget")) && (read(path.join(cappedDir(name), "boot")) ?? "").trim() === bootId());
const capBytesOf = (g: string) => { const c = (read(path.join(g, "cap")) ?? "").trim(); return c ? capBytes(c, totalMemory()) : 0; };
// What's in a group (a capped run's or a job's folder) now: what its watch last saw, the mark's
// holders, and what's under them. null if it isn't there (or hasn't started).
function groupNow(d: string) {
  if (!d || !fs.existsSync(path.join(d, "pid"))) return null;
  const w = new Watch(d, livePid(path.join(d, "pid")), 0);
  const now = procs();
  for (const [p, st] of pidLines(path.join(d, "procs"))) if (now.get(p)?.start === st) w.seen.set(p, st);
  w.look(false);
  return w;
}
const cappedWatch = (name: string) => groupNow(cappedDir(name));
// The folders of capped runs that are over and won't be asked about: from an earlier boot, or with
// neither the run nor its watch left (a watch killed with its run never removes its folder),
// unless it's a kill over the cap not yet forgotten. (systemd drops a transient unit the same way.)
// Swept by each capped run's watch; not this one's. One with no "boot" is starting (its watch
// writes it first), or never got a watch: left an hour.
export function sweepCapped(own = "") {
  const boot = bootId();
  for (const n of cappedNames()) {
    const d = cappedDir(n);
    if (d === own) continue;
    const b = (read(path.join(d, "boot")) ?? "").trim();
    let gone: boolean;
    if (!b) { try { gone = fs.statSync(d).mtimeMs < Date.now() - 3600e3 && !cappedRunning(n); } catch { continue; } }
    else if (b !== boot) gone = !cappedRunning(n);
    else gone = !cappedRunning(n) && livePid(path.join(d, "runner")) === 0 && !cappedKnown(n);
    if (gone) fs.rmSync(d, { recursive: true, force: true });
  }
}
// A stop waits for each run to end, as systemctl stop does: its watch is told (TERM: it stops the
// run, then KILLs what's left after 90 seconds); with no watch, that's done here.
function stopCapped(...given: string[]) {
  const names = given.flatMap((n) => /[*?]/.test(n) ? cappedNames().filter((x) => glob(n).test(x)) : [n]).filter(cappedRunning);
  const ends = names.map((n) => ({ n, watch: livePid(path.join(cappedDir(n), "runner")), until: Date.now() + 120000 }));
  for (const e of ends) {
    if (e.watch) { try { process.kill(e.watch, "SIGTERM"); } catch {} continue; }
    const w = cappedWatch(e.n);
    if (!w) continue;
    w.signal("SIGTERM");
    const kill = Date.now() + 90000;
    while (w.left() && Date.now() < kill) nap(50);
    if (w.left()) w.signal("SIGKILL");
    fs.rmSync(cappedDir(e.n), { recursive: true, force: true });
  }
  for (const e of ends) if (e.watch) while (!processEnded(e.watch) && Date.now() < e.until) nap(50);
}
// cappedCmd's shell: the run's folder made, its watch started out of the run's tree (and so out of
// what's measured), its mark opened, and once the watch runs (or after 5 seconds without it),
// the command in this same process, so that the caller's child is the command, as systemd-run
// --scope leaves it. (Waited for, so the run is running from its start, and seen whole.)
const CAPPED = `d=$1 cap=$2 carry=$3 node=$4 runner=$5; shift 5
rm -rf "$d"; mkdir -p "$d" || exit 125
export FACTORY_GROUP="$d"
("$node" "$runner" watch "$d" "$$" "$cap" "$carry" </dev/null >/dev/null 2>&1 3>&- &)
exec 3>"$d/mark"
i=0; while [ ! -e "$d/runner" ] && [ $i -lt 500 ]; do sleep 0.01; i=$((i + 1)); done
exec "$@"`;
// cappedStep: once the command ends, the watch's counts and the peak (os.ts, cappedStep). The
// watch writes a kill's count before the kill.
const STEP = `"$@"; rc=$?
g=\${FACTORY_GROUP:-}
{ if [ -n "$g" ] && [ -d "$g" ]; then
  set -- $(cat "$g/kills" 2>/dev/null); echo "oom \${1:-0}"; echo "oom_kill \${2:-0}"
  p=$(cat "$g/peak" 2>/dev/null) && [ -n "$p" ] && echo "peak $p"
fi; echo done; } >> "\${FACTORY_CAPPED_STATE:-/dev/null}" 2>/dev/null
exit $rc`;

const PERL_LOCK = `use Fcntl ":flock"; use Time::HiRes "alarm";
open(my $f, ">&=", 3) or exit 1;
my $s = $ARGV[0];
if ($s eq "0") { flock($f, LOCK_EX | LOCK_NB) or exit 1; exit 0 }
if ($s ne "inf") { $SIG{ALRM} = sub { exit 1 }; alarm($s) }
flock($f, LOCK_EX) or exit 1;`;

export const darwin: Os = {
  // ---- jobs
  startJob,
  jobRunning,
  jobKnown,
  // (A running job's is "success", as systemd says of an active unit.)
  jobResult: (name) => jobRunning(name) ? "success" : jobSpec(name) ? (read(path.join(jobDir(name), "result")) ?? "").trim() : "",
  jobPid: (name) => mainPid(name),
  forgetJob,
  runningJobs: (pattern) => jobNames().filter((n) => glob(pattern).test(n) && jobRunning(n)),
  knownJobs: (...patterns) => jobNames().filter((n) => patterns.some((p) => glob(p).test(n)) && jobKnown(n)),
  stopJobs,
  endedOverCap: (env) => env.SERVICE_RESULT === "oom-kill",
  // No units someone else started: never told.
  unitRunning: () => null,

  // ---- capped runs: the command under the watch (os/darwin-cap.ts, darwin-job.ts's watch)
  canCap: () => onPath("perl"),
  cappedCmd: (name, mem, cmd, carryOn = false) => ["/bin/sh", "-c", CAPPED, "sh", cappedDir(name), mem, carryOn ? "1" : "0", process.execPath, RUNNER, ...cmd],
  cappedRunning,
  cappedOverCap: (name) => cappedKnown(name) && cappedKilled(name),
  cappedPeak: (name) => groupPeak(cappedDir(name)),
  cappedGroup: (name) => fs.existsSync(cappedDir(name)) ? cappedDir(name) : "",
  killCapped: (name) => { cappedWatch(name)?.signal("SIGKILL"); },
  // (One still running goes when it ends: its watch is told, before it's asked whether it runs, so
  // a watch just ending either sees that or has ended.)
  forgetCapped: (name) => {
    try { fs.writeFileSync(path.join(cappedDir(name), "forget"), ""); } catch {}
    if (!cappedRunning(name)) fs.rmSync(cappedDir(name), { recursive: true, force: true });
  },
  knownCapped: (...patterns) => cappedNames().filter((n) => patterns.some((p) => glob(p).test(n)) && cappedKnown(n)),
  stopCapped,
  // Told by whatever started this process inside one (a capped run's step, a job's command or onEnd).
  myGroup: () => process.env.FACTORY_GROUP ?? "",
  // Looked at now, as Linux's cgroup files are read: the watch's own look can be a second old.
  groupProcesses: (g) => groupNow(g)?.live.map((p) => p.pid) ?? null,
  groupMemory: (g) => {
    const cap = capBytesOf(g), w = cap > 0 ? groupNow(g) : null;
    return w ? { used: w.usage().used, cap } : null;
  },
  groupPeak,
  groupKills,
  // sh, which costs the cap almost nothing: the watch's counts, once the command ends.
  cappedStep: ["/bin/sh", "-c", STEP, "sh"],

  // (A listing's handles are names: a capped run's, or a job's.)
  stop: (...handles) => {
    const capped = handles.filter((h) => fs.existsSync(cappedDir(h)));
    if (capped.length) stopCapped(...capped);
    stopJobs(...handles.filter((h) => !capped.includes(h)));
  },

  // ---- processes: ps and lsof
  processStart,
  processParent: (pid) => Number(ps(pid, "ppid=")) || 0,
  processEnded,
  processTree,
  // (ps gives the command line as one string: split at spaces, which only a word with a space in
  // it gets wrong.)
  processArgs: (pid) => { const a = ps(pid, "args="); return a === null ? null : a.split(" "); },
  processFolder: (pid) => {
    if (!(pid > 0)) return null;
    const o = out("lsof", "-a", "-p", String(pid), "-d", "cwd", "-Fn");
    const n = o?.split("\n").find((l) => l.startsWith("n"));
    return n ? n.slice(1) : null;
  },
  // macOS (27) shows no process's variables, not even to its own user (`ps eww` leaves them out):
  // a job's main process has those its spec gave it; any other's can't be read.
  processEnv: (pid) => {
    if (!(pid > 0)) return null;
    for (const n of jobNames()) if (livePid(path.join(jobDir(n), "pid")) === pid) return jobSpec(n)?.env ?? null;
    return null;
  },
  // Its footprint (os/darwin-cap.ts), its RSS where that's refused. (Not one that has exited: only
  // its parent's wait is left, as on Linux, where it has no RSS.)
  processMemory: (pids) => {
    const ok = pids.filter((p) => p > 0);
    if (!ok.length) return [];
    const fp = footprints(ok);
    return (out("ps", "-ww", "-o", "pid=,rss=,stat=,args=", "-p", ok.join(",")) ?? "").split("\n").flatMap((l) => {
      const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(l);
      return m && !m[3].startsWith("Z") ? [{ pid: Number(m[1]), rss: fp.get(Number(m[1])) ?? Number(m[2]) * 1024, cmd: `${m[4]} ` }] : [];
    });
  },
  // macOS's pgrep leaves out itself and the processes it runs under, and has no -A.
  processesMatching: (pattern) => {
    const r = run("pgrep", ["-f", pattern]);
    return r.status === 0 ? (r.stdout ?? "").split("\n").filter(Boolean).map(Number).filter((p) => p !== process.pid) : [];
  },
  untilEnds: (pid) => ["/bin/sh", "-c", 'while kill -0 "$0" 2>/dev/null; do sleep 1; done', String(pid)],

  // perl's flock(2) on the open file handed over as descriptor 3: the lock stays the open file's
  // when perl exits.
  lockFd: (fd, secs) => spawnSync("perl", ["-e", PERL_LOCK, secs === Infinity ? "inf" : String(secs)],
    { stdio: ["ignore", "ignore", "inherit", fd] }).status === 0,
  readTime: (when) => readTime(when),

  unitStatusHint: () => "macOS has no units: see the job's log",
  jobLogHint: (name) => { const l = jobSpec(name)?.log; return l ? `tail -n 50 ${l}` : `ls ${jobDir(name)}`; },

  // ---- another machine, over ssh: this one's half of os.ts's remote commands
  // Its supervisor still runs (exit 0), or its own process does; else 3.
  jobRunningCmd: (name) => ["sh", "-c", `d="\${FACTORY_JOBS_DIR:-$HOME/Library/Caches/wfactory/jobs}"/${sq(name)}; for f in runner pid; do set -- $(cat "$d/$f" 2>/dev/null) && [ -n "\${2:-}" ] && kill -0 "$1" 2>/dev/null && exit 0; done; exit 3`],
  sessionEnvScript: "true",

  // ---- staying awake: caffeinate, for as long as this process runs
  canStayAwake: () => onPath("caffeinate"),
  stayAwake(why) {
    void why;
    try {
      const c = spawn("caffeinate", ["-i", "-s", "-w", String(process.pid)], { stdio: "ignore", detached: true });
      c.on("error", () => {}); c.unref();
      return c.pid ?? 0;
    } catch { return 0; }
  },

  // ---- the daemon's service: its spec in ~/Library/Application Support/wfactory/services
  // (FACTORY_DAEMON_UNIT_DIR for another, which the crontab doesn't start: the tests'), started at
  // boot by the crontab and restarted by its check each minute when it failed
  installService(name, description, cmd, env) {
    const dir = servicesDir();
    const text = JSON.stringify({ name, description, cmd, env }, null, 1) + "\n";
    const f = path.join(dir, `${name}.json`);
    if (read(f) !== text) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(`${f}.tmp`, text); fs.renameSync(`${f}.tmp`, f); }
    if (dir === ownServices()) serviceCron(name);
  },
  startService: (name) => startService(name),
  // And its crontab lines moved to this copy, which a deploy restarts it onto: they name the copy's
  // own supervisor, and a deploy deletes an old copy only once the crontab no longer names it.
  restartService: (name) => {
    if (jobRunning(name)) { stopJobs(name); startService(name); }
    if (servicesDir() === ownServices() && serviceSpec(name)) serviceCron(name);
  },
  serviceCmd: (name) => serviceSpec(name)?.cmd.join(" ") ?? "",
  managerId: () => `boot-${bootId()}`,
  // Cron and the jobs go on after the user logs out.
  lingering: () => true,
  bootBlocked,
  sessionEnv: () => ({}),

  // ---- memory (FACTORY_MEMINFO: a file in /proc/meminfo's format, the tests' made-up machine)
  memory: () => {
    const f = process.env.FACTORY_MEMINFO;
    if (f) return { total: meminfo(f, "MemTotal") ?? 0, available: meminfo(f, "MemAvailable") };
    return { total: Number(out("sysctl", "-n", "hw.memsize")) || 0, available: available() };
  },
  cappedEnded: (name) => cappedKnown(name) ? Number((read(path.join(cappedDir(name), "ended")) ?? "").trim()) || 0 : 0,

  // ---- what the overseer reads of a machine
  jobState: (name) => jobRunning(name) ? "running" : "stopped",
  jobStoppedStatus: [3],
  memAvailableCmd: ["sh", "-c", `if [ -n "\${FACTORY_MEMINFO:-}" ]; then awk '/^MemAvailable:/ { printf "%d\\n", $2 * 1024 }' "$FACTORY_MEMINFO"; else vm_stat | awk '/page size of/ { p = $8 } /^Pages (free|inactive|speculative|purgeable):/ { n += $NF } END { printf "%d\\n", n * p }'; fi`],
  // The kernel's kills (jetsam) aren't read: never told.
  oomKills: () => null,
};
