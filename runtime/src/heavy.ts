// Heavy jobs share the machine: one memory budget that each reserves its share of, and N slots
// that jobs expected to run long take turns for. What each kind of job used and how long it ran
// is recorded, so its next run asks for what it needs and a job waiting behind it knows how long.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { machineGet } from "./machines.ts";
import { exitAs, host, hm, iec, lock, pwd, runFg, status, tryLock, unlock } from "./sys.ts";
import { machineOomSince, platform } from "./os.ts";

export const HELP = `
heavy.sh — the machine's heavy jobs: its memory budget, its heavy-job slots,
and how each job ended (\`just heavy\`).

Usage:
  just heavy                    what holds the budget and the slots, and what waits
  just heavy why [<name>]       how a job ended: finished, failed, crashed, killed at
                                its memory cap, or killed when the whole machine ran
                                out of memory (no name: the last few)
  just heavy reserve <name> <size> (--pid <pid> | --unit <unit>)
                                a standing reservation in the budget for something
                                that runs outside it (an editor), kept while that
                                process or systemd unit runs
  just heavy release <name>     that reservation given back now
  heavy.sh <what> -- <command…> run a command once the budget and a slot let it
                                (<what> can't be status or why; reserve or release
                                only with the --)

\`just capped\` and \`just long start\` run their command through this.
So do the loop's own heavy commands (the landing check, the tracker's probes at
a settle or a refresh), for memory only: they never wait for a slot. A
\`just capped\` inside one takes its own share too, for memory only, beside the
loop's: it doesn't wait on the loop's own.

The budget: the machine's memory, less a reserve for the desktop (the Reserve
column in docs/machines.md, default 3G) and for what no job's cap counts (GPU
buffers: the GPU column, measured, default 0). Each heavy job reserves its
share before it starts, and waits while the reservations would pass the
budget, or while the memory available now is under the reserve, whatever the
reservations say. Its share: --mem or $FACTORY_MEM (for a long job, --mem or
$FACTORY_LONG_MEM) if given, else its last 3 peaks plus 20%, else 4G. A job's
cap is that share when given; else the larger of it and 8G. A job inside a
capped job (\`just capped\` in a long job's script) runs inside its parent's
cap and reservation and takes nothing more.

The slots: at most N jobs expected to run long (over $FACTORY_HEAVY_SHORT
seconds, default 300, or never timed yet) run at once; a job expected to be
short runs beside them if the budget has room. N: $FACTORY_HEAVY, else the
Heavy column in docs/machines.md, else 1. \`just capped\` (not inside a long or
capped job) doesn't wait for a slot that's due to be held for more than 8
minutes ($FACTORY_HEAVY_MAX_WAIT, seconds): it fails at once, saying what it's
queued behind, and the job goes to \`just long start\`. Nor does it wait longer
than that for anything else (a job whose time isn't known, memory).

A job's run time (when it exits 0) and peak (unless it was killed) are recorded by its command, per
project, in $FACTORY_JOBS_HOME (default ~/.local/state/wfactory/jobs);
how it ended in runs/jobs/<name>.json. The loop's landing check (\`just check\`)
is recorded the same, in a scope of its own without a cap; a \`just capped\`
inside it counts on its own. The tracker's probes aren't: they reserve 4G
unless a \`just capped\` run of the same command left a peak. The reservations, slots and waiting
jobs are files in $FACTORY_CPU_LOCKS (default $XDG_RUNTIME_DIR/factory-cpu).
A slot or reservation is given back when the command exits; \`just capped
--hold\` keeps the reservation until what the command left running (an
editor) has exited too.

A long-lived service started some other way (an editor the owner opened, a
service of its own) holds memory no job's reservation counts. \`just heavy
reserve editor 22G --pid <pid>\` (or \`--unit <its systemd unit>\`) counts it:
jobs wait for room beside it as beside any job. It's taken at once, without
waiting for room (the memory is in use already), and replaces one of the
same name in this project. It goes when the process or unit does, or at
\`just heavy release editor\`.

Run from the checkout's root (capped.sh and long.sh do).`;

const MiB = 1024 ** 2, GiB = 1024 ** 3;

// ---------------------------------------------------------------- sizes and places

