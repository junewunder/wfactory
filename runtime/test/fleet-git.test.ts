// The git the fleet runs against origin (fleet-scripts.ts: the skill's pull, the checkout's pull, a
// lane's fetch, an orphaned clone's fetch) and a new lane's clone (lane.ts), with origin behind
// an ssh that stops answering (tracker/test/dead-origin.test.ts's fake): each gives up within
// FACTORY_GIT_TIMEOUT instead of hanging the fleet's start, its ssh with it, and ssh gets
// tracker/src/net.ts's keepalives after a project's own command.
// Run: node --test runtime/test/
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { SSH_OPTS } from "../../tracker/src/net.ts";
import { DROP_CLONE, PULL_CHECKOUT, PULL_LANE, PULL_SKILL } from "../src/fleet-scripts.ts";

const top = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-git-"));
const at = (...p: string[]) => path.join(top, ...p);
const base: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: top, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (dir: string, ...a: string[]) => {
  const r = spawnSync("git", ["-C", dir, ...a], { encoding: "utf8", env: base });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};

// The fake ssh, first on PATH: it runs the remote command here (ssh://fake/<path>), but with HANG
// set, a fetch or clone (git-upload-pack) gets no answer, ever. It notes its arguments, and the
// pid of each that hangs.
const bin = at("bin"), args = at("ssh-args"), pids = at("ssh-pids");
fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, "ssh"), `#!/bin/sh
printf '%s\\n' "$*" >> '${args}'
for last; do :; done
case "$last" in git-upload-pack*) [ -z "$HANG" ] || { echo $$ >> '${pids}'; exec sleep 120; } ;; esac
exec sh -c "$last"
`, { mode: 0o755 });
const hung = () => (fs.existsSync(pids) ? fs.readFileSync(pids, "utf8").split("\n").filter(Boolean) : []);
// (Not a zombie, nor one ps no longer finds: a zombie reaped between the kill and the ps is gone.)
const alive = (p: string) => { try { process.kill(Number(p), 0); } catch { return false; } const st = spawnSync("ps", ["-o", "stat=", "-p", p], { encoding: "utf8" }).stdout?.trim() ?? ""; return st !== "" && st[0] !== "Z"; };
after(() => {
  for (const p of hung()) { try { process.kill(Number(p), "SIGKILL"); } catch {} }
  fs.rmSync(top, { recursive: true, force: true });
});
const env = { ...base, PATH: `${bin}:${process.env.PATH}`, FACTORY_GIT_TIMEOUT: "3" };
const hang = { ...env, HANG: "1" };

// origin, a bare repo behind the fake ssh, and a checkout of it.
const seed = at("seed");
spawnSync("git", ["init", "-q", "-b", "main", seed], { env: base });
fs.writeFileSync(path.join(seed, "a"), "1\n");
git(seed, "add", "a"); git(seed, "commit", "-qm", "first");
spawnSync("git", ["clone", "-q", "--bare", seed, at("origin.git")], { env: base });
const url = `ssh://fake${at("origin.git")}`;
const F = at("checkout");
assert.equal(spawnSync("git", ["clone", "-q", url, F], { env }).status, 0);
const push = (text: string) => { fs.writeFileSync(path.join(seed, "a"), text); git(seed, "commit", "-qam", text); git(seed, "push", "-q", at("origin.git"), "main"); };

// A script as the fleet runs it on a machine (sh -c, in the checkout), cut off at 30 s: well
// below the fake ssh's 120, so without a bound it fails here instead of hanging.
const run = (script: string, cwd: string, e: NodeJS.ProcessEnv, ...a: string[]) => {
  const t0 = Date.now();
  const r = spawnSync("sh", ["-c", script, ...a], { cwd, env: e, encoding: "utf8", timeout: 30_000 });
  return { ...r, ms: Date.now() - t0 };
};
const within = (r: { ms: number; signal: NodeJS.Signals | null }) => {
  assert.equal(r.signal, null, "hung until the test's own cut-off");
  assert.ok(r.ms < 20_000, `took ${r.ms} ms`);
};

