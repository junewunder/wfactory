// An unfinished unit's outputs, set aside when the store's copy was put back over them: its card
// says where they went; the same unit claimed again gets them back before its session, if they
// were built from the commit its branch is on and the copy here is still the one they were set
// aside from; a different unit of the group never gets them; and the set goes once the unit is
// done or dropped. Run: node --test test/store/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { has, hasnt, readOr, cmd, chomp } from "../lib/index.ts";
import { storeFactory, ONE } from "./factory.ts";

const f = storeFactory(["a", "b"]);
const { add, store, asides, group } = f;
const [a, b] = f.lanes;
const UNDONE = { FACTORY_FAKE_UNDONE: "1" };
const log7 = () => readOr(a.at("work/out/f7/log.txt"));
const card = (id: string) => a.run("factory/tracker", ["show", id]).stdout;
// The set holding a unit's outputs, and a file of it.
const setOf = (u: string) => asides(a, "f7").find((x) => readOr(path.join(x, ".units")).split("\n").includes(u)) ?? "";
group("f7");
// A merged unit first: the store has the group's data, so a put-back sets aside only what's new.
add("f7/r0", "--reads", "none");
a.loop(ONE);

describe("the same unit claimed again gets its own set-aside outputs back", () => {
  let first = "", again = "";
  test("a session ends unfinished: its outputs are set aside", () => {
    add("f7/r1", "--reads", "none");
    first = a.loop(ONE, UNDONE);
    hasnt(log7(), "f7/r1 on a");
    has(readOr(path.join(setOf("f7/r1"), "out/log.txt")), "f7/r1 on a");
  });
  test("  the set records whose they are: unit, session, commit, host", () => {
    const from = readOr(path.join(setOf("f7/r1"), ".from")).trim().split("\t");
    const by = chomp(a.run("factory/tracker", ["state", "f7/r1", "--by"]).stdout);
    const head = chomp(cmd("git", ["rev-parse", "refs/remotes/origin/unit/f7/r1"], { cwd: a.dir, env: a.envWith() }).stdout);
    assert.deepEqual(from, ["f7/r1", by, head, "a"]);
  });
  test("  its card says where they went, and to rebuild before trusting notes about work/", () => {
    const c = card("f7/r1");
    has(c, `its outputs went to work/.store/aside/${path.basename(setOf("f7/r1"))} on a, built from commit`);
    has(c, "otherwise rebuild them before trusting earlier notes about what's in work/");
  });
  test("claimed again on its branch: they're back before its session", () => {
    again = a.loop(ONE);
    has(again, "Its last attempt's outputs (set aside in work/.store/aside/");
    // Its session added to them: both attempts' lines are there.
    assert.equal(log7().split("\n").filter((l) => l === "f7/r1 on a").length, 2, log7());
  });
  test("  the set is gone", () => { assert.equal(setOf("f7/r1"), ""); });
  test("  and so is the card's line", () => { hasnt(card("f7/r1"), "Set aside:"); });
});

describe("a different unit of the group never gets them", () => {
  test("another unit claimed while one's set is aside: not put back", () => {
    add("f7/r2", "--reads", "none");
    a.loop(ONE, UNDONE);
    assert.ok(setOf("f7/r2"), "no set for f7/r2");
    // As if this run and the next were one: a set still kept, its unit not claimed again, when the
    // lanes stop a second time is one to sort (aside-kept.test.ts); this is about restore's refusals.
    fs.rmSync(path.join(setOf("f7/r2"), ".night"), { force: true });
    add("f7/r3", "--reads", "none", "--priority", "50");
    const out = a.loop(ONE);
    has(out, "iteration 1: Unit r3 of f7");
    hasnt(out, "Its last attempt's outputs");
    hasnt(log7(), "f7/r2 on a");
  });
  test("  the set waits for its own unit", () => { assert.ok(setOf("f7/r2"), "the set is gone"); });
});

describe("refused when stale", () => {
  // f7/r3 landed after f7/r2's set was made: the copy here has its outputs now.
  test("made over a copy that has moved on (another unit landed since): not put back, and told to rebuild", () => {
    const out = a.loop(ONE);
    has(out, "iteration 1: Unit r2 of f7");
    has(out, "were made over a copy of the group's data that has moved on since (other work landed): they were not put back. Rebuild them before trusting earlier notes about what's in work/.");
    assert.equal(log7().split("\n").filter((l) => l === "f7/r2 on a").length, 1, log7());
  });
  test("  its set is deleted once the unit is done", () => {
    assert.equal(chomp(a.run("factory/tracker", ["state", "f7/r2"]).stdout), "done");
    store(a, ["aside", "sort"]);
    assert.equal(setOf("f7/r2"), "");
  });
  test("built from another commit (its branch moved on elsewhere): not put back", () => {
    add("f7/r6", "--reads", "none");
    a.loop(ONE, UNDONE);
    assert.ok(setOf("f7/r6"), "no set for f7/r6");
    // Another machine carries on from the branch and pushes.
    const git = (...args: string[]) => { const r = cmd("git", args, { cwd: b.dir, env: b.envWith() }); assert.equal(r.code, 0, r.stderr); return r.stdout; };
    git("fetch", "-q", "origin", "unit/f7/r6");
    git("checkout", "-q", "-b", "unit/f7/r6", "origin/unit/f7/r6");
    fs.writeFileSync(b.at("elsewhere.txt"), "more\n");
    git("add", "elsewhere.txt"); git("commit", "-q", "-m", "f7/r6: more elsewhere");
    git("push", "-q", "origin", "unit/f7/r6");
    git("checkout", "-q", "main");
    const out = a.loop(ONE, UNDONE);
    has(out, "iteration 1: Unit r6 of f7");
    has(out, "but your branch is at");
    has(out, "they were not put back. Rebuild them before trusting earlier notes about what's in work/.");
  });
  test("  dropped, its sets go too", () => {
    f.drop("f7/r6");
    store(a, ["aside", "sort"]);
    assert.deepEqual(asides(a, "f7"), []);
  });
});

