// The tracker CLI end to end: one cause breaking CI in several groups files one fix unit (#93).
// A step failing on the same tested commit within 30 minutes of another group's failure on that
// step joins that group's open ci-fix (its also lists them, its card has each group's rows); each
// comes due when it's done; a shared fix that doesn't cure a group marks it known failing; ci-split
// takes a group out. Run: node --test tracker/test/
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { trackerRepo, has, hasnt, ago, sleep } from "../../test/lib/index.ts";

const f = trackerRepo("repo", { FACTORY_TAG: "worker1", FACTORY_EVIDENCE_MIN: "0" });
const { t, ok, setup } = f;
setup(["init", "--title", "Shared CI fixes"]);
f.edit("tracker/project.json", (p) => { p.ci = { steps: { drill: { cmd: "just drill {group}" }, check: { cmd: "just check {group}" } } }; });
f.write("code.txt", "code\n"); f.git("add", "code.txt"); f.git("commit", "-q", "-m", "some code");

// A group with CI and one unit done a minute ago (so a failure now reads as broken, not "finished
// since it failed": times are to the second).
const group = (id: string, title: string) => {
  setup(["add-group", id, "--title", title, "--ci", "drill,check"]);
  setup(["add-unit", `${id}/a`, "--title", `${title} unit`]); setup(["done", `${id}/a`, "--evidence", "x"]);
  f.edit(`tracker/groups/${id}.json`, (g) => { g.units[0].record.at = ago(1 / 60); });
};
const fail = (id: string, commit: string, rows: string, step = "drill") => {
  setup(["ci-next", "--claim", "--group", id, "--force"]);
  return ok(["ci-fail", id, "--step", step, "--commit", commit, "--evidence", `${step}: ${rows}`, "--log", `/x/runs/ci-${id}.log`]);
};
const units = (id: string) => f.json(`tracker/groups/${id}.json`).units;
const fix = (id: string) => units(id).find((u: any) => u.id === `${id}/ci-fix`);

describe("three groups failing the same step on the same commit within 30 minutes: one fix unit", () => {
  for (const [id, title] of [["ash", "Ash"], ["birch", "Birch"], ["cedar", "Cedar"]]) group(id, title);
  test("the first files its fix", () => { has(fail("ash", "c0ffee11", "ash rows 3, 4 differ"), "Filed Fix Ash's CI (ash/ci-fix)"); });
  test("the second joins it", () => { has(fail("birch", "c0ffee11", "birch row 9 differs"), "added to Fix Ash's CI (ash/ci-fix), not filing a fix of its own"); });
  test("the third too, while a session is on it", () => {
    setup(["claim", "ash/ci-fix"]);
    has(fail("cedar", "c0ffee11", "cedar row 2 differs"), "added to Fix Ash's CI (ash/ci-fix)");
  });
  test("  one fix unit, naming all three", () => {
    assert.deepEqual(fix("ash").also, ["birch", "cedar"]);
    assert.equal(fix("birch"), undefined); assert.equal(fix("cedar"), undefined);
  });
  test("  its card has each group's own rows and logs", () => {
    const s = ok(["show", "ash/ci-fix"]);
    for (const x of ["ash rows 3, 4 differ", "birch row 9 differs", "cedar row 2 differs", "/x/runs/ci-ash.log", "/x/runs/ci-birch.log", "/x/runs/ci-cedar.log", "Also Birch (birch)", "Also Cedar (cedar)", "ci-split birch"]) has(s, x);
  });
  test("  with a note on it for that session, which read its card before", () => {
    const s = ok(["show", "ash/ci-fix"]);
    has(s, "Cedar's CI failed the same way (drill on c0ffee11)"); hasnt(s, "Birch's CI failed the same way");
    setup(["unclaim", "ash/ci-fix"]);
  });
  test("  its uses stay the first group's (drill takes none)", () => { assert.equal(fix("ash").uses, undefined); });
  test("  each group's CI is broken meanwhile", () => { for (const id of ["ash", "birch", "cedar"]) has(ok(["ci", id]), "broken"); });
  test("  failing again while it's open adds a note to it, files nothing", () => {
    setup(["ci-retry", "birch"]);
    has(fail("birch", "c0ffee11", "birch row 9 differs"), "Fix Ash's CI (ash/ci-fix) is open already");
    assert.equal(fix("birch"), undefined);
  });
  test("a failure on a different commit files its own", () => {
    group("dune", "Dune");
    has(fail("dune", "beef0022", "dune row 1 differs"), "Filed Fix Dune's CI (dune/ci-fix)");
    assert.deepEqual(fix("ash").also, ["birch", "cedar"]);
  });
  test("a failure of another step on the same commit files its own", () => {
    group("elm", "Elm");
    has(fail("elm", "c0ffee11", "elm broke", "check"), "Filed Fix Elm's CI (elm/ci-fix)");
  });
  test("a failure after the window files its own", () => {
    f.edit("tracker/groups/ash.json", (g) => { g.ci.failed.at = ago(31 / 60); });
    group("fir", "Fir");
    has(fail("fir", "c0ffee11", "fir row 5 differs"), "Filed Fix Fir's CI (fir/ci-fix)");
    assert.deepEqual(fix("ash").also, ["birch", "cedar"]);
  });
  test("when the shared unit is done, all three are due", async () => {
    await sleep(1000); setup(["done", "ash/ci-fix", "--evidence", "fixed the shared clip list"]);
    for (const id of ["ash", "birch", "cedar"]) has(ok(["ci", id]), "due: Fix Ash's CI (ash/ci-fix) finished since it failed");
  });
  test("  the groups outside it aren't", () => { for (const id of ["dune", "fir"]) hasnt(ok(["ci", id]), "due"); });
  test("a shared fix that didn't cure a group marks it known failing", () => {
    setup(["note", "ash/ci-fix", "the clip list was the cause"]);
    has(fail("birch", "c0ffee11", "birch row 9 still differs"), "Birch's CI is known failing now (drill still fails after Fix Ash's CI (ash/ci-fix): the clip list was the cause)");
    has(ok(["ci", "birch"]), "known failing");
    assert.equal(fix("birch"), undefined);
  });
  test("  as it does the first group", () => {
    has(fail("ash", "c0ffee11", "ash rows still differ"), "Ash's CI is known failing now");
  });
  test("  a group it cured passes and is unaffected", () => {
    setup(["ci-next", "--claim", "--group", "cedar"]); setup(["ci-pass", "cedar", "--evidence", "ok"]);
    has(ok(["ci", "cedar"]), "passed");
  });
});

