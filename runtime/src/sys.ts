// What the runtime's commands share: where they run, the time in the formats the scripts
// print, running a command as a shell script would, and locks that other lanes see.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { platform } from "./os.ts";

// The working directory as the shell names it ($PWD, through symlinks), when that's where we
// are: lane names and unit names are made from its last part.
export function pwd(env: NodeJS.ProcessEnv = process.env) {
  const cwd = process.cwd();
  const p = env.PWD;
  try { if (p && path.isAbsolute(p) && fs.realpathSync(p) === cwd) return p; } catch {}
  return cwd;
}

// A runtime script's `cd "$FACTORY_ROOT"` (the stub sets it): false, saying why on stderr, when
// it can't. $PWD follows, as a shell's `cd` makes it.
// -h or --help anywhere before a "--" (after it, the words are a command's), and before textAt
// (where a subcommand's free text starts): a subcommand given --help prints the help, never runs
// ("just fleet start --help" started lanes, 2026-10).
export const asksHelp = (args: string[], textAt = args.length) => { for (const a of args.slice(0, textAt)) { if (a === "--") return false; if (a === "-h" || a === "--help") return true; } return false; };
export function enterRoot(script: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const root = env.FACTORY_ROOT;
  try { if (!root) throw new Error(); process.chdir(root); } catch {
    console.error(`${script}: ${root ? `cd: ${root}: No such file or directory` : `FACTORY_ROOT: run this through its stub in the factory, factory/${script}`}`);
    return false;
  }
  env.PWD = root;
  return true;
}

// `hostname -s`, or FACTORY_HOST.
export const host = (env: NodeJS.ProcessEnv = process.env) => env.FACTORY_HOST || os.hostname().split(".")[0];

// ~/x → $HOME/x (the machines file writes checkouts with ~).
export function expandHome(p: string, env: NodeJS.ProcessEnv = process.env) {
  const home = env.HOME ?? os.homedir();
  return p === "~" ? home : p.startsWith("~/") ? `${home}/${p.slice(2)}` : p;
}

// ---------------------------------------------------------------- time, as `date` prints it

