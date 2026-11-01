// What a take, a copy back and `safe` trust: an empty copy is never copied back or stamped; a second
// take under a lease held here counts the copy here only once a take under it finished; a store
// stamp that isn't a finished, newer copy back doesn't make the copy here safe to delete; and this
// machine's own torn copy back is sent again, never copied down over. Run: node --test test/store/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import { has, hasnt, readOr } from "../lib/index.ts";
import { storeFactory } from "./factory.ts";

const f = storeFactory(["a", "b"]);
const { add, store, stamp, leases, st, asides, write, group } = f;
const [a, b] = f.lanes;
const ok = (l: typeof a, args: string[], env: NodeJS.ProcessEnv = {}) => { const r = store(l, args, env); assert.equal(r.code, 0, `store.sh ${args.join(" ")}: ${r.stderr}`); return r; };
const done = (id: string) => a.setup(["done", id, "--evidence", "test"]);

// A group whose data isn't on the store yet (or is kept elsewhere there, to be seeded) doesn't look
// seeded, and data put there isn't deleted.
describe("an empty copy is never copied back or stamped", () => {
  test("an empty copy over a store with no folder for the group isn't stamped", () => {
    group("f7");
    a.setup(["lease", "take", "f7"]);
    add("f7/e1"); done("f7/e1");
    ok(a, ["end", "f7", "f7/e1", "c"]);
    assert.ok(!fs.existsSync(st("stamps/f7.json")));
  });
  test("  nor copied back", () => { assert.ok(!fs.existsSync(st("groups/f7"))); });
  test("  an empty copy isn't copied back over data put on the store", () => {
    write(st("groups/f7/out/s.txt"), "seeded by hand\n");
    add("f7/e2"); done("f7/e2");
    ok(a, ["end", "f7", "f7/e2", "c"]);
    assert.equal(readOr(st("groups/f7/out/s.txt")), "seeded by hand\n");
  });
  test("    and says so", () => { has(a.events(), "store-empty\tf7's copy on a has no files, but the store's has"); });
  test("    nor stamped", () => { assert.ok(!fs.existsSync(st("stamps/f7.json"))); });
  after(() => { a.setup(["lease", "release", "f7"]); });
});

// Another lane's copy down may still be running, or may have failed. Lease f4 on b without copying,
// with an old copy here: a take without --new copies down instead of trusting it.
describe("a second take under a lease held here: the copy here counts only once a take under it finished", () => {
  add("f4/p1"); f.drop("f4/p1");   // the unit the takes are for, dropped since
  write(b.at("work/out/f4/pad.bin"), crypto.randomBytes(100000));
  b.setup(["lease", "take", "f4"]);
  ok(b, ["up", "f4", "seed", "x"]);
  test("a lease held here with no finished take under it: the next take copies down", () => {
    write(st("groups/f4/out/n.txt"), "newer on the store\n");
    write(st("stamps/f4.json"), '{"unit":"f4/z","commit":"x","host":"c","at":"2030-01-01T00:00:00Z","bytes":10}\n');
    b.setup(["lease", "take", "f4"]);
    fs.rmSync(b.at("work/.store/groups/f4.ready"), { force: true });
    has(store(b, ["take", "f4", "--unit", "f4/p1"]).stderr, "no copy down under this lease finished; copying down");
  });
  test("  and the copy here is the store's", () => { has(readOr(b.at("work/out/f4/n.txt")), "newer on the store"); });
  test("  after which a take trusts it", () => { has(store(b, ["take", "f4", "--unit", "f4/p1"]).stderr, "leased here already; the copy here is the newest"); });
  // Worked on here under a lease from before these marks (or a copy back cut short): trusted, never
  // overwritten by the store's copy.
  test("  a copy worked on here counts as the newest without a finished take", () => {
    fs.rmSync(b.at("work/.store/groups/f4.ready"), { force: true });
    ok(b, ["dirty", "f4", "f4/p1", String(process.pid)]); write(b.at("work/out/f4/b.txt"), "b's newer work\n");
    has(store(b, ["take", "f4", "--unit", "f4/p1"]).stderr, "worked on here; the copy here is the newest");
  });
  test("    and keeps its work", () => { assert.ok(fs.existsSync(b.at("work/out/f4/b.txt"))); });
  test("  (released)", () => {
    store(b, ["leave"]);
    hasnt(leases(), "f4=");
  });
});

describe("a store stamp that isn't a finished, newer copy back doesn't make the copy here safe to delete", () => {
  let saved = "";
  test("a copy here isn't safe while the store's copy is torn (a copy back cut short)", () => {
    saved = readOr(st("stamps/f4.json"));
    write(st("stamps/f4.json"), '{"copying":"f4/q","host":"c"}\n');
    assert.equal(store(b, ["safe", "f4"]).code, 1);
  });
  test("  nor when the store holds an older copy than the copy here (put back by hand, rolled back)", () => {
    write(st("stamps/f4.json"), '{"unit":"f4/old","commit":"x","host":"c","at":"2001-01-01T00:00:00Z","bytes":10}\n');
    assert.equal(store(b, ["safe", "f4"]).code, 1);
  });
  after(() => { write(st("stamps/f4.json"), saved); });
});

// This machine's own copy back cut short (a suspend), its lease gone stale and taken again here:
// the copy here is sent again, never the store's half copied down over it.
describe("this machine's own torn copy back", () => {
  let r = { code: 0, stdout: "", stderr: "" };
  test("a take over this machine's own torn copy back succeeds (even with no room: nothing comes down)", () => {
    group("f6");
    a.setup(["lease", "take", "f6"]);
    write(a.at("work/out/f6/one.txt"), "one\n");
    ok(a, ["up", "f6", "f6/seed", "x"]);
    write(a.at("work/out/f6/two.txt"), "newer work\n"); ok(a, ["dirty", "f6", "f6/cut", String(process.pid)]);
    write(a.at("work/.store/groups/f6.unsent"), ""); write(st("stamps/f6.json"), '{"copying":"f6/cut","host":"a"}\n');
    a.setup(["lease", "release", "f6"]); a.setup(["lease", "take", "f6"]);
    r = store(a, ["take", "f6", "--new"], { FACTORY_CACHE: "1K" });
    assert.equal(r.code, 0, r.stderr);
  });
  test("  it copies back again instead of down", () => { has(r.stderr, "copying back again instead of down"); });
  test("  the store gets the whole copy", () => { has(readOr(st("groups/f6/out/two.txt")), "newer work"); });
  test("  stamped for the cut-short unit", () => { assert.equal(stamp("f6"), "f6/cut"); });
  test("  the copy here is kept", () => { assert.ok(fs.existsSync(a.at("work/out/f6/two.txt"))); });
  test("  nothing set aside", () => { assert.deepEqual(asides(a, "f6"), []); });
  test("a copy here that's current needs no room", () => {
    r = store(a, ["take", "f6", "--new"], { FACTORY_CACHE: "1" });
    assert.equal(r.code, 0, r.stderr);
  });
  test("  and says it's current", () => { has(r.stderr, "the copy here is current"); });
  test("a Cache with a lowercase suffix is a size, as numfmt reads it", () => { assert.equal(store(a, ["take", "f6", "--new"], { FACTORY_CACHE: "100000k" }).code, 0); });
  after(() => { store(a, ["leave"]); });
});

f.notBroken();
