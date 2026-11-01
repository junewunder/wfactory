// What the store runs: rsync, du and git here, and a shell over ssh on the store's machine.
import os from "node:os";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { cat, out, rmrf, tmpdir } from "./store-util.ts";

export type Run = SpawnSyncReturns<string>;

export const code = (r: Run) => r.status ?? (r.error ? 127 : 128 + (os.constants.signals[r.signal as NodeJS.Signals] ?? 0));
export function run(cmd: string, args: string[], o: { input?: string | Buffer; cwd?: string; err?: "inherit" | "pipe" | "ignore"; show?: boolean } = {}): Run {
  return spawnSync(cmd, args, {
    encoding: "utf8", cwd: o.cwd, input: o.input, maxBuffer: 1 << 30,
    stdio: [o.input === undefined ? "ignore" : "pipe", o.show ? "inherit" : "pipe", o.err ?? "inherit"],
  });
}
// Every copy gives up on a store that stops answering (a laptop asleep, a wifi change, a hung
// dataset) instead of hanging the lane: rsync after 5 minutes with no data, ssh (RSYNC_RSH, set
// in storeCli) after a minute or two without the store, and never waiting on a password prompt.
// It needs rsync 3 or later, first on PATH: macOS ships openrsync, which lacks options it copies
// with (--mkpath, --protect-args, --out-format). Without it, every rsync fails (exit 2), saying so
// once.
let rsyncOk: boolean | undefined;
export function rsync(args: string[], o: Parameters<typeof run>[2] = {}): Run {
  rsyncOk ??= /^rsync\s+version\s+([3-9]|\d{2,})\./m.test(run("rsync", ["--version"], { err: "ignore" }).stdout ?? "")
    || (console.error("store: the store needs rsync 3 or later, and the rsync on PATH isn't (macOS's own is openrsync): install it (`brew install rsync`) and put it first on PATH"), false);
  if (!rsyncOk) return { pid: 0, output: [], stdout: "", stderr: "", status: 2, signal: null };
  return run("rsync", [`--timeout=${process.env.FACTORY_STORE_TIMEOUT || "300"}`, ...args], o);
}
// A copy, making the folders it needs; true if it went through.
export const copy = (...args: string[]) => code(rsync(["-a", "--mkpath", "--protect-args", ...args], { show: true })) === 0;
// A stamp: never makes the store's own folders.
export const copyStamp = (from: string, to: string) => code(rsync(["-a", "--protect-args", from, to], { show: true })) === 0;
// Is <name> in an `rsync --list-only` of a folder?
export const listed = (list: string, name: string) => list.split("\n").some((l) => l.endsWith(` ${name}`));
export const du = (args: string[], p: string) => run("du", [...args, p], { err: "ignore" }).stdout.split("\t")[0];
export const duh = (p: string) => du(["-sh"], p);
export const gitShort = () => out(run("git", ["rev-parse", "--short", "HEAD"], { err: "ignore" }).stdout);

// The store's stamp for a group: "" if it has none (never copied back). null if the store can't
// be read: never mistake an outage for "nothing there".
export function remoteStamp(r: string, g: string): string | null {
  const t = tmpdir();
  try {
    const rc = code(rsync(["-q", "--protect-args", `${r}/stamps/${g}.json`, `${t}/s`], { err: "ignore" }));
    if (rc === 0) return cat(`${t}/s`) ?? "";
    // No stamp, but only if the store itself is there: an unmounted dataset or a wrong path
    // would read as "nothing on the store yet".
    if (rc === 23) return code(rsync(["-q", "--list-only", "--protect-args", `${r}/stamps/`], { err: "ignore" })) === 0 ? "" : null;
    return null;
  } finally { rmrf(t); }
}

// Run a shell script in the store's folder, with arguments: over ssh for a host:path remote. One
// script, so a move can't stop halfway between two ssh calls. (It runs on the store's machine,
// which has a shell and nothing else of ours.)
export const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;   // quoted for a remote sh
export function storeSh(r: string, args: string[], script: string): Run {
  const i = r.indexOf(":");
  if (i >= 0 && !r.slice(0, i).includes("/")) {
    let root = r.slice(i + 1);
    if (root.startsWith("~/")) root = root.slice(2);
    const rsh = (process.env.RSYNC_RSH ?? "").split(/\s+/).filter(Boolean);
    return run(rsh[0], [...rsh.slice(1), r.slice(0, i), [`cd ${q(root || ".")} && sh -s --`, ...args.map(q)].join(" ")], { input: script });
  }
  return run("sh", ["-s", "--", ...args], { cwd: r, input: script });
}
