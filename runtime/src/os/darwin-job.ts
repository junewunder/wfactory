// A job's supervisor on macOS (os/darwin.ts, startJob), what systemd is to a job on Linux:
//
//   darwin-job.ts job <its folder>          run the job its spec.json describes
//   darwin-job.ts service <spec> [--boot]   the crontab's check of the daemon's service
//   darwin-job.ts watch <folder> <pid> <cap> <0|1>   the watch over a capped run
//
// A job: the command runs in a process group of its own, its output appended to the log, its pid
// in the folder's "pid". When it ends, whatever it started that's still running is stopped
// (TERM, then KILL after the stop timeout), as systemd stops the rest of a unit's group: the
// processes in its group; those under it now or seen under it (it looks every two seconds); and
// those holding its mark, a file open as descriptor 3, which what it starts inherits (though not
// through a Node process, which passes on only the descriptors it's told to). A new session
// (setsid) takes a process out of the group, not out of sight; one that left its session, lost
// its parent within two seconds and never held the mark gets away (on Linux the cgroup has it).
// With a memory cap (mem) the folder is the job's group as os/darwin-cap.ts says: over the cap
// its biggest process is killed and the rest stopped.
// Then onEnd runs, with $SERVICE_RESULT saying how it ended
// ("success", "exit-code", "signal", "timeout", "oom-kill"), and the folder goes, unless the job keeps its
// result and failed: then "result" says how. A TERM to the supervisor stops the job the same way
// (a stop by TERM counts as success, as for a service).
//
// The service's check: at boot (--boot) it starts the service; any other time, only one that ran
// and failed (its job folder still there, nothing running), at most five times in ten minutes;
// after that, not until the service is started by hand (darwin.ts, startService), as systemd
// leaves a unit failed past its start limit.
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { bootId, darwin, jobDir, pidFile, serviceSpec, startService, sweepCapped } from "./darwin.ts";
import { Watch, capBytes, poll, totalMemory } from "./darwin-cap.ts";

const [what = "", arg = "", flag = ""] = process.argv.slice(2);

function job(dir: string) {
  const spec = JSON.parse(fs.readFileSync(path.join(dir, "spec.json"), "utf8")) as {
    env: Record<string, string>; cmd: string[]; cwd: string; log?: string; stopTimeout: number; keepResult: boolean; onEnd?: string[]; mem?: string;
  };
  const out = spec.log ? fs.openSync(spec.log, "a") : "ignore";
  // Its folder is its group (os/darwin-cap.ts): the job's processes are told it ($FACTORY_GROUP),
  // and its onEnd reads the peak and the kills there.
  const cap = spec.mem ? capBytes(spec.mem, totalMemory()) : 0;
  if (spec.mem) fs.writeFileSync(path.join(dir, "cap"), `${spec.mem}\n`);
  const env = { ...spec.env, FACTORY_GROUP: dir };
  // The job's mark: a file every process of the job has open (as descriptor 3, which what it
  // starts inherits), even one that left its session and was handed to launchd.
  const mark = fs.openSync(path.join(dir, "mark"), "w");

  let stopping = false, timedOut = false, overCap = false, result = "", top = 0;
  let killer: NodeJS.Timeout | undefined;
  let w: Watch | null = null;
  // (Listening before the command starts: a stop that comes before it has a pid is kept for then.)
  const stop = () => {
    stopping = true;
    if (!w || killer) return;
    w.look();
    w.signal("SIGTERM", top);
    killer = setTimeout(() => { timedOut = true; w!.look(); w!.signal("SIGKILL", top); }, spec.stopTimeout * 1000);
  };
  for (const s of ["SIGTERM", "SIGINT"] as const) process.on(s, stop);
  process.on("SIGHUP", () => {});
  const c = spawn(spec.cmd[0], spec.cmd.slice(1), { cwd: spec.cwd, env, stdio: ["ignore", out, out, mark], detached: true });
  fs.closeSync(mark);
  top = c.pid ?? 0;
  if (top) { pidFile(path.join(dir, "pid"), top); w = new Watch(dir, top, cap); }
  // What's under it, every two seconds; with a cap, its memory once a second, and over the cap
  // the biggest process killed and the rest stopped (a service's OOMPolicy=stop).
  const tick = () => {
    if (!w) return;
    w.look();
    if (spec.mem) w.measure(() => { overCap = true; stop(); });
  };
  tick();
  const watch = setInterval(tick, spec.mem ? poll() : 2000);
  if (stopping) stop();

  const ended = (code: number | null, sig: NodeJS.Signals | null) => {
    if (result) return;
    clearInterval(watch);
    // (As for a service: the signals that ask a process to end count as a clean end.)
    result = overCap ? "oom-kill" : timedOut ? "timeout" : code === 0 || (sig && ["SIGTERM", "SIGINT", "SIGHUP", "SIGPIPE"].includes(sig)) ? "success" : sig ? "signal" : "exit-code";
    // What it left running goes too.
    if (w) {
      w.look();
      w.signal("SIGTERM", top);
      const until = Date.now() + spec.stopTimeout * 1000;
      const tick = new Int32Array(new SharedArrayBuffer(4));
      while (w.left() && Date.now() < until) Atomics.wait(tick, 0, 0, 50);
      if (w.left()) w.signal("SIGKILL", top);
    }
    if (killer) clearTimeout(killer);
    if (spec.onEnd?.length) {
      const status = code ?? (sig ? 128 + (({ SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 } as Record<string, number>)[sig] ?? 0) : 1);
      spawnSync(spec.onEnd[0], spec.onEnd.slice(1), { cwd: spec.cwd, stdio: ["ignore", out, out],
        env: { ...env, SERVICE_RESULT: result, EXIT_CODE: sig ? "killed" : "exited", EXIT_STATUS: sig ? sig.replace(/^SIG/, "") : String(status) } });
    }
    if (result === "success" || !spec.keepResult) fs.rmSync(dir, { recursive: true, force: true });
    else { fs.writeFileSync(path.join(dir, "result"), `${result}\n`); fs.rmSync(path.join(dir, "pid"), { force: true }); fs.rmSync(path.join(dir, "runner"), { force: true }); }
    process.exit(0);
  };
  c.on("error", () => ended(203, null));
  c.on("exit", ended);
}

