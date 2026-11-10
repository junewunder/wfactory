// What the test suites share: a throwaway repo, running a command for its exit code and output
// (or in the background, to watch), the tracker, both as the real command (what a check is
// about) and in this process (a test's own setup), and a machine to run the skill's scripts
// and recipes on (workspace). Each test file is its own process under `node --test`, so files run side
// by side and share nothing.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { after } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { trIn } from "../../runtime/src/tr.ts";
import { platform } from "../../runtime/src/os.ts";
import "./tools.ts";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const TRACKER = path.join(ROOT, "tracker", "tracker.mjs");

type Env = NodeJS.ProcessEnv;
export interface Result { code: number; stdout: string; stderr: string }
export interface RunOpts { cwd: string; env: Env; merged?: boolean; timeout?: number }

// A command run to the end. merged: stdout and stderr in one stream, in the order written, as
// `2>&1` gives them (stdout holds both). timeout: seconds it may take, after which it's killed
// and the check fails (a loop that hangs fails its test instead of hanging the run).
export function cmd(file: string, args: string[], { cwd, env, merged = false, timeout }: RunOpts): Result {
  const limit = timeout ? { timeout: timeout * 1000, killSignal: "SIGKILL" as const } : {};
  const late = (r: { error?: Error }, out: string) => {
    if ((r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT")
      assert.fail(`${path.basename(file)} is still running ${timeout} s on (killed now)\ngot (last lines): ${tail(out)}`);
  };
  if (!merged) {
    const r = spawnSync(file, args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 << 20, ...limit });
    late(r, `${r.stdout ?? ""}${r.stderr ?? ""}`);
    if (r.error) throw r.error;
    return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
  }
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "out-")), "out");
  const fd = fs.openSync(f, "w");
  try {
    const r = spawnSync(file, args, { cwd, env, stdio: ["ignore", fd, fd], ...limit });
    late(r, fs.readFileSync(f, "utf8"));
    if (r.error) throw r.error;
    return { code: r.status ?? 1, stdout: fs.readFileSync(f, "utf8"), stderr: "" };
  } finally { fs.closeSync(fd); fs.rmSync(path.dirname(f), { recursive: true, force: true }); }
}
// How long a loop run to its end may take: its --hours (the last given; 8 without), then a
// minute for its exit steps (the bash suites' loop_gone gave a stopped loop a minute).
export function loopDeadline(args: string[]) {
  const i = args.lastIndexOf("--hours"), h = i >= 0 ? Number(args[i + 1]) : 8;
  return Math.ceil((Number.isFinite(h) ? h : 8) * 3600) + 60;
}

