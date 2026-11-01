// A busy tracker lock (another command held it past the tracker's wait: exit 75) while a lane files
// a merge unit, or looks at a finished branch whose merge unit is open: waited out, never taken
// for an answer (#109). Run: node --test test/branches/
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { has, hasnt, readOr } from "../lib/index.ts";
import { busyTracker } from "../loop/factory.ts";
import { branchFactory, ONE } from "./factory.ts";

const f = branchFactory(["a"]);
const [a] = f.lanes;
const { add } = f;
let first = "";   // the first describe's merge unit

describe("a busy lock as a lane looks at a finished branch whose merge unit is open", () => {
  let out = "";
  test("the lane starts with the branch left and its merge unit open, the lock busy as it reads it", () => {
    add("mc");
    has(a.loop(ONE, { FACTORY_FAKE_BREAK: "1" }), "filed Merge main on a lane 1");
    // Without the marker, the open merge unit alone holds the branch back.
    first = readOr(a.at("runs/.merge-unit")).trim();
    fs.rmSync(a.at("runs/.merge-unit"));
    out = a.loop(["--max", "0", "--hours", "0.05"], { FACTORY_TRACKER: busyTracker(f.w.at("tracker-busy-state.mjs"), ["state", "merge/"], 2) });
    assert.ok(fs.existsSync(f.w.at("tracker-busy-state.mjs.busy")), "the wrapper answered busy");
  });
  // (The tracker's landing claim refuses it too, but the lane shouldn't get that far.)
  test("  the branch waits for its merge unit: the lane doesn't try to land it", () => { hasnt(out, "not landing unit/g/mc"); hasnt(out, "left from before"); });
});

describe("a busy lock as a lane files a merge unit", () => {
  let out = "", mu = "";
  test("a branch that fails the check, its merge unit filed while the lock is busy", () => {
    // (The merge above is done with: its unit and branch gone.)
    for (const u of [first, "g/mc"].filter(Boolean)) a.setup(["drop", u, "--why", "test"]);
    fs.rmSync(a.at("runs/.merge-unit"), { force: true });
    a.git("branch", "-q", "-D", "unit/g/mc");
    add("mb");
    out = a.loop(ONE, { FACTORY_FAKE_BREAK: "1", FACTORY_TRACKER: busyTracker(f.w.at("tracker-busy-add.mjs"), ["add-unit", "merge/"], 2) });
    mu = readOr(a.at("runs/.merge-unit")).trim();
    assert.ok(fs.existsSync(f.w.at("tracker-busy-add.mjs.busy")), "the wrapper answered busy");
  });
  test("  the merge unit is filed", () => { has(out, "filed Merge main on a lane 1"); assert.ok(mu); });
  test("  not given up on", () => { hasnt(out, "couldn't file the merge unit"); });
});
