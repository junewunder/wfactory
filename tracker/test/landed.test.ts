// A unit's landing, as the tracker records it (`merged` writes when; `state --landed` prints it):
// only a branch that landed counts, not a unit done by hand, one still merging, or one reopened
// since. And the units an older store.sh filed to sort a set-aside copy: dropped for this machine
// (`aside-retire`), and not offered to a loop meanwhile. Run: node --test tracker/test/
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { trackerRepo, has, hasnt } from "../../test/lib/index.ts";

const f = trackerRepo("repo", { FACTORY_TAG: "worker1", FACTORY_EVIDENCE_MIN: "0" });
const { t, ok, setup } = f;
setup(["init", "--title", "Test port"]);
setup(["add-group", "ln", "--title", "Landings"]);
const B = { FACTORY_BRANCHES: "1", FACTORY_TAG: "lane1" };
const unit = (id: string) => setup(["add-unit", id, "--title", `Unit ${id.split("/")[1]}`]);
const landed = (id: string) => ok(["state", id, "--landed"]).trim();
const state = (id: string) => ok(["state", id]).trim();
// A unit worked on its branch and recorded done: merging until the loop lands the branch.
const worked = (id: string) => { unit(id); setup(["claim", id], B); setup(["done", id, "--evidence", "worked"], B); };

describe("the tracker's record of a landing", () => {
  test("a unit done on its branch, not landed yet: no landing", () => {
    worked("ln/a");
    assert.equal(`${state("ln/a")} [${landed("ln/a")}]`, "merging []");
  });
  test("  its branch landed (merged): done, and the landing's time is recorded", () => {
    setup(["merged", "--branch", "unit/ln/a"]);
    assert.equal(state("ln/a"), "done");
    assert.match(landed("ln/a"), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/);
  });
  test("a unit done by hand, with no branch: done, but no landing", () => {
    unit("ln/h"); setup(["done", "ln/h", "--evidence", "by hand"]);
    assert.equal(`${state("ln/h")} [${landed("ln/h")}]`, "done []");
  });
  test("  and `merged` on it records none (nothing landed)", () => {
    setup(["merged", "ln/h"]);
    assert.equal(landed("ln/h"), "");
  });
  test("a landed unit reopened: no landing any more", () => {
    worked("ln/r"); setup(["merged", "--branch", "unit/ln/r"]);
    setup(["reopen", "ln/r"]);
    assert.equal(`${state("ln/r")} [${landed("ln/r")}]`, "ready []");
  });
  test("  done again by hand: done, and still no landing", () => {
    setup(["done", "ln/r", "--evidence", "by hand"]);
    assert.equal(`${state("ln/r")} [${landed("ln/r")}]`, "done []");
  });
  test("  worked and landed again: a landing", () => {
    setup(["reopen", "ln/r"]); setup(["claim", "ln/r"], B); setup(["done", "ln/r", "--evidence", "again"], B);
    setup(["merged", "--branch", "unit/ln/r"]);
    assert.notEqual(landed("ln/r"), "");
  });
  test("a landed unit dropped since: not a landing (it's dropped)", () => {
    worked("ln/d"); setup(["merged", "--branch", "unit/ln/d"]);
    setup(["drop", "ln/d", "--why", "test"]);
    assert.equal(`${state("ln/d")} [${landed("ln/d")}]`, "dropped []");
  });
  test("a unit in review whose branch landed isn't done: no landing to go by yet", () => {
    unit("ln/v"); setup(["claim", "ln/v"], B); setup(["review", "ln/v", "--evidence", "look"], B);
    setup(["merged", "--branch", "unit/ln/v"]);
    assert.equal(`${state("ln/v")} [${landed("ln/v")}]`, "review []");
  });
});

// The units an older store.sh filed to sort a set-aside copy, in the group `aside`, each pinned to
// its machine. The store settles those copies by rule now, so no session works one.
describe("units an older version filed to sort a set-aside copy", () => {
  const sort = (id: string, host: string) => setup(["add-unit", id, "--title", `Sort a set-aside copy on ${host}`, "--host", host, "--check", "recorded", "--data", "none"]);
  test("one isn't offered to a loop", () => {
    f.edit("tracker/project.json", (p) => { p.loops = { main: { title: "The main loop", groups: ["ln"] } }; });
    setup(["add-group", "aside", "--title", "Set-aside copies to sort"]);
    sort("aside/ln-testhost-20260101-000000", "testhost");
    hasnt(t(["next"], { LOOP: "main" }, { merged: true }).stdout, "aside/ln-testhost-20260101-000000");
  });
  test("aside-retire drops this machine's", () => {
    sort("aside/ln-otherbox-20260101-000000", "otherbox");
    sort("aside/ln-testhost-20260102-000000", "testhost"); setup(["claim", "aside/ln-testhost-20260102-000000"]);
    sort("aside/ln-testhost-20260103-000000", "testhost"); setup(["done", "aside/ln-testhost-20260103-000000", "--evidence", "sorted"]);
    ok(["aside-retire"]);
    assert.equal(state("aside/ln-testhost-20260101-000000"), "dropped");
  });
  test("  saying why on its card", () => { has(ok(["show", "aside/ln-testhost-20260101-000000"]), "dropped: No session sorts a set-aside copy any more"); });
  test("  not another machine's", () => { assert.equal(state("aside/ln-otherbox-20260101-000000"), "ready"); });
  test("  not one a session is working now (it's named, for the next look)", () => {
    assert.equal(state("aside/ln-testhost-20260102-000000"), "doing");
    has(ok(["aside-retire"]), "aside/ln-testhost-20260102-000000");
  });
  test("  and one already done stays done", () => { assert.equal(state("aside/ln-testhost-20260103-000000"), "done"); });
  test("  one named (filed in its data group by an older version still) is dropped too", () => {
    setup(["add-unit", "ln/aside-testhost-20260104-000000", "--title", "Sort a set-aside copy", "--host", "testhost"]);
    ok(["aside-retire", "ln/aside-testhost-20260104-000000", "ln/nope"]);
    assert.equal(state("ln/aside-testhost-20260104-000000"), "dropped");
  });
  test("  with nothing left to drop, it writes nothing", () => {
    const before = ok(["log", "-n", "1"]);
    ok(["aside-retire"]);
    assert.equal(ok(["log", "-n", "1"]), before);
  });
});
