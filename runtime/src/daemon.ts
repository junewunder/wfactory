// The daemon: one per machine, serving every factory on it (docs/goal-ts.md, phase 3). It runs
// while the factory is on: `oversee.sh start` writes a record for each lane it starts and makes
// sure the daemon runs; the daemon drops a lane's record once the lane has ended, and exits
// when it has none and no one is waiting on it. Its service starts at login too, so after a
// reboot, a crash or a logout, records of lanes that were cut off bring them back.
//
// Lanes stay units of their own (os.ts), so killing or restarting the daemon leaves them
// running; a restarted daemon picks them up again from its records. It also answers `fleet
// wait` for this machine (watch, below) over a socket, which other machines reach by ssh
// (`oversee.sh watch`): no network port.
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { platform, type OomKill } from "./os.ts";
import { epoch, host, tryLock, ymdHm, ymdHms, asksHelp } from "./sys.ts";
import { lastCallFile, SAME_STOP_S, writtenLastCall } from "./loop-clock.ts";

export const HELP = `
daemon — the machine's factory daemon: brings lanes back after the machine
went down, and answers \`just fleet wait\` for this machine.

\`oversee.sh start\` (so \`just fleet start\`) writes a record of each lane it
starts and starts the daemon. A lane that stops by itself drops its record,
and \`oversee.sh stop\` drops it; one ended by a signal (as a logout or a
shutdown ends them) keeps it a while. The daemon exits once it has none and
nobody is waiting on it. Its service is
enabled at login: after a reboot, a crash or a logout, a record of a lane that
was cut off brings it back, with what's left of its time, unless its stop
time has passed or the owner's last call (\`just fleet last-call\`) had begun,
or the machine went down twice soon after bringing it back. Each of those
leaves an event for the overseer. A lane brought back in its timed last call
comes back in it, and works through it as any lane does: the time is the
one the factory's lanes here last wrote for its stop time (last-call in its
lock folder), else (after a reboot, which empties it) "last_call" minutes
before the stop time, as the loop works it out.

Usage:
  main.mjs daemon run          the daemon itself (its service runs this)
  main.mjs daemon start        start it, if it isn't running (installs its service)
  main.mjs daemon status       whether it runs, and the lanes it has records of
  main.mjs daemon stop         stop it (the lanes go on; records stay)
  main.mjs daemon redeployed   restart it onto the newest deployed copy, if it runs
                               from that deploy folder (scripts/deploy.sh runs this)
  main.mjs daemon install      write and enable its service, pointing at this copy
                               (or at the deploy folder's current, for a deployed copy)

Environment: FACTORY_DAEMON_HOME (its records, socket and log; default
~/.local/state/wfactory), FACTORY_DAEMON_UNIT (its service's name,
default wfactory), FACTORY_DAEMON_UNIT_DIR (where its service file goes),
FACTORY_DAEMON_IDLE (seconds with nothing to do before it exits, default 120),
FACTORY_DAEMON_TICK (seconds between looks, default 5), FACTORY_DAEMON_GRACE
(seconds a lane ended by a signal keeps its record, in case the machine is
going down, default 120). FACTORY_MEMINFO and FACTORY_KERNEL_LOG put a file
in place of /proc/meminfo and the kernel's log, for the tests.

A lane on a copy of the skill from before restarts, asked to restart
(\`fleet restart\`), pauses after its unit instead; its record says to start it
again, and the daemon does once it stops, on the copy that asked, with what's
left of its time.`;

// ---------------------------------------------------------------- where things are
export const home = (env: NodeJS.ProcessEnv = process.env) =>
  env.FACTORY_DAEMON_HOME || path.join(env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "wfactory");
export const unitName = (env: NodeJS.ProcessEnv = process.env) => env.FACTORY_DAEMON_UNIT || "wfactory";
const sockPath = (env: NodeJS.ProcessEnv) => path.join(home(env), "daemon.sock");
const lanesDir = (env: NodeJS.ProcessEnv) => path.join(home(env), "lanes");
const num = (v: string | undefined, d: number) => Number(v) > 0 ? Number(v) : d;

