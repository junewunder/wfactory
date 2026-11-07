// Long jobs: a job detached from the session and memory-capped, waited on in calls short enough
// for one Bash tool call.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { oom } from "./capped.ts";
import { capOk, recordRun, sizes, statusLines, takeTurn, writeEnded, type Reason } from "./heavy.ts";
import { enterRoot, epoch, hm, runFg, status, tail, ymdHms, asksHelp } from "./sys.ts";
import { machineOomSince, platform } from "./os.ts";

export const HELP = `
long.sh — run a long job detached and memory-capped, and wait on it in
calls short enough for one Bash tool call.

A headless session ends when its turn ends, and a foreground Bash call is cut
off at 10 minutes, so a 40-minute build can't run in either. \`start\` runs the
job as its own systemd user service (it survives the session); \`wait\` blocks
for at most about 9 minutes and says how it stands. A session calls \`wait\`
again while the job runs; it never ends its turn on a running job.

Usage:
  factory/long.sh start <name> [--mem SIZE] [--light] -- <command…>
  factory/long.sh wait <name> [--max SECONDS]
  factory/long.sh log <name> [N]       the last N lines of its output (default 40)
  factory/long.sh stop <name>
  factory/long.sh stop-all [--tag T]   every job still running that a session with factory tag T
                                       started (loop.sh, after each session: a job never outlives
                                       its session); without --tag, every job of this checkout
  factory/long.sh list                 its jobs, then what holds the machine's memory budget
                                       and heavy-job slots, and what waits (as \`just heavy\`)

Examples:
  just long start export -- uv run python scripts/export.py lexer
  just long wait export       # "still running", "done" or "failed", with the last lines

Exit status of \`wait\`: 0 = done (the command exited 0), 1 = failed (its exit
status and last lines are printed), 10 = still running: call \`wait\` again,
11 = out of time: the lane's stop time is near and the job still runs (stop
it, note how far it got, end the turn).
A long job is a heavy one: it takes its share of the machine's memory budget,
and if it isn't known to be short one of its heavy-job slots, before its
command starts (heavy.sh). While it waits, \`wait\` says what it's queued behind
and how long that has left. \`--light\` skips that for a job that barely uses
the CPU. How a job ended: \`just heavy why <name>\`.
\`start\` refuses a name that's already running. Output goes to
runs/long/<name>.log, the exit status to runs/long/<name>.exit.
Memory: --mem, else $FACTORY_LONG_MEM, is both its share of the budget and its
cap; neither given, its share is its last 3 peaks plus 20%, else 4G, and its
cap that or 8G, whichever is more (systemd sizes). \`start\` refuses a command
that sets MemoryMax= itself (env or systemd-run): use --mem. The wait
limit: --max, else $FACTORY_LONG_WAIT, else 540 seconds. A job killed over its
cap, or by the whole machine running out, says so in \`wait\`, and an
\`oom-kill\` event tells the overseer (capped.sh).
The stop time: in a loop session, $FACTORY_DEADLINE (the loop's --hours, epoch
seconds), or runs/.stop-at if earlier (\`just fleet stop-at\`). \`wait\` returns
11 once it's under $FACTORY_LONG_MARGIN seconds away (default 900), so the
session has time to wrap up before the loop ends it. Asked again after that,
it waits $FACTORY_LONG_AGAIN seconds (default 60) before saying so again.`;

