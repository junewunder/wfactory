// What the runtime asks of the OS (src/os.ts), on Linux: systemd user units for jobs that outlive
// the shell that started them and for memory caps, cgroup v2 files for what a capped job used,
// logind for staying awake, and /proc for processes. Nothing else in the runtime calls systemd or
// reads /proc or cgroups.
//
// A job is a systemd service (<name>.service); a capped run is a scope (<name>.scope). The
// handles the listings return are the unit names, which `stop` takes back and a person can read.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Os, JobOptions, OomKill, GroupMemory } from "../os.ts";

const systemctl = (...a: string[]) => spawnSync("systemctl", ["--user", ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
// A unit's property (`systemctl show -p P --value`), "" if there's none.
const show = (unit: string, p: string) => (systemctl("show", "-p", p, "--value", unit).stdout ?? "").trim();
const listUnits = (...a: string[]) =>
  (systemctl("list-units", "--plain", "--no-legend", ...a).stdout ?? "")
    .split("\n").map((l) => l.trim().split(/\s+/)[0]).filter(Boolean);
const svc = (n: string) => `${n}.service`, scope = (n: string) => `${n}.scope`;
const stopUnits = (...units: string[]) => { if (units.length) systemctl("stop", ...units); };
// systemd's version, 0 if it can't be told.
const version = () => Number(/^systemd (\d+)/.exec(spawnSync("systemd-run", ["--version"], { encoding: "utf8" }).stdout ?? "")?.[1] ?? 0);
// `command -v`: is it on PATH?
const onPath = (c: string) => (process.env.PATH ?? "").split(":").some((d) => { try { fs.accessSync(path.join(d || ".", c), fs.constants.X_OK); return true; } catch { return false; } });
// systemd reads a command line in a property (ExecStopPost) itself: each word quoted.
const cmdLine = (cmd: string[]) => cmd.map((w) => `"${w.replace(/(["\\])/g, "\\$1")}"`).join(" ");

const read = (f: string) => { try { return fs.readFileSync(f, "utf8"); } catch { return null; } };
// /proc/<pid>/stat's fields after the command's name (which may hold spaces and parentheses):
// [0] the state, [1] the parent, [19] the start time in clock ticks since boot. null if it's gone.
const stat = (pid: number | string) => { const s = read(`/proc/${pid}/stat`); return s === null ? null : s.slice(s.lastIndexOf(")") + 2).split(" "); };
// A cgroup file's "key value" lines (memory.stat, memory.events), in order; null if unreadable.
const rows = (f: string) => read(f)?.split("\n").map((l) => l.split(/\s+/)).filter((x) => x.length >= 2) ?? null;
const STEP = fileURLToPath(new URL("../../capped-step.sh", import.meta.url));

const jobProps = (o: JobOptions) => [
  ...(o.log ? [`StandardOutput=append:${o.log}`, `StandardError=append:${o.log}`] : []),
  ...(o.mem ? [`MemoryMax=${o.mem}`, "MemorySwapMax=0"] : []),
  ...(o.stopTimeout ? [`TimeoutStopSec=${o.stopTimeout}`] : []),
  ...(o.onEnd ? [`ExecStopPost=${cmdLine(o.onEnd)}`] : []),
  ...(o.unset?.length ? [`UnsetEnvironment=${o.unset.join(" ")}`] : []),
];

export const linux: Os = {
  // ---- jobs: run detached under a name, outliving whoever started them
  startJob(name, env, cmd, o = {}) {
    const r = spawnSync("systemd-run", ["--user", "--unit", name, "--same-dir", "--quiet", ...(o.keepResult ? [] : ["--collect"]),
      ...Object.entries(env).flatMap(([k, v]) => ["-E", `${k}=${v}`]), ...jobProps(o).flatMap((p) => ["-p", p]), "--", ...cmd], { stdio: "inherit" });
    return r.status ?? 1;
  },
  jobRunning: (name) => systemctl("is-active", "-q", svc(name)).status === 0,
  jobKnown: (name) => show(svc(name), "LoadState") === "loaded",
  jobResult: (name) => show(svc(name), "Result"),
  jobPid: (name) => Number(show(svc(name), "MainPID")) || 0,
  forgetJob: (name) => { systemctl("reset-failed", svc(name)); },
  runningJobs: (pattern) => listUnits("--state=active,activating,reloading", svc(pattern)).map((u) => u.replace(/\.service$/, "")),
  knownJobs: (...patterns) => patterns.length ? listUnits(...patterns.map(svc)) : [],
  stopJobs: (...names) => stopUnits(...names.map(svc)),
  // In the command a job's onEnd runs: did the job end killed over its memory cap?
  endedOverCap: (env) => env.SERVICE_RESULT === "oom-kill",
  unitRunning: (unit) => { const s = show(unit, "ActiveState"); return s ? ["active", "activating", "deactivating", "reloading"].includes(s) : null; },

  // ---- capped runs: a command in the foreground under a memory cap
  canCap: () => onPath("systemd-run"),
  // The kernel kills only the biggest process; whether the rest of the run carries on after it.
  // (Scopes take OOMPolicy from systemd 253 on; before that, the whole run is stopped.)
  // (From systemd 254 on, systemd-run reads $ in the command as its own variables: `$$` in a
  // `bash -c` came out as `$`. --expand-environment=no passes it through as written.)
  cappedCmd: (name, mem, cmd, carryOn = false) =>
    ["systemd-run", "--user", "--scope", "--quiet", ...(version() >= 254 ? ["--expand-environment=no"] : []),
      ...[`MemoryMax=${mem}`, "MemorySwapMax=0", ...(carryOn && version() >= 253 ? ["OOMPolicy=continue"] : [])].flatMap((p) => ["-p", p]), "--unit", name, "--", ...cmd],
  cappedRunning: (name) => { const s = show(scope(name), "ActiveState"); return s === "active" || s === "deactivating"; },
  cappedOverCap: (name) => show(scope(name), "Result") === "oom-kill",
  cappedPeak: (name) => show(scope(name), "MemoryPeak"),
  // Its cgroup's folder, where the kernel counts kills (memory.events) and the processes in it are
  // listed; "" while it isn't there.
  cappedGroup: (name) => { const cg = show(scope(name), "ControlGroup"); return cg ? `/sys/fs/cgroup${cg}` : ""; },
  killCapped: (name) => { systemctl("kill", "--signal=KILL", scope(name)); },
  forgetCapped: (name) => { systemctl("reset-failed", scope(name)); },
  knownCapped: (...patterns) => patterns.length ? listUnits(...patterns.map(scope)) : [],
  stopCapped: (...names) => stopUnits(...names.map(scope)),
  // The folder of the group this process is in (a capped run's own, inside one).
  myGroup: () => {
    let cg = "";
    try { for (const l of fs.readFileSync("/proc/self/cgroup", "utf8").split("\n")) if (l.startsWith("0::")) cg = l.slice(3); } catch {}
    return `/sys/fs/cgroup${cg}`;
  },

  // A group is its cgroup's folder. Its processes are listed in it and in the groups under it.
  groupProcesses: (g) => {
    const top = read(`${g}/cgroup.procs`);
    if (top === null) return null;
    const pids = [top];
    try { for (const e of fs.readdirSync(g, { withFileTypes: true })) if (e.isDirectory()) pids.push(read(`${g}/${e.name}/cgroup.procs`) ?? ""); } catch {}
    return pids.join("\n").split(/\s+/).filter(Boolean).map(Number);
  },
  groupMemory: (g) => {
    const st = rows(`${g}/memory.stat`);
    const cur = (read(`${g}/memory.current`) ?? "").trim(), max = (read(`${g}/memory.max`) ?? "").trim();
    // ("max": no cap.)
    if (st === null || !/^[0-9]+$/.test(cur) || !/^[0-9]+$/.test(max)) return null;
    const m: GroupMemory = { used: Number(cur), cap: Number(max) };
    for (const k of ["anon", "file", "shmem"] as const) { const r = st.find((x) => x[0] === k); if (r && /^[0-9]+$/.test(r[1])) m[k] = Number(r[1]); }
    return m;
  },
  groupPeak: (g) => (read(`${g}/memory.peak`) ?? "").trim(),
  groupKills: (g) => {
    const ev = rows(`${g}/memory.events`);
    if (ev === null) return null;
    const n = (k: string) => Number(ev.find((x) => x[0] === k)?.[1] ?? 0) || 0;
    return { overCap: n("oom"), killed: n("oom_kill") };
  },
  // Bash, which costs the cap almost nothing and still runs with the scope full (docs/goal-ts.md).
  cappedStep: ["bash", STEP],

  // A listing's handles, whatever kind.
  stop: (...handles) => stopUnits(...handles),

  // ---- processes: /proc
  processStart: (pid) => pid > 0 ? stat(pid)?.[19] ?? "" : "",
  processParent: (pid) => pid > 0 ? Number(stat(pid)?.[1]) || 0 : 0,
  // (A zombie has exited: only its parent's wait is left, and one from before a restart has none.)
  processEnded: (pid) => {
    if (!(pid > 0)) return true;
    try { process.kill(pid, 0); } catch { return true; }
    return stat(pid)?.[0] === "Z";
  },
  // Every process's parent, read first, so the list is of one moment.
  processTree: (pid) => {
    if (!(pid > 0)) return [];
    const kids = new Map<number, number[]>();
    for (const e of fs.readdirSync("/proc")) {
      if (!/^[0-9]+$/.test(e)) continue;
      const pp = Number(stat(e)?.[1]);
      if (pp >= 0) kids.set(pp, [...(kids.get(pp) ?? []), Number(e)]);
    }
    const all: number[] = [];
    const walk = (p: number) => { all.push(p); for (const c of kids.get(p) ?? []) walk(c); };
    walk(pid);
    return all;
  },
  processArgs: (pid) => { const c = read(`/proc/${pid}/cmdline`); return c === null ? null : c.replace(/\0$/, "").split("\0"); },
  processFolder: (pid) => { try { return fs.readlinkSync(`/proc/${pid}/cwd`); } catch { return null; } },
  processEnv: (pid) => {
    const e = read(`/proc/${pid}/environ`);
    if (e === null) return null;
    const vars: Record<string, string> = {};
    for (const v of e.split("\0")) if (v.includes("=") && !Object.hasOwn(vars, v.slice(0, v.indexOf("=")))) vars[v.slice(0, v.indexOf("="))] = v.slice(v.indexOf("=") + 1);
    return vars;
  },
  // (The command line as the kernel keeps it: each word followed by a space.)
  processMemory: (pids) => pids.flatMap((pid) => {
    const st = read(`/proc/${pid}/status`), cl = read(`/proc/${pid}/cmdline`);
    const m = st && /^VmRSS:\s*(\d+)/m.exec(st);
    const cmd = cl?.replace(/\0/g, " ");
    return m && cmd ? [{ pid, rss: Number(m[1]) * 1024, cmd }] : [];
  }),
  // pgrep's -A: not its own shell or any other ancestor.
  processesMatching: (pattern) => {
    const r = spawnSync("pgrep", ["-A", "-f", pattern], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return r.status === 0 ? (r.stdout ?? "").split("\n").filter(Boolean).map(Number) : [];
  },

  untilEnds: (pid) => ["tail", `--pid=${pid}`, "-f", "/dev/null"],

  // flock(1), on the open file handed over as its descriptor 3 (Node has no flock(2)): the lock
  // belongs to the open file, so it stays ours when flock exits.
  lockFd: (fd, secs) => spawnSync("flock", [...secs === Infinity ? [] : secs > 0 ? ["-w", String(secs)] : ["-n"], "3"],
    { stdio: ["ignore", "ignore", "inherit", fd] }).status === 0,

  readTime: (when) => {
    const r = spawnSync("date", ["-d", when, "+%s"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return r.status === 0 && /^-?[0-9]+$/.test(r.stdout.trim()) ? Number(r.stdout.trim()) : null;
  },

  unitStatusHint: (unit) => `systemctl --user status ${unit}`,
  jobLogHint: (name) => `journalctl --user -u ${name}`,

  // ---- another machine, over ssh: command lines for its shell
  // Whether a job runs there (exit 0), and its desktop session's variables (display, bus)
  // exported, which a non-login ssh shell lacks.
  jobRunningCmd: (name) => ["systemctl", "--user", "is-active", "-q", svc(name)],
  sessionEnvScript: `eval "$(systemctl --user show-environment | grep -E '^(DISPLAY|WAYLAND_DISPLAY|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS)=' | sed 's/^/export /')"`,

  // ---- staying awake
  // A logind inhibitor on sleep, idle and the lid switch, held by a process that ends with this
  // one (`tail --pid`), even if it's killed. Its pid, to end it sooner; 0 if logind's tool isn't
  // there. Where logind refuses one (polkit), nothing is held, and the machine's own power
  // settings apply.
  canStayAwake: () => onPath("systemd-inhibit"),
  stayAwake(why) {
    try {
      const c = spawn("systemd-inhibit", ["--no-ask-password", "--what=sleep:idle:handle-lid-switch", "--who=wfactory", `--why=${why}`, "--mode=block",
        ...linux.untilEnds(process.pid)], { stdio: "ignore", detached: true });
      c.on("error", () => {}); c.unref();
      return c.pid ?? 0;
    } catch { return 0; }
  },

  // ---- the daemon's service: a unit file in the user's systemd folder (FACTORY_DAEMON_UNIT_DIR
  // for another, which isn't enabled at login: the tests' runtime folder)
  installService(name, description, cmd, env) {
    const own = path.join(os.homedir(), ".config", "systemd", "user");
    const dir = process.env.FACTORY_DAEMON_UNIT_DIR || own;
    const text = `# Written by wfactory (main.mjs daemon install): changes are overwritten.
[Unit]
Description=${description}
StartLimitIntervalSec=600
StartLimitBurst=5

[Service]
ExecStart=${cmdLine(cmd)}
${Object.entries(env).map(([k, v]) => `Environment=${cmdLine([`${k}=${v}`])}\n`).join("")}Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
    const f = path.join(dir, `${name}.service`);
    let was = ""; try { was = fs.readFileSync(f, "utf8"); } catch {}
    if (was !== text) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(`${f}.tmp`, text); fs.renameSync(`${f}.tmp`, f);
      systemctl("daemon-reload");
    }
    if (dir === own && systemctl("is-enabled", "-q", svc(name)).status !== 0) systemctl("enable", "-q", svc(name));
  },
  startService: (name) => { systemctl("reset-failed", svc(name)); systemctl("start", svc(name)); },
  restartService: (name) => { systemctl("try-restart", svc(name)); },
  serviceCmd: (name) => /argv\[\]=([^;]*)/.exec(show(svc(name), "ExecStart"))?.[1].trim() ?? "",
  managerId: () => {
    let boot = ""; try { boot = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(); } catch {}
    // The manager's own start, in the boot's clock.
    return `${boot}/${(systemctl("show", "-p", "UserspaceTimestampMonotonic", "--value").stdout ?? "").trim()}`;
  },
  bootBlocked: () => "",
  lingering: () => {
    const r = spawnSync("loginctl", ["show-user", os.userInfo().username, "-p", "Linger", "--value"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const v = (r.stdout ?? "").trim();
    return v === "yes" ? true : v === "no" ? false : null;
  },
  sessionEnv: () => Object.fromEntries((systemctl("show-environment").stdout ?? "").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])),

  // ---- memory: /proc/meminfo (FACTORY_MEMINFO: the tests' made-up machine)
  memory: () => {
    let text: string | null = null; try { text = fs.readFileSync(process.env.FACTORY_MEMINFO || "/proc/meminfo", "utf8"); } catch {}
    const kb = (k: string) => { const v = text && new RegExp(`^${k}:\\s+(\\d+)`, "m").exec(text)?.[1]; return v ? Number(v) * 1024 : null; };
    return { total: kb("MemTotal") ?? 0, available: kb("MemAvailable") };
  },
  cappedEnded: (name) => Number(/^@([0-9]+)/.exec((systemctl("show", "--timestamp=unix", "-p", "InactiveEnterTimestamp", "--value", scope(name)).stdout ?? "").trim())?.[1] ?? 0) * 1000,

  // ---- what the overseer reads of a machine
  // `is-active` says only yes or no, and no when it can't reach the manager too; ActiveState
  // comes back only from a manager that answered. (A unit it doesn't know is "inactive".)
  jobState: (name) => {
    const r = systemctl("show", "-p", "ActiveState", "--value", svc(name));
    const s = (r.stdout ?? "").trim();
    if (r.status !== 0 || !s) return "unknown";
    return s === "inactive" || s === "failed" ? "stopped" : "running";
  },
  // is-active: 3 for a unit that isn't active, 4 for one it doesn't know; 1 when it couldn't ask.
  jobStoppedStatus: [3, 4],
  memAvailableCmd: ["sh", "-c", `awk '/^MemAvailable:/ { printf "%d\\n", $2 * 1024 }' "\${FACTORY_MEMINFO:-/proc/meminfo}"`],
  // The kernel's log (journalctl -k; FACTORY_KERNEL_LOG: a file of its lines, the tests'):
  // each kill is an "oom-kill:" line naming the task and its cgroup, then "Killed process <pid>"
  // with what it held. A kill at a cap is CONSTRAINT_MEMCG; one for the whole machine isn't.
  oomKills: (since) => {
    let text: string;
    const fake = process.env.FACTORY_KERNEL_LOG;
    if (fake) { try { text = fs.readFileSync(fake, "utf8"); } catch { return null; } }
    else {
      const r = spawnSync("journalctl", ["-k", "-q", "--no-pager", "-o", "short-unix", "--since", `@${Math.floor(since)}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 << 20 });
      if (r.status !== 0) return null;
      text = r.stdout ?? "";
    }
    const out: OomKill[] = [];
    const open = new Map<number, OomKill>();
    for (const l of text.split("\n")) {
      const m = /^(\d+(?:\.\d+)?) \S+ kernel: (.*)$/.exec(l);
      if (!m || Number(m[1]) < since) continue;
      const at = Math.floor(Number(m[1])), msg = m[2];
      const k = /^oom-kill:(.*)$/.exec(msg);
      if (k) {
        const f = Object.fromEntries(k[1].split(",").map((x) => [x.slice(0, x.indexOf("=")), x.slice(x.indexOf("=") + 1)]));
        const pid = Number(f.pid) || 0;
        const o: OomKill = { at, task: f.task ?? "", pid, rss: 0, unit: path.basename(f.task_memcg ?? ""), machine: f.constraint !== "CONSTRAINT_MEMCG" };
        out.push(o); open.set(pid, o);
        continue;
      }
      const d = /Killed process (\d+) \(([^)]*)\).*?anon-rss:(\d+)kB, file-rss:(\d+)kB, shmem-rss:(\d+)kB/.exec(msg);
      if (d) {
        const o = open.get(Number(d[1]));
        if (o) { o.rss = (Number(d[3]) + Number(d[4]) + Number(d[5])) * 1024; o.task ||= d[2]; open.delete(o.pid); }
      }
    }
    return out;
  },
};