// ---------------------------------------------------------------- lane records
// One file per lane that should be running. Readable by the next version of the daemon: add
// fields, never change what one means (docs/goal-ts.md, "A deploy restarts the daemon").
export interface LaneRecord {
  v: 1;
  unit: string;                 // the lane's job (oversee.ts), which is its key
  dir: string;                  // the lane's checkout
  loop: string;                 // the project's loop name, or ""
  args: string[];               // loop.sh's options, as started
  env: Record<string, string>;  // what the lane's job was given
  started: number;              // epoch seconds
  deadline: number;             // when --hours runs out, epoch seconds
  manager: string;              // the run of the user's service manager it started under
  resumes: number[];            // when the daemon brought it back after the machine went down
  quick: number;                // times in a row the machine went down soon after a resume
  then?: "start";               // start it again as soon as it stops (oversee.ts restart: a lane
                                // on a copy from before restarts, asked to pause for it)
  restart?: { id: string; of: string };   // the fleet restart that asked it (loop.ts's --id, --of)
}

const recFile = (env: NodeJS.ProcessEnv, unit: string) => path.join(lanesDir(env), `${unit}.json`);
export function writeRecord(r: LaneRecord, env: NodeJS.ProcessEnv = process.env) {
  fs.mkdirSync(lanesDir(env), { recursive: true });
  const f = recFile(env, r.unit), t = `${f}.tmp-${process.pid}`;
  fs.writeFileSync(t, JSON.stringify(r, null, 2) + "\n");
  fs.renameSync(t, f);
}
export function records(env: NodeJS.ProcessEnv = process.env): LaneRecord[] {
  let fs_: string[] = [];
  try { fs_ = fs.readdirSync(lanesDir(env)).filter((f) => f.endsWith(".json")).sort(); } catch { return []; }
  const out: LaneRecord[] = [];
  for (const f of fs_) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(lanesDir(env), f), "utf8"));
      if (r && typeof r.unit === "string" && typeof r.dir === "string") out.push({ resumes: [], quick: 0, loop: "", args: [], env: {}, ...r });
    } catch {}
  }
  return out;
}
export const dropRecord = (unit: string, env: NodeJS.ProcessEnv = process.env) => fs.rmSync(recFile(env, unit), { force: true });

// The record `oversee.sh start` writes for a lane it just started.
export function recordLane(unit: string, dir: string, loop: string, args: string[], vars: Record<string, string>, env: NodeJS.ProcessEnv = process.env) {
  const now = epoch();
  let hours = 8;   // loop.sh's default
  for (let i = 0; i < args.length - 1; i++) if (args[i] === "--hours" && Number.isFinite(Number(args[i + 1]))) hours = Number(args[i + 1]);
  // A start the daemon makes when it brings a lane back carries the lane's history on.
  const resumed = env.FACTORY_RESUMED ? JSON.parse(env.FACTORY_RESUMED) as { resumes: number[]; quick: number } : null;
  writeRecord({
    v: 1, unit, dir, loop, args, env: vars, started: now, deadline: now + Math.trunc(hours * 3600), manager: platform.managerId(),
    resumes: resumed?.resumes ?? [], quick: resumed?.quick ?? 0,
  }, env);
}

// ---------------------------------------------------------------- the journal
function journal(env: NodeJS.ProcessEnv, text: string) {
  fs.mkdirSync(home(env), { recursive: true });
  fs.appendFileSync(path.join(home(env), "daemon.log"), `${ymdHms()} ${text}\n`);
}
// An event in a lane's runs/events.log, as the loop writes them (events.ts), from outside it.
function laneEvent(dir: string, kind: string, message: string, env: NodeJS.ProcessEnv) {
  const lane = /-lane([0-9]*)$/.exec(path.basename(dir))?.[1] || "1";
  try {
    fs.mkdirSync(path.join(dir, "runs"), { recursive: true });
    fs.appendFileSync(path.join(dir, "runs", "events.log"), [ymdHm(), host(env), lane, kind, message.replace(/[\t\n]/g, " ")].join("\t") + "\n");
  } catch {}
}

