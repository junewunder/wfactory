// The loop run in the test's own process, its entry point (loopCli) as factory/loop.sh runs it,
// with the time mocked (node:test's mock.timers: Date and setTimeout), so a test moves the
// clock to a moment instead of waiting for it: the stop time, last call, the wrap-up, a
// usage pause. Everything else is real: the loop's children (the fake claude, git, the
// tracker's commands, CI steps, the heartbeat) run as processes, in real time.
//
// What the loop's entry point assumes of its process, and how a test's process gives it that:
// - It enters the factory (process.chdir), and its environment is process.env (main.ts hands it
//   that, and what it starts without an environment of its own gets the process's real one: a
//   new object assigned to process.env doesn't reach them). So for the run process.env holds the
//   loop's variables, and only those. Both are put back when it ends, with the process's title
//   and signal handlers.
// - It ends with process.exit: that's caught, and ends the run with its code. The locks it
//   held to its end (runs/.loop.lock, its lane lock), which its exit lets go of, are let go of
//   then: the descriptors it opened on files in the checkout or its lock folder are closed.
// - It writes to process.stdout and process.stderr and the console (its log, the tracker's
//   output): those are the run's own streams while it runs, merged in the order written, as
//   `2>&1` gives them.
//   (Children it starts with its terminal write to the test process's; nothing checked here does.)
// - It waits with node:timers/promises' setTimeout, bound when it was imported: the mocked one
//   reaches it through syncBuiltinESMExports. Its sleeps are counted, so a move of the clock can
//   wait until the loop has acted on it.
//
// The clock stands still unless the test moves it (at): the loop's work between its waits takes
// no time, a session takes the time the test lets pass while it's held (hold.<unit>, as the
// fake claude knows it), and a child sees real time (so nothing a child decides may hang on the
// mocked one). What a child records (a unit done) has a real time, and the loop compares it with
// its own: keep the clock ahead of real time where that matters (a session let go at 0 s whose
// unit's CI then runs, say), or a child slow under load writes a moment the loop hasn't reached
// yet. While a run is going, the test's own waits must be real ones (waitFor, realSleep):
// test/lib's until and sleep use the mocked setTimeout. One run at a time in a process; each
// test file is a process of its own.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { mock, after } from "node:test";
import { syncBuiltinESMExports } from "node:module";
import timersPromises from "node:timers/promises";
import { Writable } from "node:stream";
import { loopCli } from "../../runtime/src/loop.ts";
import { hm } from "../../runtime/src/sys.ts";
import { hms } from "../../runtime/src/session.ts";
import { alive, openFiles, readOr } from "../lib/index.ts";

// The real timers, kept before anything mocks them.
const realSetTimeout = globalThis.setTimeout;
export const realSleep = (ms: number) => new Promise<void>((r) => realSetTimeout(r, ms));
// Polls (in real time) until fn() is true: fails after s seconds, saying what was waited for.
export async function waitFor(fn: () => boolean, what: string, s = 30) {
  // (performance.now, not Date: Date may be mocked.)
  for (const end = performance.now() + s * 1000; !fn();) {
    if (performance.now() > end) assert.fail(`not so after ${s} s: ${what}`);
    await realSleep(20);
  }
}

type Env = NodeJS.ProcessEnv;
export interface Ended { code: number; out: string }
// A place to run the loop: a checkout and its environment (a lane's, or the factory's own).
export interface Checkout { dir: string; envWith: (add?: Env) => Env }

// What the loop's clock says a moment is, as its log and messages write it: t seconds after t0.
export const hmsAt = (t0: number, t: number) => hms(new Date((t0 + t) * 1000));
export const hmAt = (t0: number, t: number) => hm(new Date((t0 + t) * 1000));
// The next whole second, to start a run's clock at (so its moments are whole seconds).
export const nextSecond = () => Math.ceil(Date.now() / 1000);

let running = false;

