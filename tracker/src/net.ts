// git that talks to a remote, bounded: on a dead connection (wifi gone mid-push) ssh's
// defaults wait forever, and a tracker push waits inside the tracker's lock. So ssh gets a
// connect timeout and keepalives (as the runtime's rsync does, runtime/src/store.ts), and the
// command a timeout as a backstop for what ssh can't see. Used by the tracker (ctx.ts git) and
// the loop's landing (runtime/src/landing.ts).
import path from "node:path";
import tty from "node:tty";
import { spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from "node:child_process";

export const SSH_OPTS = "-o BatchMode=yes -o ConnectTimeout=20 -o ServerAliveInterval=15 -o ServerAliveCountMax=4";
const REMOTE = new Set(["fetch", "push", "pull", "clone", "ls-remote"]);

// The subcommand and the -C folder of a git command line (git's own options come first).
function parse(args: string[]) {
  let dir: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-C") { dir = dir && args[i + 1] ? path.resolve(dir, args[i + 1]) : args[i + 1]; i++; continue; }
    if (a === "-c" || a === "--git-dir" || a === "--work-tree") { i++; continue; }
    if (a.startsWith("-")) continue;
    return { sub: a, dir };
  }
  return { sub: undefined, dir };
}

export const reachesRemote = (args: string[]) => REMOTE.has(parse(args).sub ?? "");

// The environment for a git command that reaches a remote: the ssh git would run anyway
// (GIT_SSH_COMMAND, else core.sshCommand, else GIT_SSH, else ssh), with SSH_OPTS after its own
// options, so a project's own -o settings win. A command that isn't OpenSSH's (plink, a
// wrapper script) is left as it is: only the timeout bounds it.
export function netEnv(args: string[], env: NodeJS.ProcessEnv, cwd?: string): NodeJS.ProcessEnv {
  let base = env.GIT_SSH_COMMAND;
  if (!base) {
    const { dir } = parse(args);
    const c = spawnSync("git", [...(dir ? ["-C", dir] : []), "config", "core.sshCommand"], { encoding: "utf8", env, cwd, stdio: ["ignore", "pipe", "ignore"] });
    base = (c.status === 0 && c.stdout.trim()) || (env.GIT_SSH ? `'${env.GIT_SSH.replace(/'/g, `'\\''`)}'` : "ssh");
  }
  const prog = base.trim().split(/\s+/)[0].replace(/^['"]|['"]$/g, "");
  if (!/^ssh(\.exe)?$/.test(path.basename(prog))) return env;
  return { ...env, GIT_SSH_COMMAND: `${base} ${SSH_OPTS}` };
}

// git that reaches a remote, given up after FACTORY_GIT_TIMEOUT seconds, else defaultSec (a
// clone, which on a big repo takes a while, gets at least 15 minutes). It runs under timeout(1),
// which kills its whole process group: killing git alone leaves its ssh behind (a pile of them,
// one a write, when the server answers keepalives but nothing else). Run by hand from a terminal,
// it stays in the terminal's group instead (--foreground: only git is killed), so Ctrl-C and a
// password prompt still reach it. A command that didn't finish (timed out, or killed) comes back
// with status 124 and says so on stderr, so callers treat it as origin unreachable.
export function netGit(args: string[], opts: SpawnSyncOptionsWithStringEncoding, defaultSec: number): SpawnSyncReturns<string> {
  const env = opts.env ?? process.env;
  const s = Number(env.FACTORY_GIT_TIMEOUT);
  const sec = Number.isFinite(s) && s > 0 ? s : parse(args).sub === "clone" ? Math.max(defaultSec, 900) : defaultSec;
  const o = { ...opts, env: netEnv(args, env, opts.cwd as string | undefined) };
  const fg = tty.isatty(0) || tty.isatty(2) ? ["--foreground"] : [];
  let r = spawnSync("timeout", [...fg, "-k", "10", String(sec), "git", ...args], { ...o, timeout: (sec + 30) * 1000, killSignal: "SIGKILL" });
  // (No timeout(1) here: git alone, killed by Node.)
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") r = spawnSync("git", args, { ...o, timeout: sec * 1000 });
  if (r.status !== null && r.status !== 124) return r;
  const why = r.status === 124 || (r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" ? `no answer from the remote in ${sec} s; gave up` : `killed (${r.signal ?? "no status"})`;
  return { ...r, status: 124, stderr: `${r.stderr ?? ""}git: ${why}\n` };
}