// ---------------------------------------------------------------- watching lanes
// What `fleet wait` asks of a machine: its lanes' jobs and event counts now (look), or once
// something changed since a look, or by `until` (watch). With `machine`, the machine too: memory
// available, and what the kernel killed for want of memory since `since`; a watch also ends on a
// kill, or on memory falling under `floor` (bytes) unless it was already `low`.
export interface LaneAsk { unit: string; dir: string }
// running: its job runs, or it was asked to start again as soon as it stops (a restart of a lane
// on a copy from before restarts); a job the service manager couldn't be asked about counts as
// running, never as a stop. deadline: when its run ends (its --hours, or an earlier stop time).
export interface LaneSeen { running: boolean; count: number; fresh?: string; deadline?: number }
export interface MachineAsk { since: number; floor: number; low: boolean }
export interface MachineSeen { avail: number | null; ooms: OomKill[] }
export interface WatchReq { lanes: LaneAsk[]; seen: LaneSeen[]; until: number; machine?: MachineAsk }
const expand = (d: string) => d === "~" ? os.homedir() : d.startsWith("~/") ? path.join(os.homedir(), d.slice(2)) : d;
const eventsOf = (dir: string) => { try { return fs.readFileSync(path.join(expand(dir), "runs", "events.log"), "utf8"); } catch { return ""; } };
const countLines = (s: string) => s === "" ? 0 : s.split("\n").length - (s.endsWith("\n") ? 1 : 0);
export function look(lanes: LaneAsk[], env: NodeJS.ProcessEnv = process.env): LaneSeen[] {
  const recs = new Map(records(env).map((r) => [r.unit, r]));
  return lanes.map((l) => {
    const r = recs.get(l.unit);
    const stopAt = Number(cat(path.join(expand(l.dir), "runs", ".stop-at")));
    const deadline = r ? (stopAt > 0 && stopAt < r.deadline ? stopAt : r.deadline) : stopAt > 0 ? stopAt : undefined;
    const running = platform.jobState(l.unit) !== "stopped" || r?.then === "start";
    return { running, count: countLines(eventsOf(l.dir)), ...(deadline ? { deadline } : {}) };
  });
}
// The machine now. The lanes' own sessions and jobs killed at their caps aren't counted: the lane
// raises an oom-kill event for those, with what used the memory.
export function lookMachine(m: MachineAsk): MachineSeen {
  return { avail: platform.memory().available, ooms: (platform.oomKills(m.since) ?? []).filter((k) => k.machine || !k.unit.startsWith("factory-")) };
}
const machineNews = (m: MachineAsk | undefined, s: MachineSeen | undefined) =>
  !!m && !!s && (s.ooms.length > 0 || (!m.low && s.avail !== null && s.avail < m.floor));
// Block until a lane that ran has stopped or logged an event since `seen`, or the machine has
// news, or until `until` (epoch seconds), or the signal. Each lane as now, with any new event
// lines, and the machine. The kernel's log is read every 10 seconds, memory every look.
export async function watch(q: WatchReq, every = 1, signal?: AbortSignal, env: NodeJS.ProcessEnv = process.env): Promise<{ lanes: LaneSeen[]; machine?: MachineSeen }> {
  let ooms: OomKill[] = [], read = 0;
  for (;;) {
    const now = look(q.lanes, env);
    let machine: MachineSeen | undefined;
    if (q.machine) {
      if (epoch() - read >= 10) { ooms = lookMachine(q.machine).ooms; read = epoch(); }
      machine = { avail: platform.memory().available, ooms };
    }
    const changed = now.some((s, i) => (q.seen[i].running && !s.running) || s.count > q.seen[i].count) || machineNews(q.machine, machine);
    if (changed || epoch() >= q.until || signal?.aborted) {
      const lanes = now.map((s, i) => s.count > q.seen[i].count ? { ...s, fresh: eventsOf(q.lanes[i].dir).split("\n").slice(q.seen[i].count, s.count).join("\n") + "\n" } : s);
      return machine ? { lanes, machine } : { lanes };
    }
    try { await sleep(every * 1000, undefined, { signal }); } catch {}
  }
}

// ---------------------------------------------------------------- talking to the daemon
// One request, one answer, each a line of JSON. null if the daemon can't be reached.
export function ask(req: unknown, env: NodeJS.ProcessEnv = process.env, signal?: AbortSignal): Promise<unknown> {
  return new Promise((resolve) => {
    let buf = "", done = false;
    const end = (v: unknown) => { if (!done) { done = true; c.destroy(); resolve(v); } };
    const c = net.createConnection(sockPath(env));
    c.on("connect", () => c.write(JSON.stringify(req) + "\n"));
    c.on("data", (d) => { buf += d; const i = buf.indexOf("\n"); if (i >= 0) { try { end(JSON.parse(buf.slice(0, i))); } catch { end(null); } } });
    c.on("error", () => end(null));
    c.on("close", () => end(null));
    signal?.addEventListener("abort", () => end(null));
  });
}

