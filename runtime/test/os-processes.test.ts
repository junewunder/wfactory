// What the runtime and the tracker read of processes through src/os.ts: a process's start time,
// parent, whether it has ended, what runs under it, its command line, folder, variables and
// memory, and finding one by its command line. Only through the interface, with real processes,
// so a port to another OS runs these as they are. Run: node --test runtime/test/
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { platform } from "../src/os.ts";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "os-proc-test-")));
const kids: ChildProcess[] = [];
// (Each one's whole tree: a sleep left behind would hold the file's run open until it ends.)
test.after(() => {
  for (const k of kids) for (const p of platform.processTree(k.pid ?? 0).reverse()) { try { process.kill(p, "SIGKILL"); } catch {} }
  fs.rmSync(tmp, { recursive: true, force: true });
});
const run = (cmd: string, args: string[], o: { cwd?: string; env?: NodeJS.ProcessEnv; out?: boolean } = {}) => {
  const c = spawn(cmd, args, { stdio: ["ignore", o.out ? "pipe" : "ignore", "ignore"], cwd: o.cwd, env: o.env });
  kids.push(c);
  return c;
};
// A pid that ran and is gone (reaped).
const gone = () => spawnSync("sh", ["-c", "echo $$"], { encoding: "utf8" }).stdout.trim();
const until = async (f: () => boolean, ms = 5000) => { const t = Date.now(); while (!f() && Date.now() - t < ms) await sleep(20); return f(); };

test("a process's start time: the same each look while it runs, none once it's gone", async () => {
  const s = platform.processStart(process.pid);
  assert.ok(s);
  await sleep(1100);
  assert.equal(platform.processStart(process.pid), s);
  assert.equal(platform.processStart(Number(gone())), "");
});

test("a process's parent, and 0 for one that's gone", () => {
  assert.equal(platform.processParent(process.pid), process.ppid);
  assert.equal(platform.processParent(Number(gone())), 0);
});

test("a process has ended once it's gone, or exited and not reaped", async () => {
  const c = run("sleep", ["30"]);
  assert.equal(platform.processEnded(c.pid!), false);
  assert.equal(platform.processEnded(Number(gone())), true);
  // The background sleep's parent becomes the exec'd one, which never waits for it: a zombie.
  const z = run("sh", ["-c", "sleep 0.1 & echo $!; exec sleep 30"], { out: true });
  const pid = Number(await new Promise<string>((r) => z.stdout!.once("data", (d) => r(String(d).trim()))));
  assert.ok(await until(() => platform.processEnded(pid)), "the exited, unreaped child counts as ended");
  assert.equal(platform.processParent(pid), z.pid);   // (still there, a zombie: not reaped)
});

test("a process's tree: itself first, then each child followed by what runs under it", async () => {
  const c = run("sh", ["-c", "sh -c 'sleep 31 & wait' & sleep 32 & wait"]);
  assert.ok(await until(() => platform.processTree(c.pid!).length === 4));
  const t = platform.processTree(c.pid!), args = t.map((p) => platform.processArgs(p)?.join(" "));
  assert.equal(t[0], c.pid);
  const inner = args.indexOf("sh -c sleep 31 & wait");
  assert.ok(inner > 0 && args[inner + 1] === "sleep 31", `the inner shell's sleep follows it: ${JSON.stringify(args)}`);
  assert.ok(args.includes("sleep 32"));
  assert.deepEqual(platform.processTree(0), []);
});

test("a process's command line, folder and variables", async () => {
  const c = run("sleep", ["33"], { cwd: tmp, env: { ...process.env, WF_OS_TEST: "a=b" } });
  assert.ok(await until(() => platform.processArgs(c.pid!)?.[0] === "sleep"));
  assert.deepEqual(platform.processArgs(c.pid!), ["sleep", "33"]);
  assert.equal(platform.processFolder(c.pid!), tmp);
  // (macOS shows no process's variables: only a job's, from what started it: runtime/test/os-jobs.test.ts.)
  if (process.platform !== "darwin") assert.equal(platform.processEnv(c.pid!)?.WF_OS_TEST, "a=b");
  const g = Number(gone());
  assert.equal(platform.processArgs(g), null);
  assert.equal(platform.processFolder(g), null);
  assert.equal(platform.processEnv(g), null);
  for (const n of [0, -1]) {
    assert.equal(platform.processStart(n), ""); assert.equal(platform.processParent(n), 0); assert.equal(platform.processEnded(n), true);
  }
});

test("what processes hold in memory, only those still running", async () => {
  const c = run("sleep", ["34"]);
  assert.ok(await until(() => platform.processArgs(c.pid!)?.[0] === "sleep"));
  const m = platform.processMemory([c.pid!, Number(gone())]);
  assert.equal(m.length, 1);
  assert.equal(m[0].pid, c.pid);
  assert.ok(m[0].rss > 0);
  assert.match(m[0].cmd, /^sleep 34/);
});

test("finding processes by command line, never this one", async () => {
  const c = run("sh", ["-c", "sleep 35; : wf-os-find-me"]);
  assert.ok(await until(() => platform.processesMatching("wf-os-find-me").includes(c.pid!)));
  assert.deepEqual(platform.processesMatching("wf-os-find-[n]obody"), []);
  // This test's own process has the file's name in its command line.
  assert.ok(!platform.processesMatching("os-processes\\.test").includes(process.pid));
});
