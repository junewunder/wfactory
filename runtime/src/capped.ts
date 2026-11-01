// `just capped`: a command in a memory-capped systemd scope, and a word to the overseer when the
// cap killed it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { event } from "./events.ts";
import { capOk, nameOf, reasonOf, recordRun, sizes, takeTurn, writeEnded } from "./heavy.ts";
import { iec, pwd, runFg, status } from "./sys.ts";
import { machineOomSince, platform } from "./os.ts";

export const HELP = `
capped.sh — run a command under a memory cap (\`just capped\`): in a systemd
scope on Linux, under a watch on macOS. And say how it ended when memory did
it.

A job over its cap is killed, by the kernel on Linux and on macOS by the
watch, which looks once a second, so a job that grows fast can pass its cap
until the next look. All the caller sees is a failed step (exit 137, or a
wrapper's own code). So this counts the kills in the scope; an
out-of-memory kill says so on stderr, whether it was the job's own cap or
(on Linux) the whole machine running out, and appends an
\`oom-kill\` event (the command, the cap, the peak) to runs/events.log, which
\`just fleet wait\` reports. long.sh notes its jobs' kills through \`--oom-note\`.
How it ended is kept for \`just heavy why <name>\` (the name: --name, else the
command's first word).

A capped command is a heavy one: it takes its share of the machine's memory
budget, and if it isn't known to be short, one of its heavy-job slots
(heavy.sh; \`just heavy\` shows them). When the slot is due to be held for more
than 8 minutes, it fails at once (exit 75), saying what it's queued behind:
run it as a long job instead (\`just long start\`). \`--light\` skips all that
for a small command that only wants the memory cap. \`--hold\` keeps the
reservation after the command exits, until what it left running in the
scope (an editor it launched) has exited too; a kill there then stops all
that the scope holds, and \`just heavy why <name>\` says how it ended.

A \`just capped\` inside a capped job runs inside that job's cap and
reservation; it makes no scope of its own.

Usage:
  capped.sh [--mem SIZE] [--name NAME] [--light] [--hold] [--] <command…>
  capped.sh --oom-note <what> <cap>                  (a long job's ExecStopPost)

Memory: --mem, else $FACTORY_MEM, is both its share of the budget and its
cap. Neither given: its share is its last 3 peaks plus 20%, else 4G, and its
cap that or 8G, whichever is more (systemd sizes; 50% or infinity are caps
too). Exit status: the command's own; 75 when it would queue too long (more
than 8 minutes, $FACTORY_HEAVY_MAX_WAIT seconds; never inside a long job).

Run from the checkout's root (just runs recipes there; a long job's service starts there).`;

const short = (what: string) => [...what].length <= 160 ? what : [...what].slice(0, 157).join("") + "...";

// Say a kill: on stderr (unless quiet), and as an oom-kill event for the overseer. Over its own
// cap, or the whole machine out of memory (the kernel's pick, not this job's cap).
export function oom(what: string, cap: string, peak: string, env: NodeJS.ProcessEnv, quiet = false, machine = false) {
  const p = /^[0-9]+$/.test(peak) ? `, peak ${iec(Number(peak))}` : "";
  if (machine) {
    if (!quiet) process.stderr.write(`killed: the whole machine ran out of memory (a machine-wide out-of-memory kill, not this job's cap of ${cap}${p}): ${what}\n`);
    event("oom-kill", `${what} was killed: the whole machine ran out of memory (its cap, ${cap}, wasn't reached${p})`, env);
    return;
  }
  if (!quiet) process.stderr.write(`killed: out of memory at ${cap}${p} (the memory cap, not the job's own failure): ${what}\n`);
  event("oom-kill", `${what} was killed: out of memory at ${cap}${p}`, env);
}

// The step in the scope, around the command: capped-step.sh, in bash, since anything there
// counts against the job's cap (Node needs about 15 MB of it). It writes the kernel's counts
// there (the cap reached, kills of any kind), and the peak, to $FACTORY_CAPPED_STATE before the scope ends.

