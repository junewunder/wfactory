// Main itself failing the check: finished branches wait, with no merge unit; the overseer hears
// it once; the lane that found it takes no new units, and a restart checks main once more and
// stops again while it's still red; another lane's work in flight still lands if it has nothing
// to merge or fixes main; and the waiting branch lands once main is fixed. Run: node --test test/branches/
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { has, hasnt, lines, readOr } from "../lib/index.ts";
import { branchFactory, ONE } from "./factory.ts";

const f = branchFactory(["b", "c"]);
const [b, c] = f.lanes;
const { add, w } = f;
const checks = () => lines(readOr(path.join(b.locks, "checks")));
const brokenEvents = () => b.events().split("\n").filter((l) => l.split("\t")[3] === "main-broken").length;

describe("main itself failing the check: finished branches wait, no merge unit", () => {
  // Someone breaks main behind the lanes' backs.
  const sneak = w.at("sneak");
  w.git(w.top, "clone", "-q", f.origin, sneak);
  let log = "";
  test("main failing just check: the branch waits", () => {
    fs.writeFileSync(path.join(sneak, "fail-check"), "");
    w.git(sneak, "add", "fail-check"); w.git(sneak, "commit", "-qm", "break main"); w.git(sneak, "push", "-q", "origin", "main");
    add("waits");
    log = b.loop(ONE);
    has(log, "main itself fails");
  });
  test("  no merge unit is filed", () => { hasnt(log, "filed Merge main"); });
  test("  the overseer hears of it", () => { has(b.events(), "main-broken"); });
  // Main is red: the lane stops taking units (the overseer stops the rest, fixes main, and starts
  // them again), so a lane started again before it's fixed stops at once.
  let again = "";
  test("  the lane takes no new units while main is red", () => {
    add("waits2");
    fs.writeFileSync(path.join(b.locks, "checks"), "");
    again = b.loop(ONE);
    has(again, "main is red: main itself fails");
    assert.equal(b.ok(["state", "g/waits2"]), "ready");
  });
  test("  once per broken main, not at every look", () => { assert.equal(brokenEvents(), 1, b.events()); });
  // A start checks the waiting branch and main once more (main may have been fixed outside its
  // code), and nothing else: the new unit isn't taken.
  test("  a start checks main once more, and takes nothing", () => { assert.equal(checks(), 2); hasnt(again, "iteration 1:"); });
  // Another lane's work in flight: a unit that committed nothing (its work is all in work/) is
  // on main already, so it lands anyway.
  test("  a unit that committed nothing lands though main is broken", () => {
    f.drop("g/waits2");
    add("empty");
    has(c.loop(ONE, { FACTORY_FAKE_NOWORK: "1" }), "unit/g/empty had nothing to merge");
  });
  test("  and is done, not left merging", () => { assert.equal(c.ok(["state", "g/empty"]), "done"); });
  // A branch that fixes main lands, though main is broken.
  test("  a branch that fixes main still lands", () => {
    add("fixes");
    has(c.loop(ONE, { FACTORY_FAKE_FIX: "1" }), "unit/g/fixes merged into main");
  });
  test("  once main is fixed, the waiting branch lands at the next look", () => {
    add("later");
    has(b.loop(ONE), "unit/g/waits merged into main");
  });
  test("  and is done", () => { assert.equal(b.ok(["state", "g/waits"]), "done"); });
});