const D = "runs/long";
// The service's command runs through main.mjs on this same Node, which a deploy keeps beside
// this copy: a running job keeps the version it started with.
const MAIN = fileURLToPath(new URL("../main.mjs", import.meta.url));
// What a service is given of the session's environment, besides every FACTORY_ variable.
const PASSED = ["PATH", "HOME", "DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "VIRTUAL_ENV"];
// A display the session hasn't got, the service doesn't either: a user service would otherwise
// get the owner's from the user manager, and a lane's session has none (loop-unit.ts, NO_DISPLAY).
const DISPLAYS = ["DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY"];

const read = (f: string) => { try { return fs.readFileSync(f, "utf8"); } catch { return null; } };
// A file's contents as `$(cat f)` gives them: without the trailing newlines.
const cat = (f: string) => read(f)?.replace(/\n+$/, "") ?? null;
const nameOk = (n: string) => {
  if (/^[a-z0-9][a-z0-9-]{0,40}$/.test(n)) return true;
  console.error(`long: name jobs with lowercase words and dashes (got '${n}')`);
  return false;
};

// The lane's stop time (epoch seconds), or null outside a loop session.
function stopTime(env: NodeJS.ProcessEnv): number | null {
  const d = env.FACTORY_DEADLINE ?? "";
  if (!/^[0-9]+$/.test(d)) return null;
  const s = cat("runs/.stop-at") ?? "";
  return /^[0-9]+$/.test(s) && Number(s) < Number(d) ? Number(s) : Number(d);
}

// The last lines of a job's output, indented, as `wait` shows them.
function lastLines(n: string, k = 5) {
  const lines = tail(`${D}/${n}.log`, k);
  if (lines?.length) console.log(lines.map((l) => `  | ${l}`).join("\n"));
}

// The log's first line, "==== <date> start: <command>": [, date, command], or null.
function startLine(n: string) {
  let head = "";
  try {
    const fd = fs.openSync(`${D}/${n}.log`, "r");
    const b = Buffer.alloc(65536);
    try { head = b.toString("utf8", 0, fs.readSync(fd, b, 0, b.length, 0)); } finally { fs.closeSync(fd); }
  } catch {}
  return /^==== (.*?) start: (.*)$/.exec(head.split("\n")[0]);
}

// When the job started (epoch ms), from its log's first line; now if that can't be read.
function startedAt(n: string) {
  const m = /^(\d+)-(\d+)-(\d+) (\d+):(\d+):(\d+)$/.exec(startLine(n)?.[1] ?? "");
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : Date.now();
}

function start(args: string[], unit: (n: string) => string, root: string, env: NodeJS.ProcessEnv): number {
  const n = args.shift();
  if (!n) { console.error("usage: long start <name> [--mem SIZE] [--light] -- <command…>"); return 2; }
  if (!nameOk(n)) return 2;
  let given = env.FACTORY_LONG_MEM || undefined, heavy = true;
  for (;;) {
    if (args[0] === "--mem") {
      if (args.length < 2) { console.error("long start: --mem needs a size"); return 2; }
      given = args[1]; args = args.slice(2);
    } else if (args[0] === "--light") { heavy = false; args = args.slice(1); }
    else break;
  }
  if (args[0] === "--") args = args.slice(1);
  if (!args.length) { console.error(`long start: no command (long start ${n} -- <command…>)`); return 2; }
  // A MemoryMax= in the command sets no cap: as an env var nothing reads it, and through
  // systemd-run it makes a scope outside this job's service, so outside the memory budget.
  if (args.some((a) => /\bMemoryMax=/.test(a))) {
    console.error(`long start: the command sets MemoryMax=, which doesn't change ${n}'s cap (an env var does nothing; systemd-run's scope escapes the memory budget). Drop it and give the cap as \`just long start ${n} --mem SIZE -- …\`.`);
    return 2;
  }
  if (given !== undefined && !capOk(given)) { console.error(`long start: not a size: ${given} (512M, 4G, 50%, infinity)`); return 2; }
  const { reserve, cap: mem } = sizes(args.join(" "), given, env);
  if (platform.jobRunning(unit(n))) { console.error(`long: ${n} is already running; \`just long wait ${n}\``); return 2; }
  for (const x of ["exit", "oom", "queue"]) fs.rmSync(`${D}/${n}.${x}`, { force: true });
  // Which loop session started it ($FACTORY_TAG), so the loop stops only that session's jobs.
  if (env.FACTORY_TAG) fs.writeFileSync(`${D}/${n}.tag`, `${env.FACTORY_TAG}\n`);
  else fs.rmSync(`${D}/${n}.tag`, { force: true });
  const log = `${root}/${D}/${n}.log`;
  fs.writeFileSync(log, `==== ${ymdHms()} start: ${args.join(" ")}\n`);
  platform.forgetJob(unit(n));
  const vars: Record<string, string> = {};
  for (const v of [...PASSED, ...Object.keys(env).filter((k) => k.startsWith("FACTORY_")).sort()]) if (env[v]) vars[v] = env[v];
  // Its own service, outside any capped job that started it: its own turn and cap.
  delete vars.FACTORY_HEAVY_HELD; delete vars.FACTORY_HEAVY_RES; delete vars.FACTORY_CAPPED_IN;
  const rc = platform.startJob(unit(n), vars,
    [process.execPath, MAIN, "long", "run", `${root}/${D}/${n}.exit`, ...(heavy ? ["--heavy", `just long start ${n}`, "--mem", String(reserve)] : []), "--", ...args],
    { mem, log, onEnd: [process.execPath, MAIN, "long", "stopped", n, mem], unset: DISPLAYS.filter((v) => !env[v]) });
  if (rc !== 0) return rc;
  console.log(`started ${n} (capped at ${mem}). \`just long wait ${n}\` until it's done; never end your turn while it runs.`);
  const st = stopTime(env);
  if (st !== null) console.log(`The lane stops at ${hm(new Date(st * 1000))}. If ${n} won't finish well before then, stop it now (\`just long stop ${n}\`) and split the unit instead.`);
  return 0;
}

// The service's command: <command…> (once its turn comes, with --heavy: <mem> bytes of the
// budget, and a slot unless it's known to be short), then its exit status in <exit file>. A
// signal (`long stop`) ends this at once, with no exit status: the job was stopped, it didn't exit.
async function run(args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const [file, ...rest] = args;
  let what: string | null = null, mem = 4 * 1024 ** 3, cmd = rest;
  if (cmd[0] === "--heavy") { what = cmd[1]; cmd = cmd.slice(2); }
  if (cmd[0] === "--mem") { mem = Number(cmd[1]); cmd = cmd.slice(2); }
  if (cmd[0] === "--") cmd = cmd.slice(1);
  if (!file || !cmd.length) { console.error("usage: long run <exit file> [--heavy <what> [--mem <bytes>]] -- <command…>"); return 2; }
  const n = path.basename(file).replace(/\.exit$/, ""), key = cmd.join(" ");
  const turn = what !== null && !env.FACTORY_HEAVY_HELD
    ? await takeTurn({ what, cmd: key, name: n, mem, queueFile: `${path.dirname(file)}/${n}.queue` }, env) : null;
  if (typeof turn === "string") return 2;   // (no failAfter: it waits)
  const t0 = Date.now();
  // A `just capped` in its command runs inside this service's cap (FACTORY_CAPPED_IN).
  const rc = status(await runFg(cmd, { env: { ...env, FACTORY_CAPPED_IN: path.basename(file), FACTORY_HEAVY_RES: "", ...(turn ? { FACTORY_HEAVY_HELD: "1" } : {}) }, signals: false }));
  turn?.give();
  if (rc === 0) recordRun(key, { secs: (Date.now() - t0) / 1000 }, env);
  fs.writeFileSync(`${file}.tmp`, `${rc}\n`);
  fs.renameSync(`${file}.tmp`, file);
  return 0;
}

async function wait(args: string[], unit: (n: string) => string, env: NodeJS.ProcessEnv): Promise<number> {
  const n = args[0];
  if (!n) { console.error("usage: long wait <name>"); return 2; }
  if (!nameOk(n)) return 2;
  let max = Number(env.FACTORY_LONG_WAIT || 540);
  if (args[1] === "--max") max = Number(args[2]);
  const exitFile = `${D}/${n}.exit`, oomFile = `${D}/${n}.oom`;
  const exited = () => fs.existsSync(exitFile);
  const active = () => platform.jobRunning(unit(n));
  const t0 = epoch(), st = stopTime(env);
  const cut = st === null ? null : st - Number(env.FACTORY_LONG_MARGIN || 900);
  // Told already and asking again: don't answer at once, or a session that keeps asking spins.
  if (cut !== null && t0 >= cut && !exited() && active()) await sleep(Number(env.FACTORY_LONG_AGAIN || 60) * 1000);
  if (!exited() && !active() && !fs.existsSync(`${D}/${n}.log`)) { console.error(`long: no job named ${n} (just long list)`); return 2; }
  while (!exited() && active() && epoch() - t0 < max && (cut === null || epoch() < cut)) await sleep(1000);
  // A kill over the cap is noted once the service has stopped, just after its exit status
  // (137, or a wrapper's own code: the kernel kills only the biggest process).
  if ((cat(exitFile) ?? "none") !== "0" && (exited() || !active())) {
    for (let i = 0; i < 20 && !fs.existsSync(oomFile) && platform.jobKnown(unit(n)); i++) await sleep(250);
  }
  if (fs.existsSync(oomFile)) {
    const o = (cat(oomFile) ?? "").split(" ");
    if (o[0] === "machine") console.log(`failed: ${n} was killed: the whole machine ran out of memory (not its cap of ${o[1]}; the overseer hears of it)`);
    else console.log(`failed: ${n} was killed: out of memory at ${o[0] === "cap" ? o[1] : o[0]} (the memory cap, not the job's own failure; the overseer hears of it)`);
    lastLines(n, 15); return 1;
  }
  const rc = cat(exitFile);
  if (rc !== null) {
    if (rc === "0") { console.log(`done: ${n} finished (exit 0)`); lastLines(n, 5); return 0; }
    console.log(`failed: ${n} exited ${rc}`); lastLines(n, 15); return 1;
  }
  if (!active()) {
    console.log(`failed: ${n} stopped without an exit status (killed, or over its memory cap: \`${platform.jobLogHint(unit(n).replace(/\.service$/, ""))}\`)`);
    lastLines(n, 15); return 1;
  }
  const queued = cat(`${D}/${n}.queue`);
  const mins = Math.floor((Date.now() - startedAt(n)) / 60000);
  if (cut !== null && st !== null && epoch() >= cut) {
    console.log(`out of time: the lane stops at ${hm(new Date(st * 1000))} and ${n} is still running (${mins} min so far). Stop it (\`just long stop ${n}\`), \`just note\` your unit with how far it got and how to split it into smaller units, and end your turn. The loop ends a session still running after the stop time.`);
    lastLines(n, 3);
    return 11;
  }
  if (queued) {
    console.log(`queued: ${n} hasn't started (${mins} min so far), ${queued}. Call \`just long wait ${n}\` again now; don't end your turn.`);
    return 10;
  }
  console.log(`still running: ${n}, ${mins} min so far. Call \`just long wait ${n}\` again now; don't end your turn.`);
  lastLines(n, 3);
  return 10;
}

export async function longCli(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const [cmd = "", ...rest] = args;
  if (cmd === "" || asksHelp(args)) { console.log(HELP); return 0; }
  if (!enterRoot("long.sh", env)) return 1;
  const root = env.FACTORY_ROOT!;
  fs.mkdirSync(D, { recursive: true });
  const prefix = `factory-${path.basename(root)}-long`;
  const unit = (n: string) => `${prefix}-${n}`;
  switch (cmd) {
    case "start": return start(rest, unit, root, env);
    case "run": return run(rest, env);
    case "wait": return wait(rest, unit, env);
    case "stopped": {   // the service's ExecStopPost: stopped <name> <cap>
      const [n = "", cap = ""] = rest;
      if (!nameOk(n)) return 2;
      // Its cgroup still holds the peak and the kernel's counts: a kill without the cap reached
      // was the machine's.
      const g = platform.myGroup();
      const peak = platform.groupPeak(g);
      let overCap = (platform.groupKills(g)?.overCap ?? 1) > 0;
      const killed = platform.endedOverCap(env);
      const st = startLine(n), rc = cat(`${D}/${n}.exit`);
      const start = startedAt(n);
      // The machine's, only if the kernel's log doesn't say otherwise (it says nothing it can't be read).
      if (killed && !overCap && machineOomSince(start) === false) overCap = true;
      const key = st?.[2] ?? "";
      if (key && !killed) recordRun(key, { peak: Number(peak) || undefined }, env);   // (a killed one's isn't what it needs)
      const reason: Reason = killed ? overCap ? "oom" : "machine" : rc === null ? "stopped" : rc === "0" ? "ok" : Number(rc) > 128 ? "signal" : "exit";
      writeEnded(root, n, { what: `just long start ${n}`, cmd: key, start, end: Date.now(), reason, rc: rc === null ? undefined : Number(rc), cap, peak: Number(peak) || undefined });
      if (!killed) return 0;
      fs.writeFileSync(`${D}/${n}.oom`, `${overCap ? "cap" : "machine"} ${cap}\n`);
      try { oom(`just long start ${n} (${key})`, cap, peak, env, true, !overCap); } catch {}
      return 0;
    }
    case "log": {
      const [n, k = "40"] = rest;
      if (!n || !/^[0-9]+$/.test(k)) { console.error("usage: long log <name> [N]"); return 2; }
      if (!nameOk(n)) return 2;
      const lines = tail(`${D}/${n}.log`, Number(k));
      if (lines === null) { console.error(`tail: cannot open '${D}/${n}.log' for reading: No such file or directory`); return 1; }
      if (lines.length) console.log(lines.join("\n"));
      return 0;
    }
    case "stop": {
      const n = rest[0];
      if (!n) { console.error("usage: long stop <name>"); return 2; }
      if (!nameOk(n)) return 2;
      platform.stopJobs(unit(n));
      console.log(`stopped ${n}`);
      return 0;
    }
    case "stop-all": {
      const tag = rest[0] === "--tag" ? rest[1] ?? "" : "";
      const name = (u: string) => u.slice(prefix.length + 1);
      let left = platform.runningJobs(`${prefix}-*`);
      if (tag) left = left.filter((u) => cat(`${D}/${name(u)}.tag`) === tag);
      if (!left.length) return 0;
      platform.stopJobs(...left);
      console.log(`stopped long jobs the session left running: ${left.map(name).join(" ")}`);
      return 0;
    }
    case "list": {
      const logs = fs.readdirSync(D).filter((f) => f.endsWith(".log")).sort();
      if (!logs.length) console.log("no long jobs yet");
      for (const f of logs) {
        const n = f.slice(0, -4);
        const rc = cat(`${D}/${n}.exit`);
        console.log(`${n}: ${platform.jobRunning(unit(n)) ? fs.existsSync(`${D}/${n}.queue`) ? "queued" : "running" : rc !== null ? `exited ${rc}` : "stopped"}`);
      }
      console.log("");
      console.log(statusLines(env).join("\n"));
      return 0;
    }
    default: console.error(`long: unknown command ${cmd} (start | wait | log | stop | stop-all | list)`); return 2;
  }
}
