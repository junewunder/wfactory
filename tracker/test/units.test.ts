// The tracker CLI end to end: units, needs, next and claim; interrupted claims; independent
// checks and reviews; priority, an old focus list, parking, block, notes and rename. Run: node --test tracker/test/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { trackerRepo, has, hasnt } from "../../test/lib/index.ts";

// Units here are done with a word of evidence; the floor has tests of its own (FACTORY_EVIDENCE_MIN=30).
const f = trackerRepo("repo", { FACTORY_TAG: "worker1", FACTORY_EVIDENCE_MIN: "0" });
const { t, ok, setup } = f;

describe("init", () => {
  test("init writes gitignore", () => {
    ok(["init", "--title", "Test port"]);
    has(f.read(".gitignore"), "/.tracker/");
  });
  test("init writes gitattributes", () => { has(f.read(".gitattributes"), "merge=union"); });
});

describe("units, needs, next, claim", () => {
  test("next offers the first unit", () => {
    setup(["add-group", "pipe", "--title", "Pipeline"]);
    setup(["add-unit", "pipe/extract", "--title", "Extract the data", "--check", "recorded"]);
    setup(["add-unit", "pipe/convert", "--title", "Convert the data", "--needs", "pipe/extract"]);
    has(ok(["next"]), "Next: Extract the data (pipe/extract)");
  });
  test("status counts", () => { has(ok(["status"]), "0 of 2 done"); });
  test("waiting sentence names title", () => { has(ok(["show", "pipe/convert"]), "can't start until Extract the data (pipe/extract) is done"); });
  test("claim shows in progress", () => {
    ok(["next", "--claim"]);
    has(ok(["show", "pipe/extract"]), "in progress (session worker1 on testhost)");
  });
  test("done without evidence refused", () => { assert.equal(t(["done", "pipe/extract"]).code, 2); });
  test("needs met moves on", () => {
    ok(["done", "pipe/extract", "--evidence", "data.json written"]);
    has(ok(["next"]), "Convert the data (pipe/convert)");
  });
});

describe("interrupted claim", () => {
  test("dead claim is interrupted", () => {
    setup(["claim", "pipe/convert"]);
    f.tryIn(["claim", "pipe/convert"], { FACTORY_PID: "999999" });
    f.edit("tracker/groups/pipe.json", (g) => { g.units[1].record.pid = 999999; g.units[1].record.start = "1"; });
    f.write("leftover.txt", "dirt\n");
    has(ok(["next"]), "interrupted: session worker1");
  });
  test("picking up an interrupted unit", () => { has(ok(["next", "--claim"], { FACTORY_TAG: "worker2" }), "Convert the data"); });
  // The bash check looked for "" in the card, which any output has. What was left uncommitted
  // is kept on worker2's claim, and its card says so once that claim is interrupted too (its
  // session dead as worker1's was; the claim put back after).
  test("dirty paths recorded", () => {
    const was = f.read("tracker/groups/pipe.json");
    f.edit("tracker/groups/pipe.json", (g) => { g.units[1].record.pid = 999999; g.units[1].record.start = "1"; });
    const card = ok(["show", "pipe/convert"]);
    f.write("tracker/groups/pipe.json", was);
    has(card, "interrupted: session worker2");
    assert.match(card, /^  Left uncommitted: .*\bleftover\.txt\b/m);
  });
  test("uncommitted paths kept on the claim", () => {
    has(f.read("tracker/groups/pipe.json"), "leftover.txt");
  });
  after(() => {
    fs.rmSync(f.at("leftover.txt"));
  });
});

describe("independent check", () => {
  test("worker can't self-check", () => {
    setup(["edit", "pipe/convert", "--check", "independent"]);
    assert.equal(t(["done", "pipe/convert", "--evidence", "x"], { FACTORY_TAG: "worker2" }).code, 2);
  });
  test("worker isn't offered own review", () => {
    ok(["review", "pipe/convert", "--evidence", "see out/"], { FACTORY_TAG: "worker2" });
    hasnt(t(["next"], { FACTORY_TAG: "worker2" }, { merged: true }).stdout, "Next: Convert");
  });
  test("another session gets the review", () => { has(ok(["next"], { FACTORY_TAG: "worker3" }), "Next: Convert the data"); });
  test("checked done", () => {
    ok(["done", "pipe/convert", "--checker", "worker3", "--evidence", "checked out/"], { FACTORY_TAG: "worker3" });
    has(ok(["show", "pipe/convert"]), "done (checked by worker3)");
  });
});