// run(c, args, add, t0): factory/loop.sh <args> in checkout c, with these variables added, in
// this process, its clock starting at t0 (epoch seconds; the next whole second by default).
//   out():         what it has written so far (stdout and stderr merged)
//   now():         the loop's clock, in seconds since t0
//   at(t):         moves the clock to t0 + t, firing the loop's waits due by then, and returns
//                  once the loop has acted on it (it waits again, or has ended)
//   flow(t):       moves it there a second at a time, as time passes: the loop acts at each
//                  second (a nap looks once a second, a session's poll at least that often)
//   until(text):   resolves once it has written text; fails after s seconds, or if it ends first
//   ended():       has it ended?   done: its exit code and output once it has
//   end(s):        the same, failing if it hasn't ended within s seconds (real ones)
export function run(c: Checkout, args: string[], add: Env = {}, t0 = nextSecond()) {
  assert.ok(!running, "one in-process loop at a time");
  running = true;
  let out = "", finished = false, exitCode: number | null = null;
  // Two streams, one output: the tracker in this process catches each on its own (tr.ts).
  // (LOOP_TEST_ECHO=1: and echoed to the test's own stderr as it comes, to see where a run is.)
  const echo = !!process.env.LOOP_TEST_ECHO;
  const sink = () => new Writable({ write(chunk, _enc, cb) { out += String(chunk); if (echo) fs.writeSync(2, String(chunk)); cb(); } });
  const sinkOut = sink(), sinkErr = sink();
  // The process as the loop finds it, put back when it ends.
  const cwd = process.cwd(), env = process.env, saved = { ...process.env }, title = process.title, cons = globalThis.console;
  const so = Object.getOwnPropertyDescriptor(process, "stdout")!, se = Object.getOwnPropertyDescriptor(process, "stderr")!;
  const sigs = { SIGTERM: process.listeners("SIGTERM"), SIGINT: process.listeners("SIGINT") };
  Object.defineProperty(process, "stdout", { configurable: true, get: () => sinkOut });
  Object.defineProperty(process, "stderr", { configurable: true, get: () => sinkErr });
  // The global console writes to the streams it was made with: one made with these instead.
  globalThis.console = new console.Console({ stdout: sinkOut, stderr: sinkErr });
  const realExit = process.exit.bind(process);
  // Its exit ends the run, as it ends the process: whatever the loop was still waiting on (a
  // signal stops it mid-wait) is left waiting, on a clock that's put back.
  let exited: (code: number) => void = () => {};
  const exitCalled = new Promise<number>((r) => { exited = r; });
  const exit = mock.method(process, "exit", ((code?: number) => { exitCode ??= code ?? 0; exited(exitCode); }) as never);
  // A signal to this process (a test runner's timeout) goes to the loop, which stops; its exit
  // is caught, so the process ends a few seconds after, as it would have.
  let stoppedByTest = false;
  const onSignal = () => { if (!stoppedByTest) realSetTimeout(() => realExit(143), 5000).unref(); };
  process.prependListener("SIGTERM", onSignal); process.prependListener("SIGINT", onSignal);
  // The clock, and the loop's sleeps: how many it has started, and when the newest is due.
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: t0 * 1000 });
  const mocked = timersPromises.setTimeout;
  let started = 0, newestDue = Infinity;
  (timersPromises as { setTimeout: unknown }).setTimeout = (ms?: number, ...rest: unknown[]) => {
    started++; newestDue = Date.now() + Number(ms ?? 0);
    return (mocked as (...a: unknown[]) => Promise<unknown>)(ms, ...rest);
  };
  syncBuiltinESMExports();
  // What the process's exit would close: its lock files' descriptors. (Nothing else in this
  // process keeps a file there open.)
  const letGoOfLocks = (dirs: string[]) => {
    // (Paths as the system resolves them: macOS's temp folder is under /private.)
    const real = dirs.flatMap((d) => { try { return [d, fs.realpathSync(d)]; } catch { return [d]; } });
    for (const { fd, path: p } of openFiles()) {
      if (real.some((d) => p.startsWith(`${d}/`))) { try { fs.closeSync(fd); } catch {} }
    }
  };
  const restore = () => {
    mock.timers.reset();   // puts back timers/promises' own setTimeout, over the wrapper too
    syncBuiltinESMExports();
    exit.mock.restore();
    Object.defineProperty(process, "stdout", so); Object.defineProperty(process, "stderr", se); globalThis.console = cons;
    for (const s of ["SIGTERM", "SIGINT"] as const) for (const l of process.listeners(s)) if (!sigs[s].includes(l)) process.off(s, l);
    process.env = env;
    for (const k of Object.keys(env)) delete env[k];
    Object.assign(env, saved);
    process.chdir(cwd); process.title = title;
    running = false;
  };
  // As factory/loop.sh's stub hands over: the factory's root, the skill and Node it picked.
  const loopEnv: Env = { ...c.envWith(add), FACTORY_ROOT: c.dir, FACTORY_NODE: process.execPath, PWD: c.dir };
  for (const k of Object.keys(env)) delete env[k];
  Object.assign(env, loopEnv);
  // A run still going when the test that started it ends (a check failed) is stopped as a signal
  // stops a lane, so the next test finds the process as it was.
  after(async () => {
    if (finished) return;
    stoppedByTest = true;
    process.emit("SIGTERM");
    await waitFor(() => finished, "the loop stops on TERM", 60).catch(() => {});
  });
  const done: Promise<Ended> = (async () => {
    let code: number | undefined;
    try { code = await Promise.race([loopCli(args, env), exitCalled]); } catch (e) { out += `${(e as Error)?.stack ?? e}\n`; code = 1; } finally {
      letGoOfLocks([fs.realpathSync(c.dir), fs.realpathSync(loopEnv.FACTORY_LOCKS!)]);
      finished = true; restore();
    }
    return { code: exitCode ?? code ?? 0, out };
  })();
  return {
    t0, done,
    out: () => out,
    ended: () => finished,
    now: () => Date.now() / 1000 - t0,
    async at(t: number) {
      assert.ok(!finished, `the loop has ended: no moment ${t} s to move to\n${out}`);
      const to = (t0 + t) * 1000;
      assert.ok(to >= Date.now(), `the clock is at ${Date.now() / 1000 - t0} s already, past ${t} s`);
      const n = started, live = newestDue <= to;
      if (echo) fs.writeSync(2, `[clock: to ${t} s; ${started} sleeps, the newest due at ${newestDue / 1000 - t0} s]\n`);
      mock.timers.tick(to - Date.now());
      // The loop waits on one thing at a time, the newest of its sleeps (older ones were raced
      // against a process that ended first). Once that's fired, it has acted when it sleeps again.
      if (live) await waitFor(() => finished || started > n, `the loop acts on the moment ${t} s`);
      else await realSleep(0);
    },
    async flow(t: number) {
      for (let now = Date.now() / 1000 - t0; now < t && !finished; now = Date.now() / 1000 - t0) await this.at(Math.min(t, Math.floor(now) + 1));
    },
    async end(s = 60) {
      try { await waitFor(() => finished, "the loop ends", s); } catch { assert.fail(`not ended in ${s} s (its clock at ${Date.now() / 1000 - t0} s)\ngot: ${out}`); }
      return done;
    },
    async until(text: string, s = 30) {
      for (const end = performance.now() + s * 1000; !out.includes(text);) {
        if (finished) assert.fail(`ended without writing: ${text}\ngot: ${out}`);
        if (performance.now() > end) assert.fail(`not written in ${s} s: ${text}\ngot: ${out}`);
        await realSleep(20);
      }
    },
  };
}
export type Run = ReturnType<typeof run>;