// A systemd size (512M, 4G, 1.5G, 1073741824) in bytes; null if it isn't one.
export function bytes(s: string | undefined): number | null {
  const m = /^([0-9]+(?:\.[0-9]+)?)([KMGT]?)$/.exec((s ?? "").trim());
  if (!m) return null;
  return Math.round(Number(m[1]) * 1024 ** " KMGT".indexOf(m[2] || " "));
}
// A cap systemd takes besides a size: a share of the machine's memory (50%), or none (infinity).
export const capOk = (s: string) => {
  const p = /^([0-9]+(\.[0-9]{1,2})?)%$/.exec(s.trim());
  return bytes(s) !== null || s.trim() === "infinity" || (p !== null && Number(p[1]) <= 100);
};
// Bytes as a size systemd takes, rounded up to whole MiB.
export const sizeArg = (n: number) => n % GiB === 0 ? `${n / GiB}G` : `${Math.ceil(n / MiB)}M`;

const dir = (env: NodeJS.ProcessEnv) => {
  const d = env.FACTORY_CPU_LOCKS || `${env.XDG_RUNTIME_DIR || `/tmp/factory-${os.userInfo().uid}`}/factory-cpu`;
  fs.mkdirSync(d, { recursive: true });
  return d;
};
const jobsHome = (env: NodeJS.ProcessEnv) =>
  env.FACTORY_JOBS_HOME || path.join(env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "wfactory", "jobs");
// The project, the same in each of its lanes' clones (<checkout>-lane<N>).
const project = (env: NodeJS.ProcessEnv) => path.basename(pwd(env)).replace(/-lane[0-9]+$/, "");
const lane = (env: NodeJS.ProcessEnv) => path.basename(pwd(env));
const readJson = <T>(f: string): T | null => { try { return JSON.parse(fs.readFileSync(f, "utf8")) as T; } catch { return null; } };
const writeJson = (f: string, v: unknown) => { fs.writeFileSync(`${f}.${process.pid}.tmp`, JSON.stringify(v) + "\n"); fs.renameSync(`${f}.${process.pid}.tmp`, f); };
const alive = (pid: number) => { if (!(pid > 0)) return false; try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } };
const mins = (s: number) => Math.max(1, Math.round(s / 60));

// ---------------------------------------------------------------- what each kind of job used

// Per project and command: its last 3 peaks (bytes) and run times (seconds, of runs that exited 0).
interface Seen { peaks: number[]; secs: number[] }
type History = Record<string, Seen>;
const keyOf = (env: NodeJS.ProcessEnv, cmd: string, proj = project(env)) => `${proj}\t${cmd}`;

// What's recorded of a command: this project's, or another's (a job of another factory on the machine).
export function seen(cmd: string, env: NodeJS.ProcessEnv = process.env, proj?: string): Seen {
  return readJson<History>(path.join(jobsHome(env), "history.json"))?.[keyOf(env, cmd, proj)] ?? { peaks: [], secs: [] };
}
export function recordRun(cmd: string, o: { peak?: number; secs?: number }, env: NodeJS.ProcessEnv = process.env) {
  if (!(o.peak! > 0) && o.secs === undefined) return;
  try {
    const d = jobsHome(env);
    fs.mkdirSync(d, { recursive: true });
    const fd = lock(path.join(d, "history.lock"));
    try {
      const f = path.join(d, "history.json"), h = readJson<History>(f) ?? {};
      const s = h[keyOf(env, cmd)] ??= { peaks: [], secs: [] };
      if (o.peak! > 0) s.peaks = [...s.peaks, o.peak!].slice(-3);
      if (o.secs !== undefined) s.secs = [...s.secs, Math.round(o.secs)].slice(-3);
      writeJson(f, h);
    } finally { unlock(fd); }
  } catch {}
}
// How long a run of this command is expected to take (the longest of its last 3), in seconds;
// null if it hasn't finished one yet.
export const expected = (cmd: string, env: NodeJS.ProcessEnv = process.env, proj?: string) => { const s = seen(cmd, env, proj).secs; return s.length ? Math.max(...s) : null; };
// What a run of this command reserves when it doesn't say: its last 3 peaks plus 20%, else 4G.
export function request(cmd: string, env: NodeJS.ProcessEnv = process.env) {
  const p = seen(cmd, env).peaks;
  return p.length ? Math.ceil(Math.max(...p) * 1.2 / MiB) * MiB : 4 * GiB;
}
// A job's reservation and cap: the size it was given (--mem, or a variable), else its request,
// with the cap at least 8G (a job's first runs aren't killed at a guess).
// (A share of the machine reserves that share; infinity, what it would without a size.)
export function sizes(cmd: string, given: string | undefined, env: NodeJS.ProcessEnv = process.env) {
  const g = bytes(given), r = request(cmd, env);
  if (g !== null) return { reserve: g, cap: given!.trim() };
  const pct = /^([0-9.]+)%$/.exec(given?.trim() ?? "");
  if (pct) return { reserve: Math.ceil(platform.memory().total * Number(pct[1]) / 100), cap: given!.trim() };
  if (given?.trim() === "infinity") return { reserve: r, cap: "infinity" };
  return { reserve: r, cap: sizeArg(Math.max(r, 8 * GiB)) };
}