describe("group priority, block, reopen, notes, rename", () => {
  test("group priority wins", () => {
    setup(["add-group", "fenn", "--title", "Fenn"]);
    setup(["add-unit", "fenn/rig", "--title", "Import Fenn's rig"]);
    ok(["edit-group", "fenn", "--priority", "3"]);
    has(ok(["next"]), "Import Fenn's rig");
  });
  test("stuck with reason", () => {
    setup(["edit-group", "fenn", "--priority", "0"]);
    ok(["block", "fenn/rig", "--why", "Steam is down"]);
    has(ok(["show", "fenn/rig"]), "stuck: Steam is down");
  });
  test("notes shown", () => {
    ok(["reopen", "fenn/rig"]);
    ok(["note", "fenn/rig", "the FBX needs Blender 4"]);
    has(ok(["show", "fenn/rig"]), "the FBX needs Blender 4");
  });
  test("rename keeps the unit", () => {
    ok(["rename", "fenn/rig", "fenn/rig-import"]);
    has(ok(["show", "fenn/rig-import"]), "Import Fenn's rig (fenn/rig-import)");
  });
});

describe("priority says what runs before what", () => {
  test("priority output says what it runs before", () => {
    setup(["add-group", "order", "--title", "Ordering"]);
    setup(["add-unit", "order/a", "--title", "First thing"]);
    setup(["add-unit", "order/b", "--title", "Second thing"]);
    setup(["add-unit", "order/c", "--title", "Third thing"]);
    // A unit's priority ranks it against every group's units, so it now runs before Fenn's too.
    has(ok(["edit", "order/c", "--priority", "5"]), "runs before Import Fenn's rig (fenn/rig-import), (first of the ready units)");
  });
  test("and what it runs after", () => { has(ok(["edit", "order/b", "--priority", "2"]), "runs before Import Fenn's rig (fenn/rig-import), after Third thing (order/c)"); });
  test("card shows the order", () => { has(ok(["show", "order/c"]), "Order: priority 5"); });
  test("group priority output", () => {
    setup(["add-group", "later", "--title", "Later work"]); setup(["add-unit", "later/x", "--title", "Later thing"]);
    has(ok(["edit-group", "later", "--priority", "9"]), "its units run before");
  });
  after(() => { setup(["edit-group", "later", "--priority", "0"]); });
});

// Trackers from before kept a focus list, which ran its groups before every other; the next write
// makes it priorities above the rest, in its order, so what runs first doesn't change.
describe("an old focus list becomes group priority", () => {
  test("a focus list still decides next", () => {
    setup(["edit-group", "later", "--priority", "4"]);
    f.edit("tracker/project.json", (p) => { p.focus = ["fenn", "nosuch", "order"]; });
    has(ok(["next"]), "Import Fenn's rig");
  });
  test("  a write turns it into priorities above the rest, in its order", () => {
    ok(["note", "fenn/rig-import", "a write"]);
    assert.equal(f.json("tracker/project.json").focus, undefined);
    assert.equal(f.json("tracker/groups/fenn.json").priority, 6);
    assert.equal(f.json("tracker/groups/order.json").priority, 5);
    assert.equal(f.json("tracker/groups/later.json").priority, 4);
    has(ok(["next"]), "Import Fenn's rig");
  });
  test("  and the log says so", () => { has(ok(["log"]), "focus became group priority: Fenn 6, Ordering 5"); });
  after(() => { for (const g of ["fenn", "order", "later"]) setup(["edit-group", g, "--priority", "0"]); });
});

describe("parked", () => {
  test("park a group's units", () => { has(ok(["park", "group:order", "--why", "the owner wants this after the playtest"]), "parked 3 units"); });
  test("parked shows why", () => { has(ok(["show", "order/a"]), "parked: the owner set it aside (the owner wants this after the playtest)"); });
  test("parked units aren't offered", () => { hasnt(ok(["next"]), "order/"); });
  test("status counts parked", () => { has(ok(["status", "order"]), "3 parked"); });
  test("lint accepts parked", () => { assert.equal(t(["lint"]).code, 0); });
  test("unpark brings one back", () => {
    has(ok(["unpark", "order/c"]), "Third thing (order/c) (ready)");
  });
  after(() => {
    setup(["drop", "later/x", "--why", "test"]);
  });
});

describe("unit flags --model; edit --model none; --check", () => {
  test("--model shows on the card", () => {
    setup(["add-group", "mf", "--title", "Model flags"]);
    setup(["add-unit", "mf/a", "--title", "Model unit", "--model", "opus"]);
    has(ok(["show", "mf/a"]), "Model: opus");
  });
  test("and in next --json", () => { has(ok(["next", "--json", "--group", "mf"]), '"model":"opus"'); });
  test("--model none clears it", () => {
    ok(["edit", "mf/a", "--model", "none"]);
    assert.equal(Object.hasOwn(f.json("tracker/groups/mf.json").units[0], "model"), false);
  });
  test("--check must be one of the three", () => { assert.equal(t(["edit", "mf/a", "--check", "sometimes"]).code, 2); });
});

