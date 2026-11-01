// A CI run through the loop that ends other than passing: given back after a step that ran (exit 79)
// still copies that step's rebuild back, before giving the run back takes the lease with it; one
// whose last step was killed mid-way copies nothing back.
// Run: node --test test/store/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { has, hasnt, readOr } from "../lib/index.ts";
import { storeFactory } from "./factory.ts";

const f = storeFactory(["a"]);
const { add, st, leases } = f;
const [a] = f.lanes;
f.editMain("tracker/project.json", (j) => {
  j.ci = { steps: {
    build: { cmd: "echo built by CI > work/out/{group}/built.txt; echo built" },
    // Not run the first time (exit 79), run the next.
    later: { cmd: "[ -e work/out/{group}/again ] || { touch work/out/{group}/again; echo 'not now: the editor is busy'; exit 79; }; echo later" },
    crash: { cmd: "echo half > work/out/{group}/half.txt; kill -9 $$", retries: 0 },
  } };
  j.min_unit_minutes = 0;
});
a.setup(["edit-group", "f1", "--ci", "build,later"]);
a.setup(["edit-group", "f2", "--ci", "build,crash"]);
const run = (g: string) => { add(`${g}/c1`, "--reads", "none"); return a.loop(["--max", "2", "--hours", "0.05", "--idle-wait", "0.05"]); };

describe("a run given back after a step that ran copies that step's rebuild back", () => {
  const out = run("f1");
  test("the run was given back at its second step, after copying the first step's rebuild back", () => {
    const order = [...out.matchAll(/f1: copied back after f1's CI run|later didn't run, a condition it needs unmet/g)].map((m) => m[0]);
    assert.deepEqual(order.slice(0, 2), ["f1: copied back after f1's CI run", "later didn't run, a condition it needs unmet"]);
  });
  test("  the rebuild is on the store, stamped as the group's CI", () => {
    assert.equal(readOr(st("groups/f1/out/built.txt")), "built by CI\n");
    assert.equal(JSON.parse(readOr(st("stamps/f1.json")) || "{}").ci, "f1");
  });
  test("  copied back while the lease was still a's: no lost-lease", () => { hasnt(a.events(), "lost-lease"); });
  test("  nothing owed, and the lease gone", () => {
    assert.ok(!fs.existsSync(a.at("work/.store/groups/f1.unsent")));
    hasnt(leases(), "f1=");
  });
});

describe("a run whose last step was killed mid-way copies nothing back", () => {
  const out = run("f2");
  test("the run failed at the killed step", () => { has(out, "ci: Fighter f2 (f2) broken: crash failed (exit 137"); });
  // (The failure files f2/ci-fix, which the lane works next: that unit's copy back carries the
  // copy as it is, as any unit's does. The run itself copies nothing.)
  test("  the run copies nothing back", () => {
    hasnt(out, "f2: copied back after f2's CI run");
    hasnt(a.events(), "after f2's CI run");
  });
});

f.notBroken();