// Make sure the daemon runs: its service installed (pointing at the deployed current, or at this
// copy) and started. What to tell the owner about it, if anything: once, as it starts, that it
// stops when they log out.
export async function ensureDaemon(env: NodeJS.ProcessEnv = process.env): Promise<{ ok: boolean; said: string }> {
  if (await ask({ op: "ping" }, env) !== null) return { ok: true, said: "" };
  install(env);
  platform.startService(unitName(env));
  for (let i = 0; i < 50; i++) {
    if (await ask({ op: "ping" }, env) !== null) {
      const said = platform.lingering() === false
        ? "the factory daemon runs while you're logged in here: logging out stops it and the lanes, and the next login brings them back"
        : "";
      return { ok: true, said };
    }
    await sleep(100);
  }
  return { ok: false, said: "couldn't start the factory daemon here: lanes run, but won't come back by themselves after the machine goes down" };
}

// The service's command: for a deployed copy (a stub picked it: FACTORY_SKILL_FROM=deploy), the
// deploy folder's current, so a restart is onto the newest; for a copy chosen by hand (a checkout,
// the tests), that copy, on the Node running now.
function serviceCmd(env: NodeJS.ProcessEnv): string[] {
  const cur = path.join(deployDir(env), "current");
  const node = path.join(cur, "node", "bin", "node"), main = path.join(cur, "wfactory", "runtime", "main.mjs");
  if (env.FACTORY_SKILL_FROM === "deploy" && fs.existsSync(main)) {
    try { fs.accessSync(node, fs.constants.X_OK); return [node, main, "daemon", "run"]; } catch {}
  }
  return [process.execPath, fs.realpathSync(new URL("../main.mjs", import.meta.url).pathname), "daemon", "run"];
}
const deployDir = (env: NodeJS.ProcessEnv) => env.FACTORY_DEPLOY || path.join(os.homedir(), ".local", "share", "wfactory");

export function install(env: NodeJS.ProcessEnv = process.env) {
  const pass: Record<string, string> = {};
  // Its own settings (a test's home and timings) and the deploy folder: what the service runs with.
  for (const k of Object.keys(env).filter((k) => k.startsWith("FACTORY_DAEMON_") || ["FACTORY_DEPLOY", "FACTORY_MEMINFO", "FACTORY_KERNEL_LOG"].includes(k)).sort()) if (env[k]) pass[k] = env[k]!;
  platform.installService(unitName(env), "wfactory: brings a factory's lanes back after the machine went down, and answers just fleet", serviceCmd(env), pass);
}