async function capped(args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  let given = env.FACTORY_MEM || undefined, heavy = true, hold = false, name = "", memFlag = false;
  for (;;) {
    if (args[0] === "--mem" || args[0] === "--name") {
      if (args.length < 2) { console.error(`capped: ${args[0]} needs a value`); return 2; }
      if (args[0] === "--mem") { given = args[1]; memFlag = true; } else name = args[1];
      args = args.slice(2);
    }
    else if (args[0] === "--light") { heavy = false; args = args.slice(1); }
    else if (args[0] === "--hold") { hold = true; args = args.slice(1); }
    else if (args[0] === "--") args = args.slice(1);
    else break;
  }
  if (!args.length) { console.error("usage: just capped [--light] [--hold] [--name NAME] <command…>"); return 2; }
  if (name && !/^[A-Za-z0-9_-]{1,40}$/.test(name)) { console.error(`capped: name a job with letters, digits, - and _ (got '${name}')`); return 2; }
  if (given !== undefined && !capOk(given)) { console.error(`capped: not a size: ${given} (512M, 4G, 50%, infinity)`); return 2; }
  const key = args.join(" "), what = `just capped ${key}`;
  name ||= nameOf(args);
  const { reserve, cap } = sizes(key, given, env);
  // A heavy one takes its turn first (its share of the budget, and a slot unless it's known to be
  // short), and holds it (not the scope) until the command ends.
  // (Inside a long or capped job there's no Bash call to be cut off: it waits as long as it takes.)
  const inJob = !!env.FACTORY_CAPPED_IN;
  // Inside one of the loop's own heavy commands (its landing check, a probe): a turn beside the
  // loop's, for memory only, as the loop's own is (heavy.ts, memoryTurn).
  const beside = env.FACTORY_HEAVY_HELD ? env.FACTORY_HEAVY_RES || undefined : undefined;
  const turn = heavy && (!env.FACTORY_HEAVY_HELD || beside)
    ? await takeTurn({ what: short(what), cmd: key, name, mem: reserve, cap, beside, memoryOnly: !!beside, failAfter: inJob ? undefined : Number(env.FACTORY_HEAVY_MAX_WAIT || 480) }, env)
    : null;
  if (typeof turn === "string") { process.stderr.write(`capped: ${turn}\n`); return 75; }
  const held = turn ? { FACTORY_HEAVY_HELD: "1", FACTORY_HEAVY_RES: "" } : {};
  // Inside a capped job already: in its scope, under its cap. A scope of its own would escape it.
  if (inJob) {
    if (memFlag || hold) process.stderr.write(`capped: inside a capped job (${env.FACTORY_CAPPED_IN}): this runs in its scope, under its cap${hold ? ", and ends with it (no --hold)" : ""}\n`);
    try { return status(await runFg(args, { env: { ...env, ...held } })); } finally { turn?.give(); }
  }
  const unit = `factory-${path.basename(pwd(env))}-capped-${process.pid}-${Math.floor(Math.random() * 32768)}`;
  // The kernel kills only the biggest process; a wrapper around it (a batch script running
  // a renderer) goes on and exits with its own code. OOMPolicy=continue keeps it that way: systemd's
  // default stops the whole scope after a kill, which SIGTERMs the wrapper (exit 143, #41). Then
  // systemd records no oom-kill, so the step in the scope (capped-step.sh) writes the
  // kernel's counts there, and the peak, to $FACTORY_CAPPED_STATE before the scope ends.
  // (Scopes take OOMPolicy from systemd 253 on; before that, the wrapper is stopped as it was.)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "capped-"));
  const state = path.join(tmp, "state");
  fs.writeFileSync(state, "");
  const t0 = Date.now();
  let rc: number;
  try {
    // (Held, a kill stops the whole scope instead, so that systemd records it: nothing waits on
    // what it left running to read the kernel's counts.)
    rc = status(await runFg(platform.cappedCmd(unit, cap, [...platform.cappedStep, ...args], !(hold && turn)),
      { env: { ...env, FACTORY_CAPPED_STATE: state, FACTORY_CAPPED_IN: unit, ...held } }));
  } catch (e) { turn?.give(); throw e; }
  const t1 = Date.now();
  const lines = fs.readFileSync(state, "utf8").split("\n").map((l) => l.split(" "));
  fs.rmSync(tmp, { recursive: true, force: true });
  const most = (k: string) => lines.filter(([x, n]) => x === k && /^[0-9]+$/.test(n ?? "")).reduce((p, [, n]) => Math.max(p, Number(n)), 0);
  let peak = String(most("peak") || "");
  // A kill of any kind in the scope (oom_kill), and whether the scope reached its own cap (oom):
  // a kill without the cap reached was the machine's.
  let killed = most("oom_kill") > 0, overCap = most("oom") > 0;
  if (!lines.some(([k]) => k === "oom_kill") && rc !== 0) {
    // No count from the scope: either its cgroup couldn't be read (no cgroup v2), or the step was
    // killed too before it was done: the kernel picked it (the memory isn't any one process's, as in
    // a tmpfs), systemd-oomd ended the scope, or an older systemd stopped it. What the command left
    // in the scope goes now (the step is gone, so nothing would end it). Then systemd's verdict
    // says, once it settles; and nothing but a kill over the cap SIGKILLs that step.
    const wrote = lines.some((l) => l.length === 1 && l[0] === "done");
    if (!wrote) platform.killCapped(unit);
    for (let i = 0; i < 20; i++) {
      if (!platform.cappedRunning(unit)) break;
      await sleep(100);
    }
    if (platform.cappedOverCap(unit)) { killed = true; overCap = !machineOomSince(t0); }
    else if (!wrote && rc === 137) { killed = true; overCap = true; }
    if (!peak) peak = platform.cappedPeak(unit);
  }
  if (killed) oom(short(what), cap, peak, env, false, !overCap);
  // Held: the reservation stays while what the command left in the scope runs, and how it ends
  // is written once it has (heavy.ts).
  const holding = hold && turn !== null ? await turn.hold(unit) : (turn?.give(), false);
  // A killed run's peak is where the kill stopped it, not what it needs: not kept, or each kill
  // at a cap would raise the next one.
  recordRun(key, { peak: killed ? undefined : Number(peak) || undefined, secs: rc === 0 ? (t1 - t0) / 1000 : undefined }, env);
  if (!holding) {
    writeEnded(pwd(env), name, { what: short(what), cmd: key, start: t0, end: t1, rc, cap, peak: Number(peak) || undefined, reason: reasonOf(rc, killed, overCap) });
    // A scope that failed (its command killed by a signal) stays loaded until it's reset.
    platform.forgetCapped(unit);
  }
  return rc;
}

