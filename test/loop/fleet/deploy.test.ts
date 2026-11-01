// scripts/deploy.sh and the stubs that pick a copy (the deploy checks of the bash suite's "fleet
// on this machine"): only what's pushed is deployed, one folder per commit, `current` the newest,
// with the Node its runtime/node.txt pins (a stand-in build in a local dist, checked against its
// checksum), which the stubs run; old versions retired, kept while a process runs them, then
// deleted. And a project recipe named like one of the skill's. Run: node --test test/loop/fleet/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { has, chomp, readOr, until, ROOT } from "../../lib/index.ts";
import { fleetFactory } from "./helpers.ts";

const f = fleetFactory("fdeploy");
const { F, w, run } = f;
const W = w.top, DEP = w.at("deploy");
const git = (dir: string, ...a: string[]) => w.git(dir, ...a);
// The skill's origin, a checkout that makes its commits (skill), another that pushes fixes (skill2).
git(W, "init", "-q", "--bare", w.at("skill-origin.git"));
git(W, "clone", "-q", w.at("skill-origin.git"), w.at("skill"));
fs.cpSync(path.join(ROOT, "tracker"), w.at("skill/tracker"), { recursive: true });
git(w.at("skill"), "add", "-A"); git(w.at("skill"), "commit", "-qm", "skill"); git(w.at("skill"), "branch", "-q", "-M", "main"); git(w.at("skill"), "push", "-q", "origin", "main");
git(W, "clone", "-q", w.at("skill-origin.git"), w.at("skill2"));
// The Node a deploy brings: a stand-in build in a local dist, pinned by the skill's runtime/node.txt
// (its own checksum, as the real file has the published ones). It notes that it ran, then runs
// this machine's node.
const narch = `${process.platform === "darwin" ? "darwin" : "linux"}-${process.arch}`;
const nb = w.at(`node-build/node-v26.0.0-${narch}`), tgz = w.at(`node-dist/v26.0.0/node-v26.0.0-${narch}.tar.gz`);
fs.mkdirSync(path.join(nb, "bin"), { recursive: true }); fs.mkdirSync(path.dirname(tgz), { recursive: true });
fs.writeFileSync(path.join(nb, "bin/node"), `#!/bin/sh\necho "$0" >> "${W}/node-ran"\nexec "${process.execPath}" "$@"\n`, { mode: 0o755 });
assert.equal(spawnSync("tar", ["-czf", tgz, "-C", w.at("node-build"), `node-v26.0.0-${narch}`]).status, 0);
const sha = createHash("sha256").update(fs.readFileSync(tgz)).digest("hex");
fs.mkdirSync(w.at("skill/runtime"));
fs.writeFileSync(w.at("skill/runtime/node.txt"), `version 26.0.0\n${narch} ${sha}\n`);
git(w.at("skill"), "add", "-A"); git(w.at("skill"), "commit", "-qm", "pin node"); git(w.at("skill"), "push", "-q", "origin", "main"); git(w.at("skill2"), "pull", "-q");
git(w.at("skill2"), "commit", "-q", "--allow-empty", "-m", "a fix"); git(w.at("skill2"), "push", "-q", "origin", "main");

const dep = () => run("bash", [path.join(ROOT, "scripts/deploy.sh")], { add: { FACTORY_SKILL_REPO: w.at("skill-origin.git"), FACTORY_NODE_DIST: `file://${w.at("node-dist")}` } }).stdout;
const real = (p: string) => { try { return fs.realpathSync(p); } catch { return ""; } };
// `. factory/skill` in the factory, with these variables: what it then prints.
const stub = (script: string, add: NodeJS.ProcessEnv) => chomp(run("bash", ["-c", `. factory/skill && ${script}`], { add }).stdout);
const ran = () => chomp(readOr(w.at("node-ran")));

