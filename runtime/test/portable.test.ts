// What the runtime used to run tools for that a Mac lacks (flock, `tail --pid`, `find -printf`,
// `du -b`, `date -d`), now in Node or behind src/os.ts: on Linux each still answers as the tool
// did. Run: node --test runtime/test/
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { platform } from "../src/os.ts";
import { lock, lockHeld, lockWithin, tryLock, unlock } from "../src/sys.ts";
import { bytesFollowed, filesFollowed } from "../src/store-util.ts";
import { LOCK9 } from "../src/fleet-scripts.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "portable-test-"));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const sh = (script: string) => spawnSync("bash", ["-c", script], { cwd: tmp, encoding: "utf8" });
const sorted = (s: string) => s.split("\n").filter(Boolean).sort();
// The checks against GNU find, du and flock(1), which only Linux has.
const gnu = { skip: process.platform !== "linux" && "compares with GNU tools" };

// A tree with what a group's copy can hold: folders, a hard link, links to a file and a folder
// outside, a link back up (a loop), a dangling link, an empty file.
const tree = path.join(tmp, "tree");
sh(`mkdir -p tree/a/b out/d && echo hello > tree/a/b/f && printf 12345 > out/x && echo y > out/d/y && : > tree/empty
    ln tree/a/b/f tree/a/hard && ln -s ../out/x tree/lx && ln -s ../out/d tree/ld && ln -s .. tree/a/up && ln -s nowhere tree/dangling`);
fs.utimesSync(path.join(tree, "a/b/f"), 0, new Date(2026, 0, 2, 3, 4, 5).getTime() / 1000 + 0.5);

test("a group's listing is find's -printf '%P\\t%s\\t%T@', links followed", gnu, () => {
  const find = sh(`find -L tree -type f -printf '%P\\t%s\\t%T@\\n' 2>/dev/null`).stdout;
  assert.deepEqual(filesFollowed(tree).sort(), sorted(find));
  assert.ok(filesFollowed(tree).includes(`a/b/f\t6\t${new Date(2026, 0, 2, 3, 4, 5).getTime() / 1000}.5000000000`));
});
test("  and without -L, links aren't followed", gnu, () => {
  const find = sh(`find tree -type f -printf '%P\\t%s\\t%T@\\n'`).stdout;
  assert.deepEqual(filesFollowed(tree, false).sort(), sorted(find));
});
test("a group's size is du -sbL's", gnu, () => {
  assert.equal(bytesFollowed(tree), Number(sh("du -sbL tree 2>/dev/null").stdout.split("\t")[0]));
  assert.equal(bytesFollowed(path.join(tmp, "nothing")), 0);
});

test("a lock: one holder at a time, and bash's flock sees it", () => {
  const f = path.join(tmp, "a.lock");
  const fd = tryLock(f);
  assert.notEqual(fd, null);
  assert.equal(tryLock(f), null);
  assert.equal(lockHeld(f), true);
  if (!gnu.skip) assert.notEqual(sh(`flock -n ${f} true`).status, 0);
  unlock(fd!);
  assert.equal(lockHeld(f), false);
  if (!gnu.skip) assert.equal(sh(`flock -n ${f} true`).status, 0);
  assert.equal(lockHeld(path.join(tmp, "none.lock")), false);
  assert.equal(fs.existsSync(path.join(tmp, "none.lock")), false);
});
test("  waited for: within a time, or as long as it takes", gnu, async () => {
  const f = path.join(tmp, "b.lock");
  // Held by flock(1) until the test closes its stdin.
  const c = spawn("flock", [f, "sh", "-c", "read x"], { stdio: ["pipe", "ignore", "ignore"] });
  const ended = new Promise((r) => c.on("exit", r));
  while (!lockHeld(f)) await new Promise((r) => setTimeout(r, 10));
  assert.equal(lockWithin(f, 0.1), null);
  c.stdin!.end();
  await ended;
  unlock(lock(f));
});
test("  and a shell without flock(1) takes it by perl's flock(2)", () => {
  const f = path.join(tmp, "d.lock"), bin = path.join(tmp, "bin");
  fs.mkdirSync(bin);
  for (const t of ["perl", "sh"]) fs.symlinkSync(spawnSync("sh", ["-c", `command -v ${t}`], { encoding: "utf8" }).stdout.trim(), path.join(bin, t));
  const take = () => spawnSync(path.join(bin, "sh"), ["-c", `exec 9>>${f} && ${LOCK9} && echo ours`], { encoding: "utf8", env: { PATH: bin } }).stdout.trim();
  assert.equal(take(), "ours");
  const fd = tryLock(f)!;
  assert.equal(take(), "");
  unlock(fd);
});

test("a holder keeps a lock it's handed until the process it waits on ends", async () => {
  const f = path.join(tmp, "c.lock");
  const waited = spawn("sleep", ["30"], { stdio: "ignore" });
  const fd = tryLock(f)!;
  const [cmd, ...args] = platform.untilEnds(waited.pid!);
  const h = spawn(cmd, args, { stdio: ["ignore", "ignore", "ignore", fd], detached: true });
  unlock(fd);
  assert.equal(lockHeld(f), true);
  const gone = new Promise((r) => h.on("exit", r));
  waited.kill();
  await gone;
  assert.equal(lockHeld(f), false);
});

test("a time as people write it", () => {
  assert.equal(platform.readTime("2026-10-27 09:30"), new Date(2026, 9, 27, 9, 30).getTime() / 1000);
  const now = Date.now() / 1000;
  assert.ok(Math.abs(platform.readTime("-24 hours")! - (now - 86400)) < 5);
  assert.equal(platform.readTime("not a time"), null);
});