// Driven by store.sh itself, in lane a: a session of f7/r7 ends unfinished on its branch (here at
// main's commit), and its set is made; then each thing in the copy here that isn't on the store
// keeps it from being put back, until it's gone.
describe("never put back over other work in the copy here", () => {
  const G = (x: string) => a.at(`work/.store/groups/${x}`);
  const ok = (args: string[]) => { const r = store(a, args); assert.equal(r.code, 0, `store.sh ${args.join(" ")}: ${r.stderr}`); return r; };
  const restore = () => store(a, ["restore", "f7", "f7/r7"]);
  const git = (...args: string[]) => cmd("git", args, { cwd: a.dir, env: a.envWith() });
  test("(f7/r7's set is made)", () => {
    add("f7/r7", "--reads", "none");
    a.setup(["lease", "take", "f7"]); ok(["take", "f7"]);
    a.setup(["claim", "f7/r7"], { FACTORY_BRANCHES: "1", FACTORY_TAG: "s7" });
    git("branch", "-f", "unit/f7/r7", "HEAD");
    ok(["dirty", "f7", "f7/r7", String(process.pid)]);
    fs.appendFileSync(a.at("work/out/f7/log.txt"), "f7/r7 on a\n");
    fs.writeFileSync(a.at("work/out/f7/r7.txt"), "r7\n");
    ok(["end", "f7", "f7/r7", "c"]);
    assert.ok(setOf("f7/r7"), "no set");
    assert.equal(readOr(path.join(setOf("f7/r7"), ".from")).split("\t")[2], chomp(git("rev-parse", "HEAD").stdout));
  });
  test("another lane's session on the group: not put back", () => {
    ok(["dirty", "f7", "f7/x", String(process.pid)]); fs.renameSync(G("f7.dirty.a-lane1"), G("f7.dirty.a-lane2"));
    const r = restore();
    fs.rmSync(G("f7.dirty.a-lane2"));
    assert.equal(r.code, 3);
    has(r.stdout, "weren't put back: the copy here has other work in it that isn't on the store yet (a session in a-lane2)");
  });
  test("another unit's outputs waiting to land: not put back", () => {
    fs.writeFileSync(G("f7.unmerged.f7+x"), "f7/x\tc\n");
    const r = restore();
    fs.rmSync(G("f7.unmerged.f7+x"));
    has(r.stdout, "(f7/x's outputs, waiting to land)");
  });
  test("a copy back still owed: not put back", () => {
    fs.writeFileSync(G("f7.unsent"), "");
    const r = restore();
    fs.rmSync(G("f7.unsent"));
    has(r.stdout, "(a copy back still owed)");
  });
  test("a file of the set where the copy here has a folder: refused before anything is copied", () => {
    fs.mkdirSync(a.at("work/out/f7/r7.txt/inner"), { recursive: true });
    const r = restore();
    fs.rmSync(a.at("work/out/f7/r7.txt"), { recursive: true });
    assert.equal(r.code, 3);
    has(r.stdout, "out/r7.txt is a file in one and a folder in the other");
    hasnt(log7(), "f7/r7 on a");
  });
  test("with nothing in the way, it's put back", () => {
    const r = restore();
    assert.equal(r.code, 0, r.stdout + r.stderr);
    has(log7(), "f7/r7 on a");
    assert.equal(readOr(a.at("work/out/f7/r7.txt")), "r7\n");
  });
  test("  and the card stops naming the set", () => { hasnt(card("f7/r7"), "Set aside:"); });
  // A killed lane's session, put back by another lane's look: that clone's branch says nothing
  // about what the outputs were built on, so no commit is recorded, and they're never put back.
  test("a killed lane's session, put back by a look: no commit recorded, never put back", () => {
    ok(["dirty", "f7", "f7/r7", String(process.pid)]);
    fs.appendFileSync(a.at("work/out/f7/log.txt"), "f7/r7 again\n");
    fs.rmSync(G("f7.dirty.a-lane1"));
    fs.writeFileSync(G("f7.unmerged.f7+r7"), "f7/r7\tc\n");
    ok(["release-idle"]);
    assert.equal(readOr(path.join(setOf("f7/r7"), ".from")).split("\t")[2], "");
    has(restore().stdout, "were built from commit (unknown)");
  });
  test("a set dropped by hand: the card stops naming it", () => {
    has(card("f7/r7"), "Set aside:");
    ok(["aside", "drop", path.basename(setOf("f7/r7"))]);
    hasnt(card("f7/r7"), "Set aside:");
    f.drop("f7/r7");
  });
});