// A command started in the background; the promise settles when it ends.
export function start(file: string, args: string[], { cwd, env }: RunOpts): Promise<Result> {
  return new Promise((resolve, reject) => {
    const p = spawn(file, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => { stdout += d; });
    p.stderr.on("data", (d) => { stderr += d; });
    p.on("error", reject);
    p.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Output checks, saying what was wanted and what came.
// (The output shown is its last lines, where a loop's failure is.)
export const tail = (text: string, n = 12) => text.replace(/\n+$/, "").split("\n").slice(-n).join("\n");
export function has(text: string, wanted: string) {
  assert.ok(text.includes(wanted), `wanted: ${wanted}\ngot (last lines): ${tail(text)}`);
}
export function hasnt(text: string, unwanted: string) {
  assert.ok(!text.includes(unwanted), `unwanted: ${unwanted}\ngot (last lines): ${tail(text)}`);
}
// A command's output as `$(…)` gives it: without its trailing newlines.
export const chomp = (s: string) => s.replace(/\n+$/, "");
export const firstLine = (s: string) => s.replace(/\n+$/, "").split("\n")[0];
// How many lines (`| wc -l` of a command's output): none for "".
export const lines = (s: string) => (s ? chomp(s).split("\n").length : 0);
export const lastLine = (s: string) => s.replace(/\n+$/, "").split("\n").at(-1) ?? "";

// What's still running when the file's tests end (background loops, their sessions), stopped
// before the temp folders go: after() hooks run in the order they were made, so a hook made after
// the folder's own would come too late, with a session still writing into it.
const stops: (() => void)[] = [];
export const stopFirst = (fn: () => void) => { stops.push(fn); };
// A new temp folder, by its real path (as `realpath "$(mktemp -d)"`), removed when the file's tests end.
function tempTop() {
  const top = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wf-test-")));
  after(() => {
    for (const s of stops.splice(0)) s();
    // (A process just killed may still be writing for a moment.)
    fs.rmSync(top, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return top;
}
// A new temp folder for a unit test's own files (prefix-XXXXXX), removed as the file's process
// exits, wherever in it it was made: left behind, a few runs' worth used up /tmp's inodes.
const temps: string[] = [];
process.on("exit", () => { for (const d of temps) try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* gone */ } });
export function tempDir(prefix: string) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(d);
  return d;
}
// A pid as a file or a command's output gives it ("" or junk: 0). Only a number > 0 names one
// process: 0 is this process's group (the whole test run) and -n a group, to process.kill.
export const pidOf = (text: string | number) => { const n = Number(String(text).trim()); return Number.isInteger(n) && n > 0 ? n : 0; };
// Signals the process with this pid (a number, or a pid file's text), if it's still there:
// a pid that isn't one (empty file, 0, junk) signals nothing. Did the signal go?
export function killPid(pid: string | number, sig: NodeJS.Signals = "SIGTERM") {
  const n = pidOf(pid);
  if (!n) return false;
  try { process.kill(n, sig); return true; } catch { return false; }
}
// Kills a process group (as `kill -9 -<pgid>`), if it's still there.
export const killGroup = (pgid: number) => { if (pidOf(pgid)) { try { process.kill(-pgid, "SIGKILL"); } catch { /* gone */ } } };

// This process's environment with a git identity and none of the caller's FACTORY_* or LOOP
// (nor node:test's own, which would make a child node think it's a test). A new repo starts on
// main, whatever this machine's git says (macOS's: master), so a clone of a bare origin checks
// it out.
function cleanEnv(): Env {
  const env: Env = { ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com",
    GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "init.defaultBranch", GIT_CONFIG_VALUE_0: "main" };
  for (const k of Object.keys(env)) if (k.startsWith("FACTORY_") || k === "LOOP" || k === "WFACTORY_PROFILE" || k === "NODE_TEST_CONTEXT") delete env[k];
  return env;
}

// A git repo in a new temp folder, removed when the file's tests end: <tmp>/<name>, with one
// empty commit, and an environment of its own (none of the caller's FACTORY_* or LOOP).
export function tempRepo(name = "repo", { commit = true } = {}) {
  const top = tempTop();
  const dir = path.join(top, name);
  fs.mkdirSync(dir);
  const env = cleanEnv();
  const git = (...args: string[]) => {
    const r = cmd("git", args, { cwd: dir, env });
    assert.equal(r.code, 0, `git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.replace(/\n+$/, "");
  };
  git("init", "-q");
  if (commit) git("commit", "-q", "--allow-empty", "-m", "init");
  return { top, dir, env, git };
}

// A repo with a tracker to drive. Every call gets the repo's environment plus `add`.
//   t:     the real command (node tracker/tracker.mjs), for its exit code and output
//   ok:    the same, which must exit 0 (as `out=$(t …)` under `set -e`); its stdout
//   setup: the tracker in this process, for a test's own setup; it must exit 0
export function trackerRepo(name = "repo", base: Env = {}, opts: { commit?: boolean } = {}) {
  const r = tempRepo(name, opts);
  Object.assign(r.env, { FACTORY_HOST: "testhost", FACTORY_PID: String(process.pid), ...base });
  const envWith = (add: Env = {}) => {
    const env = { ...r.env, ...add };
    for (const k of Object.keys(add)) if (add[k] === undefined) delete env[k];
    return env;
  };
  const at = (p: string) => path.join(r.dir, p);
  const t = (args: string[], add: Env = {}, { merged = false } = {}) => cmd(process.execPath, [TRACKER, ...args], { cwd: r.dir, env: envWith(add), merged });
  const ok = (args: string[], add: Env = {}, o: { merged?: boolean } = {}) => {
    const res = t(args, add, o);
    assert.equal(res.code, 0, `tracker ${args.join(" ")}: exit ${res.code}\n${res.stdout}${res.stderr}`);
    return res.stdout;
  };
  const tryIn = (args: string[], add: Env = {}) => trIn(args, envWith(add), r.dir);
  const setup = (args: string[], add: Env = {}) => {
    const res = tryIn(args, add);
    assert.equal(res.code, 0, `setup: tracker ${args.join(" ")}: exit ${res.code}\n${res.out}${res.err}`);
    return res.out;
  };
  const read = (p: string) => fs.readFileSync(at(p), "utf8");
  const write = (p: string, text: string) => { fs.mkdirSync(path.dirname(at(p)), { recursive: true }); fs.writeFileSync(at(p), text); };
  const json = (p: string): any => JSON.parse(read(p));
  // Changes a JSON file by hand, as a hand edit or a merge would.
  const edit = (p: string, fn: (j: any) => void) => { const j = json(p); fn(j); fs.writeFileSync(at(p), JSON.stringify(j)); };
  return { ...r, envWith, at, t, ok, setup, tryIn, read, write, json, edit };
}

// A moment as the tracker writes it: to the second, `h` hours ago.
export const ago = (h: number) => new Date(Date.now() - h * 3600e3).toISOString().replace(/\.\d+Z$/, "Z");

// This machine's short hostname (`hostname -s`), which the machines file and the profile use.
export const HOST = os.hostname().split(".")[0];

// A command started in the background, with its output (stdout and stderr, merged) to watch:
//   out():          what it has written so far
//   until(text, s): resolves once it has written text; fails after s seconds, or if it ends first
//   stop():         SIGTERM, then its result once it has ended (at once if it already has)
//   end(s):         its result once it has ended; fails if it's still running s seconds on (a
//                   loop that said it stopped and hangs: the bash suites' loop_gone), killing it
//                   (its group, with group), so a hung loop fails its test instead of the run
//   ended():        has it ended?
// group: in a process group of its own (as `setsid`), so pid is the group's too, and a signal
// to -pid reaches everything it started.
export function background(file: string, args: string[], { cwd, env, group = false }: RunOpts & { group?: boolean }) {
  const p = spawn(file, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: group });
  let out = "", code: number | null = null;
  const done = new Promise<Result>((resolve, reject) => {
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { out += d; });
    p.on("error", reject);
    p.on("close", (c) => { code = c ?? 1; resolve({ code, stdout: out, stderr: "" }); });
  });
  return {
    pid: p.pid,
    out: () => out,
    done,
    async until(text: string, s = 20) {
      for (const end = Date.now() + s * 1000; !out.includes(text);) {
        if (code !== null) assert.fail(`ended (exit ${code}) without writing: ${text}\ngot: ${out}`);
        if (Date.now() > end) assert.fail(`not written in ${s} s: ${text}\ngot: ${out}`);
        await sleep(50);
      }
    },
    stop() { if (code === null) p.kill("SIGTERM"); return done; },
    ended: () => code !== null,
    async end(s = 60) {
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<null>((r) => { timer = setTimeout(() => r(null), s * 1000); });
      const r = await Promise.race([done, late]);
      clearTimeout(timer);
      if (r) return r;
      if (group) killGroup(p.pid!); else p.kill("SIGKILL");
      return assert.fail(`a background loop is still running ${s === 60 ? "a minute" : `${s} s`} after the test began waiting for it to end (killed now)\ngot (last lines): ${tail(out)}`);
    },
  };
}

// A machine to run the skill's scripts on: a temp folder `top` (none of it a repo) with the
// environment the suites run the skill in. FACTORY_SKILL is this checkout, so the stubs run it
// and nothing is deployed; FACTORY_DEPLOY, FACTORY_SKILL_CHECKOUT (absent: nothing to deploy
// from) and FACTORY_LOCKS are under top; WFACTORY_PROFILE is top/profile.md (made by
// profile()); top/bin is first on PATH, for fakes.
//   script(name, args): bash scripts/<name>.sh, for its exit code and output
//   just(args, cwd):    the recipes, stdout and stderr merged (as `just … 2>&1`)
//   profile():          a profile from profile.sh new with every <fill: …> filled; its path
//   init(name, opts):   scripts/init.sh <name> in top (or --dir), which must exit 0; the factory
//   setup(args, cwd):   the tracker in this process, in a factory, for a test's own setup; it must exit 0
export function workspace() {
  const top = tempTop();
  const at = (p: string) => path.join(top, p);
  const env = cleanEnv();
  Object.assign(env, {
    FACTORY_TRACKER: TRACKER, FACTORY_SKILL: ROOT, FACTORY_DEPLOY: at("deploy"), FACTORY_SKILL_CHECKOUT: at("no-skill-checkout"),
    FACTORY_LOCKS: at("locks"), WFACTORY_PROFILE: at("profile.md"), PATH: `${at("bin")}:${process.env.PATH}`,
    // The heavy jobs' budget, slots and history are the test's own, on a made-up machine with
    // memory to spare (/proc/meminfo's format), never this machine's.
    FACTORY_CPU_LOCKS: at("cpu"), FACTORY_JOBS_HOME: at("jobs"), FACTORY_MEMINFO: at("meminfo"),
    // The machine's one usage reading, which every factory's lanes on it act on, is the test's
    // own too: never this machine's (its real lanes would act on a test's made-up reading).
    FACTORY_USAGE_FILE: at("usage.json"),
  });
  fs.mkdirSync(at("bin"));
  fs.writeFileSync(at("meminfo"), "MemTotal:       268435456 kB\nMemAvailable:   268435456 kB\n");
  const envWith = (add: Env = {}) => {
    const e = { ...env, ...add };
    for (const k of Object.keys(add)) if (add[k] === undefined) delete e[k];
    return e;
  };
  const script = (name: string, args: string[] = [], { cwd = top, add = {} as Env, merged = false } = {}) =>
    cmd("bash", [path.join(ROOT, "scripts", `${name}.sh`), ...args], { cwd, env: envWith(add), merged });
  const just = (args: string[], cwd: string, add: Env = {}) => cmd("just", args, { cwd, env: envWith(add), merged: true });
  const profile = () => {
    const r = script("profile", ["new"]);
    assert.equal(r.code, 0, `profile.sh new: ${r.stdout}${r.stderr}`);
    const f = env.WFACTORY_PROFILE!;
    fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(/<fill[^>]*>/g, "filled"));
    return f;
  };
  const init = (name: string, { dir = top, add = {} as Env } = {}) => {
    const r = script("init", dir === top ? [name] : [name, "--dir", dir], { add });
    assert.equal(r.code, 0, `init.sh ${name}: exit ${r.code}\n${r.stdout}${r.stderr}`);
    return path.join(dir, name);
  };
  // git in a folder, which must succeed; its output as `$(…)` gives it.
  const git = (dir: string, ...args: string[]) => {
    const r = cmd("git", args, { cwd: dir, env });
    assert.equal(r.code, 0, `git ${args.join(" ")}: ${r.stderr}`);
    return chomp(r.stdout);
  };
  const setup = (args: string[], cwd: string, add: Env = {}) => {
    const r = trIn(args, envWith(add), cwd);
    assert.equal(r.code, 0, `setup: tracker ${args.join(" ")}: exit ${r.code}\n${r.out}${r.err}`);
    return r.out;
  };
  return { top, at, env, envWith, script, just, profile, init, setup, git };
}

// Polls until fn() is true: fails after s seconds, saying what was waited for.
export async function until(fn: () => boolean, what: string, s = 20) {
  for (const end = Date.now() + s * 1000; !fn();) {
    if (Date.now() > end) assert.fail(`not so after ${s} s: ${what}`);
    await sleep(50);
  }
}
// A file's text, "" if it isn't there.
export const readOr = (f: string) => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } };
// A process that stands in for a lane's loop or a session: `sleep 600`, alive until kill(),
// which waits until it has ended (so its pid is a dead one's). Killed when the file's tests end.
export function sleeper() {
  const p = spawn("sleep", ["600"], { stdio: "ignore" });
  const ended = new Promise<void>((r) => p.on("close", () => r()));
  after(() => { p.kill("SIGKILL"); });
  return { pid: p.pid!, kill: () => { p.kill("SIGKILL"); return ended; } };
}
// Is a lock file held (by flock) by some process? The lanes' locks are flock(1) locks.
export const lockHeld = (file: string) => fs.existsSync(file) && spawnSync("flock", ["-n", file, "true"], { stdio: "ignore" }).status !== 0;
// Holds a lock file (flock), as a lane or a session does, until release(); resolves once it's held.
export async function holdLock(file: string) {
  // In a process group of its own: flock's command inherits the lock, so both are killed.
  const p = spawn("flock", [file, "sleep", "600"], { stdio: "ignore", detached: true });
  const ended = new Promise<void>((r) => p.on("close", () => r()));
  const kill = () => { try { process.kill(-p.pid!, "SIGKILL"); } catch { /* gone */ } };
  after(kill);
  await until(() => lockHeld(file), `${file} is locked`);
  return { release: async () => { kill(); await ended; await until(() => !lockHeld(file), `${file} is let go`); } };
}
// Waits until a file has this text: fails after s seconds.
export const fileHas = (f: string, text: string, s = 30) => until(() => readOr(f).includes(text), `${path.basename(f)} has: ${text}`, s);
// The newest file in a folder whose name matches re, by its modification time; its path ("" if none).
export function newest(dir: string, re: RegExp) {
  let best = "", t = -1;
  for (const e of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!re.test(e)) continue;
    const m = fs.statSync(path.join(dir, e)).mtimeMs;
    if (m > t) { t = m; best = path.join(dir, e); }
  }
  return best;
}
// A test's options that run it on Linux only, saying why it doesn't run elsewhere (what only
// systemd, cgroups or the kernel's log do there, or what macOS has its own way of).
export const linuxOnly = (why: string) => ({ skip: process.platform !== "linux" && why });
// Is this process running (not gone, nor a zombie waiting to be reaped)?
// (0, a negative pid or junk, as an empty pid file gives, is none.)
export function alive(pid: number | string) {
  pid = pidOf(pid);
  if (!pid) return false;
  try { process.kill(pid, 0); } catch { return false; }
  return !platform.processEnded(pid);
}
// Does any process in this process group still run? (ps, which both systems have.)
export function groupAlive(pgid: number) {
  const r = spawnSync("ps", ["-A", "-o", "pgid=,stat="], { encoding: "utf8" });
  return (r.stdout ?? "").split("\n").some((l) => { const [g, st] = l.trim().split(/\s+/); return Number(g) === pgid && !!st && !st.startsWith("Z"); });
}
// This process's open files: each descriptor and the path it has open (/proc on Linux, lsof on
// macOS).
export function openFiles(): { fd: number; path: string }[] {
  if (fs.existsSync("/proc/self/fd")) {
    return fs.readdirSync("/proc/self/fd").flatMap((fd) => { try { return [{ fd: Number(fd), path: fs.readlinkSync(`/proc/self/fd/${fd}`) }]; } catch { return []; } });
  }
  const out: { fd: number; path: string }[] = [];
  let fd = -1;
  for (const l of (spawnSync("lsof", ["-a", "-p", String(process.pid), "-d", "0-9999", "-Fn"], { encoding: "utf8" }).stdout ?? "").split("\n")) {
    if (l.startsWith("f")) fd = Number(l.slice(1));
    else if (l.startsWith("n") && fd >= 0) out.push({ fd, path: l.slice(1) });
  }
  return out;
}

// systemd's user manager: `systemctl --user <args>`, its output kept. active(unit): is the unit
// running (`is-active`)? prop(unit, p): a property of it (`show -p P --value`). On macOS, where
// a job is runtime/src/os/darwin.ts's, the same asked of the Os: stop and reset-failed take
// patterns of jobs (<name>.service, or <name>.* for its kinds), and the properties are a job's
// pid, state, result (a job that's gone: "success", as systemd says of an unloaded unit) and
// command.
const job = (unit: string) => unit.replace(/\.(service|\*)$/, "");
const DARWIN = process.platform === "darwin";
export const systemctl = (...a: string[]) => {
  if (!DARWIN) return spawnSync("systemctl", ["--user", ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const [verb, ...units] = a;
  if (verb === "stop") platform.stopJobs(...units.flatMap((u) => platform.runningJobs(job(u))));
  if (verb === "reset-failed") for (const n of units.flatMap((u) => platform.knownJobs(job(u)))) platform.forgetJob(n);
  return { status: 0, stdout: "", stderr: "" };
};
export const active = (unit: string) => DARWIN ? platform.jobRunning(job(unit)) : systemctl("is-active", "-q", unit).status === 0;
export const prop = (unit: string, p: string) => {
  if (!DARWIN) return chomp(systemctl("show", "-p", p, "--value", unit).stdout ?? "");
  const n = job(unit);
  return p === "MainPID" ? String(platform.jobPid(n)) : p === "ActiveState" ? (platform.jobRunning(n) ? "active" : "inactive")
    : p === "Result" ? platform.jobResult(n) || "success" : p === "ExecStart" ? platform.serviceCmd(n) : "";
};

// The fake `claude` the loop's sessions run: it finds the unit in the appended card ("Next:
// Title (group/slug)"), keeps the card ($FACTORY_LOCKS/card.<id>.seen), appends a line to
// out/<group>-<slug>.txt on the unit's branch, commits it and records the unit done. A merge
// unit (merge/…) instead merges origin/main keeping this branch's side. Knobs (variables):
//   FACTORY_FAKE_NOWORK   commit nothing           FACTORY_FAKE_NODONE  leave the unit unfinished
//   FACTORY_FAKE_SHARED   also write shared.txt (a real conflict with another lane's)
//   FACTORY_FAKE_WIP      leave work/wip-<group> while it works (outputs not committed yet)
//   FACTORY_FAKE_TRACKER  also change tracker/ (a new file too) on the branch
//   FACTORY_FAKE_TRACKERONLY  commit only a change to tracker/ (nothing else on the branch)
//   FACTORY_FAKE_LOOP     also change factory/loop.sh and add factory/extra.sh
//   FACTORY_FAKE_BREAK    add fail-check (the factory's check fails)   FACTORY_FAKE_FIX  remove it
// A unit held ($FACTORY_LOCKS/hold.<group>-<slug>) works, once its commit is made, until the test
// lets it go (go.<group>-<slug>), at most 5 minutes; while held, held.<group>-<slug> has its pid.
export const FAKE_CLAUDE = `#!/usr/bin/env bash
card=""; while [ $# -gt 0 ]; do [ "$1" = --append-system-prompt-file ] && card=$(cat "$2"); shift; done
id=$(grep -oE '^Next: .*\\(([a-z0-9-]+/[a-z0-9.-]+)\\)' <<<"$card" | head -1 | sed -E 's/.*\\(([^)]*)\\)$/\\1/')
u=\${id//\\//-}
printf '%s\\n' "$card" > "$FACTORY_LOCKS/card.$id.seen" 2>/dev/null || printf '%s\\n' "$card" > "$FACTORY_LOCKS/card.seen"
echo '{"type":"system","subtype":"init"}'
if [[ "$id" == merge/* ]]; then
  git fetch -q origin && git merge -q -X ours --no-edit origin/main >/dev/null 2>&1
elif [ -n "\${FACTORY_FAKE_TRACKERONLY:-}" ]; then
  echo x >> tracker/log.jsonl; git add tracker; git commit -qm "$id: tracker only" >/dev/null 2>&1
elif [ -z "\${FACTORY_FAKE_NOWORK:-}" ]; then
  [ -z "\${FACTORY_FAKE_WIP:-}" ] || echo half > "work/wip-\${id%%/*}"
  mkdir -p out; f="out/$u.txt"; echo "work on $id from $FACTORY_HOST" >> "$f"; git add "$f"
  [ -z "\${FACTORY_FAKE_SHARED:-}" ] || { echo "$id" > shared.txt; git add shared.txt; }
  [ -z "\${FACTORY_FAKE_TRACKER:-}" ] || { echo '{}' > tracker/groups/sneaky.json; echo x >> tracker/log.jsonl; git add tracker; }
  [ -z "\${FACTORY_FAKE_LOOP:-}" ] || { echo "# $id was here" >> factory/loop.sh; echo "# $id" > factory/extra.sh; git add factory/loop.sh factory/extra.sh; }
  [ -z "\${FACTORY_FAKE_BREAK:-}" ] || { touch fail-check; git add fail-check; }
  [ -z "\${FACTORY_FAKE_FIX:-}" ] || git rm -q fail-check
  git commit -qm "$id: fake work" >/dev/null 2>&1
  if [ -e "$FACTORY_LOCKS/hold.$u" ]; then
    echo $$ > "$FACTORY_LOCKS/held.$u.new" && mv "$FACTORY_LOCKS/held.$u.new" "$FACTORY_LOCKS/held.$u"
    for _ in $(seq 1500); do [ ! -e "$FACTORY_LOCKS/go.$u" ] || break; sleep 0.2; done
  fi
  [ -z "\${FACTORY_FAKE_WIP:-}" ] || rm -f "work/wip-\${id%%/*}"
fi
[ -n "\${FACTORY_FAKE_NODONE:-}" ] || just done "$id" --evidence "fake session" >/dev/null 2>&1
echo '{"type":"result","is_error":false,"result":"did '"$id"'","num_turns":1,"total_cost_usd":0.01}'
`;

// The fake reviewer the loop's review of a finished branch runs (FACTORY_REVIEWER), so no test runs
// the real claude. Each review is numbered ($FACTORY_LOCKS/reviews counts them) and leaves what it
// was given: review.<n>.args, .prompt (its stdin), .system (its appended system prompt), .env
// (\`env -0\`). Its verdict is the first line of $FACTORY_LOCKS/review-verdicts, taken off (a JSON
// object, other text for a result that won't parse, "exit <n>" to fail, or "sleep <s>" to give
// none that long), else a pass.
export const FAKE_REVIEWER = `#!/usr/bin/env bash
n=$(( $(cat "$FACTORY_LOCKS/reviews" 2>/dev/null || echo 0) + 1 )); echo $n > "$FACTORY_LOCKS/reviews"
printf '%s\\n' "$*" > "$FACTORY_LOCKS/review.$n.args"
cat > "$FACTORY_LOCKS/review.$n.prompt"
env -0 > "$FACTORY_LOCKS/review.$n.env"
while [ $# -gt 0 ]; do [ "$1" = --append-system-prompt-file ] && cat "$2" > "$FACTORY_LOCKS/review.$n.system"; shift; done
v='{"verdict":"pass","findings":[]}'
q="$FACTORY_LOCKS/review-verdicts"
if [ -s "$q" ]; then l=$(head -1 "$q"); tail -n +2 "$q" > "$q.t" && mv "$q.t" "$q"; [ -z "$l" ] || v=$l; fi
echo '{"type":"system","subtype":"init"}'
case $v in exit\\ *) exit "\${v#exit }" ;; sleep\\ *) exec sleep "\${v#sleep }" ;; "{"*) printf '{"type":"result","is_error":false,"result":"reviewed","structured_output":%s}\\n' "$v" ;; *) printf '{"type":"result","is_error":false,"result":"%s"}\\n' "$v" ;; esac
`;

// A factory made by init.sh on a local bare origin (a stand-in for GitHub), with lanes that are
// clones of it, each with its own lock folder and host name, so lanes meet only on origin, as
// two laptops do. Sessions are the fake claude (FAKE_CLAUDE, or the suite's own). The
// factory's checkout is F; its `just check` (and `rebuildable`) run `check`; `files` go in its
// first commit, and prepare(F) changes anything else there before it. The workspace's own calls
// (w) are there too.
//   lane(n, {k, locks, host}): a clone, <top>/<n>-lane<k>, locks <top>/locks-<locks>, FACTORY_HOST
//     host (each n by default); what runs there:
//       run(file, args, add, {timeout}): a command in the clone (stdout and stderr merged)
//       tracker(args, add):    factory/tracker there, the real command (merged); ok(): must exit 0
//       setup(args, add):      the tracker in this process there, for a test's own setup
//       loop(args, add):       factory/loop.sh --no-awake --idle-wait 0.05 --no-wait, to the end,
//                              failing if it runs past its --hours and a minute (loopDeadline)
//       loopBg(args, add):     factory/loop.sh --no-awake --no-wait in the background, in a process group of its own
//       git(...args):          git there, which must succeed; events(): runs/events.log
//       hold(unit):            holds the unit's session there (hold.<unit>); held() waits until it
//                              is, go() lets it go
//   main(file): the file on origin's main ("" if it isn't there)
//   editMain(files, fn): changes JSON files on origin's main by hand (fn changes each in place), as
//     time passing would (records backdated) or the owner does; one commit, pushed from a clone of its own
export function originFactory(name: string, { check = "true", files = {} as Record<string, string>, claude = FAKE_CLAUDE, prepare = (_F: string) => {} } = {}) {
  const w = workspace();
  // The machine's daemon's home (its lane records, which a lane's loop drops when it ends) is the
  // test's own, never the user's ~/.local/state/wfactory.
  Object.assign(w.env, { FACTORY_EVIDENCE_MIN: "0", FACTORY_NOCAP: "1", FACTORY_FETCH_EVERY: "0", FACTORY_PID: String(process.pid), FACTORY_POLL: "0.1", FACTORY_DAEMON_HOME: w.at("daemon") });
  // Its memory (workspace()'s FACTORY_MEMINFO) and the kernel's log are stand-ins too, so this
  // machine's own (memory low while the suites run, a kill elsewhere) never wakes a test's
  // \`fleet wait\`: plenty available, no kills.
  Object.assign(w.env, { FACTORY_KERNEL_LOG: w.at("kernel.log") });
  fs.writeFileSync(w.at("meminfo"), "MemTotal:       33554432 kB\nMemAvailable:   16777216 kB\n");
  fs.writeFileSync(w.at("kernel.log"), "");
  fs.writeFileSync(w.at("bin/claude"), claude, { mode: 0o755 });
  fs.writeFileSync(w.at("bin/claude-review"), FAKE_REVIEWER, { mode: 0o755 });
  w.env.FACTORY_REVIEWER = w.at("bin/claude-review");
  w.profile();
  const origin = w.at("origin.git");
  w.git(w.top, "init", "-q", "--bare", origin);
  w.git(origin, "config", "core.logAllRefUpdates", "always");
  const F = w.init(name);
  const fill = (f: string) => fs.writeFileSync(path.join(F, f), fs.readFileSync(path.join(F, f), "utf8").replace(/<fill[^>]*>/g, "filled"));
  fill("docs/factory.md"); fill("docs/machines.md");
  w.setup(["pass", "opening/ready"], F);   // past its opening
  const jf = path.join(F, "justfile");
  fs.writeFileSync(jf, fs.readFileSync(jf, "utf8").replace(/@echo "TODO.*/g, `@${check}`));
  for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(F, f), text);
  prepare(F);
  w.git(F, "add", "-A"); w.git(F, "commit", "-qm", "init"); w.git(F, "branch", "-q", "-M", "main");
  w.git(F, "remote", "add", "origin", origin); w.git(F, "push", "-q", "origin", "main");
  // Loops still running when the file's tests end are killed, with all they started.
  const bg: number[] = [];
  stopFirst(() => { for (const p of bg) killGroup(p); });
  const main = (file: string) => { const r = cmd("git", ["--git-dir", origin, "show", `main:${file}`], { cwd: w.top, env: w.env }); return r.code === 0 ? chomp(r.stdout) : ""; };
  const lane = (n: string, { k = 1, locks = n, host = n } = {}) => {
    const dir = w.at(`${n}-lane${k}`);
    w.git(w.top, "clone", "-q", origin, dir);
    const lk = w.at(`locks-${locks}`);
    fs.mkdirSync(lk, { recursive: true });
    const envWith = (add: Env = {}) => w.envWith({ FACTORY_LOCKS: lk, FACTORY_HOST: host, ...add });
    const run = (file: string, args: string[] = [], add: Env = {}, { timeout }: { timeout?: number } = {}) => cmd(file, args, { cwd: dir, env: envWith(add), merged: true, timeout });
    const tracker = (args: string[], add: Env = {}) => run("factory/tracker", args, add);
    const ok = (args: string[], add: Env = {}) => {
      const r = tracker(args, add);
      assert.equal(r.code, 0, `tracker ${args.join(" ")} in ${n}: exit ${r.code}\n${r.stdout}`);
      return chomp(r.stdout);
    };
    const setup = (args: string[], add: Env = {}) => {
      const r = trIn(args, envWith(add), dir);
      assert.equal(r.code, 0, `setup: tracker ${args.join(" ")} in ${n}: exit ${r.code}\n${r.out}${r.err}`);
      return r.out;
    };
    const loop = (args: string[], add: Env = {}) => run("factory/loop.sh", ["--no-awake", "--idle-wait", "0.05", "--no-wait", ...args], add, { timeout: loopDeadline(args) }).stdout;
    const loopBg = (args: string[], add: Env = {}) => {
      const b = background(path.join(dir, "factory/loop.sh"), ["--no-awake", "--no-wait", ...args], { cwd: dir, env: envWith(add), group: true });
      bg.push(b.pid!);
      return b;
    };
    const git = (...args: string[]) => w.git(dir, ...args);
    const events = () => readOr(path.join(dir, "runs/events.log"));
    const at = (p: string) => path.join(dir, p);
    const hold = (u: string) => {
      const k = u.replace("/", "-"), f = (x: string) => path.join(lk, `${x}.${k}`);
      fs.writeFileSync(f("hold"), "");
      return {
        held: (s = 20) => until(() => fs.existsSync(f("held")), `${u}'s session is working in lane ${n}`, s),
        go: () => { fs.rmSync(f("hold"), { force: true }); fs.rmSync(f("held"), { force: true }); fs.writeFileSync(f("go"), ""); },
      };
    };
    return { n, dir, locks: lk, at, envWith, run, tracker, ok, setup, loop, loopBg, git, events, hold };
  };
  const scratch = w.at("main-edit");
  const editMain = (files: string | string[], fn: (j: any, file: string) => void) => {
    if (!fs.existsSync(scratch)) w.git(w.top, "clone", "-q", origin, scratch);
    w.git(scratch, "fetch", "-q", "origin"); w.git(scratch, "reset", "-q", "--hard", "origin/main");
    for (const file of ([] as string[]).concat(files)) {
      const p = path.join(scratch, file), j = JSON.parse(fs.readFileSync(p, "utf8"));
      fn(j, file);
      fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
    }
    w.git(scratch, "commit", "-qam", "test: changed by hand"); w.git(scratch, "push", "-q", "origin", "HEAD:main");
  };
  return { w, F, origin, main, editMain, lane };
}