// ---------------------------------------------------------------- the daemon itself
async function run(env: NodeJS.ProcessEnv): Promise<number> {
  fs.mkdirSync(home(env), { recursive: true });
  // One per home; a second one started meanwhile leaves.
  let lock: number | null = null;
  try { lock = tryLock(path.join(home(env), "daemon.lock")); } catch {}
  if (lock === null) { console.log("the daemon is already running"); return 0; }
  const TICK = num(env.FACTORY_DAEMON_TICK, 5), IDLE = num(env.FACTORY_DAEMON_IDLE, 120);
  const me = platform.managerId();
  const beatFile = path.join(home(env), "beat");
  let lastBeat = 0; try { lastBeat = Math.floor(fs.statSync(beatFile).mtimeMs / 1000); } catch {}
  const beat = () => { try { fs.writeFileSync(beatFile, ""); } catch {} };
  beat();
  journal(env, `started (pid ${process.pid}, ${fs.realpathSync(new URL("..", import.meta.url).pathname)})`);
  if (platform.lingering() === false) journal(env, "lingering is off: this stops when the user logs out, and the next login brings the lanes back");

  let clients = 0, busyAt = epoch();
  const conns = new Set<net.Socket>();
  const seen = new Set<string>(), ended = new Map<string, number>();
  const GRACE = num(env.FACTORY_DAEMON_GRACE, 120);
  const sock = sockPath(env);
  fs.rmSync(sock, { force: true });
  const server = net.createServer((c) => {
    clients++; busyAt = epoch(); conns.add(c);
    const ac = new AbortController();
    let buf = "";
    c.on("data", async (d) => {
      buf += d;
      const i = buf.indexOf("\n");
      if (i < 0) return;
      let req: { op?: string; lanes?: LaneAsk[]; seen?: LaneSeen[]; until?: number; machine?: MachineAsk } = {};
      try { req = JSON.parse(buf.slice(0, i)); } catch {}
      buf = "";
      let res: unknown = { error: `unknown op ${req.op}` };
      if (req.op === "ping") res = { ok: true, pid: process.pid, records: records(env).length };
      else if (req.op === "look" && Array.isArray(req.lanes)) res = { lanes: look(req.lanes, env), ...(req.machine ? { machine: lookMachine(req.machine) } : {}) };
      else if (req.op === "watch" && Array.isArray(req.lanes) && Array.isArray(req.seen))
        res = await watch({ lanes: req.lanes, seen: req.seen, until: Number(req.until) || epoch(), machine: req.machine }, 1, ac.signal, env);
      if (!c.destroyed) c.end(JSON.stringify(res) + "\n");
    });
    c.on("error", () => {});
    c.on("close", () => { clients--; busyAt = epoch(); conns.delete(c); ac.abort(); });
  });
  await new Promise<void>((res, rej) => { server.once("error", rej); server.listen(sock, () => res()); });

  // Stopped (a deploy's restart, a logout): at once. Whoever waits on it asks again, of the next.
  let stopping = false;
  const wake = new AbortController();
  for (const s of ["SIGTERM", "SIGINT"] as const) process.on(s, () => { stopping = true; wake.abort(); });

  await bringBack(env, me, lastBeat);

  while (!stopping) {
    beat();
    for (const r of records(env)) {
      if (r.manager !== me) continue;   // cut off, and not brought back (bringBack said why)
      if (platform.jobRunning(r.unit)) { seen.add(r.unit); ended.delete(r.unit); busyAt = epoch(); continue; }
      if (r.then === "start") { busyAt = epoch(); if (platform.jobState(r.unit) === "stopped") await startAgain(env, r); continue; }
      // A lane that stops by itself drops its own record, and `oversee.sh stop` drops it for one
      // stopped on purpose. One still here ended by a signal: a logout or a shutdown stops the
      // lanes before this daemon, so its record is kept a while (this daemon is stopped too within
      // it, and the next login brings the lane back). Past that, the machine stayed up: dropped.
      // (A start seconds ago may not show as running yet.)
      if (!seen.has(r.unit) && epoch() - r.started <= 30) continue;
      if (!ended.has(r.unit)) ended.set(r.unit, epoch());
      if (epoch() - ended.get(r.unit)! >= GRACE) {
        dropRecord(r.unit, env); seen.delete(r.unit); ended.delete(r.unit);
        journal(env, `${r.unit} ended (${platform.jobResult(r.unit) || "gone"}); its record is dropped`);
      }
      busyAt = epoch();
    }
    if (records(env).length === 0 && clients === 0 && epoch() - busyAt >= IDLE) { journal(env, "nothing to do: exiting"); break; }
    try { await sleep(TICK * 1000, undefined, { signal: wake.signal }); } catch {}
  }
  if (stopping) journal(env, "stopped");
  server.close();
  for (const c of conns) c.destroy();
  fs.rmSync(sock, { force: true });
  process.exit(0);
}

