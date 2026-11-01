// The tracker writes to origin's main, whatever branch a lane is on: a write on a branch reaches
// other clones and leaves the branch alone, and a write made while origin was away goes up with
// the next one, even one that changes nothing. Run: node --test test/branches/
import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { has, hasnt } from "../lib/index.ts";
import { branchFactory } from "./factory.ts";

const f = branchFactory(["a", "b"]);
const [a, b] = f.lanes;
const { add, drop } = f;

describe("a tracker write while on a branch lands on main for everyone, and not on the branch", () => {
  test("a note written on a branch shows up in another clone at its next fetch", () => {
    add("note");
    a.git("checkout", "-q", "-b", "unit/g/note");
    a.ok(["note", "g/note", "seen from the other laptop"]);
    has(b.ok(["show", "g/note"]), "seen from the other laptop");
  });
  test("  and the branch carries no tracker commit", () => { assert.equal(a.git("log", "--format=%s", "main..unit/g/note"), ""); });
  test("  nor any change in its tree", () => { assert.equal(a.git("status", "--porcelain"), ""); });
  after(() => {
    a.git("checkout", "-q", "main"); a.git("branch", "-q", "-D", "unit/g/note");
    drop("g/note");
  });
});

describe("a tracker write that changes nothing still pushes earlier writes origin didn't get", () => {
  test("a write made offline isn't on origin yet", () => {
    add("offline");
    fs.renameSync(f.origin, `${f.origin}.off`);
    try { a.tracker(["note", "g/offline", "written while origin was away"]); } finally { fs.renameSync(`${f.origin}.off`, f.origin); }
    hasnt(f.main("tracker/groups/g.json"), "written while origin was away");
  });
  test("  a later write that changes nothing pushes it", () => {
    a.tracker(["merged", "--branch", "unit/nothing"]);
    has(f.main("tracker/groups/g.json"), "written while origin was away");
  });
});
