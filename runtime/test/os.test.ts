// What the overseer reads of a machine through src/os.ts, on Linux: memory available, the
// kernel's out-of-memory kills, and a lane's state when the service manager can't be asked (a
// global OOM on wren, 2026-10-19 01:37, made `fleet wait` raise "a lane stopped" for a lane
// systemd still ran). The files and the systemctl here are stand-ins. Run: node --test runtime/test/
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { machineOomSince, platform } from "../src/os.ts";
import { look } from "../src/daemon.ts";

// What only Linux reads (the kernel's log, systemd, cgroups): macOS has its own (os-jobs.test.ts).
const linux = { skip: process.platform !== "linux" && "Linux's kernel log, systemd and cgroups" };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "os-test-"));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const withEnv = <T>(add: Record<string, string>, f: () => T): T => {
  const was = Object.fromEntries(Object.keys(add).map((k) => [k, process.env[k]]));
  Object.assign(process.env, add);
  try { return f(); } finally { for (const [k, v] of Object.entries(was)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
};

test("memory: /proc/meminfo's MemTotal and MemAvailable, in bytes", () => {
  const f = path.join(tmp, "meminfo");
  fs.writeFileSync(f, "MemTotal:       32000000 kB\nMemFree:          900000 kB\nMemAvailable:    2097152 kB\n");
  assert.deepEqual(withEnv({ FACTORY_MEMINFO: f }, () => platform.memory()), { total: 32000000 * 1024, available: 2 * 2 ** 30 });
});
test("  available null when it can't be read", () => {
  assert.equal(withEnv({ FACTORY_MEMINFO: path.join(tmp, "none") }, () => platform.memory().available), null);
});

// As journalctl -k -o short-unix prints them (a global OOM, then a unit at its own cap).
const KLOG = `1792514419.900000 wren kernel: tuned-ppd invoked oom-killer: gfp_mask=0x140cca(GFP_HIGHUSER_MOVABLE|__GFP_COMP), order=0, oom_score_adj=0
1792514419.916628 wren kernel: oom-kill:constraint=CONSTRAINT_NONE,nodemask=(null),cpuset=user.slice,mems_allowed=0,global_oom,task_memcg=/user.slice/user-1000.slice/user@1000.service/app.slice/editor.service,task=GameThread,pid=3057580,uid=1000
1792514419.916643 wren kernel: Out of memory: Killed process 3057580 (GameThread) total-vm:16830904kB, anon-rss:7340032kB, file-rss:8kB, shmem-rss:0kB, UID:1000 pgtables:17244kB oom_score_adj:800
1792518000.100000 tern kernel: oom-kill:constraint=CONSTRAINT_MEMCG,nodemask=(null),cpuset=/,mems_allowed=0,oom_memcg=/user.slice/user-1000.slice/user@1000.service/app.slice/editor.service,task_memcg=/user.slice/user-1000.slice/user@1000.service/app.slice/editor.service,task=UnrealEditor,pid=42,uid=1000
1792518000.100100 tern kernel: Memory cgroup out of memory: Killed process 42 (UnrealEditor) total-vm:30000000kB, anon-rss:20971520kB, file-rss:0kB, shmem-rss:0kB, UID:1000 pgtables:1kB oom_score_adj:0
`;
test("the kernel's out-of-memory kills: what, how big, in which unit, and whether the machine ran out", linux, () => {
  const f = path.join(tmp, "klog");
  fs.writeFileSync(f, KLOG);
  const ks = withEnv({ FACTORY_KERNEL_LOG: f }, () => platform.oomKills(0));
  assert.deepEqual(ks, [
    { at: 1792514419, task: "GameThread", pid: 3057580, rss: (7340032 + 8) * 1024, unit: "editor.service", machine: true },
    { at: 1792518000, task: "UnrealEditor", pid: 42, rss: 20971520 * 1024, unit: "editor.service", machine: false },
  ]);
});
test("  only those since the time asked", linux, () => {
  const f = path.join(tmp, "klog");
  assert.deepEqual(withEnv({ FACTORY_KERNEL_LOG: f }, () => platform.oomKills(1792515000))?.map((k) => k.pid), [42]);
});

// A systemctl on PATH that fails as one that can't reach the user's manager does, or answers.
const fakeSystemctl = (body: string) => {
  const d = fs.mkdtempSync(path.join(tmp, "bin-"));
  fs.writeFileSync(path.join(d, "systemctl"), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return { PATH: `${d}:${process.env.PATH}` };
};
const lane = { unit: "factory-os-test-lane1", dir: path.join(tmp, "lane1") };
const home = { FACTORY_DAEMON_HOME: path.join(tmp, "daemon") };
test("  the machine ran out since a time (epoch ms): a kill at a cap alone doesn't count", linux, () => {
  const f = path.join(tmp, "klog");
  assert.equal(withEnv({ FACTORY_KERNEL_LOG: f }, () => machineOomSince(1792514000_000)), true);
  assert.equal(withEnv({ FACTORY_KERNEL_LOG: f }, () => machineOomSince(1792515000_000)), false);
});
test("  null when the kernel's log can't be read", linux, () => {
  assert.equal(withEnv({ FACTORY_KERNEL_LOG: path.join(tmp, "none") }, () => platform.oomKills(0)), null);
  assert.equal(withEnv({ FACTORY_KERNEL_LOG: path.join(tmp, "none") }, () => machineOomSince(0)), null);
});

test("a lane whose state the service manager can't tell isn't taken for stopped", linux, () => {
  const env = { ...fakeSystemctl('echo "Failed to connect to bus: Connection timed out" >&2; exit 1'), ...home };
  assert.equal(withEnv(env, () => platform.jobState(lane.unit)), "unknown");
  assert.equal(withEnv(env, () => look([lane], { ...process.env, ...env })[0].running), true);
});
test("  one it says is inactive is", linux, () => {
  const env = { ...fakeSystemctl("echo inactive"), ...home };
  assert.equal(withEnv(env, () => platform.jobState(lane.unit)), "stopped");
  assert.equal(withEnv(env, () => look([lane], { ...process.env, ...env })[0].running), false);
});
test("  and one active, or stopping, runs", linux, () => {
  for (const s of ["active", "activating", "deactivating"]) assert.equal(withEnv(fakeSystemctl(`echo ${s}`), () => platform.jobState(lane.unit)), "running");
});

// A capped run's group, on Linux its cgroup's folder (a stand-in here, as `session mem-snap`'s test
// uses): its processes (with any group under it), memory, peak and the kernel's counts.
test("a capped run's group: its processes, memory, peak and kills", linux, () => {
  const g = path.join(tmp, "cg");
  fs.mkdirSync(path.join(g, "sub"), { recursive: true });
  for (const f of ["memory.stat", "memory.events", "memory.current", "memory.max", "memory.peak"]) fs.rmSync(path.join(g, f), { force: true });
  assert.equal(platform.groupProcesses(g), null);
  assert.equal(platform.groupMemory(g), null);
  assert.equal(platform.groupKills(g), null);
  assert.equal(platform.groupPeak(g), "");
  fs.writeFileSync(path.join(g, "cgroup.procs"), "11\n12\n");
  fs.writeFileSync(path.join(g, "sub", "cgroup.procs"), "13\n");
  assert.deepEqual(platform.groupProcesses(g), [11, 12, 13]);
  fs.writeFileSync(path.join(g, "memory.stat"), "anon 300\nfile 200\nkernel 5\nshmem 100\n");
  fs.writeFileSync(path.join(g, "memory.current"), "650\n");
  fs.writeFileSync(path.join(g, "memory.max"), "max\n");
  assert.equal(platform.groupMemory(g), null);   // (no cap)
  fs.writeFileSync(path.join(g, "memory.max"), "1000\n");
  assert.deepEqual(platform.groupMemory(g), { used: 650, cap: 1000, anon: 300, file: 200, shmem: 100 });
  fs.writeFileSync(path.join(g, "memory.stat"), "anon 300\n");
  assert.deepEqual(platform.groupMemory(g), { used: 650, cap: 1000, anon: 300 });
  fs.writeFileSync(path.join(g, "memory.peak"), "900\n");
  assert.equal(platform.groupPeak(g), "900");
  fs.writeFileSync(path.join(g, "memory.events"), "low 0\nhigh 0\nmax 4\noom 0\noom_kill 0\n");
  assert.deepEqual(platform.groupKills(g), { overCap: 0, killed: 0 });
  fs.writeFileSync(path.join(g, "memory.events"), "low 0\nhigh 0\nmax 4\noom 2\noom_kill 1\noom_group_kill 0\n");
  assert.deepEqual(platform.groupKills(g), { overCap: 2, killed: 1 });
});