// After the machine went down (a record from another run of the service manager): bring each
// cut-off lane back with what's left of its time, unless it's too late or the machine keeps
// going down soon after a resume. (A deploy's restart, or a crash of the daemon alone, keeps the
// same run, so it brings nothing back: the lanes never stopped.)
export const QUICK_S = 30 * 60;
async function bringBack(env: NodeJS.ProcessEnv, me: string, lastBeat: number) {
  const cut = records(env).filter((r) => r.manager !== me);
  if (!cut.length) return;
  const down = lastBeat || epoch();
  for (const r of cut) {
    dropRecord(r.unit, env);
    const now = epoch();
    const stopAt = Number(cat(path.join(r.dir, "runs", ".stop-at")));
    const deadline = stopAt > 0 && stopAt < r.deadline ? stopAt : r.deadline;
    const name = r.loop ? `${path.basename(r.dir)} (${r.loop})` : path.basename(r.dir);
    // A timed last call is working time (units CI won't redo, and CI): the lane comes back for it.
    // The owner's (`just fleet last-call`) ends the night: it stays down.
    if (now >= deadline || fs.existsSync(path.join(r.dir, "runs", ".last-call"))) {
      const why = now >= deadline ? "its stop time has passed" : "the owner's last call (just fleet last-call) had begun";
      laneEvent(r.dir, "resume-skipped", `the machine went down while ${name} ran; not brought back: ${why}`, env);
      journal(env, `${r.unit}: not brought back (${why})`);
      continue;
    }
    const last = r.resumes[r.resumes.length - 1] ?? 0;
    const quick = last && down - last < QUICK_S ? r.quick + 1 : 0;
    if (quick >= 2) {
      laneEvent(r.dir, "resume-refused", `the machine went down within ${QUICK_S / 60} minutes of bringing ${name} back, twice running: not brought back again. Something it runs may be taking the machine down; read its last session's log before starting it`, env);
      journal(env, `${r.unit}: not brought back (the machine went down soon after the last two resumes)`);
      continue;
    }
    const left = Math.max(0.01, Math.round((deadline - now) / 36) / 100);
    const args = withHours(r.args, left);
    const vars: Record<string, string> = { ...r.env };
    // A lane on the deployed copy comes back on the newest one, as `fleet start` would start it.
    if (vars.FACTORY_SKILL_FROM === "deploy") { delete vars.FACTORY_SKILL; delete vars.FACTORY_SKILL_FROM; }
    Object.assign(vars, await sessionVars(r.env, env));
    const lc = lastCallAt(r, deadline);
    vars.FACTORY_LAST_CALL_AT = `${lc} ${deadline}`;
    vars.FACTORY_RESUMED = JSON.stringify({ resumes: [...r.resumes, now].slice(-5), quick });
    // Not blocking: the start asks this daemon whether it runs.
    const s = await runIn(r.dir, ["factory/oversee.sh", "start", ...(r.loop ? [r.loop] : []), ...args], { ...vars, ...daemonVars(env) });
    if (s.status === 0) {
      laneEvent(r.dir, "resumed", `the machine went down while ${name} ran; brought back with ${left} hours left (until ${hmAt(deadline)})${inLastCall(lc)}`, env);
      journal(env, `${r.unit}: brought back (${left} hours left)`);
    } else {
      laneEvent(r.dir, "resume-failed", `the machine went down while ${name} ran, and starting it again failed (exit ${s.status}): ${(s.stdout + s.stderr).trim().split("\n").slice(-2).join(" ")}`, env);
      journal(env, `${r.unit}: bringing it back failed (exit ${s.status})`);
    }
  }
}
// A lane asked to pause so it could start again on the newest copy (oversee.ts restart): it has
// stopped, so start it, with what's left of its time, as `fleet start` would.
// Its record stays until then (dropped if it isn't started), so the lane reads as running meanwhile.
async function startAgain(env: NodeJS.ProcessEnv, r: LaneRecord) {
  const name = r.loop ? `${path.basename(r.dir)} (${r.loop})` : path.basename(r.dir);
  // Only after the pause it was asked for: one that stopped for its own reason (nothing left, a
  // usage stop, a crash) stays stopped, as any lane would, and fleet wait says so.
  const log = cat(path.join(r.dir, "runs", "loop.log")).split("\n");
  const last = log.slice(log.findLastIndex((l) => l.startsWith("==== ")) + 1).filter((l) => / loop: /.test(l)).pop() ?? "";
  if (!/ loop: (stopping: )?paused (at a good point|asap)/.test(last)) {
    dropRecord(r.unit, env);
    journal(env, `${r.unit}: stopped before its pause for a restart (${last.trim() || "no log"}); not started again`);
    return;
  }
  // The pause it was asked for is gone once it paused (the loop takes it): one there now is a new
  // one, the owner's, which outranks the restart.
  if (fs.existsSync(path.join(r.dir, "runs", ".pause"))) {
    dropRecord(r.unit, env);
    journal(env, `${r.unit}: paused for a restart, then asked to pause; not started again`);
    return;
  }
  const stopAt = Number(cat(path.join(r.dir, "runs", ".stop-at")));
  const deadline = stopAt > 0 && stopAt < r.deadline ? stopAt : r.deadline;
  const now = epoch();
  if (now >= deadline || fs.existsSync(path.join(r.dir, "runs", ".last-call"))) {
    dropRecord(r.unit, env);
    laneEvent(r.dir, "restart-failed", `${name} paused to restart on the newest runner, but ${now >= deadline ? "its stop time has passed" : "the owner's last call (just fleet last-call) has begun"}: not started again`, env);
    journal(env, `${r.unit}: paused for a restart, not started again (too late)`);
    return;
  }
  const left = Math.max(0.01, Math.round((deadline - now) / 36) / 100);
  // (Its record names the copy to start on: oversee.ts restart left the old one out.)
  const vars: Record<string, string> = { ...r.env, ...await sessionVars(r.env, env) };
  const lc = lastCallAt(r, deadline);
  vars.FACTORY_LAST_CALL_AT = `${lc} ${deadline}`;
  const s = await runIn(r.dir, ["factory/oversee.sh", "start", ...(r.loop ? [r.loop] : []), ...withHours(r.args, left)], { ...vars, ...daemonVars(env) });
  if (s.status === 0) {
    laneEvent(r.dir, "restarted", `${name} ran a copy of the skill from before restarts: it paused after its unit and started again on the newest runner, with ${left} hours left (until ${hmAt(deadline)})${inLastCall(lc)}`, env);
    journal(env, `${r.unit}: started again on the newest copy (${left} hours left)`);
    // It counts among the lanes its fleet restart asked, as a lane that restarted itself does
    // (loop.ts): the last of them tells the morning summary they all are.
    // (Where the loop puts them when it isn't told: loop.ts.)
    const locks = locksOf(r);
    if (r.restart && locks) {
      try {
        const rd = path.join(locks, `restart-${r.restart.id}`);
        fs.mkdirSync(rd, { recursive: true }); fs.writeFileSync(path.join(rd, `${path.basename(r.dir)}${r.loop ? `-${r.loop}` : ""}`), "");
        const n = fs.readdirSync(rd, { withFileTypes: true }).filter((e) => e.isFile()).length;
        const of = Number(r.restart.of) || 1;
        if (of > 1 && n >= of) { fs.mkdirSync(path.join(rd, "told")); laneEvent(r.dir, "restarted", `all ${of} restarted lanes on ${host(env)} are on the newest runner`, env); }
      } catch {}
    }
  } else {
    dropRecord(r.unit, env);
    laneEvent(r.dir, "restart-failed", `${name} paused to restart on the newest runner, and starting it again failed (exit ${s.status}): ${(s.stdout + s.stderr).trim().split("\n").slice(-2).join(" ")}`, env);
    journal(env, `${r.unit}: starting it again failed (exit ${s.status})`);
  }
}
function runIn(cwd: string, cmd: string[], env: Record<string, string>): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = "", stderr = "";
    const c = spawn(cmd[0], cmd.slice(1), { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    c.stdout.on("data", (d) => { stdout += d; }); c.stderr.on("data", (d) => { stderr += d; });
    c.on("error", (e) => resolve({ status: 127, stdout, stderr: stderr + String(e) }));
    c.on("close", (code) => resolve({ status: code ?? 1, stdout, stderr }));
  });
}
const cat = (f: string) => { try { return fs.readFileSync(f, "utf8").trim(); } catch { return ""; } };
const hmAt = (t: number) => { const d = new Date(t * 1000); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
// The machine's lock folder for the lane's factory, as the loop works it out (loop-start.ts).
function locksOf(r: LaneRecord) {
  let pname = "";
  try { const p = JSON.parse(fs.readFileSync(path.join(r.dir, "tracker", "project.json"), "utf8")); if (typeof p?.name === "string") pname = p.name; } catch {}
  return r.env.FACTORY_LOCKS || `${r.env.XDG_RUNTIME_DIR || "/tmp"}/factory-${pname || path.basename(r.dir)}`;
}
// When the lane's last call begins: the time its factory's lanes here last wrote for this stop
// time and its last_call (loop-clock.ts), else as its loop works it out: "last_call" minutes before the stop time,
// at most half its run. The lane brought back keeps its run's (FACTORY_LAST_CALL_AT), if that's
// earlier.
export function lastCallAt(r: LaneRecord, deadline: number) {
  const lcMin = lastCallOf(r);
  if (lcMin <= 0) return deadline;
  let w = lcMin * 60;
  const half = Math.trunc((deadline - r.started) / 2);
  if (half > 0 && w > half) w = half;
  const own = writtenLastCall(lastCallFile(locksOf(r)), deadline, lcMin) ?? deadline - w;
  // One brought back (or restarted) before carries its run's last call on, as its loop does.
  const [at, d] = (r.env.FACTORY_LAST_CALL_AT ?? "").split(" ");
  const carried = /^[0-9]+$/.test(at ?? "") && /^[0-9]+$/.test(d ?? "") && Math.abs(Number(d) - deadline) <= SAME_STOP_S ? Number(at) : 0;
  return carried > 0 && carried < own ? carried : own;
}
const inLastCall = (lc: number) => epoch() >= lc ? `, in its last call (since ${hmAt(lc)})` : "";
function lastCallOf(r: LaneRecord) {
  const i = r.args.indexOf("--last-call");
  if (i >= 0 && /^[0-9]+$/.test(r.args[i + 1] ?? "")) return Number(r.args[i + 1]);
  return settingOf(r, "last_call", 30);
}
// The lane's tracker/project.json whole-number setting, else its default (as loop-start.ts reads it).
function settingOf(r: LaneRecord, k: string, dflt: number) {
  try { const v = JSON.parse(fs.readFileSync(path.join(r.dir, "tracker", "project.json"), "utf8"))?.[k]; if (/^[0-9]+$/.test(String(v))) return Number(v); } catch {}
  return dflt;
}
function withHours(args: string[], hours: number) {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) { if (args[i] === "--hours") { i++; continue; } out.push(args[i]); }
  return ["--hours", String(hours), ...out];
}
// The daemon's own settings, which a lane it starts passes on to its record.
const daemonVars = (env: NodeJS.ProcessEnv) => Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith("FACTORY_DAEMON_")).map(([k, v]) => [k, v ?? ""]));
// After a login, the desktop session's display and bus come a little after the service manager:
// wait for the ones the lane had (up to 10 minutes), and take their values now.
async function sessionVars(had: Record<string, string>, env: NodeJS.ProcessEnv) {
  const want = ["DISPLAY", "WAYLAND_DISPLAY"].filter((k) => had[k]);
  const end = epoch() + num(env.FACTORY_DAEMON_SESSION_WAIT, 600);
  for (;;) {
    const s = platform.sessionEnv();
    if (want.every((k) => s[k]) || epoch() >= end) {
      return Object.fromEntries(["DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"].filter((k) => s[k]).map((k) => [k, s[k]]));
    }
    await sleep(5000);
  }
}

