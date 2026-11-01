// tracker/src/net.ts on its own, and landing's git through it: which ssh a git command that
// reaches a remote gets, and a push to an origin that stops answering giving up within the bound
// instead of hanging the lane. (tracker/test/dead-origin.test.ts has the tracker's side.)
// Run: node --test runtime/test/
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { SSH_OPTS, netEnv, netGit, reachesRemote } from "../../tracker/src/net.ts";
import { git } from "../src/landing.ts";

const base = { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

test("only the commands that reach a remote are bounded", () => {
  for (const a of [["push", "-q", "origin", "main"], ["-C", "x", "fetch", "-q", "origin"], ["-c", "a=b", "clone", "u", "d"], ["ls-remote", "origin"]]) assert.ok(reachesRemote(a), a.join(" "));
  for (const a of [["-C", "x", "rev-parse", "HEAD"], ["commit", "-m", "push"], ["log", "--grep", "fetch"]]) assert.ok(!reachesRemote(a), a.join(" "));
});

test("ssh gets the options after a project's own, which win", () => {
  assert.equal(netEnv(["push"], base).GIT_SSH_COMMAND, `ssh ${SSH_OPTS}`);
  assert.equal(netEnv(["push"], { ...base, GIT_SSH_COMMAND: "ssh -i key -o ConnectTimeout=5" }).GIT_SSH_COMMAND, `ssh -i key -o ConnectTimeout=5 ${SSH_OPTS}`);
  assert.equal(netEnv(["push"], { ...base, GIT_SSH: "/usr/bin/ssh" }).GIT_SSH_COMMAND, `'/usr/bin/ssh' ${SSH_OPTS}`);
});

test("  a repo's core.sshCommand is kept (GIT_SSH_COMMAND would override it)", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "net-"));
  try {
    spawnSync("git", ["init", "-q", d], { env: base });
    spawnSync("git", ["-C", d, "config", "core.sshCommand", "ssh -i deploy-key"], { env: base });
    assert.equal(netEnv(["-C", d, "push"], base).GIT_SSH_COMMAND, `ssh -i deploy-key ${SSH_OPTS}`);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test("  a command that isn't OpenSSH's is left as it is (the timeout still bounds it)", () => {
  const env = { ...base, GIT_SSH_COMMAND: "plink -batch" };
  assert.equal(netEnv(["push"], env).GIT_SSH_COMMAND, "plink -batch");
});

test("landing's push to an origin that stops answering gives up within the bound, its ssh with it", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "net-"));
  const pids = path.join(d, "pids"), was = { ...process.env }, cwd = process.cwd();
  try {
    fs.mkdirSync(path.join(d, "bin"));
    fs.writeFileSync(path.join(d, "bin", "ssh"), `#!/bin/sh\necho $$ >> '${pids}'\nexec sleep 120\n`, { mode: 0o755 });
    spawnSync("git", ["init", "-q", "-b", "main", path.join(d, "lane")], { env: base });
    spawnSync("git", ["-C", path.join(d, "lane"), "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x"], { env: base });
    Object.assign(process.env, base, { PATH: `${path.join(d, "bin")}:${process.env.PATH}`, FACTORY_GIT_TIMEOUT: "2" });
    process.chdir(path.join(d, "lane"));
    const t0 = Date.now();
    assert.equal(git("push", "-q", `ssh://fake${d}/origin.git`, "main"), null);
    assert.ok(Date.now() - t0 < 15_000, `took ${Date.now() - t0} ms`);
    // Its ssh went with it (killing git alone leaves ssh running).
    const ssh = fs.readFileSync(pids, "utf8").split("\n").filter(Boolean);
    assert.ok(ssh.length > 0, "the push never reached the fake ssh");
    const running = (p: string) => { try { return !/\) Z /.test(fs.readFileSync(`/proc/${p}/stat`, "utf8")); } catch { return false; } };
    for (let i = 0; i < 50 && ssh.some(running); i++) spawnSync("sleep", ["0.1"]);
    for (const p of ssh) assert.ok(!running(p), `ssh ${p} is still running`);
  } finally {
    process.chdir(cwd);
    for (const k of Object.keys(process.env)) if (!(k in was)) delete process.env[k];
    Object.assign(process.env, was);
    for (const p of fs.existsSync(pids) ? fs.readFileSync(pids, "utf8").split("\n").filter(Boolean) : []) { try { process.kill(Number(p), "SIGKILL"); } catch {} }
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test("  a git that won't stop is killed, and comes back failed, not with no status", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "net-"));
  try {
    fs.writeFileSync(path.join(d, "git"), `#!/bin/sh\n[ "$1" = config ] && exit 1\ntrap '' TERM\nsleep 30 & wait; sleep 30\n`, { mode: 0o755 });
    const r = netGit(["fetch", "-q", "origin"], { encoding: "utf8", env: { ...base, PATH: `${d}:${process.env.PATH}`, FACTORY_GIT_TIMEOUT: "1" } }, 180);
    assert.equal(r.status, 124);
    assert.match(r.stderr, /git: (killed|no answer)/);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
