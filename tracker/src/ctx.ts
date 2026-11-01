// Who is running the tracker, where, and on what: worked out from the environment, the
// working directory and the command, once per command (setContext). The commands read it
// from here, so the loop can call them in-process with an environment of its own.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { list } from "./text.ts";
import { hasStateAt } from "./store.ts";
import { netGit, reachesRemote } from "./net.ts";

export interface Ctx {
  env: NodeJS.ProcessEnv;
  cwd: string;
  cmd: string | undefined;
  TAG: string;
  HOST: string;
  ACTOR: string;
  // The repo: the nearest folder up with a tracker, else the working directory.
  ROOT: string;
  CDIR: string;
  MAIN: string;
  // Shared state: origin's URL when the state is origin's main (store.ts), else null.
  ORIGIN: string | null;
  // The checkout whose tracker/ is the state (.tracker/main with an origin, else ROOT), and
  // that tracker/. store.ts alone knows what's in it.
  SDIR: string;
  TDIR: string;
  // What each machine can do (docs/machines.md), and this one (FACTORY_CAPS overrides it).
  MCAPS: Map<string, Set<string>>;
  // Each machine's heavy-job slots (the Heavy column), where it gives a number.
  MHEAVY: Map<string, number>;
  CAPS: Set<string> | null;
  STALE_MS: number;
  BEAT_MS: number;
  LAST_CALL: boolean;
  // Asked once per command: locks other lanes hold, busy resources, main's newest code commit.
  heldCache: Map<string, boolean>;
  resCache: Map<string, boolean>;
  codeHead?: string | null;
}

// git, with a bound on the commands that reach origin (net.ts): the pushes run inside the lock.
export const git = (args: string[], opts: Partial<SpawnSyncOptionsWithStringEncoding> = {}) => {
  const env = opts.env ?? ctx.env;
  if (!reachesRemote(args)) return spawnSync("git", args, { encoding: "utf8", ...opts, env });
  return netGit(args, { encoding: "utf8", ...opts, env }, 180);
};

function findRoot(cwd: string) {
  let d = cwd;
  for (;;) {
    if (hasStateAt(d)) return d;
    const up = path.dirname(d);
    if (up === d) return cwd;
    d = up;
  }
}

// What each machine can do: docs/machines.md, the Lanes table's "Can" column
// (FACTORY_CAPS overrides this machine's). A unit with `caps` goes only to a
// machine that has all of them; one no machine can do isn't waited for.
function machineCaps(root: string, heavy = new Map<string, number>()) {
  const out = new Map<string, Set<string>>();
  let text = ""; try { text = fs.readFileSync(path.join(root, "docs", "machines.md"), "utf8"); } catch { return out; }
  // (Under "## Lanes" if the file has that section, so another table above it isn't read.)
  const lanes = text.split("\n").findIndex((l) => /^## Lanes\s*$/i.test(l));
  let head: string[] | null = null;
  for (const line of text.split("\n").slice(Math.max(0, lanes))) {
    if (!/^\s*\|/.test(line)) { if (head && out.size) break; continue; }
    const cells = line.split("|").slice(1, -1).map((c) => c.replace(/`/g, "").trim());
    // (By the header's names, any case and any order, as the runtime reads it: runtime/src/machines.ts.)
    if (!head) { if (cells.some((c) => c.toLowerCase() === "machine")) head = cells.map((c) => c.toLowerCase()); continue; }
    if (cells.every((c) => /^:?-*:?$/.test(c))) continue;
    const at = (col: string) => head!.includes(col) ? cells[head!.indexOf(col)] ?? "" : "";
    const name = at("machine"), can = at("can"), h = at("heavy");
    out.set(name, new Set(/^(—|-|none|)$/.test(can) ? [] : list(can)));
    if (/^[1-9][0-9]*$/.test(h)) heavy.set(name, Number(h));
  }
  return out;
}

export function makeContext(env: NodeJS.ProcessEnv = process.env, cmd: string | undefined = undefined, cwd: string = process.cwd()): Ctx {
  const TAG = env.FACTORY_TAG || (env.CLAUDE_CODE_SESSION_ID || "").slice(0, 8) || "manual";
  const HOST = env.FACTORY_HOST || os.hostname().split(".")[0];
  const ACTOR = env.FACTORY_ACTOR || (env.FACTORY_TAG ? "loop" : "session");
  const ROOT = findRoot(cwd);
  const CDIR = path.join(ROOT, ".tracker");
  const MAIN = env.FACTORY_MAIN || "main";
  const ORIGIN = env.FACTORY_STATE === "local" || ["init", "merge-json", "memory"].includes(cmd ?? "") || !hasStateAt(ROOT)
    ? null : (git(["-C", ROOT, "remote", "get-url", "origin"], { env }).stdout || "").trim() || null;
  const SDIR = ORIGIN ? path.join(CDIR, "main") : ROOT;
  const TDIR = path.join(SDIR, "tracker");
  const MHEAVY = new Map<string, number>();
  const MCAPS = machineCaps(ROOT, MHEAVY);
  return {
    env, cwd, cmd, TAG, HOST, ACTOR, ROOT, CDIR, MAIN, ORIGIN, SDIR, TDIR,
    MCAPS, MHEAVY,
    CAPS: env.FACTORY_CAPS !== undefined ? new Set(list(env.FACTORY_CAPS)) : MCAPS.get(HOST) || (MCAPS.size ? new Set() : null),
    STALE_MS: Number(env.FACTORY_LEASE_STALE ?? 1800) * 1000,
    BEAT_MS: Number(env.FACTORY_LEASE_BEAT ?? 600) * 1000,
    LAST_CALL: env.FACTORY_LAST_CALL === "1",
    heldCache: new Map(),
    resCache: new Map(),
  };
}

// The context the running command sees: main.ts (or a caller in-process) sets it first.
export let ctx: Ctx = null as unknown as Ctx;
export function setContext(c: Ctx) { ctx = c; }