describe("a group whose failure only looked alike splits off with ci-split", () => {
  for (const [id, title] of [["gale", "Gale"], ["haze", "Haze"]]) group(id, title);
  test("(the second joined the first's fix)", () => {
    fail("gale", "abad1dea", "gale rows differ");
    has(fail("haze", "abad1dea", "haze rows differ"), "added to Fix Gale's CI (gale/ci-fix)");
  });
  test("ci-split files its own fix, with its failure", () => {
    has(ok(["ci-split", "haze"]), "Filed Fix Haze's CI (haze/ci-fix)");
    const s = ok(["show", "haze/ci-fix"]);
    has(s, "haze rows differ"); has(s, "/x/runs/ci-haze.log");
  });
  test("  and takes it out of the shared one", () => {
    assert.deepEqual(fix("gale").also ?? [], []);
    const s = ok(["show", "gale/ci-fix"]);
    has(s, "Haze is out of this fix: its CI failure has another cause"); hasnt(s, "Also Haze"); hasnt(s, "haze rows differ");
    has(s, "gale rows differ");
  });
  test("  the shared fix done no longer brings it due", async () => {
    await sleep(1000); setup(["done", "gale/ci-fix", "--evidence", "fixed"]);
    has(ok(["ci", "gale"]), "due"); has(ok(["ci", "haze"]), "broken");
  });
  test("ci-split on a group in no shared fix is refused", () => { assert.equal(t(["ci-split", "haze"]).code, 2); });
});

describe("the first group passing leaves the shared fix to the groups in it still failing", () => {
  for (const [id, title] of [["iris", "Iris"], ["juniper", "Juniper"]]) group(id, title);
  test("(the second joined the first's fix)", () => {
    fail("iris", "d00d0033", "iris rows differ");
    has(fail("juniper", "d00d0033", "juniper rows differ"), "added to Fix Iris's CI (iris/ci-fix)");
  });
  test("the first passes: its fix stays open, for the second", () => {
    setup(["ci-retry", "iris"]); setup(["ci-next", "--claim", "--group", "iris"]); setup(["ci-pass", "iris", "--evidence", "ok"]);
    assert.equal(ok(["state", "iris/ci-fix"]).trim(), "ready");
    has(ok(["ci", "juniper"]), "broken");
  });
  test("  once the second passes too, its pass settles it", () => {
    setup(["ci-retry", "juniper"]); setup(["ci-next", "--claim", "--group", "juniper"]);
    has(ok(["ci-pass", "juniper", "--evidence", "ok"]), "Fix Iris's CI (iris/ci-fix) is done: CI passed since");
    assert.equal(ok(["state", "iris/ci-fix"]).trim(), "done");
  });
  test("  which doesn't make the first's CI stale: no code changed", () => { has(ok(["ci", "iris"]), "Iris (iris): passed"); });
});

