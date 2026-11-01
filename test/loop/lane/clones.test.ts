// A second lane: a plain clone beside the checkout, sharing work/, with the checkout's .env, its
// copy of the skill and a project's lane-setup; without an origin, lane 1 is the checkout itself.
// factory/lane.sh dir, the real command, in the factory's checkout. Run: node --test test/loop/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chomp, cmd, has, readOr } from "../../lib/index.ts";
import { laneFactory } from "./helpers.ts";

const f = laneFactory("lane-clones", "other");
const { w, F } = f;
const laneDir = (k: string, cwd = F) => cmd(path.join(cwd, "factory/lane.sh"), ["dir", k], { cwd, env: w.env });
const git = (...args: string[]) => w.git(F, ...args);
const land = (msg: string) => { git("commit", "-qm", msg); git("pull", "-q", "--rebase", "origin", "main"); git("push", "-q", "origin", "HEAD:main"); };
const excluded = (d: string) => readOr(path.join(d, ".git/info/exclude")).split("\n");
fs.mkdirSync(path.join(F, "work")); fs.writeFileSync(path.join(F, "work/x"), "data\n");

describe("a second lane: a plain clone beside the checkout, sharing work/", () => {
  const d = `${F}-lane2`;
  test("lane 2's checkout is beside the first", () => { assert.equal(chomp(laneDir("2").stdout), d); });
  test("  its work/ is the machine's one work/", () => {
    assert.ok(fs.lstatSync(path.join(d, "work")).isSymbolicLink());
    assert.equal(readOr(path.join(d, "work/x")), "data\n");
  });
  test("  a plain clone, not a worktree", () => {
    assert.ok(fs.statSync(path.join(d, ".git")).isDirectory());
    assert.ok(!w.git(d, "worktree", "list").includes(`${F} `));
  });
  test("lane 1 has its own clone too (the checkout stays on main)", () => { assert.equal(chomp(laneDir("1").stdout), `${F}-lane1`); });
  test("lane.sh dir: lanes count from 1", () => { assert.equal(laneDir("0").code, 2); });
});

// What a new clone gets besides work/: .env, the recipes' link, a project's lane-setup.
describe("a new clone: .env, the recipes' link, a project's lane-setup", () => {
  const d = `${F}-lane3`;
  let r: ReturnType<typeof laneDir>;
  test("a new clone prints only its checkout", () => {
    fs.writeFileSync(path.join(F, ".env"), "SECRET=1\n");
    // (No #! line: the shell runs such a script itself.)
    fs.writeFileSync(path.join(F, "factory/lane-setup"), "pwd > setup.ran\necho setting up\n", { mode: 0o755 });
    git("add", "factory/lane-setup"); land("lane-setup");
    r = laneDir("3");
    assert.equal(r.stdout, `${d}\n`);
  });
  test("  and says on stderr what it made", () => { has(r.stderr, `made lane 3's clone at ${d}`); });
  test("  its .env is the checkout's", () => { assert.equal(fs.readlinkSync(path.join(d, ".env")), path.join(F, ".env")); });
  test("  its recipes are the checkout's copy of the skill", () => { assert.equal(fs.readlinkSync(path.join(d, ".tracker/skill")), fs.readlinkSync(path.join(F, ".tracker/skill"))); });
  test("  factory/lane-setup ran in it", () => { assert.equal(readOr(path.join(d, "setup.ran")), `${d}\n`); });
  test("    its output on stderr", () => { has(r.stderr, "setting up"); });
  test("  the links are never committed", () => { assert.ok(excluded(d).includes("/work") && excluded(d).includes("/.env")); });
  test("  lane-setup runs only once", () => {
    fs.rmSync(path.join(d, "setup.ran"));
    laneDir("3");
    assert.ok(!fs.existsSync(path.join(d, "setup.ran")));
  });
  test("a lane's clone finds the others beside the first checkout", () => { assert.equal(chomp(laneDir("2", d).stdout), `${F}-lane2`); });
  test("a lane whose work/ link went missing gets it back", () => {
    fs.rmSync(path.join(d, "work"));
    laneDir("3");
    assert.ok(fs.lstatSync(path.join(d, "work")).isSymbolicLink());
    assert.equal(readOr(path.join(d, "work/x")), "data\n");
  });
  test("  excluded once", () => { assert.equal(excluded(d).filter((l) => l === "/work").length, 1); });
});

// Without an origin, lane 1 is the checkout itself, and there's no second lane.
describe("without an origin", () => {
  const n = w.at("noorigin");
  fs.mkdirSync(n); w.git(n, "init", "-q"); fs.cpSync(path.join(F, "factory"), path.join(n, "factory"), { recursive: true, verbatimSymlinks: true });
  test("without an origin, lane 1 is the checkout", () => { assert.equal(chomp(laneDir("1", n).stdout), n); });
  test("  and lane 2 can't be made", () => { assert.equal(laneDir("2", n).code, 2); });
});
