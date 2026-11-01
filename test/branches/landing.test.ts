// Landing a finished branch on main: a push beaten to it by another, edits the branch mustn't
// carry (tracker/, the loop's scripts), a branch that moved both here and on origin, and a
// tracker write on main while the branch is being checked. Run: node --test test/branches/
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { has, hasnt, lines } from "../lib/index.ts";
import { branchFactory, ONE } from "./factory.ts";

const f = branchFactory(["a", "b", "d"]);
const [a, b, d] = f.lanes;
const { add, w } = f;
// Another clone, to push to origin behind the lanes' backs.
const sneak = w.at("sneak");
w.git(w.top, "clone", "-q", f.origin, sneak);
const sg = (...args: string[]) => w.git(sneak, ...args);

describe("a push race at merge time: both units end up on main", () => {
  let ra = "", rb = "";
  test("a lane's push at merge time was beaten to it", async () => {
    add("race1"); add("race2");
    // Lane a's first push loses: a hook lands someone else's commit just before it.
    fs.writeFileSync(a.at(".git/hooks/pre-push"), `#!/bin/sh
mkdir "${w.at("sneaked")}" 2>/dev/null || exit 0   # once, even for two pushes at the same moment
cd "${sneak}" && git pull -q --no-edit origin main && echo sneak > sneak.txt && git add sneak.txt && git commit -qm sneak || exit 1
# Lane b and the tracker push to main too: on a lost race, rebase and push again.
for i in 1 2 3 4 5; do git push -q origin main 2>/dev/null && exit 0; git pull -q --rebase origin main; done; exit 1
`, { mode: 0o755 });
    const args = ["--idle-wait", "0.05", ...ONE];
    [ra, rb] = (await Promise.all([a.loopBg(args).end(120), b.loopBg(args).end(120)])).map((r) => r.stdout);
    assert.ok(fs.existsSync(w.at("sneaked")));
  });
  test("  both units and the other push are on main", () => {
    assert.ok(f.main("out/g-race1.txt"), `${ra}\n${rb}`);
    assert.ok(f.main("out/g-race2.txt"), `${ra}\n${rb}`);
    assert.equal(f.main("sneak.txt"), "sneak");
  });
  test("  both lanes say merged", () => { has(ra, "merged into main"); has(rb, "merged into main"); });
  test("  and the tracker says done for both", () => {
    assert.equal(a.ok(["state", "g/race1"]), "done");
    assert.equal(a.ok(["state", "g/race2"]), "done");
  });
});

describe("a branch's tracker/ edits never reach main, new files included", () => {
  test("a branch that changed tracker/ still lands", () => {
    add("sneaky");
    has(a.loop(ONE, { FACTORY_FAKE_TRACKER: "1" }), "unit/g/sneaky merged into main");
  });
  test("  without its tracker/ edits, even a new file", () => { assert.equal(f.main("tracker/groups/sneaky.json"), ""); });
  test("  and the overseer hears of it", () => { has(a.events(), "tracker-edits"); });
});

describe("a branch's edits to the loop's scripts are dropped, unless the unit is tagged factory", () => {
  test("a branch that changed the loop's scripts still lands", () => {
    add("loopy");
    has(a.loop(ONE, { FACTORY_FAKE_LOOP: "1" }), "unit/g/loopy merged into main");
  });
  test("  without those edits", () => { hasnt(f.main("factory/loop.sh"), "g/loopy was here"); });
  test("  even a new script", () => { assert.equal(f.main("factory/extra.sh"), ""); });
  test("  but its work does", () => { has(f.main("out/g-loopy.txt"), "work on g/loopy"); });
  test("  and the overseer hears where the edits are", () => { has(a.events(), "factory-edits"); });
  test("a unit tagged factory may change them", () => {
    add("loopfix", "--tags", "factory");
    a.loop(ONE, { FACTORY_FAKE_LOOP: "1" });
    has(f.main("factory/loop.sh"), "g/loopfix was here");
  });
});

// Nothing is overwritten, the session works on this clone's, and once it lands, origin's copy is
// left for the overseer.
describe("a unit's branch moved both in this lane's clone and on origin", () => {
  let ev = "", log = "";
  test("a branch moved here and on origin isn't pushed over origin's", () => {
    add("both");
    a.git("fetch", "-q", "origin");
    a.git("branch", "-q", "unit/g/both", "origin/main");
    a.git("checkout", "-q", "unit/g/both"); fs.writeFileSync(a.at("both.txt"), "here\n"); a.git("add", "both.txt"); a.git("commit", "-qm", "here"); a.git("checkout", "-q", "main");
    sg("fetch", "-q", "origin"); sg("checkout", "-q", "-B", "unit/g/both", "origin/main");
    fs.writeFileSync(path.join(sneak, "both.txt"), "there\n"); sg("add", "both.txt"); sg("commit", "-qm", "there"); sg("push", "-q", "origin", "unit/g/both"); sg("checkout", "-q", "main");
    log = a.loop(ONE);
    ev = a.events();
    has(ev, "stuck-branch\tunit/g/both on a lane 1 and on origin have both moved; nothing was overwritten");
  });
  test("  claimed, the two clash: the session works on this clone's", () => {
    has(ev, "stuck-branch\tunit/g/both on a lane 1 and on origin have both moved and clash; the session works on this clone's, and origin's keeps its own");
  });
  test("  it lands", () => { has(log, "unit/g/both merged into main"); });
  test("  with this clone's work", () => { assert.equal(f.main("both.txt"), "here"); });
  test("  and origin's copy, not on main, is left there, for the overseer", () => {
    has(ev, "stuck-branch\tUnit both (g/both) is merged, but origin's unit/g/both has commits that aren't on main (someone carried on); it was left there");
  });
  test("  (still on origin)", () => { assert.notEqual(a.git("ls-remote", "origin", "refs/heads/unit/g/both"), ""); });
});

// The push loses the race, main is merged in again, and the branch isn't checked again (main's
// code didn't move).
describe("a tracker write lands on main while a branch is being checked", () => {
  let log = "";
  test("a tracker write on main mid-check: the branch still lands", () => {
    add("racy");
    fs.writeFileSync(path.join(b.locks, "check-hook"), `#!/usr/bin/env bash
rm -f "$0"
cd "${d.dir}" && FACTORY_LOCKS="${d.locks}" FACTORY_HOST=d factory/tracker note g/race1 "a tracker write mid-check" >/dev/null
`, { mode: 0o755 });
    fs.writeFileSync(path.join(b.locks, "checks"), "");
    log = b.loop(ONE);
    has(log, "unit/g/racy merged into main");
    has(f.main("tracker/groups/g.json"), "a tracker write mid-check");
  });
  test("  checked once, not again for a main that moved only in tracker/", () => {
    assert.equal(lines(fs.readFileSync(path.join(b.locks, "checks"), "utf8")), 1);
  });
});