describe("claiming a unit in review keeps the review: the checker can record it, and giving up puts it back", () => {
  test("a checker's claim says whose work it checks", () => {
    setup(["add-group", "rv", "--title", "Reviews"]);
    setup(["add-unit", "rv/a", "--title", "Reviewed unit a", "--check", "independent"]);
    setup(["add-unit", "rv/b", "--title", "Reviewed unit b", "--check", "independent"]);
    setup(["claim", "rv/a"], { FACTORY_TAG: "wa" }); setup(["review", "rv/a", "--evidence", "see out/a"], { FACTORY_TAG: "wa" });
    has(ok(["next", "--claim", "--group", "rv"], { FACTORY_TAG: "wb" }), "You're checking it: wa worked it; their evidence: see out/a");
  });
  test("the session that worked it can't record it done", () => {
    const r = t(["done", "rv/a", "--evidence", "my own look"], { FACTORY_TAG: "wa" });
    assert.equal(r.code, 2); has(r.stderr, "needs an independent check, and wa worked it");
  });
  test("and the checker records it done without naming itself", () => {
    assert.equal(t(["done", "rv/a", "--evidence", "checked"], { FACTORY_TAG: "wb" }).code, 0);
  });
  test("done, checked by the checker", () => { has(ok(["show", "rv/a"]), "done (checked by wb)"); });
  test("a check that ends without a verdict puts the unit back in review", () => {
    setup(["claim", "rv/b"], { FACTORY_TAG: "wa" }); setup(["review", "rv/b", "--evidence", "see out/b"], { FACTORY_TAG: "wa" });
    setup(["claim", "rv/b"], { FACTORY_TAG: "wc" });
    ok(["settle", "rv/b"], { FACTORY_TAG: "wc" });
    has(ok(["state", "rv/b"]), "review");
  });
  test("still the worker's", () => { has(ok(["show", "rv/b"]), "worked by wa"); });
  test("and so does giving the claim back", () => {
    setup(["claim", "rv/b"], { FACTORY_TAG: "wd" });
    ok(["unclaim", "rv/b"], { FACTORY_TAG: "wd" });
    has(ok(["state", "rv/b"]), "review");
  });
});

describe("an interrupted unit whose need was reopened since isn't offered before the need", () => {
  test("an interrupted unit with a need reopened since", () => {
    setup(["add-group", "nd", "--title", "Needs"]);
    setup(["add-unit", "nd/a", "--title", "Needed first"]);
    setup(["add-unit", "nd/b", "--title", "Needs the first", "--needs", "nd/a"]);
    setup(["claim", "nd/a"]); setup(["done", "nd/a", "--evidence", "x"]);
    setup(["claim", "nd/b"], { FACTORY_PID: "999999" });
    setup(["reopen", "nd/a", "--note", "found a gap"]);
    has(ok(["state", "nd/b"]), "interrupted");
  });
  test("isn't offered; the need is", () => { has(ok(["next", "--group", "nd"]), "Next: Needed first (nd/a)"); });
  test("and while the need is worked, it waits and says why", () => {
    setup(["claim", "nd/a"]);
    has(t(["next", "--group", "nd"], { FACTORY_TAG: "other" }, { merged: true }).stdout, "waiting on what it needs");
  });
  after(() => {
    setup(["done", "nd/a", "--evidence", "y"]);
  });
});

describe("edit --add-needs adds to what a unit needs; --needs replaces it", () => {
  test("--add-needs keeps the needs already there", () => {
    setup(["add-group", "an", "--title", "Adding needs"]);
    setup(["add-unit", "an/a", "--title", "First need"]);
    setup(["add-unit", "an/b", "--title", "Second need"]);
    setup(["add-unit", "an/c", "--title", "Needs both", "--needs", "an/a"]);
    ok(["edit", "an/c", "--add-needs", "an/b,an/a"]);
    has(ok(["show", "an/c"]), "Needs: First need (an/a), Second need (an/b)\n");
  });
  test("--add-needs refuses a unit that doesn't exist", () => {
    assert.notEqual(t(["edit", "an/c", "--add-needs", "an/nope"]).code, 0);
  });
  test("--needs still replaces the list", () => {
    ok(["edit", "an/c", "--needs", "an/b"]);
    has(ok(["show", "an/c"]), "Needs: Second need (an/b)\n");
  });
});