// ---------------------------------------------------------------- the command
export async function daemonCli(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const [cmd = ""] = args;
  if (asksHelp(args)) { console.log(HELP); return 0; }
  switch (cmd) {
    case "": case "-h": case "--help": console.log(HELP); return 0;
    case "run": return run(env);
    case "install": install(env); console.log(`installed ${unitName(env)}`); return 0;
    case "start": {
      const r = await ensureDaemon(env);
      console.log(r.ok ? `the daemon runs${r.said ? `; ${r.said}` : ""}` : r.said);
      return r.ok ? 0 : 1;
    }
    case "stop": platform.stopJobs(unitName(env)); console.log("the daemon is stopped (the lanes go on)"); return 0;
    case "status": {
      const p = await ask({ op: "ping" }, env) as { pid?: number } | null;
      console.log(p ? `running (pid ${p.pid})` : "not running");
      for (const r of records(env)) console.log(`  ${r.unit}: ${platform.jobRunning(r.unit) ? "running" : "not running"} in ${r.dir}${r.manager !== platform.managerId() ? " (cut off when the machine went down)" : ""}`);
      return 0;
    }
    case "redeployed": {
      // Only a daemon running from this deploy folder: a test's or a hand-chosen copy is left alone.
      const cmdNow = platform.serviceCmd(unitName(env));
      if (platform.jobRunning(unitName(env)) && cmdNow.startsWith(path.join(deployDir(env), "current") + path.sep)) {
        platform.restartService(unitName(env));
        console.log("restarted the factory daemon onto it");
      }
      return 0;
    }
    default: console.error(`daemon: unknown command ${cmd} (run | start | status | stop | redeployed | install)`); return 2;
  }
}
