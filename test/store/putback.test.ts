// Putting the store's copy back over an unfinished unit's outputs: it waits for another lane's
// session on the group; outputs it can't tell apart from finished ones go aside as a set to sort;
// a store that moved on, or is torn, older session marks, a CI run, a copy back still owed, and
// nothing on the store yet. Run: node --test test/store/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { has, hasnt, readOr, chomp, cmd, holdLock } from "../lib/index.ts";
import { storeFactory } from "./factory.ts";

const f = storeFactory(["a"]);
const { add, drop, store, leases, st, asides, asideRead, asideLines, write, group } = f;
const [a] = f.lanes;
const ok = (args: string[], env: NodeJS.ProcessEnv = {}) => { const r = store(a, args, env); assert.equal(r.code, 0, `store.sh ${args.join(" ")}: ${r.stderr}`); return r; };
const G = (x: string) => a.at(`work/.store/groups/${x}`);
const out9 = (x: string) => a.at(`work/out/f9/${x}`);
const pid = String(process.pid);
// The sets aside of a group dropped, and the units that sort them.
const sortdrop = (g: string) => {
  for (const x of asides(a, g)) {
    const u = chomp(readOr(path.join(x, ".unit")));
    if (u) a.run("factory/tracker", ["drop", u, "--why", "test"]);
    fs.rmSync(x, { recursive: true, force: true });
  }
};
const done = (id: string, env: NodeJS.ProcessEnv = {}) => a.setup(["done", id, "--evidence", "test"], env);
group("f9");
a.setup(["lease", "take", "f9"]);
add("f9/s1"); done("f9/s1");
write(out9("base.txt"), "base\n"); ok(["end", "f9", "f9/s1", "c"]);

// Two lanes on one group: an unfinished unit's put-back waits for the other lane's session. If that
// unit lands meanwhile, its outputs can't be told apart from the unfinished ones: both go aside, as
// a set with a unit to sort it, and neither reaches the store.
describe("two lanes on one group", () => {
  test("an unfinished unit's put-back waits for another lane's session on the group", () => {
    add("f9/a"); add("f9/b");
    ok(["dirty", "f9", "f9/b", pid]); fs.renameSync(G("f9.dirty.a-lane1"), G("f9.dirty.a-lane2"));
    ok(["dirty", "f9", "f9/a", pid]); write(out9("a.txt"), "A\n");
    has(ok(["end", "f9", "f9/a", "c"]).stderr, "waits for the session or CI here");
  });
  test("  its outputs stay here meanwhile, and don't reach the store", () => {
    assert.ok(fs.existsSync(out9("a.txt")), "gone from here");
    assert.ok(!fs.existsSync(st("groups/f9/out/a.txt")), "on the store");
  });
  test("  the other unit lands: neither unit's outputs reach the store", () => {
    write(out9("b.txt"), "B\n"); done("f9/b"); fs.rmSync(G("f9.dirty.a-lane2"));
    ok(["end", "f9", "f9/b", "c"]);
    assert.ok(!fs.existsSync(st("groups/f9/out/a.txt")) && !fs.existsSync(st("groups/f9/out/b.txt")));
  });
  test("  the store's copy is put back here", () => { assert.ok(!fs.existsSync(out9("a.txt")) && !fs.existsSync(out9("b.txt"))); });
  test("  both are kept aside, in a set to sort", () => { assert.equal(asideLines(a, "f9", ".kind", "out/a.txt", "out/b.txt"), "check A B"); });
  test("  with a unit, and an event that says why", () => { has(a.events(), "mixed with finished f9/b"); });
  after(() => { sortdrop("f9"); drop("f9/a"); });
});

// The store moved on (this machine's lease lapsed, another copied back): a due copy back isn't sent
// over it; the next copy down sets the copy here aside.
let saved = "";
describe("the store moved on", () => {
  test("a copy back owed to a store that has moved on isn't sent", () => {
    write(out9("stale.txt"), "stale\n"); write(G("f9.unsent"), "");
    saved = readOr(st("stamps/f9.json"));
    write(st("stamps/f9.json"), '{"unit":"f9/v","commit":"x","host":"b","at":"2031-01-01T00:00:00Z","bytes":10}\n');
    ok(["release-idle"], { FACTORY_STORE_RETRY: "0" });
    assert.ok(!fs.existsSync(st("groups/f9/out/stale.txt")));
  });
  test("  an event says so", () => { has(a.events(), "store-moved\tf9's copy on a owes the store a copy back"); });
  test("  the next copy down sets it aside", () => {
    ok(["take", "f9", "--new"]);
    has(asideRead(a, "f9", "out/stale.txt"), "stale");
  });
  after(() => { sortdrop("f9"); });
});