// ---------------------------------------------------------------- the machine's budget

// A machine's reserve, from its row in docs/machines.md: memory kept back for the desktop (Reserve,
// 3G if it says none) and the GPU's share (GPU). Also the floor under which the overseer hears the
// machine is short of memory (fleet wait's memory-low).
export function reserveOf(name: string, file?: string) {
  // (Written by hand, so 6g is taken as 6G.)
  const col = (c: "reserve" | "gpu") => bytes((machineGet(name, c, file) || "").toUpperCase());
  const desk = col("reserve") ?? 3 * GiB, gpu = col("gpu") ?? 0;
  return { desk, gpu, reserve: desk + gpu };
}
export function budget(env: NodeJS.ProcessEnv = process.env) {
  const m = platform.memory();
  const { desk, gpu, reserve } = reserveOf(host(env));
  // (Unreadable, nothing is available: no heavy job starts on a guess.)
  return { total: m.total, available: m.available ?? 0, desk, gpu, reserve, budget: Math.max(0, m.total - reserve) };
}
function slotCount(env: NodeJS.ProcessEnv) {
  const n = env.FACTORY_HEAVY || machineGet(host(env), "heavy") || "";
  return /^[1-9][0-9]*$/.test(n) ? Number(n) : 1;
}

// A reservation: res-<id>.json. Held while its process (pid) runs; with hold, while its capped
// run (scope) does, whatever it left there included.
// A standing one (heavy reserve): held while its process (pid) or systemd unit runs.
interface Res { id: string; what: string; cmd: string; project: string; lane: string; root: string; name: string; mem: number; cap?: string; pid: number; scope?: string; hold?: boolean; slot?: boolean; since: number; standing?: boolean; unit?: string }
// A job waiting its turn: wait-<pid>.json.
interface Waiting { what: string; lane: string; mem: number; since: number; why: string; pid: number }
// A slot's holder: slot-<i>.json.
interface Who { what: string; cmd: string; project: string; lane: string; since: number }

// Whether a capped run's scope still holds a process. Its state lags: systemd takes a moment to
// see a scope go empty, so the processes in its group say.
async function holdsProcesses(scope: string) {
  for (let i = 0; i < 20; i++) {
    if (!platform.cappedRunning(scope)) return false;
    const g = platform.cappedGroup(scope);
    const procs = g ? platform.groupProcesses(g) : null;
    if (procs?.length) return true;
    if (procs === null && i >= 10) return true;   // (its group can't be read: take systemd's word)
    await sleep(100);
  }
  return false;
}

// (A standing one's unit is dropped only when systemd says it has stopped: it lasts days, and one
// failed look would let jobs start into the editor's memory.)
const live = (r: Res) => r.standing && r.unit ? platform.unitRunning(r.unit) !== false
  : r.hold && r.scope ? alive(r.pid) || platform.cappedRunning(r.scope) : alive(r.pid);