describe("the shared fix reopened for the first group's new failure: the others are retried first", () => {
  for (const [id, title] of [["kale", "Kale"], ["lime", "Lime"]]) group(id, title);
  test("(the second joined the first's fix, and it's done)", async () => {
    fail("kale", "e0e0e044", "kale rows differ");
    fail("lime", "e0e0e044", "lime rows differ");
    await sleep(1000); setup(["done", "kale/ci-fix", "--evidence", "fixed"]);
    has(ok(["ci", "lime"]), "due: Fix Kale's CI (kale/ci-fix) finished since it failed");
  });
  test("the first fails another step: its fix reopens", () => { has(fail("kale", "e0e0e044", "kale broke", "check"), "Reopened Fix Kale's CI (kale/ci-fix)"); });
  test("  the second, not run since the fix was done, is still due", () => { has(ok(["ci", "lime"]), "due: a retry was asked for"); });
  test("  and no longer in the fix", () => { assert.equal(fix("kale").also, undefined); });
});

describe("the cards and the step a shared fix is for", () => {
  for (const [id, title] of [["moss", "Moss"], ["nut", "Nut"], ["oak", "Oak"]]) group(id, title);
  test("(two groups joined the first's fix)", () => {
    fail("moss", "f00d0055", "moss rows differ");
    fail("nut", "f00d0055", "nut rows differ");
    has(fail("oak", "f00d0055", "oak rows differ"), "added to Fix Moss's CI (moss/ci-fix)");
  });
  test("the first failing again: its card has its new rows and keeps the others'", () => {
    setup(["ci-retry", "moss"]);
    has(fail("moss", "f00d0055", "moss rows differ again"), "is open already");
    const s = ok(["show", "moss/ci-fix"]);
    for (const x of ["moss rows differ again", "Also Nut (nut)", "nut rows differ", "Also Oak (oak)", "oak rows differ"]) has(s, x);
    hasnt(s, "moss rows differ The");
  });
  test("a joined group failing another step leaves the fix and files its own", () => {
    setup(["ci-retry", "nut"]);
    has(fail("nut", "f00d0055", "nut broke", "check"), "Filed Fix Nut's CI (nut/ci-fix)");
    assert.deepEqual(fix("moss").also, ["oak"]);
    const s = ok(["show", "moss/ci-fix"]);
    hasnt(s, "nut rows differ"); has(s, "Nut is out of this fix: its CI fails on check now");
  });
  test("a joined group failing a step that's the owner's leaves it too", () => {
    f.edit("tracker/project.json", (p) => { p.ci.steps.check.on_fail = "owner"; });
    setup(["ci-retry", "oak"]);
    has(fail("oak", "f00d0055", "oak broke", "check"), "the owner's to look at");
    assert.deepEqual(fix("moss").also ?? [], []);
    f.edit("tracker/project.json", (p) => { delete p.ci.steps.check.on_fail; });
  });
  test("  so the first passing settles its fix: nobody in it fails its step", () => {
    setup(["ci-retry", "moss"]); setup(["ci-next", "--claim", "--group", "moss"]);
    has(ok(["ci-pass", "moss", "--evidence", "ok"]), "Fix Moss's CI (moss/ci-fix) is done: CI passed since");
  });
});

describe("ci-split of the last group failing settles the shared fix; its card names the failing machine", () => {
  for (const [id, title] of [["pine", "Pine"], ["quince", "Quince"]]) group(id, title);
  test("(the second joined; the first has passed since)", () => {
    fail("pine", "aaaa0066", "pine rows differ");
    fail("quince", "aaaa0066", "quince rows differ");
    setup(["ci-retry", "pine"]); setup(["ci-next", "--claim", "--group", "pine"]); setup(["ci-pass", "pine", "--evidence", "ok"]);
    assert.equal(ok(["state", "pine/ci-fix"]).trim(), "ready");
  });
  test("split from another machine", () => { has(ok(["ci-split", "quince"], { FACTORY_HOST: "laptop2" }), "Filed Fix Quince's CI (quince/ci-fix)"); });
  test("  the shared fix, with nobody in it failing, is settled", () => { assert.equal(ok(["state", "pine/ci-fix"]).trim(), "done"); });
  test("  the new fix's log is on the machine that ran it", () => {
    const s = ok(["show", "quince/ci-fix"]);
    has(s, "/x/runs/ci-quince.log on testhost"); hasnt(s, "laptop2");
  });
});
