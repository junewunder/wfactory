// Memory caps on macOS (os/darwin.ts), which has no cgroups: a watch over a group of processes
// that adds up their memory, keeps the peak, and over the cap kills the biggest, as Linux's kernel
// does. The kernel doesn't enforce it: memory is looked at once a second ($FACTORY_CAP_POLL, in
// seconds), so a run that grows fast can go past its cap until the next look.
//
// A group is a folder. The process at its top is in "pid" ("<pid> <start>"), its cap in "cap" (a
// systemd size, 50% or infinity); the watch writes there what it last saw ("procs", a "<pid>
// <start>" line each), the most it has held ("peak", bytes), and its kills ("kills": "<over the
// cap> <killed>"), each before the kill it counts. What's in the group: the top process
// and everything under it, everything seen under it before (a process whose parent has exited is
// handed to launchd), and whatever holds the group's mark (a file every process of the group has
// open as descriptor 3, inherited by what it starts; os/darwin-job.ts's header says what that
// misses).
//
// Memory is each process's footprint, what macOS itself counts against a process (compressed
// memory too, unlike its RSS): proc_pid_rusage, through perl's syscall, since Node can't ask for
// another process's. ps's RSS where that's refused.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// The folders of jobs (os/darwin.ts) and of capped runs: each a group.
export const jobsDir = () => process.env.FACTORY_JOBS_DIR || path.join(os.homedir(), "Library", "Caches", "wfactory", "jobs");
export const cappedDirs = () => path.join(path.dirname(jobsDir()), "capped");
// The processes at the top of every group but this one (a job's supervisor too): a group doesn't
// reach into another, as a cgroup on Linux doesn't. (A capped run started inside another, or a
// long job a session started, is its own, with its own cap.)
function fences(own: string) {
  const s = new Set<number>();
  for (const top of [jobsDir(), cappedDirs()]) {
    let names: string[] = [];
    try { names = fs.readdirSync(top); } catch {}
    for (const n of names) {
      const d = path.join(top, n);
      if (n.startsWith(".") || d === own) continue;
      for (const f of ["pid", "runner"]) { const p = Number((read(path.join(d, f)) ?? "").split(" ")[0]); if (p > 0) s.add(p); }
    }
  }
  return s;
}

const read = (f: string) => { try { return fs.readFileSync(f, "utf8"); } catch { return null; } };
// (Into a file of its own, then renamed: a reader never sees half of it.)
export const put = (f: string, text: string) => { fs.writeFileSync(`${f}.tmp`, text); fs.renameSync(`${f}.tmp`, f); };
export const poll = () => Math.max(0.05, Number(process.env.FACTORY_CAP_POLL) || 1) * 1000;