describe("the fleet's git with origin answering", () => {
  test("the checkout's pull brings it up to date", () => {
    push("2\n");
    const r = run(PULL_CHECKOUT, F, env);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(path.join(F, "a"), "utf8"), "2\n");
  });
  test("  ssh gets a connect timeout and keepalives", () => {
    assert.ok(fs.readFileSync(args, "utf8").includes(SSH_OPTS), fs.readFileSync(args, "utf8"));
  });
  test("  after a project's own ssh command (core.sshCommand), which is kept", () => {
    git(F, "config", "core.sshCommand", "ssh -o Project=1");
    fs.rmSync(args);
    push("3\n");
    assert.equal(run(PULL_LANE, F, env).status, 0);
    assert.equal(fs.readFileSync(path.join(F, "a"), "utf8"), "3\n");
    assert.ok(fs.readFileSync(args, "utf8").startsWith(`-o Project=1 ${SSH_OPTS}`), fs.readFileSync(args, "utf8"));
    git(F, "config", "--unset", "core.sshCommand");
  });
  test("  a command that isn't OpenSSH's is left as it is (the timeout still bounds it)", () => {
    const wrap = at("bin", "myssh");
    fs.writeFileSync(wrap, `#!/bin/sh\nexec ssh "$@"\n`, { mode: 0o755 });
    fs.rmSync(args);
    push("3b\n");
    assert.equal(run(PULL_LANE, F, { ...env, GIT_SSH_COMMAND: `${wrap} -o Wrapped=1` }).status, 0);
    assert.ok(!fs.readFileSync(args, "utf8").includes("ServerAliveInterval"), fs.readFileSync(args, "utf8"));
  });
  test("  GIT_SSH, even in a folder with a space, gets the options", () => {
    const d = at("my tools");
    fs.mkdirSync(d);
    fs.copyFileSync(path.join(bin, "ssh"), path.join(d, "ssh"));
    fs.chmodSync(path.join(d, "ssh"), 0o755);
    fs.rmSync(args);
    push("3c\n");
    const r = run(PULL_LANE, F, { ...env, GIT_SSH: path.join(d, "ssh") });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.readFileSync(args, "utf8").startsWith(SSH_OPTS), fs.readFileSync(args, "utf8"));
  });
});

describe("the fleet's git with origin not answering", () => {
  test("the checkout's pull gives up within the bound", () => {
    push("4\n");
    const r = run(PULL_CHECKOUT, F, hang);
    within(r);
    assert.equal(r.status, 124);
    assert.match(r.stderr, /no answer from the remote in 3 s/);
  });
  test("  as does a lane's fetch", () => {
    const r = run(PULL_LANE, F, hang);
    within(r);
    assert.notEqual(r.status, 0);
  });
  test("  and the skill's pull, which says it wasn't updated", () => {
    const r = run(PULL_SKILL, F, { ...hang, FACTORY_SKILL_CHECKOUT: F });
    within(r);
    assert.match(r.stdout, /could not fast-forward .*: not updated/);
  });
  test("  and an orphaned clone's fetch, which leaves the clone alone", () => {
    const c = at("checkout-lane2");
    assert.equal(spawnSync("git", ["clone", "-q", url, c], { env }).status, 0);
    fs.appendFileSync(path.join(c, ".git/info/exclude"), "/runs\n");   // (a factory's .gitignore has it)
    git(c, "commit", "-q", "--allow-empty", "-m", "of its own");
    const r = run(DROP_CLONE, F, hang, c, "checkout");
    within(r);
    assert.match(r.stdout, /commits origin lacks .*: left alone/);
    assert.ok(fs.existsSync(c));
  });
  test("  a new lane's clone gives up within the bound, leaving no part-made clone", () => {
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [path.resolve(import.meta.dirname, "../main.mjs"), "lane", "dir", "3"], { cwd: F, env: { ...hang, FACTORY_ROOT: F }, encoding: "utf8", timeout: 30_000 });
    within({ ms: Date.now() - t0, signal: r.signal });
    assert.equal(r.status, 124, r.stderr);
    assert.match(r.stderr, /no answer from the remote in 3 s/);
    assert.ok(!fs.existsSync(at("checkout-lane3")), "the part-made clone is still there");
  });
  test("  and leaves no ssh behind", () => {
    assert.ok(hung().length >= 5, `only ${hung().length} reached the fake ssh`);
    let left = hung().filter(alive);
    for (let i = 0; i < 100 && left.length; i++) { spawnSync("sleep", ["0.1"]); left = hung().filter(alive); }
    assert.deepEqual(left, []);
  });
});
