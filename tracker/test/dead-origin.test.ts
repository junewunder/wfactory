// The tracker CLI end to end, with origin behind an ssh that stops answering mid-push (wifi gone,
// the connection dead but never closed): a write comes back within FACTORY_GIT_TIMEOUT with the
// lock let go and no ssh left behind, kept locally for the next write to push; a claim fails, to
// be tried again later; a fetch that hangs is origin unreachable; and ssh gets keepalives and a
// connect timeout. Run: node --test tracker/test/
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { trackerRepo, has, cmd, killPid, alive, until, TRACKER } from "../../test/lib/index.ts";

const f = trackerRepo("repo");
const { setup, ok } = f;
setup(["init", "--title", "Dead origin"]);
setup(["add-group", "g", "--title", "Group"]);
setup(["add-unit", "g/a", "--title", "First unit"]);
f.git("add", "-A"); f.git("commit", "-qm", "tracker");
const bare = path.join(f.top, "origin.git");
f.git("clone", "-q", "--bare", f.dir, bare);

// The fake ssh, first on PATH: it runs the remote command here (ssh://fake/<path>), but with
// HANG set, a push (git-receive-pack) gets no answer, ever, and with HANG_FETCH a fetch
// (git-upload-pack) neither. It notes its arguments, and the pid of each that hangs.
const bin = path.join(f.top, "bin"), args = path.join(f.top, "ssh-args"), pids = path.join(f.top, "ssh-pids");
fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, "ssh"), `#!/bin/sh
printf '%s\\n' "$*" >> '${args}'
for last; do :; done
case "$last" in git-receive-pack*) [ -z "$HANG" ] || { echo $$ >> '${pids}'; exec sleep 120; } ;; esac
case "$last" in git-upload-pack*) [ -z "$HANG_FETCH" ] || { echo $$ >> '${pids}'; exec sleep 120; } ;; esac
exec sh -c "$last"
`, { mode: 0o755 });
const hung = () => (fs.existsSync(pids) ? fs.readFileSync(pids, "utf8").split("\n").filter(Boolean) : []);
after(() => { for (const p of hung()) killPid(p, "SIGKILL"); });
f.git("remote", "add", "origin", `ssh://fake${bare}`);
const env = { PATH: `${bin}:${process.env.PATH}`, FACTORY_GIT_TIMEOUT: "3" };
const hang = { ...env, HANG: "1" };
// The real command, cut off at 30 s, well below the fake ssh's 120: without a bound it hangs.
const run = (a: string[], e: Record<string, string>) => cmd(process.execPath, [TRACKER, ...a], { cwd: f.dir, env: { ...f.env, ...e }, timeout: 30 });
const onOrigin = () => cmd("git", ["--git-dir", bare, "log", "--format=%s", "main"], { cwd: f.top, env: f.env }).stdout;

describe("origin stops answering mid-push", () => {
  test("a write reaches origin while it answers", () => {
    ok(["add-unit", "g/b", "--title", "Second unit"], env);
    has(onOrigin(), "Second unit");
  });
  test("  ssh gets a connect timeout and keepalives", () => {
    has(fs.readFileSync(args, "utf8"), "-o BatchMode=yes -o ConnectTimeout=20 -o ServerAliveInterval=15 -o ServerAliveCountMax=4");
  });
  test("  a write whose push hangs comes back within the bound, kept here, the lock let go", () => {
    const t0 = Date.now();
    const r = run(["add-unit", "g/c", "--title", "Third unit"], hang);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(Date.now() - t0 < 20_000, `took ${Date.now() - t0} ms`);
    has(r.stderr, "not pushed yet");
    has(r.stderr, "no answer from the remote");
    assert.ok(!fs.existsSync(f.at(".tracker/lock")), "the tracker's lock is still there");
    assert.ok(!onOrigin().includes("Third unit"));
    has(ok(["show", "g/c"], env), "Third unit");
  });
  test("  and leaves no ssh behind", async () => {
    assert.ok(hung().length > 0, "the push never reached the fake ssh");
    await until(() => !hung().some(alive), "the hung ssh is gone", 15);
  });
  test("  a claim whose push hangs fails, to be tried again later", () => {
    const r = run(["next", "g", "--claim"], hang);
    assert.notEqual(r.code, 0, r.stdout);
    has(r.stderr, "trying again later");
    assert.ok(!fs.existsSync(f.at(".tracker/lock")), "the tracker's lock is still there");
  });
  test("  a write whose fetch hangs works from this machine's last copy, kept here", () => {
    const t0 = Date.now();
    const r = run(["add-unit", "g/e", "--title", "Fifth unit"], { ...env, HANG_FETCH: "1" });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(Date.now() - t0 < 20_000, `took ${Date.now() - t0} ms`);
    has(r.stderr, "couldn't reach origin");
    has(r.stderr, "not pushed yet");
    assert.ok(!fs.existsSync(f.at(".tracker/lock")), "the tracker's lock is still there");
  });
  test("  once origin answers again, the next write takes the kept one with it", () => {
    ok(["add-unit", "g/d", "--title", "Fourth unit"], env);
    const log = onOrigin();
    has(log, "Third unit"); has(log, "Fourth unit"); has(log, "Fifth unit");
  });
});
