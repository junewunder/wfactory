// A lane's own merge unit goes through the same checks as any other unit it claims: one whose
// usual session won't fit before the stop isn't started, and one a session of this lane gave back
// unstarted isn't taken again this run. (A lane's merge, filed 17 minutes before the stop and
// needing the project's whole check, was claimed seven times in 18 minutes, two of its sessions
// giving it back: the merge claim passed neither --time-left nor --skip-units.) The lane takes what
// fits meanwhile, doesn't wait for the merge, and the next run takes the merge first.
// The loop runs in this process (inproc.ts). Run: node --test test/loop/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { has, hasnt } from "../lib/index.ts";
import { loopFactory } from "./factory.ts";

const f = loopFactory("mergetime");
const { a, setup, state, claude, loop } = f;
// A session that gives its unit back unstarted.
const GIVE_BACK = `#!/usr/bin/env bash
card=""; while [ $# -gt 0 ]; do case $1 in --append-system-prompt-file) card=$(cat "$2") ;; --append-system-prompt) card=$2 ;; esac; shift; done
id=$(grep -oE '^Next: .*\\(([a-z0-9-]+/[a-z0-9.-]+)\\)' <<<"$card" | head -1 | sed -E 's/.*\\(([^)]*)\\)$/\\1/')
echo '{"type":"system","subtype":"init"}'
factory/tracker unclaim "$id" >/dev/null
echo '{"type":"result","is_error":false,"result":"gave '"$id"' back unstarted","num_turns":1,"total_cost_usd":0.01}'
`;
const iterations = (out: string, title: string) => out.split("\n").filter((l) => new RegExp(`iteration [0-9]*: ${title}`).test(l)).length;
const MU = "merge/a-lane1-g-fin";

describe("a lane's merge unit filed close to the stop isn't started", () => {
  let out = "";
  test("setup: a finished unit's branch on origin, this lane's merge unit for it (as landing files one), and a short unit", () => {
    a.run("git", ["checkout", "-q", "-b", "unit/g/fin", "origin/main"]);
    fs.writeFileSync(a.at("fin.txt"), "finished\n");
    a.run("git", ["add", "fin.txt"]); a.run("git", ["commit", "-qm", "finished work"]);
    const p = a.run("git", ["push", "-q", "origin", "unit/g/fin"]);
    a.run("git", ["checkout", "-q", "main"]);
    assert.equal(p.code, 0, p.stdout + p.stderr);
    // (The finished unit, recorded done on its branch.)
    setup("add-unit", "g/fin", "--title", "Finished unit", "--check", "recorded");
    a.setup(["claim", "g/fin"], { FACTORY_TAG: "f1" });
    a.setup(["done", "g/fin", "--evidence", "fin.txt"], { FACTORY_TAG: "f1" });
    setup("add-group", "merge", "--title", "Merges the loop couldn't do by itself", "--priority", "1000");
    setup("add-unit", MU, "--title", "Merge main on a lane 1", "--branch", "unit/g/fin", "--lane", "a/1", "--check", "recorded",
      "--detail", "Merge origin/main into unit/g/fin, run the check, record this unit done.");
    fs.mkdirSync(a.at("runs"), { recursive: true });
    fs.writeFileSync(a.at("runs/.merge-unit"), `${MU}\n`);
    setup("add-unit", "g/short", "--title", "Short unit");
  });
  test("with 15 minutes left, the merge (45 min with nothing to go by) isn't started; the short unit is", async () => {
    out = (await loop(["--max", "3", "--hours", "0.25"]).end()).out;
    assert.equal(iterations(out, "Merge main on a lane 1"), 0, out);
    assert.equal(iterations(out, "Short unit"), 1, out);
  });
  test("  the log says why", () => {
    has(out, `this lane's merge (${MU}) can't move yet: nothing workable: 1 unit whose usual session (45 min) won't fit in the`);
  });
  test("  with nothing else to take, the lane stops rather than waiting for it", () => {
    has(out, `nothing fits before the stop at`);
    hasnt(out, "loop: waiting:");
  });
  test("  the merge is still this lane's, untouched", () => {
    assert.equal(fs.readFileSync(a.at("runs/.merge-unit"), "utf8").trim(), MU);
    assert.equal(state(MU), "ready");
  });
});

describe("a lane's merge unit given back unstarted isn't taken again this run", () => {
  let out = "";
  test("the session gives it back: one claim, then the lane stops", async () => {
    claude(GIVE_BACK);
    out = (await loop(["--max", "4", "--hours", "3"]).end()).out;
    claude();
    assert.equal(iterations(out, "Merge main on a lane 1"), 1, out);
  });
  test("  the log says why", () => {
    has(out, `Merge main on a lane 1 (${MU}) was given back unstarted: this lane doesn't take it again this run`);
    has(out, `this lane's merge (${MU}) can't move yet: nothing workable: 1 unit this lane's sessions gave back unstarted this run`);
    hasnt(out, "loop: waiting:");
  });
  test("  the next run takes the merge first", async () => {
    setup("add-unit", "g/later", "--title", "Later unit");
    const o = (await loop(["--max", "1", "--hours", "3"]).end()).out;
    has(o, "iteration 1: Merge main on a lane 1");
    assert.equal(iterations(o, "Later unit"), 0, o);
  });
});
