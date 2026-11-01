// The cache limit: making room deletes only safe, unleased groups, least recently used first; a
// lane with no room gives the unit back and takes one that needs no lease, and every lane on the
// machine waits rather than claiming and giving back at every look. Run: node --test test/store/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import { has, hasnt, holdLock } from "../lib/index.ts";
import { storeFactory, ONE } from "./factory.ts";

const f = storeFactory(["a", "b"]);
const { add, drop, store, leases, touch, write } = f;
const [a, b] = f.lanes;
const hours = (h: number) => Date.now() - h * 3600e3;

// On b: f1 (safe on the store, not leased: b worked it, then a did), f3 (worked on since its last
// copy back), f4 (leased here), f5 (stamps match, but a file changed since). All about 100 KB.
add("f1/x1"); b.loop(ONE);
add("f1/x2"); a.loop(ONE);
for (const g of ["f3", "f4", "f5"]) {
  write(b.at(`work/out/${g}/pad.bin`), crypto.randomBytes(100000));
  b.setup(["lease", "take", g]);
  assert.equal(store(b, ["up", g, "seed", "x"]).code, 0, `store.sh up ${g}`);
}
assert.equal(store(b, ["dirty", "f3"]).code, 0);
fs.appendFileSync(b.at("work/out/f5/pad.bin"), "changed\n");
b.setup(["lease", "release", "f3", "f5"]);
touch(b.at("work/.store/groups/f1.used"), hours(3)); touch(b.at("work/.store/groups/f3.used"), hours(2)); touch(b.at("work/.store/groups/f5.used"), hours(1));
// f2 needs about 100 KB, on the store.
f.onStore("f2");
const here = (g: string) => fs.existsSync(b.at(`work/out/${g}/pad.bin`));

describe("the cache: eviction deletes only safe, unleased groups, least recently used first", () => {
  let r = store(b, ["take", "f2", "--new"], { FACTORY_CACHE: "150K" });
  test("when nothing safe can be deleted, there's no room", () => { assert.equal(r.code, 1); });
  test("  and nothing was deleted for nothing", () => { for (const g of ["f1", "f3", "f4", "f5"]) assert.ok(here(g), g); });
  test("  it says so", () => { has(r.stderr, "no room for f2"); });
  test("  nor copied down", () => { assert.ok(!fs.existsSync(b.at("work/out/f2"))); });
  test("making room deletes a safe old group", () => {
    r = store(b, ["take", "f2", "--new"], { FACTORY_CACHE: "420K" });
    assert.equal(r.code, 0, r.stderr);
  });
  test("  it was f1: an older copy, untouched since the store moved on, not leased", () => { assert.ok(!fs.existsSync(b.at("work/out/f1"))); });
  test("  the worked-on, leased and changed groups are kept", () => { for (const g of ["f3", "f4", "f5"]) assert.ok(here(g), g); });
  test("  and f2 is copied down", () => { assert.ok(here("f2")); });
  after(() => {
    fs.rmSync(b.at("work/out/f2"), { recursive: true, force: true });
    for (const x of fs.readdirSync(b.at("work/.store/groups"))) if (x.startsWith("f2.")) fs.rmSync(b.at(`work/.store/groups/${x}`), { recursive: true, force: true });
  });
});

describe("the loop with no room for a new lease gives the unit back and takes one that needs none", () => {
  let log = "";
  test("a lane with no room gives back the unit needing a new lease", () => {
    add("f2/n1"); add("code/n2");
    log = b.loop(ONE, { FACTORY_CACHE: "150K" });
    has(log, "no room in this machine's cache for f2");
  });
  test("  and works a unit that needs none", () => { has(log, "iteration 1: Unit n2 of code"); });
  test("  f2 isn't leased", () => { hasnt(leases(), "f2="); });
});

// A lease held here from an earlier claim, with no finished copy here: no room gives the lease back
// too, and every lane on the machine waits, instead of claiming and giving back at every look.
describe("no room under a lease held here from before", () => {
  const noroom = `${b.locks}/noroom-until`;
  test("no room under a lease held here from before: the unit is given back", () => {
    add("f2/n3");
    fs.rmSync(noroom, { force: true });
    b.setup(["lease", "take", "f2"]);
    has(b.loop(ONE, { FACTORY_CACHE: "150K" }), "no room in this machine's cache for f2");
  });
  test("  and the lease with it", () => { hasnt(leases(), "f2="); });
  test("  every lane on the machine waits", () => { assert.ok(fs.existsSync(noroom) && fs.statSync(noroom).size > 0); });
  test("  so the next lane there doesn't claim it again", async () => {
    const other = await holdLock(`${b.locks}/lane-b-lane2.lock`);   // another lane running there
    const log = b.loop(ONE, { FACTORY_CACHE: "150K" });
    await other.release();
    fs.rmSync(`${b.locks}/lane-b-lane2.lock`, { force: true });
    has(log, "units needing a new lease, which this machine's cache has no room for");
    hasnt(log, "no room in this machine's cache");
  });
  test("  the first lane to start on the machine again starts afresh", () => {
    has(b.loop(ONE, { FACTORY_CACHE: "150K" }), "no room in this machine's cache for f2");
  });
  after(() => { fs.rmSync(noroom, { force: true }); drop("f2/n3"); drop("f2/n1"); });
});

f.notBroken();