// The reservations held now. One whose job is gone is dropped, and a held one's end recorded
// (what its run left behind has exited, so how it ended is systemd's to say).
export function reservations(env: NodeJS.ProcessEnv = process.env): Res[] {
  const d = dir(env), out: Res[] = [];
  for (const f of fs.readdirSync(d).filter((f) => /^res-.*\.json$/.test(f))) {
    const r = readJson<Res>(path.join(d, f));
    if (r && live(r)) { out.push(r); continue; }
    fs.rmSync(path.join(d, f), { force: true });
    if (r?.hold && r.scope) {
      // A held run's scope is stopped whole at a kill (no OOMPolicy=continue), so systemd's verdict
      // says one happened; the kernel's log, whether it was the machine's.
      // (The kernel's log around its end: a hold can last hours, and another kill then isn't this one's.)
      const over = platform.cappedOverCap(r.scope), end = platform.cappedEnded(r.scope) || Date.now();
      const machine = over ? machineOomSince(Math.max(r.since, end - 120000)) : null;
      writeEnded(r.root, r.name, { what: r.what, cmd: r.cmd, start: r.since, end, cap: r.cap ?? sizeArg(r.mem), held: true,
        reason: over ? machine ? "machine" : "oom" : "left-ended" });
      platform.forgetCapped(r.scope);
    }
  }
  return out.sort((a, b) => a.since - b.since);
}
const waiting = (env: NodeJS.ProcessEnv): Waiting[] => {
  const d = dir(env), out: Waiting[] = [];
  for (const f of fs.readdirSync(d).filter((f) => /^wait-.*\.json$/.test(f))) {
    const w = readJson<Waiting>(path.join(d, f));
    if (w && alive(w.pid)) out.push(w); else fs.rmSync(path.join(d, f), { force: true });
  }
  return out.sort((a, b) => a.since - b.since);
};
// The slots' holders now (a slot's lock is free once its holder has exited, whatever its file says).
function holders(env: NodeJS.ProcessEnv): Who[] {
  const d = dir(env), out: Who[] = [];
  for (let i = 1; i <= slotCount(env); i++) {
    const fd = tryLock(path.join(d, `slot-${i}.lock`));
    if (fd !== null) { unlock(fd); continue; }
    const w = readJson<Who>(path.join(d, `slot-${i}.json`));
    out.push(w ?? { what: "another job", cmd: "", project: "", lane: "", since: Date.now() });
  }
  return out;
}

// How long a job has left, in seconds, as its own past runs (its project's) say; null if they
// don't, or it has run past them already.
export const left = (w: { cmd: string; since: number; project?: string }, env: NodeJS.ProcessEnv = process.env, now = Date.now()) => {
  const e = expected(w.cmd, env, w.project || undefined);
  const l = e === null ? -1 : e - (now - w.since) / 1000;
  return l < 0 ? null : l;
};
const leftText = (w: { cmd: string; since: number; project?: string }, env: NodeJS.ProcessEnv) => {
  const l = left(w, env);
  return l === null ? `running ${Math.floor((Date.now() - w.since) / 60000)} min, time left unknown` : `about ${mins(l)} min left`;
};
const whoText = (w: Who, env: NodeJS.ProcessEnv) => `${w.what} (${w.lane ? `${w.lane}, ` : ""}${leftText(w, env)})`;

// ---------------------------------------------------------------- taking a turn

export interface Turn {
  id: string;                 // its reservation's
  slot: number | null;        // the slot's lock, if it took one
  give(): void;               // the reservation and the slot back
  // The slot back, the reservation kept while the capped run lasts; false if it has ended already.
  hold(scope: string): Promise<boolean>;
}
export interface TurnOpts {
  what: string;               // what a job waiting behind it is told
  cmd: string;                // its command, which its history is kept by
  name?: string;              // what `just heavy why` knows it by
  mem: number;                // bytes to reserve
  cap?: string;               // its cap, for a held run's record
  failAfter?: number;         // seconds: a wait for a slot due to last longer fails at once, and
                              // any wait fails once it has lasted that long
  queueFile?: string;         // where to say, while it waits, what it waits for
  memoryOnly?: boolean;       // no slot, however long it's expected to run
  beside?: string;            // a reservation it runs inside (the loop's, around its check), not
                              // waited on: it fits if it would without that one
}

