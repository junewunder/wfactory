// The store keeps only merged work: a unit handed back unmerged never gets its outputs to the
// store, and the copy here is the store's again, so main's check passes on any machine that copies
// the group down; a finished unit whose branch waits to land has its outputs held here until it
// lands. Run: node --test test/store/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { has, hasnt, readOr } from "../lib/index.ts";
import { storeFactory, ONE } from "./factory.ts";

const f = storeFactory(["a", "b"]);
const { add, store, stamp, leases, state, st, asides, asideRead, group } = f;
const [a, b] = f.lanes;
const ok = (l: typeof a, args: string[], env: NodeJS.ProcessEnv = {}) => { const r = store(l, args, env); assert.equal(r.code, 0, `store.sh ${args.join(" ")}: ${r.stderr}`); return r; };
const both = (l: typeof a | null) => l ? readOr(l.at("work/out/f8/log.txt")) + readOr(l.at("mods/m-f8/mod.txt")) : readOr(st("groups/f8/out/log.txt")) + readOr(st("groups/f8/mod/mod.txt"));
group("f8");

describe("a unit handed back unmerged: its outputs never reach the store", () => {
  test("a merged unit's outputs are copied back", () => {
    add("f8/h1", "--reads", "none");
    a.loop(ONE);
    assert.equal(stamp("f8"), "f8/h1");
  });
  test("  one handed back unfinished isn't: the store keeps the merged unit's", () => {
    add("f8/h2", "--reads", "none");
    a.loop(ONE, { FACTORY_FAKE_UNDONE: "1" });
    assert.equal(stamp("f8"), "f8/h1");
  });
  test("    (none of its outputs)", () => { hasnt(both(null), "f8/h2"); });
  test("  the store's copy is put back over the copy here", () => { hasnt(both(a), "f8/h2"); });
  test("  its outputs are kept aside for it", () => { has(asideRead(a, "f8", "out/log.txt"), "f8/h2 on a"); });
  test("  the unit is interrupted, for its next session to rebuild from its branch", () => { assert.equal(state("f8/h2"), "interrupted"); });
  test("  the lease goes when the lanes stop", () => { hasnt(leases(), "f8="); });
  test("  another machine copies down only merged work", () => {
    ok(b, ["take", "f8", "--unit", "f8/h2", "--new"]);
    b.setup(["lease", "release", "f8"]);
    hasnt(both(b), "f8/h2");
  });
  test("  the set waits for the unit", () => { has(ok(a, ["aside"]).stdout, "the outputs of f8/h2, not on main"); });
  test("  and goes once it's dropped", () => {
    f.drop("f8/h2");
    ok(a, ["aside", "sort"]);
    assert.deepEqual(asides(a, "f8"), []);
  });
});

// A finished unit whose branch waits to land (main broken, a merge unit): its outputs are held
// here, not copied back, and go once it lands.
describe("a unit waiting to land", () => {
  test("(the unit is merging)", () => {
    a.setup(["lease", "take", "f8"]);
    ok(a, ["take", "f8"]);
    add("f8/m1", "--reads", "none"); a.setup(["claim", "f8/m1"], { FACTORY_BRANCHES: "1", FACTORY_TAG: "m1" });
    ok(a, ["dirty", "f8", "f8/m1", String(process.pid)]);
    f.write(a.at("work/out/f8/log.txt"), readOr(a.at("work/out/f8/log.txt")) + "f8/m1 on a\n");
    a.setup(["done", "f8/m1", "--evidence", "test"], { FACTORY_TAG: "m1" });
    assert.equal(state("f8/m1"), "merging");
  });
  test("a unit waiting to land: its outputs aren't copied back", () => {
    ok(a, ["end", "f8", "f8/m1", "c"]);
    hasnt(readOr(st("groups/f8/out/log.txt")), "f8/m1");
  });
  test("  they're held in the copy here", () => { has(readOr(a.at("work/out/f8/log.txt")), "f8/m1 on a"); });
  test("  and the lease with them", () => {
    ok(a, ["release-idle"]);
    has(leases(), "f8=a");
  });
  test("  once it lands, the next look copies them back", () => {
    a.setup(["merged", "f8/m1"]);
    ok(a, ["release-idle"]);
    has(readOr(st("groups/f8/out/log.txt")), "f8/m1 on a");
  });
  test("  and the lease goes", () => { hasnt(leases(), "f8="); });
});

f.notBroken();
