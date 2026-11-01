// The store or origin out of reach: nothing is stamped, released or mistaken for "nothing there";
// a store folder that isn't there is an outage too; a copy back that fails is tried again at the
// next look, with no new unit; and a session mark whose loop is gone doesn't hold the lease.
// Run: node --test test/store/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { has, hasnt, readOr, sleeper, chomp } from "../lib/index.ts";
import { storeFactory, NOPE } from "./factory.ts";

const f = storeFactory(["a"]);
const { add, store, stamp, leases, st, write } = f;
const [a] = f.lanes;
const ok = (args: string[], env: NodeJS.ProcessEnv = {}) => { const r = store(a, args, env); assert.equal(r.code, 0, `store.sh ${args.join(" ")}: ${r.stderr}`); };
const G = (x: string) => a.at(`work/.store/groups/${x}`);
f.onStore("f3");

describe("the store unreachable: nothing is stamped, released or mistaken for \"nothing there\"", () => {
  test("copying down from an unreachable store fails (not \"nothing on the store yet\")", () => {
    assert.equal(store(a, ["take", "f3", "--unit", "f3/x", "--new"], { FACTORY_STORE: NOPE }).code, 2);
  });
  test("copying back to an unreachable store fails", () => {
    a.setup(["lease", "take", "f3"]);
    ok(["take", "f3", "--new"]);
    write(a.at("work/out/f3/w.txt"), "a's work\n");
    assert.notEqual(store(a, ["up", "f3", "f3/x", "c"], { FACTORY_STORE: NOPE }).code, 0);
  });
  test("  the copy here is marked unsent", () => { assert.ok(fs.existsSync(G("f3.unsent"))); });
  test("  and the lanes stopping keep the lease", () => {
    store(a, ["leave"], { FACTORY_STORE: NOPE });
    has(leases(), "f3=a");
  });
  test("  and so does a look while it's still down", () => {
    store(a, ["release-idle"], { FACTORY_STORE: NOPE, FACTORY_STORE_RETRY: "0" });
    has(leases(), "f3=a");
  });
  test("  once the store is back, the next look copies it back", () => {
    ok(["release-idle"], { FACTORY_STORE_RETRY: "0" });
    has(readOr(st("groups/f3/out/w.txt")), "a's work");
  });
  test("  and releases the lease", () => { hasnt(leases(), "f3="); });
});

describe("a store folder that isn't there (a dataset not mounted, a wrong path) is an outage, not \"nothing there\"", () => {
  const GONE = f.w.at("store-unmounted");
  test("copying down from a missing store folder fails (not \"nothing on the store yet\")", () => {
    assert.equal(store(a, ["take", "f3", "--new"], { FACTORY_STORE: GONE }).code, 2);
  });
  test("  copying back to it fails", () => {
    a.setup(["lease", "take", "f3"]);
    write(a.at("work/out/f3/w2.txt"), "a's later work\n");
    assert.notEqual(store(a, ["up", "f3", "f3/x", "c"], { FACTORY_STORE: GONE }).code, 0);
  });
  test("  and makes no folder where the store should be", () => { assert.ok(!fs.existsSync(GONE)); });
  after(() => { ok(["leave"]); });
});

// The event says when it lands. Origin out of reach: the lease can't be confirmed.
describe("a copy back that fails is tried again at the next look, with no new unit", () => {
  test("a unit's copy back with origin out of reach fails", () => {
    a.setup(["lease", "take", "f3"]);
    add("f3/r1"); a.setup(["claim", "f3/r1"], { FACTORY_TAG: "r1" });
    ok(["dirty", "f3", "f3/r1", String(process.pid)]); write(a.at("work/out/f3/r1.txt"), "r1's work\n");
    a.setup(["done", "f3/r1", "--evidence", "test"], { FACTORY_TAG: "r1" });
    fs.renameSync(f.origin, `${f.origin}.off`);
    const rc = store(a, ["end", "f3", "f3/r1", "c"]).code;
    fs.renameSync(`${f.origin}.off`, f.origin);
    assert.equal(rc, 2);
  });
  test("  and says so once", () => { has(a.events(), "lost-lease\tf3's lease isn't a's any more, or origin couldn't confirm it, after f3/r1"); });
  test("  its tries are counted", () => { assert.equal(chomp(readOr(G("f3.retry"))).split("\t")[2], "1"); });
  test("  its session's mark goes (the unsent mark says the rest)", () => { assert.ok(!fs.existsSync(G("f3.dirty.a-lane1"))); });
  test("  the next look before its next try doesn't copy it back", () => {
    ok(["release-idle"]);
    hasnt(readOr(st("groups/f3/out/r1.txt")), "r1's work");
  });
  test("  the look at its next try does, with no new unit", () => {
    ok(["release-idle"], { FACTORY_STORE_RETRY: "0" });
    has(readOr(st("groups/f3/out/r1.txt")), "r1's work");
  });
  test("    stamped for its unit", () => { assert.equal(stamp("f3"), "f3/r1"); });
  test("  an event says it went through", () => { has(a.events(), "store-up-retried\tf3's copy back from a after f3/r1 went through on try 2"); });
  test("  and the lease goes", () => { hasnt(leases(), "f3="); });
});

// A session mark whose loop is gone (a lane killed): it doesn't hold the lease. Its unit, done
// since, gets its outputs copied back; a live session's mark keeps the lease.
describe("a session mark whose loop is gone", () => {
  test("a live session's mark keeps the lease", async () => {
    a.setup(["lease", "take", "f3"]);
    add("f3/r2"); a.setup(["done", "f3/r2", "--evidence", "test"]);
    ok(["dirty", "f3", "f3/r3", String(process.pid)]);
    fs.renameSync(G("f3.dirty.a-lane1"), G("f3.dirty.a-lane2"));   // another lane's, live
    const dead = sleeper();
    ok(["dirty", "f3", "f3/r2", String(dead.pid)]); write(a.at("work/out/f3/r2.txt"), "r2's work\n");
    await dead.kill();
    ok(["release-idle"]);
    has(leases(), "f3=a");
  });
  test("  a dead session's doesn't: its unit's outputs are copied back", () => {
    fs.rmSync(G("f3.dirty.a-lane2"));
    ok(["release-idle"]);
    has(readOr(st("groups/f3/out/r2.txt")), "r2's work");
  });
  test("    stamped with this checkout's commit (its mark had none)", () => {
    assert.equal(JSON.parse(readOr(st("stamps/f3.json")) || "{}").commit, a.git("rev-parse", "--short", "HEAD"));
  });
  test("  and the lease goes", () => { hasnt(leases(), "f3="); });
});

f.notBroken();