// Wait until the budget has room for <mem> and, for a job not known to be short, a slot is
// free; then hold both. A string instead when the slot would be held past failAfter: what it's
// queued behind.
export async function takeTurn(o: TurnOpts, env: NodeJS.ProcessEnv = process.env): Promise<Turn | string> {
  const d = dir(env);
  const e = expected(o.cmd, env);
  const needSlot = !o.memoryOnly && (e === null || e > Number(env.FACTORY_HEAVY_SHORT || 300));
  const id = `${process.pid}-${Math.floor(Math.random() * 1e9)}`;
  const resFile = path.join(d, `res-${id}.json`), waitFile = path.join(d, `wait-${process.pid}.json`);
  const t0 = Date.now();
  let said = "";
  for (;;) {
    let why = "";
    const fd = lock(path.join(d, "budget.lock"));
    try {
      const b = budget(env), held = reservations(env).filter((r) => r.id !== o.beside);
      const used = held.reduce((s, r) => s + r.mem, 0);
      // A job bigger than the whole budget runs alone, rather than never.
      const fits = used + o.mem <= b.budget || held.length === 0;
      let slot: number | null = null;
      if (b.available < b.reserve) why = `memory: ${iec(b.available)} available, under the reserve of ${iec(b.reserve)} (docs/machines.md, Reserve and GPU)`;
      else if (!fits) why = `memory: needs ${iec(o.mem)}, and ${iec(Math.max(0, b.budget - used))} of the budget's ${iec(b.budget)} is free; held by ${held.map((r) => `${r.what} (${iec(r.mem)}${r.standing ? `, ${whileText(r)}` : r.hold && !alive(r.pid) ? ", until what it left exits" : ""})`).join("; ")}`;
      else if (needSlot) {
        for (let i = 1; i <= slotCount(env) && slot === null; i++) {
          slot = tryLock(path.join(d, `slot-${i}.lock`));
          if (slot !== null) writeJson(path.join(d, `slot-${i}.json`), { what: o.what, cmd: o.cmd, project: project(env), lane: lane(env), since: Date.now() } satisfies Who);
        }
        if (slot === null) {
          const hs = holders(env);
          const ls = hs.map((h) => left(h, env));
          // Due to be held past failAfter: every holder's time is known, and the soonest is past it.
          if (o.failAfter !== undefined && ls.every((l) => l !== null) && Math.min(...ls as number[]) > o.failAfter) {
            const h = hs[ls.indexOf(Math.min(...ls as number[]))];
            fs.rmSync(waitFile, { force: true });
            if (o.queueFile) fs.rmSync(o.queueFile, { force: true });
            return `queued behind ${h.what}${h.lane ? ` (${h.lane})` : ""}, about ${mins(ls[hs.indexOf(h)]!)} min left; use \`just long start\``;
          }
          why = `waiting for the CPU: queued behind ${hs.map((h) => whoText(h, env)).join("; ")}. ${slotCount(env)} long heavy job(s) at a time on this machine (docs/machines.md, Heavy)`;
        }
      }
      if (!why) {
        writeJson(resFile, { id, what: o.what, cmd: o.cmd, project: project(env), lane: lane(env), root: pwd(env), name: o.name ?? "", mem: o.mem, cap: o.cap, pid: process.pid, slot: slot !== null, since: Date.now() } satisfies Res);
        fs.rmSync(waitFile, { force: true });
        if (o.queueFile) fs.rmSync(o.queueFile, { force: true });
        if (said) process.stderr.write(`heavy: its turn after ${Math.floor((Date.now() - t0) / 60000)} min; starting\n`);
        const give = () => { fs.rmSync(resFile, { force: true }); if (slot !== null) unlock(slot); };
        return {
          id, slot, give,
          async hold(scope) {
            if (slot !== null) unlock(slot);
            if (!await holdsProcesses(scope)) { fs.rmSync(resFile, { force: true }); return false; }
            const r = readJson<Res>(resFile);
            if (r) writeJson(resFile, { ...r, pid: 0, scope, hold: true, slot: false });
            return true;
          },
        };
      }
    } finally { unlock(fd); }
    // Waited as long as it may (behind a job whose time isn't known, or for memory).
    if (o.failAfter !== undefined && Date.now() - t0 >= o.failAfter * 1000) {
      fs.rmSync(waitFile, { force: true });
      if (o.queueFile) fs.rmSync(o.queueFile, { force: true });
      const s = Math.round((Date.now() - t0) / 1000);
      return `queued ${s < 60 ? `${s} s` : `${mins(s)} min`} and still waiting (${why}); use \`just long start\``;
    }
    writeJson(waitFile, { what: o.what, lane: lane(env), mem: o.mem, since: t0, why, pid: process.pid } satisfies Waiting);
    if (o.queueFile) fs.writeFileSync(o.queueFile, `${why}\n`);
    // Said once, and again when what it waits on changes.
    const gist = why.replace(/[0-9.]+G|about [0-9]+ min|running [0-9]+ min/g, "");
    if (gist !== said) { process.stderr.write(`heavy: ${why}. It starts when there's room.\n`); said = gist; }
    await sleep(Number(env.FACTORY_HEAVY_POLL || 2) * 1000);
  }
}

