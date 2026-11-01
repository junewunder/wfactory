// What the files in test/loop/fleet/ share: a factory whose lanes, long jobs, capped runs and
// daemon are real systemd units, as factory/fleet.sh, oversee.sh and long.sh start them. Each
// file is its own project (named after its area and its process), so its units are its own
// (factory-<project>-*, the daemon factory-<project>-daemon, with its own home and service file),
// and any file runs alone or beside the others without stopping their units. Its units are
// stopped and forgotten when its tests end, before its temp folder goes (the bash suite's EXIT trap).
// Run: node --test test/loop/fleet/
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after } from "node:test";
import { originFactory, background, cmd, chomp, readOr, until, prop, systemctl, killGroup, stopFirst, ROOT, HOST, type Result } from "../../lib/index.ts";
import { CLAUDE } from "../factory.ts";

type Env = NodeJS.ProcessEnv;

const RUNTIME_DIR = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid!()}`;

// The kill over a memory cap these files use: a fake one on Linux unless FACTORY_TEST_OOM=1 (each
// real one pops Plasma's "Memory Shortage Avoided"). The fake hog writes what capped.sh's step in the scope
// would have read from the kernel (the cap reached, a kill, the peak), then kills itself; a long job's stop step
// is told it was the cap (oomNote). Real: tail /dev/zero eats memory; on macOS, where the
// kills are the watch's and pop nothing, always real, a perl that eats it.
export function hog(binDir: string) {
  if (process.env.FACTORY_TEST_OOM && process.platform !== "darwin") return { HOG: "tail /dev/zero", real: true };
  fs.mkdirSync(binDir, { recursive: true });
  const f = path.join(binDir, "hog");
  if (process.platform === "darwin") {
    fs.writeFileSync(f, `#!/usr/bin/perl\nmy @x; while (1) { push @x, "a" x 5_000_000; select(undef, undef, undef, 0.05) }\n`, { mode: 0o755 });
    return { HOG: f, real: true };
  }
  fs.writeFileSync(f, '#!/usr/bin/env bash\nprintf "oom 1\\noom_kill 1\\npeak 31457280\\n" >> "${FACTORY_CAPPED_STATE:-/dev/null}"\nkill -9 $$\n', { mode: 0o755 });
  return { HOG: f, real: false };
}

