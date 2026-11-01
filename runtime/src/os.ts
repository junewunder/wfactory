// What the runtime asks of the operating system, in its own terms: run a job detached under a
// name so it outlives whoever started it, ask whether it runs, stop it and everything it started,
// run a command under a memory cap and say afterwards whether the cap killed it, and keep the
// machine awake; what it reads of processes (their parents, start times, folders, variables) and
// of a capped run's group; and the few tools whose options differ between systems (file locks, a
// wait for a process to end, reading a time). Everything here goes through one implementation per OS; nothing
// else in the runtime or the tracker calls the OS's service manager or reads /proc or cgroups
// (docs/goal-ts.md, "systemd stays, behind one OS module").
// One for Linux (os/linux.ts) and one for macOS (os/darwin.ts).
import { linux } from "./os/linux.ts";
import { darwin } from "./os/darwin.ts";

export interface JobOptions {
  log?: string;           // stdout and stderr appended to this file
  mem?: string;           // a memory cap ("8G"); past it the kernel kills the job (macOS: a watch, os/darwin-cap.ts)
  stopTimeout?: number;   // seconds a stop waits for the job's own exit before killing it
  keepResult?: boolean;   // a job that failed stays known, with how it ended, until it's forgotten
  onEnd?: string[];       // a command run once the job has ended, however it ended (endedOverCap)
  unset?: string[];       // variables the job doesn't get from the user's own environment either
}

export interface Os {
  // ---- jobs
  // Start <cmd> detached, in the current folder, with these variables only. The exit status of
  // the starting (0: it started).
  startJob(name: string, env: Record<string, string>, cmd: string[], o?: JobOptions): number;
  jobRunning(name: string): boolean;
  // Running, or ended but kept (keepResult).
  jobKnown(name: string): boolean;
  // How a kept job ended ("success", "exit-code", "oom-kill"…), "" if it isn't known.
  jobResult(name: string): string;
  jobPid(name: string): number;
  forgetJob(name: string): void;
  // The names of the jobs matching a pattern (* and ?) that run now.
  runningJobs(pattern: string): string[];
  // Handles (for stop, and to show) of the jobs matching these patterns that are known.
  knownJobs(...patterns: string[]): string[];
  // (A name with * or ? stops each running job it matches.)
  stopJobs(...names: string[]): void;
  endedOverCap(env: NodeJS.ProcessEnv): boolean;
  // Whether a unit someone else started runs, by its full name (an editor's scope or service);
  // null when the service manager doesn't say (it couldn't be asked).
  unitRunning(unit: string): boolean | null;

  // ---- capped runs
  canCap(): boolean;
  // The command line that runs <cmd> in the foreground under the cap, named so it can be asked
  // about while and after it runs. With carryOn, a kill of its biggest process doesn't end the rest.
  cappedCmd(name: string, mem: string, cmd: string[], carryOn?: boolean): string[];
  cappedRunning(name: string): boolean;
  cappedOverCap(name: string): boolean;
  cappedPeak(name: string): string;
  cappedGroup(name: string): string;
  killCapped(name: string): void;
  forgetCapped(name: string): void;
  knownCapped(...patterns: string[]): string[];
  stopCapped(...names: string[]): void;
  myGroup(): string;
  // What a capped run's group (cappedGroup, myGroup) holds now. Its processes, null if the group
  // can't be read.
  groupProcesses(group: string): number[] | null;
  // The memory charged to it and its cap, and how much of that is anonymous, file cache and shared
  // memory (each undefined where it isn't told), in bytes; null if it can't be read or has no cap.
  groupMemory(group: string): GroupMemory | null;
  // The most it has held, "" if that can't be read.
  groupPeak(group: string): string;
  // How often it reached its own cap, and how many of its processes were killed for want of memory
  // (its cap or the whole machine's); null if it can't be read.
  groupKills(group: string): { overCap: number; killed: number } | null;
  // The words run inside the cap before the command (`just capped`): once the command ends they
  // append the group's counts to $FACTORY_CAPPED_STATE, a line each ("oom N", "oom_kill N",
  // "peak N"), then "done".
  cappedStep: string[];

  stop(...handles: string[]): void;

  // ---- processes, by pid (0 and below: no process)
  // When it started, as a token that tells it from a later process given the same pid: one word
  // of digits (records keep it beside the pid, a space between, and a store mark whose token
  // isn't digits is an older copy's), the same for as long as the process runs; "" if it's gone.
  processStart(pid: number): string;
  // Its parent's pid, 0 if it's gone.
  processParent(pid: number): number;
  // Whether it has ended: no such process, or one that has exited and not yet been reaped.
  processEnded(pid: number): boolean;
  // A process and everything under it: itself first, then each child followed by everything under it.
  processTree(pid: number): number[];
  // Its command line, word by word; null if it can't be read.
  processArgs(pid: number): string[] | null;
  // The folder it runs in; null if it can't be read.
  processFolder(pid: number): string | null;
  // The variables it was started with; null if they can't be read.
  processEnv(pid: number): Record<string, string> | null;
  // What each of these that still runs holds in memory (resident, in bytes; on macOS its footprint,
  // what a cap counts there) and its command line.
  processMemory(pids: number[]): { pid: number; rss: number; cmd: string }[];
  // The processes whose command line matches this regular expression (extended), never this
  // process or the ones it runs under; none if they couldn't be looked for.
  processesMatching(pattern: string): number[];