// The loop's own heavy commands (the landing check, the tracker's probes): a turn in the budget for
// the largest of their commands' requests, given back after. Memory only: a lane doesn't wait hours
// behind a long job holding the machine's only slot. What runs in it gets env: a \`just capped\`
// there takes its own turn beside this one, not waiting on it (capped.ts). null for no command,
// or inside a heavy job already.
// The landing check's peak is recorded where the loop runs it (capped.ts, measured). The tracker's
// probes stay at the default (4G, unless a \`just capped\` run of the same command left a peak): the
// settle's runs inside the loop's own process (tr.ts), so what it used can't be told from the
// loop's, and refresh runs many probes in one process, whose peak would be put on each (#116).
export interface MemTurn { env: Record<string, string>; give(): void }
export async function memoryTurn(what: string, cmds: string[], env: NodeJS.ProcessEnv = process.env): Promise<MemTurn | null> {
  if (!cmds.length || env.FACTORY_HEAVY_HELD) return null;
  const sized = cmds.map((c) => ({ c, mem: request(c, env) })).sort((x, y) => y.mem - x.mem);
  const turn = await takeTurn({ what, cmd: sized[0].c, mem: sized[0].mem, memoryOnly: true }, env) as Turn;
  return { env: { FACTORY_HEAVY_HELD: "1", FACTORY_HEAVY_RES: turn.id }, give: turn.give };
}

// ---------------------------------------------------------------- standing reservations

// A standing reservation's file: per project and name, so another factory's "editor" is its own.
// (+ is in neither, so project foo's "bar-x" isn't project foo-bar's "x".)
const standingFile = (env: NodeJS.ProcessEnv, name: string) =>
  path.join(dir(env), `res-standing-${project(env).replace(/[^A-Za-z0-9_.-]+/g, "_")}+${name}.json`);
const whileText = (r: Res) => r.unit ? `while ${r.unit} runs` : `while pid ${r.pid} runs`;

// Reserve <mem> for something running outside the budget (an editor) while its process or unit
// runs. Taken at once, room or not: the memory is in use already. An error's text, else null.
export function reserve(name: string, mem: string, on: { pid?: number; unit?: string }, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) return `a name of letters, digits, . _ and - only: ${name}`;
  const m = bytes(mem.toUpperCase());
  if (m === null || m <= 0) return `not a size (512M, 4G, 1.5G): ${mem}`;
  if ((on.pid === undefined) === (on.unit === undefined)) return "say what it's tied to: --pid <pid> or --unit <unit>";
  if (on.pid !== undefined && !alive(on.pid)) return `no process ${on.pid} is running`;
  if (on.unit !== undefined && platform.unitRunning(on.unit) !== true) return `${on.unit} isn't running (${platform.unitStatusHint(on.unit)})`;
  const fd = lock(path.join(dir(env), "budget.lock"));
  try {
    const f = standingFile(env, name), id = path.basename(f).slice(4, -5);
    writeJson(f, { id, what: `${name}, a standing reservation`, cmd: "", project: project(env), lane: lane(env), root: pwd(env), name,
      mem: m, pid: on.pid ?? 0, standing: true, unit: on.unit, since: Date.now() } satisfies Res);
  } finally { unlock(fd); }
  return null;
}
// Give a standing reservation back now; false if this project holds none by that name.
export function release(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) return false;
  const fd = lock(path.join(dir(env), "budget.lock"));
  try {
    const f = standingFile(env, name), had = fs.existsSync(f);
    fs.rmSync(f, { force: true });
    return had;
  } finally { unlock(fd); }
}

// ---------------------------------------------------------------- how jobs ended

// runs/jobs/<name>.json in the job's checkout.
export type Reason = "ok" | "exit" | "signal" | "oom" | "machine" | "stopped" | "left-ended";
export interface Ended { what: string; cmd: string; start: number; end: number; reason: Reason; rc?: number; cap?: string; peak?: number; held?: boolean }

