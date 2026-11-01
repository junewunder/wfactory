// The tracker for the loop: run in the loop's own process, sharing its loaded code, instead of
// a new Node for every call (the bash loop called it from 83 places). What it prints is caught
// and handed back, as a command's output would be. FACTORY_TRACKER naming some other file (a
// test's wrapper that refuses a command) runs that through the stub instead, as before. The loop
// still starts it as a command where that must be stoppable or timed: refresh (it runs probes)
// and lanes-stopped.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { run } from "../../tracker/src/index.ts";

export interface TrOut { code: number; out: string; err: string }
type Env = Record<string, string | undefined>;

const here = path.dirname(fileURLToPath(import.meta.url));
const own = new Set([path.join(here, "..", "..", "tracker", "main.ts"), path.join(here, "..", "..", "tracker", "tracker.mjs")].map(real));
function real(p: string) { try { return fs.realpathSync(p); } catch { return p; } }
// Read once a call: a test sets it for one loop.
const spawned = () => { const t = process.env.FACTORY_TRACKER; return !!t && !own.has(real(t)); };

// `factory/tracker <args>` with these variables added (FACTORY_TAG, FACTORY_ACTOR…), in the
// working directory.
export function tr(args: string[], add: Env = {}): TrOut {
  const env = { ...process.env, ...add };
  for (const k of Object.keys(add)) if (add[k] === undefined) delete env[k];
  if (spawned()) {
    const r = spawnSync("factory/tracker", args, { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 << 20 });
    return { code: r.status ?? 1, out: r.stdout ?? "", err: (r.stderr ?? "") + (r.error ? `${r.error.message}\n` : "") };
  }
  return trIn(args, env, process.cwd());
}

// The tracker run in this process with this environment and working directory, what it prints
// caught and handed back. The test suites call it for their own setup too.
export function trIn(args: string[], env: Env, cwd: string): TrOut {
  let out = "", err = "";
  const ow = process.stdout.write, ew = process.stderr.write;
  const catcher = (add: (s: string) => void) => ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    add(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    const cb = rest.find((x) => typeof x === "function") as (() => void) | undefined;
    if (cb) cb();
    return true;
  }) as typeof process.stdout.write;
  process.stdout.write = catcher((s) => { out += s; });
  process.stderr.write = catcher((s) => { err += s; });
  let code: number;
  try { code = run(args, { env, cwd }); } catch (e) {
    // What Node prints for an uncaught error, and its exit status.
    err += `${(e as Error)?.stack ?? String(e)}\n`; code = 1;
  } finally { process.stdout.write = ow; process.stderr.write = ew; }
  return { code, out, err };
}

// Its output without the trailing newline, as `$(…)` gives it; "" if it failed.
export const trOut = (args: string[], add: Env = {}) => { const r = tr(args, add); return r.code === 0 ? r.out.replace(/\n+$/, "") : ""; };
// Did it succeed?
export const trOk = (args: string[], add: Env = {}) => tr(args, add).code === 0;

// The tracker's exit status when another command held its lock past its wait (FACTORY_LOCK_WAIT):
// nothing is wrong with the data, and the call can be made again.
export const TR_BUSY = 75;
// A call that waits out a busy lock: tried again (the tracker's own wait is the pause between
// tries), saying so through say once and then every 20 tries; anything else is handed back. Once
// stopping() is true, a busy answer is handed back too: a loop stopping on a signal doesn't wait
// for the lock past one try (the wait blocks its signals, and its stop has a time limit).
export function trWait(args: string[], say: (m: string) => void, add: Env = {}, stopping: () => boolean = () => false): TrOut {
  for (let n = 0; ; n++) {
    const r = tr(args, add);
    if (r.code !== TR_BUSY || stopping()) return r;
    if (n % 20 === 0) say(`the tracker is locked by another command (.tracker/lock)${n ? `, still, after ${n + 1} tries` : ""}; waiting for it (tracker ${args[0]})`);
  }
}

// The gate init.sh files: the opening (one-off work on the project's issues, before the factory
// proper) is over, and lanes may start. Passed by the owner. A factory without it (one made before
// it existed) never waits on it.
export const OPENING_GATE = "opening/ready";
// What to say while it's still open, or "" once it's passed (or there is none).
export function openingOpen(run: (args: string[]) => TrOut = tr): string {
  const r = run(["state", OPENING_GATE]);
  const s = r.out.trim();
  if (r.code !== 0 || s === "done") return "";
  if (s === "parked") return `the opening isn't over: the owner stopped it (its gate is parked; \`just show ${OPENING_GATE}\` says why), so no lanes start`;
  if (s === "dropped") return `the opening's gate was dropped, so it can't be passed: \`just reopen ${OPENING_GATE}\`, then the owner passes it`;
  return `the opening isn't over: lanes start once the owner passes its gate (\`just pass ${OPENING_GATE}\`); see docs/factory.md, "The opening"`;
}