  // A command that runs until <pid> ends, even if that one is killed: given a lock's open file, it
  // holds the lock across a restart.
  untilEnds(pid: number): string[];

  // ---- locks: flock(2)'s, on an open file, which bash scripts and the other lanes see too
  // Take it on this open descriptor, waiting up to <secs> seconds for whoever has it (0: not at
  // all; Infinity: as long as it takes). Whether it's ours now; it stays so until every copy of the
  // descriptor is closed. flock(2)'s, never fcntl's: those belong to the process, so closing any
  // descriptor of the file (sys.ts, lockHeld) would let go of the process's other locks on it.
  lockFd(fd: number, secs: number): boolean;

  // ---- a time as people write it ("09:00", "9am", "tomorrow 9am", "-24 hours"), in epoch
  // seconds; null if it can't be read
  readTime(when: string): number | null;

  // ---- what to tell a person to run, to see more of a job or unit than a message says
  unitStatusHint(unit: string): string;
  jobLogHint(name: string): string;

  // ---- another machine (ssh)
  jobRunningCmd(name: string): string[];
  sessionEnvScript: string;

  // ---- staying awake while this process runs; the holder's pid, 0 if none
  canStayAwake(): boolean;
  stayAwake(why: string): number;

  // ---- the daemon's own service, started at login
  // Write it (and enable it at login) to run <cmd> with these variables, restarted when it fails
  // but not when it exits cleanly; a no-op when it's already so.
  installService(name: string, description: string, cmd: string[], env: Record<string, string>): void;
  startService(name: string): void;
  restartService(name: string): void;
  // The command line the service runs now, "" if it isn't installed.
  serviceCmd(name: string): string;
  // Which run of the user's service manager this is: it changes when the machine restarts or the
  // user's last session ends, not when a job or the daemon restarts.
  managerId(): string;
  // Whether the user's services go on running after they log out; null if it can't be told.
  lingering(): boolean | null;
  // Why lanes in this folder can't be brought back after the machine restarts, "" if they can.
  bootBlocked(dir: string): string;
  // The desktop session's variables as the service manager has them now (display, bus).
  sessionEnv(): Record<string, string>;

  // ---- memory: the machine's budget of heavy jobs (src/heavy.ts), and what the overseer hears
  // (fleet wait and the beat, through the daemon). One reader of each: /proc/meminfo or vm_stat,
  // and the kernel's log; FACTORY_MEMINFO (a file in /proc/meminfo's format) and
  // FACTORY_KERNEL_LOG (one in journalctl -k -o short-unix's) stand in for them in the tests.
  // The machine's memory and how much of it is available now (what the kernel can hand out
  // without swapping, cache included: `free`'s "available"), in bytes; available is null if it
  // can't be read.
  memory(): { total: number; available: number | null };
  // When a capped run that has ended did (epoch ms), while it's still known; 0 if it isn't.
  cappedEnded(name: string): number;

  // ---- what the overseer reads of a machine
  // A job's state as the service manager has it now: "unknown" when it couldn't be asked (the
  // manager slow or out of reach, as under memory pressure), which is never a stop.
  jobState(name: string): "running" | "stopped" | "unknown";
  // The exit statuses of jobRunningCmd that mean the job isn't running (any other but 0: it
  // couldn't be asked).
  jobStoppedStatus: number[];
  // The command line that prints memory()'s available figure, for another machine's shell.
  memAvailableCmd: string[];
  // What the kernel killed for want of memory since <since> (epoch seconds), oldest first; null
  // if its log can't be read (macOS: its kills, jetsam's, are never read).
  oomKills(since: number): OomKill[] | null;
}

export interface OomKill {
  at: number;        // epoch seconds
  task: string;      // the process's name
  pid: number;
  rss: number;       // what it held when killed, in bytes
  unit: string;      // the unit (service or scope) it ran in, "" if none
  machine: boolean;  // the whole machine ran out; false: its unit's memory cap
}

export interface GroupMemory {
  used: number;
  cap: number;
  anon?: number;
  file?: number;
  shmem?: number;
}

export const platform: Os = process.platform === "darwin" ? darwin : linux;

// Whether the kernel killed a process because the whole machine ran out of memory (not a group
// over its own cap) since this time (epoch ms); null if its log can't be read.
export function machineOomSince(ms: number): boolean | null {
  const ks = platform.oomKills(Math.floor(ms / 1000));
  return ks === null ? null : ks.some((k) => k.machine);
}

// What the runtime runs on another machine over ssh, which may be on either system: each command
// asks the machine which it is (uname), then runs that system's own.
const shWords = (cmd: string[]) => cmd.map((w) => `'${w.replace(/'/g, `'\\''`)}'`).join(" ");
const either = (mac: string, other: string) => `if [ "$(uname)" = Darwin ]; then ${mac}; else ${other}; fi`;
export const remote = {
  // Exit 0 while the job runs; one of jobStoppedStatus when it doesn't; anything else: it couldn't
  // be asked.
  jobRunningCmd: (name: string) => ["sh", "-c", either(shWords(darwin.jobRunningCmd(name)), shWords(linux.jobRunningCmd(name)))],
  jobStoppedStatus: [...new Set([...linux.jobStoppedStatus, ...darwin.jobStoppedStatus])],
  // Exports the desktop session's variables that a non-login ssh shell lacks.
  sessionEnvScript: either(darwin.sessionEnvScript, linux.sessionEnvScript),
  memAvailableCmd: ["sh", "-c", either(shWords(darwin.memAvailableCmd), shWords(linux.memAvailableCmd))],
};