describe("deploy: only what's pushed, one folder per commit, `current` the newest", () => {
  let first = "";
  test("deploy: the first deploy", () => { has(dep(), "deployed"); first = fs.readlinkSync(path.join(DEP, "current")); });
  test("  a stub runs the deployed copy", () => {
    assert.equal(stub('echo "$FACTORY_SKILL"', { FACTORY_SKILL: undefined }), `${real(path.join(DEP, "current"))}/wfactory`);
  });
  test("  and just reads its recipes through current", () => { assert.equal(fs.readlinkSync(path.join(F, ".tracker/skill")), `${DEP}/current/wfactory`); });
  test("  the deploy brings the pinned Node, beside the version", () => { fs.accessSync(path.join(DEP, "current/node/bin/node"), fs.constants.X_OK); });
  test("  and a stub runs it", () => {
    fs.rmSync(w.at("node-ran"), { force: true });
    run(path.join(F, "factory/tracker"), ["status"], { add: { FACTORY_SKILL: undefined, FACTORY_TRACKER: undefined } });
    assert.ok(ran() !== "", "the deployed Node didn't run");
    assert.equal(real(ran()), real(path.join(DEP, "current/node/bin/node")));
  });
  test("  a copy chosen by hand runs the deployed Node too", () => {
    fs.rmSync(w.at("node-ran"), { force: true });
    run(path.join(F, "factory/tracker"), ["status"]);
    has(ran(), `${DEP}/current/node/bin/node`);
  });
  // A commit pinning a Node that can't be fetched isn't deployed: current stays, and the message
  // reads as offline (so fleet restart restarts nothing).
  let was = "";
  test("  a Node that can't be fetched isn't deployed", () => {
    was = fs.readlinkSync(path.join(DEP, "current"));
    const nt = w.at("skill2/runtime/node.txt");
    fs.writeFileSync(nt, readOr(nt).replace(/^version .*/m, "version 26.0.1"));
    git(w.at("skill2"), "commit", "-qam", "pin an unfetchable node"); git(w.at("skill2"), "push", "-q", "origin", "main");
    const out = dep();
    git(w.at("skill2"), "reset", "-q", "--hard", "HEAD~1"); git(w.at("skill2"), "push", "-q", "-f", "origin", "main");
    has(out, "couldn't reach");
  });
  test("  and current stays where it was", () => { assert.equal(fs.readlinkSync(path.join(DEP, "current")), was); });
  // A tampered build fails its checksum and isn't used.
  test("  a build that fails its checksum isn't used", () => {
    fs.copyFileSync(tgz, w.at("node-good.tar.gz"));
    fs.appendFileSync(tgz, "junk\n"); fs.rmSync(path.join(DEP, "node"), { recursive: true, force: true });
    has(run("bash", [path.join(ROOT, "scripts/deploy.sh")], { add: { FACTORY_SKILL_REPO: w.at("skill-origin.git"), FACTORY_NODE_DIST: `file://${w.at("node-dist")}` } }).stdout, "checksum");
  });
  test("  and nothing of it is kept", () => { assert.ok(!fs.existsSync(path.join(DEP, "current/node/bin/node"))); });
  test("  the next deploy fetches it again", () => {
    fs.renameSync(w.at("node-good.tar.gz"), tgz); dep();
    fs.accessSync(path.join(DEP, "current/node/bin/node"), fs.constants.X_OK);
  });
  test("  a Node no version uses is deleted", () => {
    fs.mkdirSync(path.join(DEP, `node/v25.0.0-${narch}`), { recursive: true }); dep();
    assert.ok(!fs.existsSync(path.join(DEP, `node/v25.0.0-${narch}`)));
  });
  test("  a new pushed commit is deployed", () => {
    git(w.at("skill2"), "commit", "-q", "--allow-empty", "-m", "a later fix"); git(w.at("skill2"), "push", "-q", "origin", "main");
    has(dep(), `(was ${first.replace(/^versions\//, "")})`);
  });
  test("  the old version is kept for running loops, marked retired", () => {
    assert.ok(fs.existsSync(path.join(DEP, first, ".retired")), "marked retired");
    assert.ok(fs.statSync(path.join(DEP, first, "wfactory")).isDirectory(), "kept");
  });
  test("  a loop started on it keeps it (inherited)", () => {
    assert.equal(stub('echo "$FACTORY_SKILL"', { FACTORY_SKILL: `${DEP}/${first}/wfactory`, FACTORY_SKILL_FROM: "deploy" }), `${DEP}/${first}/wfactory`);
  });
  test("  deploying again changes nothing", () => { has(dep(), "up to date"); });
  // Another deploy holds the lock (perl's flock(2), the lock flock(1) takes too): this one waits.
  test("  a deploy waits for one that holds the lock", async () => {
    const held = w.at("lock-held");
    const p = spawn("perl", ["-e", 'use Fcntl ":flock"; open(my $f, ">", $ARGV[0]) or die; flock($f, LOCK_EX) or die; open(my $h, ">", $ARGV[1]); close $h; sleep 2', path.join(DEP, "lock"), held], { stdio: "ignore" });
    const ended = new Promise<void>((r) => p.on("close", () => r()));
    after(() => { p.kill("SIGKILL"); });
    await until(() => fs.existsSync(held), "the lock is held");
    const t = Date.now(), out = dep(), took = Date.now() - t;
    await ended;
    has(out, "up to date");
    assert.ok(took >= 1000, `took ${took} ms`);
  });
  // On Linux it's told by the process's FACTORY_SKILL. macOS shows no process's variables, so
  // there by its command line, as a loop's names the copy's main.mjs.
  test("  a retired version a process still runs is kept", async () => {
    const old = new Date(Date.now() - 3 * 86400e3);
    fs.utimesSync(path.join(DEP, first, ".retired"), old, old);
    const skill = `${real(path.join(DEP, first))}/wfactory`;
    const p = process.platform === "linux"
      ? spawn("sleep", ["30"], { env: { ...process.env, FACTORY_SKILL: skill }, stdio: "ignore" })
      : spawn(process.execPath, ["-e", "setTimeout(() => {}, 30e3)", `${skill}/runtime/main.mjs`], { stdio: "ignore" });
    const ended = new Promise<void>((r) => p.on("close", () => r()));
    after(() => { p.kill("SIGKILL"); });
    // Once it runs as that (not still the forked node).
    await until(() => process.platform === "linux"
      ? readOr(`/proc/${p.pid}/environ`).includes(`FACTORY_SKILL=${skill}`)
      : (spawnSync("ps", ["-ww", "-o", "args=", "-p", String(p.pid)], { encoding: "utf8" }).stdout ?? "").includes(skill), "the process runs the retired version");
    dep();
    const kept = fs.existsSync(path.join(DEP, first));
    p.kill("SIGKILL"); await ended;
    assert.ok(kept);
  });
  // On macOS the daemon's service is a crontab entry, which runs the supervisor of the copy that
  // wrote it (on Linux, a systemd unit that runs through current).
  test("  a retired version the crontab names is kept", { skip: process.platform !== "darwin" && "macOS's crontab (Linux's daemon is a systemd unit, run through current)" }, () => {
    const bin = w.at("cronbin");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "crontab"), `#!/bin/sh\necho "* * * * * '${real(path.join(DEP, first))}/wfactory/runtime/src/os/darwin-job.ts' service x # wfactory:wfactory"\n`, { mode: 0o755 });
    run("bash", [path.join(ROOT, "scripts/deploy.sh")], { add: { FACTORY_SKILL_REPO: w.at("skill-origin.git"), FACTORY_NODE_DIST: `file://${w.at("node-dist")}`, PATH: `${bin}:${process.env.PATH}` } });
    assert.ok(fs.existsSync(path.join(DEP, first)));
  });
  test("  and so is one when the crontab can't be read", { skip: process.platform !== "darwin" && "macOS's crontab (Linux's daemon is a systemd unit, run through current)" }, () => {
    const bin = w.at("cronbin-broken");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "crontab"), `#!/bin/sh\necho "crontab: can't open your crontab" >&2\nexit 1\n`, { mode: 0o755 });
    run("bash", [path.join(ROOT, "scripts/deploy.sh")], { add: { FACTORY_SKILL_REPO: w.at("skill-origin.git"), FACTORY_NODE_DIST: `file://${w.at("node-dist")}`, PATH: `${bin}:${process.env.PATH}` } });
    assert.ok(fs.existsSync(path.join(DEP, first)));
  });
  test("  a version retired over two days ago is deleted", () => { dep(); assert.ok(!fs.existsSync(path.join(DEP, first))); });
  test("  a FACTORY_SKILL set by hand isn't taken for a deploy pin", () => {
    assert.equal(stub("readlink .tracker/skill", { FACTORY_SKILL: ROOT, FACTORY_SKILL_FROM: "deploy" }), ROOT);
  });
});

// A recipe the project defines too is the project's, and doesn't break just.
describe("a project recipe named like one of the skill's", () => {
  test("a project recipe named like one of the skill's wins", () => {
    fs.appendFileSync(path.join(F, "justfile"), "\nprompt:\n    @echo project-prompt\n");
    has(w.just(["prompt"], F).stdout, "project-prompt");
  });
  test("  and just still loads the skill's others", () => {
    const out = w.just(["status"], F).stdout;
    git(F, "checkout", "-q", "--", "justfile");
    has(out.split("\n")[0], "of");
  });
});