export function writeEnded(root: string, name: string, e: Ended) {
  if (!name) return;
  try {
    const d = path.join(root, "runs", "jobs");
    fs.mkdirSync(d, { recursive: true });
    writeJson(path.join(d, `${name}.json`), e);
  } catch {}
}
// The name a capped run is known by when it isn't given one: its command's first word, as a
// file name (\`just capped uv run x.py\` is "uv").
export const nameOf = (cmd: string[]) => path.basename(cmd[0] ?? "job").replace(/\.[a-z]+$/, "").replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 40) || "job";

// How a job's command ended, from its exit status and what its group's kernel counts said.
export function reasonOf(rc: number, killed: boolean, overCap: boolean): Reason {
  if (killed) return overCap ? "oom" : "machine";
  if (rc === 0) return "ok";
  return rc > 128 ? "signal" : "exit";
}

export function endedText(name: string, e: Ended): string {
  const peak = e.peak ? `, peak ${iec(e.peak)}` : "";
  const when = `${hm(new Date(e.end))}, after ${mins((e.end - e.start) / 1000)} min`;
  const sig = (n: number) => Object.entries(os.constants.signals).find(([, v]) => v === n - 128)?.[0] ?? `signal ${n - 128}`;
  switch (e.reason) {
    case "ok": return `${name}: finished (exit 0) at ${when}${peak}`;
    case "exit": return `${name}: failed, exited ${e.rc} at ${when}${peak}: its own failure, not memory`;
    case "signal": return `${name}: crashed, ended by ${sig(e.rc!)} (exit ${e.rc}) at ${when}${peak}; not out of memory`;
    case "oom": return `${name}: killed at its memory cap (${e.cap}${peak}) at ${when}`;
    case "machine": return `${name}: killed when the whole machine ran out of memory (not at its cap of ${e.cap}${peak}) at ${when}`;
    case "stopped": return `${name}: stopped at ${when} (just long stop, or its session ended)`;
    case "left-ended": return `${name}: what it left running (held until it exited) had ended by ${when}`;
  }
}

// ---------------------------------------------------------------- status