// A factory made by init.sh on a local bare origin (test/lib's originFactory), run as the bash suite
// ran it: test/loop/factory.ts's fake claude, group g, a factory/tidy that notes it ran
// (<top>/tidied), this file's own daemon, heavy-job slots enough that nothing queues. Everything is run in F, the
// factory's checkout, as the owner runs it; lanes are the clones fleet.sh makes beside it
// (<F>-lane<N>).
//   P:              the project's name (and so its units' prefix: factory-<P>-…)
//   run(file, args, {cwd, add}): a command (stdout and stderr merged), in F by default
//   fleet / oversee / long / dmn: factory/fleet.sh, factory/oversee.sh (in a lane, lane 1 by
//                   default), factory/long.sh, `main.mjs daemon`
//   bg(file, args, {cwd, add}): a command in the background, in a process group of its own
//                   (test/lib's background()): out() so far, ended(), end(s) (its result once it
//                   ends, failing if it hasn't s seconds on)
//   tr(args):       factory/tracker in F (the real command), its stdout as `$(…)` gives it
//   setup(args):    the tracker in this process in F, for a test's own setup
//   hold(unit):     holds the unit's session (hold.<unit> in the locks): held() waits until it
//                   works, go() lets it go; every hold is let go of when the file ends
//   lane(n):        lane n's clone; laneLog(n), laneEvents(n): its runs/loop.log, runs/events.log
//   ev(kind, text): an event line in lane 1's runs/events.log, as a lane logs one
//   dpid():         the daemon's pid (0 when it isn't running)
//   record(unit):   the daemon's record of a lane, its file
export function fleetFactory(area: string, { lanes = 1 } = {}) {
  const P = `${area}${process.pid}`;
  // (macOS: the daemon's service spec in a folder of the file's own, which the crontab never sees.)
  let unitDir = path.join(RUNTIME_DIR, "systemd", "user");
  const daemonUnit = `factory-${P}-daemon`;
  // Registered before the temp folder's removal, so it runs first (after() hooks run in order):
  // held sessions let go of, and the units stopped.
  const holds: string[] = [];
  let letGo = (_k: string) => {};
  after(() => {
    for (const k of holds) letGo(k);
    systemctl("stop", `factory-${P}.*`, `factory-${P}-*`);
    systemctl("reset-failed", `factory-${P}.*`, `factory-${P}-*`);   // (a lane's result is kept after it ends)
    fs.rmSync(path.join(unitDir, `${daemonUnit}.service`), { force: true });
    systemctl("daemon-reload");
  });
  const f = originFactory(P, {
    claude: CLAUDE,
    prepare: (F) => {
      fs.writeFileSync(path.join(F, "factory/tidy"), `#!/bin/sh\necho tidied >> "${path.dirname(F)}/tidied"\n`, { mode: 0o755 });
      if (lanes !== 1) {
        const mf = path.join(F, "docs/machines.md");
        fs.writeFileSync(mf, fs.readFileSync(mf, "utf8").replace(`| ${HOST} | ${HOST} | 1 |`, `| ${HOST} | ${HOST} | ${lanes} |`));
      }
    },
  });
  const { w, F } = f;
  // (And this process's own: test/lib's prop() asks the Os, which reads it from there.)
  if (process.platform === "darwin") unitDir = process.env.FACTORY_DAEMON_UNIT_DIR = w.at("services");
  Object.assign(w.env, {
    FACTORY_DAEMON_HOME: w.at("daemon"), FACTORY_DAEMON_UNIT: daemonUnit, FACTORY_DAEMON_UNIT_DIR: unitDir,
    FACTORY_DAEMON_IDLE: "5", FACTORY_DAEMON_TICK: "1", FACTORY_DAEMON_SESSION_WAIT: "1", FACTORY_DAEMON_GRACE: "8",
    FACTORY_CPU_LOCKS: w.at("cpu"), FACTORY_HEAVY: "99",
  });
  const locks = w.env.FACTORY_LOCKS!;
  fs.mkdirSync(locks, { recursive: true });
  w.setup(["add-group", "g", "--title", "Group"], F);

  const run = (file: string, args: string[] = [], { cwd = F, add = {} as Env } = {}): Result => cmd(file, args, { cwd, env: w.envWith(add), merged: true });
  const bg = (file: string, args: string[] = [], { cwd = F, add = {} as Env } = {}) => {
    const b = background(file, args, { cwd, env: w.envWith(add), group: true });
    stopFirst(() => killGroup(b.pid!));
    return b;
  };
  const lane = (n = 1) => `${F}-lane${n}`;
  const fleet = (args: string[], add: Env = {}) => run(path.join(F, "factory/fleet.sh"), args, { add });
  const oversee = (args: string[], { n = 1, add = {} as Env } = {}) => run(path.join(lane(n), "factory/oversee.sh"), args, { cwd: lane(n), add });
  const long = (args: string[], { cwd = F, add = {} as Env } = {}) => run(path.join(cwd, "factory/long.sh"), args, { cwd, add });
  const dmn = (args: string[], add: Env = {}) => run(process.execPath, [path.join(ROOT, "runtime/main.mjs"), "daemon", ...args], { add });
  const tr = (args: string[]) => chomp(run(path.join(F, "factory/tracker"), args).stdout);
  const setup = (args: string[]) => w.setup(args, F);
  letGo = (k: string) => {
    for (const x of ["hold", "held"]) fs.rmSync(path.join(locks, `${x}.${k}`), { force: true });
    fs.writeFileSync(path.join(locks, `go.${k}`), "");
  };
  const hold = (unit: string) => {
    const k = unit.replace("/", "-"), held = path.join(locks, `held.${k}`);
    fs.rmSync(path.join(locks, `go.${k}`), { force: true });
    fs.writeFileSync(path.join(locks, `hold.${k}`), "");
    holds.push(k);
    return {
      held: (s = 60) => until(() => fs.existsSync(held), `${unit}'s session is working`, s),
      go: () => letGo(k),
    };
  };
  const laneLog = (n = 1) => readOr(path.join(lane(n), "runs/loop.log"));
  const laneEvents = (n = 1) => readOr(path.join(lane(n), "runs/events.log"));
  const ev = (kind: string, text: string, n = 1) => {
    const d = new Date(), p2 = (x: number) => String(x).padStart(2, "0");
    const at = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
    fs.mkdirSync(path.join(lane(n), "runs"), { recursive: true });
    fs.appendFileSync(path.join(lane(n), "runs/events.log"), `${at}\t${HOST}\t1\t${kind}\t${text}\n`);
  };
  const dpid = () => Number(prop(`${daemonUnit}.service`, "MainPID")) || 0;   // (test/lib's prop: macOS's too)
  const record = (unit: string) => path.join(w.env.FACTORY_DAEMON_HOME!, "lanes", `${unit}.json`);
  return { ...f, P, daemonUnit, locks, run, bg, lane, fleet, oversee, long, dmn, tr, setup, hold, laneLog, laneEvents, ev, dpid, record };
}
export type FleetFactory = ReturnType<typeof fleetFactory>;

// The moment the machine's daemon has first read a lane's runs/events.log, as `fleet wait`'s
// first look has it do: from then on, a line appended there is news to that wait (before it, the
// line would be in its baseline). Read by its access time: set back an hour now, so the next
// read moves it (the kernel moves it on a read when it isn't newer than the file's last change).
// Only the daemon reads that file.
export function readNext(f: string) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.appendFileSync(f, "");
  const st = fs.statSync(f), back = st.mtimeMs / 1000 - 3600;
  fs.utimesSync(f, back, st.mtimeMs / 1000);
  const was = fs.statSync(f).atimeMs;
  assert.ok(was < st.mtimeMs, "the access time was set back");
  return () => until(() => fs.statSync(f).atimeMs > was, `${path.basename(f)} is read`, 30);
}