const p2 = (n: number) => String(n).padStart(2, "0");
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const hm = (d = new Date()) => `${p2(d.getHours())}:${p2(d.getMinutes())}`;                 // %H:%M
export const dayHm = (d = new Date()) => `${DAYS[d.getDay()]} ${hm(d)}`;                            // %a %H:%M
export const ymdHm = (d = new Date()) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${hm(d)}`;  // %F %H:%M
// The tracker's time format, to the second (2026-10-13T20:35:00Z): its notes and decisions
// compare with it as strings.
export const stamp = (d = new Date()) => d.toISOString().slice(0, 19) + "Z";
export const ymdHms = (d = new Date()) => `${ymdHm(d)}:${p2(d.getSeconds())}`;              // %F %T
export const epoch = () => Math.floor(Date.now() / 1000);

// `numfmt --to=iec`: 31457280 → 30M, 1572864 → 1.5M (rounded up, one decimal under 10).
export function iec(n: number) {
  if (n < 1024) return String(n);
  const units = "KMGTPEZY";
  let v = n, u = -1;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  for (;;) {
    const r = v < 10 ? Math.ceil(v * 10) / 10 : Math.ceil(v);
    if (r >= 1024 && u < units.length - 1) { v = r / 1024; u++; continue; }
    return (r < 10 ? r.toFixed(1) : String(r)) + units[u];
  }
}

// ---------------------------------------------------------------- files

// `tail -n N`: a file's last N lines (without their newlines), read from its end, so a long
// job's big log costs no more than its last lines. null if it can't be read.
export function tail(file: string, n: number): string[] | null {
  let fd: number;
  try { fd = fs.openSync(file, "r"); } catch { return null; }
  try {
    let pos = fs.fstatSync(fd).size;
    const chunks: Buffer[] = [];
    let newlines = 0;
    // One newline more than N lines need: the one before the first of them (the file's last
    // newline ends its last line rather than starting another).
    while (pos > 0 && newlines <= n) {
      const len = Math.min(65536, pos);
      pos -= len;
      const b = Buffer.alloc(len);
      fs.readSync(fd, b, 0, len, pos);
      chunks.unshift(b);
      for (const c of b) if (c === 10) newlines++;
    }
    const lines = Buffer.concat(chunks).toString("utf8").split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    return n > 0 ? lines.slice(-n) : [];
  } finally { fs.closeSync(fd); }
}

// ---------------------------------------------------------------- commands

// A shell's `printf %q`: the word as the shell reads it back.
export const shq = (s: string) => /^[A-Za-z0-9_./+:,=@%^-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;

export interface Ended { code: number | null; signal: NodeJS.Signals | null }

// Run a command with this process's terminal, as a script runs one in the foreground, and
// wait for it. A SIGTERM or SIGHUP sent to us goes on to it (`systemctl stop`, a closed ssh);
// a Ctrl-C reaches it from the terminal itself, and we wait for it to end. With signals: false,
// a signal ends us at once, as it does a shell script waiting on its command.
export function runFg(cmd: string[], opts: { env?: NodeJS.ProcessEnv; cwd?: string; signals?: boolean } = {}): Promise<Ended> {
  const { signals = true, ...o } = opts;
  return new Promise((resolve) => {
    let c: ReturnType<typeof spawn>;
    const pass = (s: NodeJS.Signals) => { c.kill(s); };
    const quiet = () => {};
    const sigs: [NodeJS.Signals, (s: NodeJS.Signals) => void][] = signals ? [["SIGTERM", pass], ["SIGHUP", pass], ["SIGINT", quiet], ["SIGQUIT", quiet]] : [];
    for (const [s, f] of sigs) process.on(s, f);
    const done = (e: Ended) => { for (const [s, f] of sigs) process.off(s, f); resolve(e); };
    const failed = (e: NodeJS.ErrnoException) => {
      // What bash says and returns for a command it can't run.
      process.stderr.write(`${cmd[0]}: ${e.code === "ENOENT" ? "command not found" : e.message}\n`);
      done({ code: e.code === "ENOENT" ? 127 : 126, signal: null });
    };
    const start = (argv: string[]) => {
      // Some failures to run come back as an error event, some (ENOEXEC) are thrown.
      try { c = spawn(argv[0], argv.slice(1), { stdio: "inherit", ...o }); } catch (e) {
        // A script without a #! line: bash runs it itself, and so do we.
        if ((e as NodeJS.ErrnoException).code === "ENOEXEC" && argv === cmd) start(["bash", ...cmd]);
        else failed(e as NodeJS.ErrnoException);
        return;
      }
      c.on("error", failed);
      c.on("exit", (code, signal) => done({ code, signal }));
    };
    start(cmd);
  });
}

// A shell's $? for a command that ended so: 128 + the signal's number for a killed one.
export const status = (e: Ended) => e.signal ? 128 + (os.constants.signals[e.signal] ?? 0) : e.code ?? 1;

// End this process as the command ended, as `exec` would have: by the same signal if it was killed.
export function exitAs(e: Ended): never {
  if (e.signal) {
    process.removeAllListeners(e.signal);
    try { process.kill(process.pid, e.signal); } catch {}
  }
  process.exit(status(e));
}

// ---------------------------------------------------------------- locks

// flock(2)'s lock on a file, which bash scripts and the other lanes see: tryLock holds it on an
// open descriptor until unlock (or this process ends), or returns null at once if someone else
// has it. Node has no flock(2): the OS's tool takes it on that same open file (os.ts, lockFd);
// the lock belongs to the open file, so it stays ours when the tool exits. The descriptor is
// close-on-exec: nothing we start holds the lock.
export function lockWithin(file: string, secs: number): number | null {
  const fd = fs.openSync(file, "a");
  if (platform.lockFd(fd, secs)) return fd;
  fs.closeSync(fd);
  return null;
}
export const tryLock = (file: string) => lockWithin(file, 0);
// The same lock, waited for as long as someone else has it.
export function lock(file: string): number {
  const fd = lockWithin(file, Infinity);
  if (fd === null) throw new Error(`couldn't lock ${file}`);
  return fd;
}
// Whether someone has the lock on this file now (false when there's no such file).
export function lockHeld(file: string): boolean {
  let fd: number;
  try { fd = fs.openSync(file, "r"); } catch { return false; }
  try { return !platform.lockFd(fd, 0); } finally { fs.closeSync(fd); }
}
export const unlock = (fd: number) => { try { fs.closeSync(fd); } catch {} };