const resText = (r: Res, env: NodeJS.ProcessEnv) =>
  `  ${iec(r.mem).padStart(6)}  ${r.what} (${r.lane}, since ${hm(new Date(r.since))}${r.standing ? `, ${whileText(r)}, or until \`just heavy release ${r.name}\``
    : r.hold && !alive(r.pid) ? ", held until what it left running exits" : `, ${leftText(r, env)}`})`;

// What holds the machine's budget and slots, and what waits: \`just heavy\`, and below \`just long list\`.
export function statusLines(env: NodeJS.ProcessEnv = process.env): string[] {
  const d = dir(env);
  const fd = lock(path.join(d, "budget.lock"));
  let held: Res[], ws: Waiting[], hs: Who[];
  try { held = reservations(env); ws = waiting(env); hs = holders(env); } finally { unlock(fd); }
  const b = budget(env), used = held.reduce((s, r) => s + r.mem, 0);
  const out = [`memory on ${host(env)}: ${iec(b.total)}, less a reserve of ${iec(b.reserve)} (desktop ${iec(b.desk)}, GPU ${iec(b.gpu)}): a budget of ${iec(b.budget)}, ${iec(used)} held, ${iec(Math.max(0, b.budget - used))} free; ${iec(b.available)} available now${b.available < b.reserve ? ", under the reserve: no heavy job starts" : ""}`];
  out.push(held.length ? "held by:" : "held by: nothing");
  for (const r of held) out.push(resText(r, env));
  out.push(`heavy slots (${slotCount(env)}, for jobs expected to run long): ${hs.length ? hs.map((h) => whoText(h, env)).join("; ") : "free"}`);
  if (ws.length) out.push("waiting:");
  for (const w of ws) out.push(`  ${iec(w.mem).padStart(6)}  ${w.what} (${w.lane}, since ${hm(new Date(w.since))}): ${w.why}`);
  return out;
}

// The machine's memory for the overseer's beat (\`heavy brief\`, one line of JSON): available now
// (null if it can't be read), and what holds the budget, biggest first.
export function brief(env: NodeJS.ProcessEnv = process.env) {
  const fd = lock(path.join(dir(env), "budget.lock"));
  let held: Res[];
  try { held = reservations(env); } finally { unlock(fd); }
  return { available: platform.memory().available, held: held.map((r) => ({ what: r.name || r.what, mem: r.mem })).sort((a, b) => b.mem - a.mem) };
}

export async function heavyCli(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (args[0] === "-h" || args[0] === "--help") { console.log(HELP); return 0; }
  if (args.length === 0 || args[0] === "status") { console.log(statusLines(env).join("\n")); return 0; }
  if (args[0] === "brief") { console.log(JSON.stringify(brief(env))); return 0; }
  if (args[0] === "reserve" && args[1] !== "--") {
    const [, name, mem, flag, val, ...more] = args;
    const usage = "usage: just heavy reserve <name> <size> (--pid <pid> | --unit <unit>)";
    if (!name || !mem || !flag || !val || more.length || (flag !== "--pid" && flag !== "--unit")) { console.error(usage); return 2; }
    if (flag === "--pid" && !/^[1-9][0-9]*$/.test(val)) { console.error(`heavy: not a pid: ${val}`); return 2; }
    const err = reserve(name, mem, flag === "--pid" ? { pid: Number(val) } : { unit: val }, env);
    if (err) { console.error(`heavy: ${err}`); return err.startsWith("say what") ? 2 : 1; }
    console.log(`heavy: ${sizeArg(bytes(mem.toUpperCase())!)} reserved for ${name}, ${flag === "--pid" ? `while pid ${val} runs` : `while ${val} runs`}`);
    return 0;
  }
  if (args[0] === "release" && args[1] !== "--") {
    if (!args[1] || args.length > 2) { console.error("usage: just heavy release <name>"); return 2; }
    if (!release(args[1], env)) { console.error(`heavy: no standing reservation named ${args[1]} here (just heavy)`); return 1; }
    console.log(`heavy: ${args[1]}'s reservation given back`);
    return 0;
  }
  if (args[0] === "why") {
    const lk = lock(path.join(dir(env), "budget.lock"));
    let held: Res[];
    try { held = reservations(env); } finally { unlock(lk); }   // (a held run that has ended gets its record)
    const d = path.join(pwd(env), "runs", "jobs");
    let names = args[1] ? [args[1]] : [];
    if (!names.length) {
      try { names = fs.readdirSync(d).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)); } catch {}
      names = names.sort((a, b) => (readJson<Ended>(path.join(d, `${b}.json`))?.end ?? 0) - (readJson<Ended>(path.join(d, `${a}.json`))?.end ?? 0)).slice(0, 10);
      if (!names.length) { console.log("no job has ended here yet"); return 0; }
    }
    let rc = 0;
    for (const n of names) {
      const e = readJson<Ended>(path.join(d, `${n}.json`));
      const running = held.find((r) => r.name === n && r.root === pwd(env));
      if (running) console.log(`${n}: running (${running.what}, since ${hm(new Date(running.since))})`);
      else if (e) console.log(endedText(n, e));
      else { console.log(`${n}: no record of a job by that name here (just heavy why, for the last few)`); rc = 1; }
    }
    return rc;
  }
  const [what, ...rest] = args;
  const cmd = rest[0] === "--" ? rest.slice(1) : rest;
  if (what === undefined || !cmd.length) { console.error("usage: heavy.sh <what> -- <command…> | heavy.sh [status] | heavy.sh why [<name>] | heavy.sh reserve <name> <size> (--pid <pid> | --unit <unit>) | heavy.sh release <name>"); return 2; }
  // Already in a heavy job: it has its turn.
  if (env.FACTORY_HEAVY_HELD) exitAs(await runFg(cmd, { env }));
  const key = cmd.join(" ");
  const turn = await takeTurn({ what, cmd: key, mem: sizes(key, env.FACTORY_MEM, env).reserve }, env);
  if (typeof turn === "string") { console.error(`heavy: ${turn}`); return 75; }
  const t = Date.now();
  const rc = status(await runFg(cmd, { env: { ...env, FACTORY_HEAVY_HELD: "1" } }));
  turn.give();
  if (rc === 0) recordRun(key, { secs: (Date.now() - t) / 1000 }, env);
  return rc;
}
