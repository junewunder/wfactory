// A merge unit recorded finished whose branch couldn't land (main looked red): the lane lands it
// at its next look, as any branch it left, and is free again; one whose lane died landing it is
// landed by another lane from origin's copy, pushed after the merge, before landing (#135); and a
// record naming no lane still lands.
// Run: node --test test/branches/
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { has, hasnt, readOr } from "../lib/index.ts";
import { branchFactory, ONE } from "./factory.ts";

const f = branchFactory(["c"]);
const [c] = f.lanes;
const { add } = f;
const hook = path.join(c.locks, "check-hook");
const failing = (when: string) => fs.writeFileSync(hook, `#!/bin/sh\n${when}\n`, { mode: 0o755 });

describe("a merge unit recorded finished whose branch couldn't land: landed at the lane's next look", () => {
  let mu = "";
  test("a branch that fails the check becomes this lane's merge unit", () => {
    // The check fails on the unit's branch only; main alone passes.
    failing('case "$(git rev-parse --abbrev-ref HEAD)" in unit/*) exit 1;; esac');
    add("mr");
    has(c.loop(ONE), "filed Merge main on c lane 1");
    mu = readOr(c.at("runs/.merge-unit")).trim();
  });
  test("  its session settles it, but main looks red when it lands", () => {
    failing("exit 1");
    const out = c.loop(ONE);
    has(out, "iteration 1: Merge main on c lane 1");
    has(out, "main itself fails");
    assert.equal(c.ok(["state", mu]), "merging");
  });
  test("  the next look lands it", () => {
    fs.rmSync(hook);
    add("mr-next");
    has(c.loop(ONE), "unit/g/mr merged into main");
    assert.equal(c.ok(["state", "g/mr"]), "done");
  });
  test("  and the lane is free again", () => { assert.equal(readOr(c.at("runs/.merge-unit")).trim(), ""); });
});

describe("a lane that dies landing its merge unit: another lane lands the branch as merged", () => {
  const c2 = f.lane("c", { k: 2, locks: "c2" });
  let mu = "";
  test("a branch that fails the check becomes this lane's merge unit, its branch pushed", () => {
    failing('case "$(git rev-parse --abbrev-ref HEAD)" in unit/*) exit 1;; esac');
    add("mk");
    has(c.loop(ONE), "filed Merge main on c lane 1");
    mu = readOr(c.at("runs/.merge-unit")).trim();
    fs.rmSync(hook);
  });
  test("  its merge unit is done, and the lane dies landing it", async () => {
    // The landing's check kills the lane (everything it started), after the merged branch is pushed.
    failing(`kill -KILL -- -$(cat "${c.locks}/lane-pgid")`);
    const k = c.loopBg(ONE);
    fs.writeFileSync(path.join(c.locks, "lane-pgid"), String(k.pid));
    await k.end();
    fs.rmSync(hook);
    assert.equal(c.ok(["state", mu]), "merging");
  });
  // (Until #135 it waited for the lane's restart: origin had only the copy from before the merge.)
  test("  the other lane on its machine lands it, as merged", () => {
    has(c2.loop(ONE), "unit/g/mk merged into main");
    assert.equal(c2.ok(["state", "g/mk"]), "done");
    assert.equal(c2.ok(["state", mu]), "done");
  });
  test("  the lane, started again, drops its own copy and pushes nothing", () => {
    const out = c.loop(ONE);
    has(out, "unit/g/mk's unit was done elsewhere");
    hasnt(out, "unit/g/mk pushed");
    assert.equal(c.git("ls-remote", "origin", "refs/heads/unit/g/mk"), "");
  });
});

describe("a finished branch whose record names no lane (recorded before lanes were, or by hand) still lands", () => {
  test("its lane lands it", () => {
    // A session by hand whose process is gone by now (its claim lives with it).
    const gone = String(spawnSync("true").pid);
    const H = { FACTORY_BRANCHES: "1", FACTORY_TAG: "byhand", FACTORY_LANE: undefined, FACTORY_PID: gone };
    add("old");
    c.setup(["claim", "g/old"], H);
    c.git("fetch", "-q", "origin");
    c.git("checkout", "-q", "-b", "unit/g/old", "origin/main");
    fs.mkdirSync(c.at("out"), { recursive: true });
    fs.writeFileSync(c.at("out/g-old.txt"), "by hand\n");
    c.git("add", "out/g-old.txt"); c.git("commit", "-qm", "old: by hand");
    c.git("checkout", "-q", "main");
    c.setup(["done", "g/old", "--evidence", "by hand"], H);
    assert.equal(c.ok(["state", "g/old"]), "merging");
    has(c.loop(ONE), "unit/g/old merged into main");
    assert.equal(c.ok(["state", "g/old"]), "done");
  });
});