// A unit's session, held: the fake claude, once it has written its work (not committed it), waits
// while hold.<unit> is in the lane's locks (<unit> as group-slug), its pid in held.<unit>, until
// go.<unit>. It's let go of when the test that held it ends, if it hasn't been.
//   held(): resolves once it's working; holding(): is it working, held, now?; go(): lets it go on
export function hold(locks: string, unit: string) {
  const k = unit.replace("/", "-"), held = path.join(locks, `held.${k}`);
  fs.writeFileSync(path.join(locks, `hold.${k}`), "");
  after(() => { if (fs.existsSync(path.join(locks, `hold.${k}`))) letGo(locks, k); });
  const holding = () => alive(readOr(held));
  return {
    held: (s = 30) => waitFor(() => fs.existsSync(held), `${unit}'s session is working`, s),
    holding,
    go: () => letGo(locks, k),
  };
}
export function letGo(locks: string, k: string) {
  for (const x of ["hold", "held"]) fs.rmSync(path.join(locks, `${x}.${k}`), { force: true });
  fs.writeFileSync(path.join(locks, `go.${k}`), "");
}
// The held session working now: its unit as group-slug (held.<group-slug> in the locks), or
// null once the loop has ended without one.
export async function nextHeld(locks: string, r: Run, s = 30): Promise<string | null> {
  let k: string | undefined;
  await waitFor(() => !!(k = fs.readdirSync(locks).find((x) => x.startsWith("held.") && !x.endsWith(".new"))) || r.ended(), "a session is working", s);
  return k ? k.slice("held.".length) : null;
}