// A torn store doesn't stop a put-back (else the group would be stuck): it's put back as it is.
describe("a torn store", () => {
  test("a put-back over a torn store goes ahead", () => {
    add("f9/c"); write(out9("c.txt"), "C\n"); write(G("f9.unmerged.f9+c"), "f9/c\t\n");
    write(st("stamps/f9.json"), '{"copying":"f9/w","host":"b"}\n');
    ok(["release-idle"]);
    assert.ok(!fs.existsSync(out9("c.txt")), "c.txt still here");
    assert.ok(!fs.readdirSync(a.at("work/.store/groups")).some((x) => x.startsWith("f9.unmerged.")), "an unmerged mark left");
  });
  test("  and says the store is torn", () => { has(a.events(), "store-torn\tf9 on the store is a copy back that didn't finish (f9/w from b); put back"); });
  after(() => { drop("f9/c"); store(a, ["aside", "sort"]); write(st("stamps/f9.json"), saved); });
});

// Session marks from an older store.sh (no pid): live while their lane's loop holds the lane lock.
describe("older session marks", () => {
  test("an older mark is live while its lane holds its lock", async () => {
    add("f9/d"); write(out9("d.txt"), "D\n"); write(G("f9.dirty.a-lane1"), "");
    const lock = await holdLock(path.join(a.locks, "lane-a-lane1.lock"));
    try { ok(["release-idle"]); } finally { await lock.release(); }
    assert.ok(fs.existsSync(G("f9.dirty.a-lane1")));
  });
  test("  and ended once it doesn't: put back, with a unit to sort it (no unit named)", () => {
    ok(["release-idle"]);
    assert.ok(!fs.existsSync(G("f9.dirty.a-lane1")), "the mark is still there");
    assert.ok(!fs.existsSync(out9("d.txt")), "not put back");
  });
  after(() => { sortdrop("f9"); drop("f9/d"); });
});

// A finished unit's copy back still owed (origin out of reach) when an unfinished unit's put-back
// runs: the finished work is in the copy too, so the set is one to sort, never deleted with the unit.
describe("a copy back still owed under a put-back", () => {
  test("(f9/f's copy back is owed)", () => {
    ok(["take", "f9", "--new"]);
    add("f9/f"); done("f9/f"); write(out9("f.txt"), "F\n");
    fs.renameSync(f.origin, `${f.origin}.off`);
    try { store(a, ["end", "f9", "f9/f", "c"]); } finally { fs.renameSync(`${f.origin}.off`, f.origin); }
    assert.ok(fs.existsSync(G("f9.unsent")));
  });
  // A CI run reading the group holds the put-back up; old-format marks of a live lane do too.
  test("a CI run on the group holds a put-back up", () => {
    add("f9/u"); write(out9("u.txt"), "U\n"); write(G("f9.unmerged.f9+u"), "f9/u\t\n");
    ok(["dirty", "f9", "ci", pid]);
    ok(["release-idle"]);
    assert.ok(fs.existsSync(out9("u.txt")));
  });
  test("  so does a live session's mark written by an older store.sh", () => {
    ok(["clean", "f9"]);
    const lstart = chomp(cmd("ps", ["-o", "lstart=", "-p", pid], { cwd: a.dir, env: process.env }).stdout);
    write(G("f9.dirty.a-lane3"), `f9/z\t${pid}\t${lstart}\n`);
    ok(["release-idle"]);
    assert.ok(fs.existsSync(out9("u.txt")));
  });
  test("  then it runs", () => {
    fs.rmSync(G("f9.dirty.a-lane3"));
    ok(["release-idle"]);
    assert.ok(!fs.existsSync(out9("u.txt")));
  });
  test("  the owed finished work goes aside to sort, not deleted with the unfinished unit", () => { assert.equal(asideLines(a, "f9", ".kind", "out/f.txt"), "check F"); });
  after(() => { sortdrop("f9"); drop("f9/u"); a.setup(["lease", "release", "f9"]); });
});

// Nothing on the store yet: an unfinished unit's outputs (with anything else here) all go aside, to sort.
describe("a put-back with nothing on the store", () => {
  test("a put-back with nothing on the store sets everything here aside, and stamps nothing", () => {
    group("f10");
    a.setup(["lease", "take", "f10"]);
    add("f10/u"); write(a.at("work/out/f10/u.txt"), "U\n"); write(G("f10.unmerged.f10+u"), "f10/u\t\n");
    ok(["release-idle"]);
    assert.ok(!fs.existsSync(a.at("work/out/f10/u.txt")), "u.txt still here");
    assert.ok(!fs.existsSync(st("stamps/f10.json")), "stamped");
  });
  test("  kept, to sort", () => { has(asideRead(a, "f10", "out/u.txt"), "U"); });
  test("  and the lease goes", () => {
    sortdrop("f10"); drop("f10/u");
    ok(["release-idle"]);
    hasnt(leases(), "f10=");
  });
});

f.notBroken();