// One of the loop's own heavy commands (its landing check) in a scope of its own with no cap, so
// its peak and run time are recorded under key as a \`just capped\` job's are, and its next run
// reserves that peak plus 20% (heavy.ts, request), not always 4G (#116). A \`just capped\` inside
// makes a scope of its own (FACTORY_CAPPED_IN isn't set here), counted on its own and not in this
// peak; on macOS the watch fences it off the same way (os/darwin-cap.ts). Without scopes
// (unit "": FACTORY_NOCAP=1, or none on the machine), only its run time. unit: the scope's name,
// one \`oversee.sh stop\` finds, as it finds a session's: what the command leaves running there (a
// build daemon) stays until the lanes stop, as it would in the lane's own service. run starts a
// command as the caller does (the loop's stoppable, which a stop ends).
export async function measured(key: string, cmd: string[], env: NodeJS.ProcessEnv, unit: string,
  run: (argv: string[], env: NodeJS.ProcessEnv) => Promise<number>): Promise<number> {
  const t0 = Date.now();
  if (!unit) {
    const rc = await run(cmd, env);
    if (rc === 0) recordRun(key, { secs: (Date.now() - t0) / 1000 }, env);
    return rc;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "measured-"));
  const state = path.join(tmp, "state");
  fs.writeFileSync(state, "");
  try {
    const rc = await run(platform.cappedCmd(unit, "infinity", [...platform.cappedStep, ...cmd], true), { ...env, FACTORY_CAPPED_STATE: state });
    const secs = (Date.now() - t0) / 1000;
    const lines = fs.readFileSync(state, "utf8").split("\n").map((l) => l.split(" "));
    const most = (k: string) => lines.filter(([x, n]) => x === k && /^[0-9]+$/.test(n ?? "")).reduce((p, [, n]) => Math.max(p, Number(n)), 0);
    // (Its step ended before it could say, by a stop: the scope's own count.)
    const peak = most("peak") || Number(platform.cappedPeak(unit)) || 0;
    // A run the machine's memory ran out under: its peak is where the kill stopped it, not what it needs.
    recordRun(key, { peak: most("oom_kill") > 0 ? undefined : peak || undefined, secs: rc === 0 ? secs : undefined }, env);
    return rc;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    platform.forgetCapped(unit);
  }
}

export async function cappedCli(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (args[0] === "-h" || args[0] === "--help") { console.log(HELP); return 0; }
  if (args[0] === "--oom-note") {
    // In a service's ExecStopPost: systemd says how it ended, and its cgroup still holds the peak.
    if (!platform.endedOverCap(env)) return 0;
    const peak = platform.groupPeak(platform.myGroup());
    try { oom(args[1] ?? "", args[2] ?? "", peak, env, true); } catch {}
    return 0;
  }
  if (args[0] === "--in-scope") return status(await runFg([...platform.cappedStep, ...args.slice(1)], { env }));
  return capped(args, env);
}
