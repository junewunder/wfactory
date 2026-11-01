// One headless session for the loop, and what its transcript says. Kept apart so a test can
// drive it with a fake `claude` (session.sh's mem_snap runs memSnap through main.mjs).
import fs from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { epoch, iec, status } from "./sys.ts";
import { platform } from "./os.ts";

const p2 = (n: number) => String(n).padStart(2, "0");
export const hms = (d = new Date()) => `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
export const log = (s: string) => { process.stderr.write(`${hms()} loop: ${s}\n`); };
const read = (f: string) => { try { return fs.readFileSync(f, "utf8"); } catch { return null; } };

// The lane's stop time: <deadline>, or runs/.stop-at if the overseer set an earlier one.
export function stopTime(deadline: number): number {
  const s = (read("runs/.stop-at") ?? "").replace(/\n+$/, "");
  return /^[0-9]+$/.test(s) && Number(s) < deadline ? Number(s) : deadline;
}

export interface SessionOpts {
  out: string;            // its stream-json transcript
  err: string;            // its stderr
  scope: string;          // its scope's unit (without .scope), or "" if it has none
  cmd: string[];
  stdin?: string;         // a file it reads on stdin (none: no stdin)
  env: NodeJS.ProcessEnv;
  stopFile?: string;      // "pause asap": the session is stopped at once when this appears
  deadline?: number;      // the lane's stop time (epoch seconds; runs/.stop-at if earlier)
  tick?: () => boolean | Promise<boolean>;   // called at every poll; false stops the session
  tickWhy?: string;       // what the log says when the tick stops it (else: the wrap-up time is over)
  silent?: number;        // seconds of a silent stream, with no tool call open, that end it (0 or none: never)
}
export interface Ended {
  rc: number;             // the command's exit status
  // 0 ran to its end; 1 stopped after its result; 2 pause asap; 3 past the stop time; 4 its tick said so;
  // 5 its stream went silent
  stopped: 0 | 1 | 2 | 3 | 4 | 5;
  end: number;            // when it ended (epoch seconds)
}
// While a session runs: so the loop's signal handling can stop it.
export interface Running { child: ChildProcess; scope: string }

// A session is done once its stream-json `result` line is written. `claude -p` can still sit
// there afterwards, waiting on a child it started (an editor kept its pipe open in
// a lane). So once the result is in, give the process FACTORY_RESULT_GRACE seconds
// (default 60) to exit, then stop it: the session's scope if it has one (anything left in it
// goes too), else the process. A child that runs in its own scope is left running. A session
// still running FACTORY_OVERRUN seconds (default 1200) after the stop time is stopped the same
// way: `just long wait` told it to wrap up 15 minutes before. One whose stream has had nothing
// new for <silent> seconds, with no tool call open (a `tool_use` with no `tool_result` yet), is
// stopped too: 21 Oct, a session sat silent for 1 h 22 min holding its lane and its unit. Not "a
// child still running": the CLI always keeps its MCP servers running. A long Bash call (a
// two-hour `just capped`) keeps its tool call open, so it's never ended for its silence. The
// silence is timed on the loop's clock, from the poll that last saw the stream grow.
// With a scope, each poll that finds its processes holding a quarter of its cap or more writes
// what uses the memory to <out>.mem (memSnap), so an out-of-memory kill leaves a record of the
// processes just before it; a kill the kernel counted in the scope leaves <out>.mem.oom, and
// the polls after it take no more snapshots.
export async function runSession(o: SessionOpts, running: (r: Running | null) => void): Promise<Ended> {
  const env = o.env;
  const grace = Number(env.FACTORY_RESULT_GRACE || 60), poll = Number(env.FACTORY_POLL || 5) * 1000;
  const overrun = Number(env.FACTORY_OVERRUN || 1200);
  const out = fs.openSync(o.out, "w"), err = fs.openSync(o.err, "w");
  const input = o.stdin ? fs.openSync(o.stdin, "r") : "ignore";
  let exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  let wake: () => void = () => {};
  const exited = new Promise<void>((resolve) => { wake = resolve; });
  const start = (argv: string[]): ChildProcess | null => {
    try {
      const c = spawn(argv[0], argv.slice(1), { stdio: [input, out, err], env });
      c.on("error", (e: NodeJS.ErrnoException) => {
        fs.appendFileSync(o.err, `${argv[0]}: ${e.code === "ENOENT" ? "command not found" : e.message}\n`);
        exit = { code: e.code === "ENOENT" ? 127 : 126, signal: null }; wake();
      });
      c.on("exit", (code, signal) => { exit = { code, signal }; wake(); });
      return c;
    } catch (e) {
      // A script without a #! line: bash runs it itself, and so do we.
      if ((e as NodeJS.ErrnoException).code === "ENOEXEC" && argv === o.cmd) return start(["bash", ...o.cmd]);
      fs.appendFileSync(o.err, `${argv[0]}: ${(e as Error).message}\n`);
      exit = { code: 126, signal: null }; wake();
      return null;
    }
  };
  const child = start(o.cmd);
  fs.closeSync(out); fs.closeSync(err); if (typeof input === "number") fs.closeSync(input);
  if (child) running({ child, scope: o.scope });

  let stopped: Ended["stopped"] = 0, since = 0, cg = "";
  const mem = `${o.out.replace(/\.jsonl$/, "")}.mem`;
  for (const f of [mem, `${mem}.oom`]) fs.rmSync(f, { force: true });
  const stream = streamWatch(o.out);
  let heard = epoch();
  const end = (s: Ended["stopped"], why: string) => {
    log(why);
    stopped = s;
    if (o.scope) platform.stopCapped(o.scope);
    try { child?.kill("SIGTERM"); } catch {}
  };
  while (child && exit === null) {
    if (o.scope) {
      if (!cg) cg = platform.cappedGroup(o.scope);
      // The kernel's own count of kills in it: systemd may see the scope empty before it sees the kill.
      if (cg && (platform.groupKills(cg)?.killed ?? 0) > 0) fs.closeSync(fs.openSync(`${mem}.oom`, "a"));
      // After a kill, no more looks: the snapshot is the one from before it.
      if (cg && !fs.existsSync(`${mem}.oom`)) memSnap(cg, mem);
    }
    if (o.stopFile && fs.existsSync(o.stopFile)) { end(2, "pause asap: ending the session"); break; }
    // Not one that has posted its result: that one is finishing, and the grace below ends it.
    if (!since && o.deadline && epoch() >= stopTime(o.deadline) + overrun) { end(3, "past the stop time: ending the session"); break; }
    if (stream.look()) heard = epoch();
    if (!since && stream.result) since = epoch();
    // After the result check: a session that has just finished isn't cut short.
    if (!since && o.tick && !(await o.tick())) { end(4, o.tickWhy ?? "its wrap-up time is over: ending the session"); break; }
    if (!since && o.silent && o.silent > 0 && stream.open.size === 0 && epoch() - heard >= o.silent) {
      end(5, `the session has written nothing for ${minsOf(o.silent)} and has no tool call open: ending it`); break;
    }
    if (since && epoch() - since >= grace) { end(1, `session posted its result ${grace}s ago but is still running; stopping it`); break; }
    await Promise.race([sleep(poll), exited]);
  }
  await exited;
  running(null);
  return { rc: status(exit!), stopped, end: epoch() };
}

const minsOf = (s: number) => s % 60 === 0 ? `${s / 60} min` : `${s} s`;

// The transcript, read as it grows, not whole at every poll. look() reads what's new and says
// whether there was any; then result: has it a `"type":"result"` line yet; open: the tool calls
// it has started (`tool_use`) and has no `tool_result` for yet.
export function streamWatch(f: string) {
  const RESULT = '"type":"result"';
  let pos = 0, part = "";
  const w = { result: false, open: new Set<string>(), look };
  const line = (s: string) => {
    if (s.includes(RESULT)) w.result = true;
    if (!s.includes('"tool_use"') && !s.includes('"tool_result"')) return;
    let content: unknown;
    try { content = (JSON.parse(s) as { message?: { content?: unknown } } | null)?.message?.content; } catch { return; }
    if (!Array.isArray(content)) return;
    for (const c of content as ({ type?: unknown; id?: unknown; tool_use_id?: unknown } | null)[]) {
      if (c?.type === "tool_use" && typeof c.id === "string") w.open.add(c.id);
      else if (c?.type === "tool_result" && typeof c.tool_use_id === "string") w.open.delete(c.tool_use_id);
    }
  };
  function look(): boolean {
    let fd: number;
    try { fd = fs.openSync(f, "r"); } catch { return false; }
    const from = pos;
    try {
      const size = fs.fstatSync(fd).size;
      while (pos < size) {
        const b = Buffer.alloc(Math.min(1 << 20, size - pos));
        const n = fs.readSync(fd, b, 0, b.length, pos);
        if (n <= 0) break;
        pos += n;
        // (latin1: a byte a character, so a character split between reads stays whole in part.)
        const lines = (part + b.subarray(0, n).toString("latin1")).split("\n");
        part = lines.pop()!;
        for (const l of lines) line(Buffer.from(l, "latin1").toString("utf8"));
      }
    } finally { fs.closeSync(fd); }
    // A result line not yet ended by its newline counts too.
    if (part.includes(RESULT)) w.result = true;
    return pos > from;
  }
  return w;
}

// memSnap <group> <file>: when a capped run's processes (its group, platform.cappedGroup) hold a
// quarter of its cap or more (anon and shmem), write its biggest processes to <file> (replacing
// the last): a header line, then pid, RSS and full command line, biggest first. Over the cap, the
// kernel kills the biggest and systemd the rest. Never fails: a process gone mid-look is normal.
export function memSnap(d: string, f: string) {
  try {
    const m = platform.groupMemory(d);
    // Not what's charged (used): the scope stays charged for a moment after its biggest process is
    // killed, and a look then would replace the snapshot that names it with one that doesn't.
    // (Not removed below a quarter: memory drops the moment the kill lands. The loop judges a
    // snapshot by its age instead.)
    // (Where the kinds aren't told, what's charged is all there is to go by.)
    const held = m && (m.anon === undefined && m.shmem === undefined ? m.used : (m.anon ?? 0) + (m.shmem ?? 0));
    if (!m || held! * 4 < m.cap) return;
    const procs = platform.processMemory(platform.groupProcesses(d) ?? []).map(({ pid, rss, cmd }) => [pid, rss, cmd.slice(0, 300)] as const);
    procs.sort((a, b) => b[1] - a[1]);
    // Nor while a killed process's memory is still being freed: the scope's processes hold it
    // (anon) but none of them has it in its RSS any more, so this look can't say whose it was.
    const sum = procs.reduce((n, x) => n + x[1], 0);
    let had = false; try { had = fs.statSync(f).size > 0; } catch {}
    // (Where the kinds aren't told, what's charged stands in for anon.)
    if (had && sum * 2 < (m.anon ?? m.used)) return;
    const h = (b: number) => b >= 2 ** 30 ? `${(b / 2 ** 30).toFixed(1)}G` : `${Math.floor(b / 2 ** 20)}M`;
    // Memory no process holds (a file in a tmpfs /tmp, say) shows only here.
    const kinds = (["anon", "file", "shmem"] as const).filter((k) => m[k] !== undefined).map((k) => `${k} ${h(m[k]!)}`).join(", ");
    const lines = [`at ${hms()} the session used ${iec(m.used)} of its ${iec(m.cap)} cap (${kinds}); its biggest processes (pid, RSS, command):`,
      ...procs.slice(0, 8).map(([p, r, c]) => `${p}\t${iec(r)}\t${c}`)];
    const tmp = `${f}.${process.pid}`;
    fs.writeFileSync(tmp, lines.join("\n") + "\n");
    fs.renameSync(tmp, f);
  } catch {}
}

// The real directory behind each top-level symlink in <dir> that leads out of it (a lane clone's
// work/, linked to the checkout's), for --add-dir. Without it the CLI refuses a write that
// resolves through the link while the tools follow it: 14-15 Oct, 40 refused Bash
// calls into work/, half of them worded as a compound command needing approval.
export function linkedDirs(dir: string): string[] {
  let top: string, ents: fs.Dirent[];
  try { top = fs.realpathSync(dir); ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out: string[] = [];
  for (const e of ents) {
    if (!e.isSymbolicLink()) continue;
    let real: string;
    try { real = fs.realpathSync(`${dir}/${e.name}`); if (!fs.statSync(real).isDirectory()) continue; } catch { continue; }
    if (real === top || real.startsWith(`${top}/`) || out.includes(real)) continue;
    out.push(real);
  }
  return out.sort();
}

// True if the session ended on a usage or rate limit. Reads only what the CLI itself reports
// (the result line, API-error assistant messages, stderr), never the session's own text: a unit
// about 429s must not put the loop to sleep.
export function limitHit(out: string, err: string): boolean {
  const re = /usage limit|session limit|rate.?limit|hit your limit|\b429\b/i;
  const str = (v: unknown) => v === undefined || v === null || v === false ? "" : typeof v === "string" ? v : JSON.stringify(v);
  for (const line of (read(out) ?? "").split("\n")) {
    let j: Record<string, unknown>;
    try { const v = JSON.parse(line); if (!v || typeof v !== "object" || Array.isArray(v)) continue; j = v; } catch { continue; }
    if (j.type === "result" && j.is_error === true && re.test(str(j.result))) return true;
    if (j.type === "assistant" && /rate_limit|usage/i.test(str(j.error))) return true;
    if (j.type === "assistant" && j.isApiErrorMessage === true) {
      const content = (j.message as { content?: unknown } | undefined)?.content;
      const text = Array.isArray(content) ? content.map((c) => str((c as { text?: unknown } | null)?.text)).join(" ") : "";
      if (re.test(text)) return true;
    }
    if (j.type === "system" && j.subtype === "api_retry" && (j.error_status ?? 0) === 429) return true;
  }
  return re.test(read(err) ?? "");
}

export function sessionCli(args: string[]): number {
  const [cmd, ...a] = args;
  switch (cmd) {
    case "mem-snap": if (a.length < 2) { console.error("usage: session mem-snap <group> <file>"); return 2; } memSnap(a[0], a[1]); return 0;
    case "limit-hit": if (a.length < 2) { console.error("usage: session limit-hit <out.jsonl> <err>"); return 2; } return limitHit(a[0], a[1]) ? 0 : 1;
    default:
      console.log(`session: what the loop does with one headless session (src/session.ts)
  mem-snap <group> <file>        write what uses a capped run's memory, if it holds a quarter of its cap
  limit-hit <out.jsonl> <err>    exit 0 if the session ended on a usage or rate limit`);
      return cmd === undefined || cmd === "-h" || cmd === "--help" ? 0 : 2;
  }
}
