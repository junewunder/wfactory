// A branch the loop can't merge by itself becomes a merge unit for the lane that hit it: a real
// code conflict between two lanes' work, and a branch that fails `just check`; a merge that
// fails three times is stuck, for the overseer, and the lane goes on.
// Run: node --test test/branches/
import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { has, hasnt, until, readOr, lines } from "../lib/index.ts";
import { branchFactory, ONE as L } from "./factory.ts";

const f = branchFactory(["a", "b", "c"]);
const [a, b, c] = f.lanes;
const { add, drop } = f;
const mergeJson = (l: typeof a) => JSON.parse(fs.readFileSync(path.join(l.ok(["dir"]), "groups/merge.json"), "utf8"));

describe("a real code conflict: the lane that hits it files a merge unit for itself, then settles it", () => {
  let blog = "", mu = "";
  test("the first lane's change to shared.txt landed", async () => {
    add("left"); add("right");
    // b's session starts from main and is held there, its work committed, while a lands its own.
    for (const u of ["g-left", "g-right"]) fs.writeFileSync(path.join(b.locks, `hold.${u}`), "");
    const bl = b.loopBg(L, { FACTORY_FAKE_SHARED: "1" });
    await until(() => ["g-left", "g-right"].some((u) => fs.existsSync(path.join(b.locks, `held.${u}`))), "lane b's session is working");
    a.loop(L, { FACTORY_FAKE_SHARED: "1" });
    for (const u of ["g-left", "g-right"]) fs.writeFileSync(path.join(b.locks, `go.${u}`), "");
    blog = (await bl.end(120)).stdout;
    const first = f.main("shared.txt");
    assert.ok(first && first !== "base", `got ${first}`);
  });
  test("the second lane's merge conflicts and becomes a merge unit", () => { has(blog, "filed Merge main on b lane 1"); });
  test("  for that lane only", () => {
    mu = readOr(b.at("runs/.merge-unit")).trim();
    assert.equal(mergeJson(b).units.find((u: any) => u.id === mu)?.lane, "b/1");
  });
  test("  the unit it couldn't merge shows as merging, not done", () => {
    const stuck = mergeJson(b).units.find((u: any) => u.id === mu)?.branch ?? "";
    has(b.tracker(["state", stuck.replace(/^unit\//, "")]).stdout, "merging");
  });
  test("  its branch waits on origin", () => { assert.notEqual(a.git("ls-remote", "origin", "refs/heads/unit/*"), ""); });
  test("  another lane isn't offered the merge unit", () => {
    add("after");
    hasnt(c.tracker(["next", "--json"], { FACTORY_LANE: "someone/9" }).stdout, `"id":"${mu}"`);
  });
  let b2 = "";
  test("  the lane takes the merge unit next, before other ready work", () => {
    b2 = b.loop(L);
    has(b2, "iteration 1: Merge main on b lane 1");
  });
  test("  and lands the branch", () => { has(b2, "merged into main"); });
  test("  nothing shows as merging afterwards", () => { hasnt(b.ok(["status"]).toLowerCase(), "merging"); });
  test("  both units' work is on main", () => {
    assert.equal(lines(f.main("out/g-left.txt")), 1);
    assert.equal(lines(f.main("out/g-right.txt")), 1);
  });
  test("  and the lane is free again", () => { assert.ok(!fs.existsSync(b.at("runs/.merge-unit"))); });
  after(() => { drop("g/after"); });
});

describe("the loop checks before merging: a branch that breaks the check becomes a merge unit", () => {
  let log = "", mu = "";
  test("a branch that fails just check doesn't reach main", () => {
    add("breaks");
    log = a.loop(L, { FACTORY_FAKE_BREAK: "1" });
    assert.equal(f.main("fail-check"), "");
    assert.ok(!f.main("out/g-breaks.txt"), "the branch's work reached main");
  });
  test("  it becomes this lane's merge unit", () => {
    has(log, "filed Merge main on a lane 1");
    mu = readOr(a.at("runs/.merge-unit")).trim();
    assert.ok(mu);
  });
  test("  a stuck merge's branch isn't tried again at each look", () => {
    // Stuck (as after its third failure): the branch waits for the overseer, not another try every look.
    a.setup(["block", mu, "--why", "test"]); fs.rmSync(a.at("runs/.merge-unit"));
    add("bk-next");
    const out = a.loop(L);
    has(out, "iteration 1: Unit bk-next (g/bk-next)");
    hasnt(out, "landing unit/g/breaks");
  });
  after(() => {
    drop(mu); drop("g/breaks");
    a.run("git", ["push", "-q", "origin", "--delete", "unit/g/breaks"]); a.run("git", ["branch", "-q", "-D", "unit/g/breaks"]);
  });
});

describe("a merge unit that fails three times is stuck, for the overseer, and the lane goes on", () => {
  let mu = "";
  test("a branch that fails its merge three times: a stuck-merge event", () => {
    add("breaks3");
    a.loop(["--max", "3", "--hours", "0.05"], { FACTORY_FAKE_BREAK: "1" });
    has(a.events(), "stuck-merge\tMerge main on a lane 1: merging branch unit/g/breaks3 into main failed three times");
  });
  test("  its merge unit is stuck", () => {
    mu = mergeJson(a).units.find((u: any) => u.branch === "unit/g/breaks3")?.id ?? "";
    has(a.tracker(["state", mu]).stdout, "stuck");
  });
  test("  and the lane is free for other work", () => { assert.ok(!fs.existsSync(a.at("runs/.merge-unit"))); });
});
