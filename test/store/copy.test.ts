// A group's data moved by lease: copied down with the inputs it reads, copied back after each
// unit, the lease released when the group has no more units for the laptop or the lanes stop,
// and the other laptop carrying on with current data. Run: node --test test/store/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { has, hasnt, readOr } from "../lib/index.ts";
import { storeFactory, ONE } from "./factory.ts";

const f = storeFactory(["a", "b"]);
const { add, stamp, st } = f;
const [a, b] = f.lanes;

describe("copy down, copy back, release, and the other laptop carries on with current data", () => {
  let a1 = "", a2 = "", b1 = "";
  test("after a unit, the lease stays while the group has more units for the laptop", () => {
    add("f1/u1"); add("f1/u2");
    a1 = a.loop(ONE);
    hasnt(a1, "no more units for it");
  });
  test("  and goes when the lanes stop", () => { has(a1, "lease released (the lanes on a stopped)"); });
  test("  its data is on the store, stamped with the unit", () => { assert.equal(stamp("f1"), "f1/u1"); });
  test("  the data itself", () => { has(readOr(st("groups/f1/out/log.txt")), "f1/u1 on a"); });
  test("  and the mod folder", () => { has(readOr(st("groups/f1/mod/mod.txt")), "f1/u1"); });
  test("  the inputs it reads were copied down", () => { has(readOr(a.at("work/out/f1/log.txt")), "f1/u1 saw the input"); });
  test("  only the parts it reads", () => {
    assert.ok(fs.existsSync(a.at("work/rip/fighters/f1/f.txt")), "its fighter part");
    assert.ok(!fs.existsSync(a.at("work/rip/fighters/f2")), "another group's part");
  });
  test("with no units left for it, the lease is released", () => {
    a2 = a.loop(ONE);
    has(a2, "lease released (no more units for it on a)");
  });
  test("  after its data went back", () => { assert.equal(stamp("f1"), "f1/u2"); });
  test("the other laptop copies the data down", () => {
    add("f1/u3");
    b1 = b.loop(ONE);
    has(b1, "f1: copied down");
  });
  test("  and carries on with it current", () => { has(readOr(b.at("work/out/f1/log.txt")), "f1/u2 on a"); });
  test("  adding its own", () => { has(readOr(b.at("work/out/f1/log.txt")), "f1/u3 on b"); });
  test("  which goes back to the store", () => { has(readOr(st("groups/f1/out/log.txt")), "f1/u3 on b"); });
  test("  and the store's stamp is b's", () => { assert.equal(stamp("f1"), "f1/u3"); });
  test("back on the first laptop, its old copy isn't current and is replaced", () => {
    add("f1/u4");
    has(a.loop(ONE), "f1: copied down");
  });
  test("  so it has b's work", () => { has(readOr(a.at("work/out/f1/log.txt")), "f1/u3 on b"); });
  test("a laptop with a current copy doesn't copy it down again", () => {
    add("f1/u5"); add("f1/u6");
    has(a.loop(["--max", "2", "--hours", "0.05"]), "f1: the copy here is current");
  });
});

f.notBroken();