// A capped run's watch (os/darwin.ts, cappedCmd): started beside the run, out of its process tree,
// it watches the group until nothing of it is left. Over the cap the biggest process is killed;
// with carryOn ("1") that's all, else the rest is stopped too (a scope's OOMPolicy=stop). A TERM
// stops the run: TERM to all of it, then KILL after 90 seconds, as systemd stops a scope. At the
// end the folder goes, unless the cap killed something: then it stays, with "ended" saying when,
// until the run is forgotten (at once, if it was forgotten while it ran).
function watchCapped(dir: string, top: number, capSize: string, carryOn: boolean) {
  const cap = capBytes(capSize, totalMemory());
  try {
    fs.writeFileSync(path.join(dir, "boot"), `${bootId()}\n`);
    fs.writeFileSync(path.join(dir, "cap"), `${capSize}\n`);
    pidFile(path.join(dir, "pid"), top);
    // (Last: the run starts once it's there.)
    pidFile(path.join(dir, "runner"), process.pid);
  } catch { process.exit(0); }   // (forgotten already: the run ended before this started)
  const w = new Watch(dir, top, cap);
  // (Other runs' folders are swept after the first look, or as this ends: never before a look.)
  let swept = false;
  const sweep = () => { if (!swept) { swept = true; try { sweepCapped(dir); } catch {} } };
  // The folder is this watch's while it's the one it started with: a run started since under the
  // same name made a new one, which isn't this watch's to look at, write in or remove.
  let ino = 0;
  try { ino = fs.statSync(dir).ino; } catch { process.exit(0); }
  const mine = () => { try { return fs.statSync(dir).ino === ino; } catch { return false; } };
  let killer: NodeJS.Timeout | undefined;
  const stop = () => {
    if (killer) return;
    w.look();
    w.signal("SIGTERM");
    killer = setTimeout(() => { w.look(); w.signal("SIGKILL"); }, 90000);
  };
  process.on("SIGTERM", stop);
  for (const s of ["SIGINT", "SIGHUP"] as const) process.on(s, () => {});
  const tick = () => {
    if (!mine()) process.exit(0);
    if (!w.look().length) {
      try {
        fs.writeFileSync(path.join(dir, "ended"), `${Date.now()}\n`);
        if (w.kills.overCap === 0 || fs.existsSync(path.join(dir, "forget"))) fs.rmSync(dir, { recursive: true, force: true });
        fs.rmSync(path.join(dir, "runner"), { force: true });
      } catch {}
      sweep();
      process.exit(0);
    }
    w.measure(carryOn ? undefined : stop);
  };
  tick();
  sweep();
  setInterval(tick, poll());
}

function service(spec: string, boot: boolean) {
  const dir = path.dirname(spec), name = path.basename(spec, ".json");
  if (!serviceSpec(name, dir) || darwin.jobRunning(name)) return;
  const failed = fs.existsSync(jobDir(name));
  const gaveUp = path.join(dir, `${name}.gave-up`);
  if (!boot && (!failed || fs.existsSync(gaveUp))) return;
  // The starts in the last ten minutes, this one's included: no more than five.
  const log = path.join(dir, `${name}.starts`), now = Math.floor(Date.now() / 1000);
  let starts: number[] = [];
  try { starts = fs.readFileSync(log, "utf8").split("\n").map(Number).filter((t) => t > now - 600); } catch {}
  if (!boot && starts.length >= 5) { fs.writeFileSync(gaveUp, `${now}\n`); return; }
  fs.writeFileSync(log, [...starts, now].join("\n") + "\n");
  startService(name, dir, boot);
}

if (what === "job" && arg) job(arg);
else if (what === "service" && arg) service(arg, flag === "--boot");
else if (what === "watch" && arg) watchCapped(arg, Number(flag), process.argv[5] ?? "", process.argv[6] === "1");
else { process.stderr.write("usage: darwin-job.ts job <folder> | service <spec> [--boot] | watch <folder> <pid> <cap> <carry on: 0|1>\n"); process.exit(2); }