export interface Proc { pid: number; ppid: number; rss: number; zombie: boolean; start: string }
// ps's lstart ("Mon Oct 26 23:35:06 2026", local time) in epoch seconds.
export const startOf = (lstart: string) => { const t = Date.parse(lstart.replace(/\s+/g, " ")); return Number.isFinite(t) ? String(t / 1000) : ""; };
// Every process now, at one look. (In the C locale: ps prints dates in the user's language otherwise.)
export function procs(): Map<number, Proc> {
  const r = spawnSync("ps", ["-A", "-o", "pid=,ppid=,rss=,stat=,lstart="], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" }, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 << 20 });
  const m = new Map<number, Proc>();
  for (const l of (r.stdout ?? "").split("\n")) {
    const x = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(l);
    if (x) m.set(Number(x[1]), { pid: Number(x[1]), ppid: Number(x[2]), rss: Number(x[3]) * 1024, zombie: x[4].startsWith("Z"), start: startOf(x[5]) });
  }
  return m;
}

// Each pid's footprint, in bytes: proc_info (syscall 336), PIDRUSAGE (9), RUSAGE_INFO_V2 (2), whose
// ri_phys_footprint is the 8 bytes at 72. A pid it's refused for is left out.
const FOOTPRINT = `for my $p (@ARGV) { my $b = "\\0" x 512; next if syscall(336, 9, $p + 0, 2, 0, $b, 0) != 0; print "$p ", unpack("Q<", substr($b, 72, 8)), "\\n" }`;
export function footprints(pids: number[]): Map<number, number> {
  const m = new Map<number, number>();
  if (!pids.length) return m;
  const r = spawnSync("perl", ["-e", FOOTPRINT, ...pids.map(String)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  for (const l of (r.stdout ?? "").split("\n")) { const [p, n] = l.split(" ").map(Number); if (p > 0 && n >= 0) m.set(p, n); }
  return m;
}

// The processes holding a file open.
export const holders = (f: string) =>
  (spawnSync("lsof", ["-t", f], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).stdout ?? "").split("\n").map(Number).filter((p) => p > 0);

// A cap in bytes: a systemd size, a share of the machine's memory (50%), or none (infinity, 0).
export function capBytes(s: string, total: number) {
  const t = s.trim();
  const m = /^([0-9]+(?:\.[0-9]+)?)([KMGT]?)$/.exec(t);
  if (m) return Math.round(Number(m[1]) * 1024 ** " KMGT".indexOf(m[2] || " "));
  const p = /^([0-9]+(?:\.[0-9]+)?)%$/.exec(t);
  return p ? Math.round(total * Number(p[1]) / 100) : 0;
}
let total = 0;
export const totalMemory = () => total ||= Number(spawnSync("sysctl", ["-n", "hw.memsize"], { encoding: "utf8" }).stdout) || 0;

// What a group's folder says, for os/darwin.ts's group calls.
export const groupKills = (g: string) => {
  if (!g || !fs.existsSync(g)) return null;
  const [o = 0, k = 0] = (read(path.join(g, "kills")) ?? "").trim().split(" ").map((x) => Number(x) || 0);
  return { overCap: o, killed: k };
};
export const groupPeak = (g: string) => g ? (read(path.join(g, "peak")) ?? "").trim() : "";
// The "<pid> <start>" lines of a file, each with its start.
export const pidLines = (f: string) => (read(f) ?? "").split("\n").flatMap((l) => { const [p, st = ""] = l.trim().split(" "); return Number(p) > 0 ? [[Number(p), st] as const] : []; });

// The watch over one group. look() takes in what's in it now, measure() adds up their memory and,
// over the cap, kills the biggest (it returns true then). onOver: what else a kill over the cap
// does (a job's whole stop).
export class Watch {
  seen = new Map<number, string>();   // everything seen of the group, with its start (a pid used again since is left alone)
  live: Proc[] = [];                  // what's in it, at the last look
  peak = 0;
  kills = { overCap: 0, killed: 0 };
  killing = 0;                        // the process last killed over the cap, while it's still going
  readonly dir: string; top: number; readonly cap: number; readonly self: number;
  constructor(dir: string, top: number, cap: number, self = process.pid) {
    this.dir = dir; this.top = top; this.cap = cap; this.self = self;
    const p = Number(groupPeak(dir)); if (p > 0) this.peak = p;
    const k = groupKills(dir); if (k) this.kills = k;
  }
  // (keep: written to the folder's "procs", as the watch keeps it; a look from outside the watch
  // leaves it alone.)
  look(keep = true) {
    const all = procs();
    const kids = new Map<number, number[]>();
    for (const p of all.values()) kids.set(p.ppid, [...(kids.get(p.ppid) ?? []), p.pid]);
    const ours = (pid: number) => { const p = all.get(pid); const st = this.seen.get(pid); return !!p && (st === undefined || st === p.start); };
    const roots = [this.top, ...this.seen.keys(), ...holders(path.join(this.dir, "mark"))];
    const found = new Set<number>(), fenced = fences(this.dir);
    const walk = (pid: number) => {
      if (found.has(pid) || pid === this.self || pid <= 1 || fenced.has(pid) || !ours(pid)) return;
      found.add(pid);
      for (const c of kids.get(pid) ?? []) walk(c);
    };
    for (const r of roots) walk(r);
    for (const pid of found) if (!this.seen.has(pid)) this.seen.set(pid, all.get(pid)!.start);
    this.live = [...found].map((p) => all.get(p)!).filter((p) => !p.zombie);
    if (keep) { try { put(path.join(this.dir, "procs"), this.live.map((p) => `${p.pid} ${p.start}\n`).join("")); } catch {} }
    return this.live;
  }
  // Signal everything in the group that's still the process it was.
  signal(sig: NodeJS.Signals, group = 0) {
    if (group > 0) { try { process.kill(-group, sig); } catch {} }
    const now = procs();
    for (const [p, st] of this.seen) if (now.get(p)?.start === st) { try { process.kill(p, sig); } catch {} }
  }
  left() { const now = procs(); return [...this.seen].some(([p, st]) => { const x = now.get(p); return !!x && x.start === st && !x.zombie; }); }
  // What each process at the last look holds, and all of it, in bytes.
  usage() {
    const fp = footprints(this.live.map((p) => p.pid));
    const each = this.live.map((p) => ({ pid: p.pid, start: p.start, mem: fp.get(p.pid) ?? p.rss }));
    return { each, used: each.reduce((n, x) => n + x.mem, 0) };
  }
  measure(onOver?: () => void) {
    const { each, used } = this.usage();
    if (used > this.peak) { this.peak = used; try { fs.writeFileSync(path.join(this.dir, "peak"), `${used}\n`); } catch {} }
    // (One kill at a time: the memory of the one killed takes a moment to be given back.)
    if (this.killing && each.some((x) => x.pid === this.killing)) return false;
    this.killing = 0;
    if (!(this.cap > 0) || used <= this.cap || !each.length) return false;
    const big = each.reduce((a, b) => b.mem > a.mem ? b : a);
    this.kills.overCap++; this.kills.killed++;
    try { fs.writeFileSync(path.join(this.dir, "kills"), `${this.kills.overCap} ${this.kills.killed}\n`); } catch {}
    try { process.kill(big.pid, "SIGKILL"); } catch {}
    this.killing = big.pid;
    onOver?.();
    return true;
  }
}
