// A loop by hand in the owner's checkout won't start over their work, since the loop resets it
// to origin's main between units: not with untracked files, nor with unpushed commits; a clean
// one it starts in. Run: node --test test/branches/
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { cmd, has, hasnt } from "../lib/index.ts";
import { branchFactory } from "./factory.ts";

const f = branchFactory(["a"]);
const { F, w } = f;
const loop = () => cmd("factory/loop.sh", ["--no-awake", "--no-wait", "--max", "1", "--hours", "0.01"], { cwd: F, env: w.envWith({ FACTORY_LOCKS: w.at("locks-f"), FACTORY_HOST: "f" }), merged: true }).stdout;

describe("a loop by hand in the owner's checkout won't start over their work", () => {
  test("a loop in the owner's checkout refuses untracked files", () => {
    w.git(F, "pull", "-q", "--no-edit", "origin", "main");
    fs.writeFileSync(path.join(F, "notes-of-mine.txt"), "mine\n");
    has(loop(), "not starting in this checkout: it has changes");
  });
  test("  and leaves them be", () => { assert.ok(fs.existsSync(path.join(F, "notes-of-mine.txt"))); });
  test("  and unpushed commits", () => {
    fs.rmSync(path.join(F, "notes-of-mine.txt"));
    w.git(F, "commit", "-q", "--allow-empty", "-m", "the owner's own commit");
    has(loop(), "main has commits origin doesn't");
  });
  test("  but starts in a clean one", () => {
    w.git(F, "reset", "-q", "--hard", "origin/main");
    const out = loop();
    hasnt(out, "not starting in this checkout");
    has(out, "nothing workable: every unit is done or dropped");
  });
});
