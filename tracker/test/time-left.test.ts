// The tracker CLI end to end: what a lane near its stop passes over (#141). `next --time-left`
// takes no unit whose usual session (from the log: its own, its template's units', those using the
// same resources) is longer than the time left; `--skip-units` none its sessions gave back
// unstarted this run. A session that gives its unit back unstarted pushes out none of the notes
// earlier attempts left.
// Run: node --test tracker/test/
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { trackerRepo, ago, has, sleep } from "../../test/lib/index.ts";

const f = trackerRepo("repo", { FACTORY_TAG: "s1", FACTORY_EVIDENCE_MIN: "0" });
const { t, ok, setup } = f;
setup(["init", "--title", "Time left"]);
const logLine = (x: Record<string, unknown>) => fs.appendFileSync(f.at("tracker/log.jsonl"), JSON.stringify({ actor: "loop", host: "testhost", ...x }) + "\n");
const next = (args: string[], add = {}) => JSON.parse(t(["next", "--json", ...args], add).stdout);

describe("next --time-left: units whose usual session won't fit are passed over", () => {
  test("setup: an hour-long editor unit's session in the log, and one given back unstarted", () => {
    f.edit("tracker/project.json", (p) => { p.resources = { editor: { title: "the editor" } }; });
    setup(["add-group", "e", "--title", "Effects"]);
    setup(["add-unit", "e/mesh", "--title", "Mesh emitters", "--uses", "editor"]);
    setup(["add-unit", "e/spark", "--title", "Spark emitters", "--uses", "editor"]);
    setup(["add-unit", "e/table", "--title", "Effect table"]);
    // e/mesh: one real session of an hour, then one given back unstarted after 30 s (not counted).
    logLine({ at: ago(5), tag: "a1", cmd: "claim", id: "e/mesh", text: "Mesh emitters: claimed" });
    logLine({ at: ago(4), tag: "a1", cmd: "note", id: "e/mesh", text: "Mesh emitters: note: half done" });
    logLine({ at: ago(3), tag: "a2", cmd: "claim", id: "e/mesh", text: "Mesh emitters: claimed" });
    logLine({ at: ago(3 - 30 / 3600), tag: "a2", cmd: "unclaim", id: "e/mesh", text: "Mesh emitters: given back unstarted", unstarted: true });
  });
  test("  with an hour or more left, the editor unit is taken", () => {
    assert.equal(next(["--time-left", "3600"]).id, "e/mesh");
    assert.equal(next([]).id, "e/mesh");
  });
  test("  with 30 min left, it's passed over; so is the other editor unit, by its sessions; a unit with nothing to go by is taken", () => {
    assert.equal(next(["--time-left", "1800"]).id, "e/table");
  });
  test("  with nothing that fits, nothing is offered, and why says so; late counts what was passed over", () => {
    const j = next(["--time-left", "600", "--skip-units", "e/table"]);
    assert.equal(j.code, 1);
    assert.equal(j.late, 2);
    assert.equal(j.wait, false, "waiting won't make it fit");
    has(j.why, "2 units whose usual session (60 min) won't fit in the 10 min left before the stop");
    has(j.why, "1 unit this lane's sessions gave back unstarted this run");
  });
  test("  --claim passes it over the same way", () => {
    const r = t(["next", "--claim", "--json", "--time-left", "600"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).id, "e/table");
    setup(["unclaim", "e/table", "--unstarted"]);
  });
  test("  a session's own claim is never passed over", () => {
    setup(["claim", "e/mesh"], { FACTORY_TAG: "s2" });
    assert.equal(next(["--time-left", "60", "--skip-units", "e/mesh"], { FACTORY_TAG: "s2" }).id, "e/mesh");
    setup(["unclaim", "e/mesh", "--unstarted"], { FACTORY_TAG: "s2" });
  });
});

describe("what was passed over doesn't count as moving; other work does", () => {
  test("setup: the other editor unit interrupted", () => {
    setup(["claim", "e/spark"], { FACTORY_TAG: "o2" });
    setup(["settle", "e/spark"], { FACTORY_TAG: "o2" });
  });
  test("  only an interrupted unit that won't fit: not moving, so the lane stops", () => {
    const j = next(["--time-left", "600", "--skip-units", "e/mesh,e/table"]);
    assert.equal(j.late, 1);
    assert.equal(j.wait, false, j.why);
    has(j.why, "1 unit whose usual session");
  });
  test("  with a unit in progress elsewhere too, the lane waits for it (its work may make room for more)", () => {
    // (Its claim is alive while this test's process is.)
    setup(["claim", "e/table"], { FACTORY_TAG: "o3" });
    const j = next(["--time-left", "600", "--skip-units", "e/mesh"]);
    assert.equal(j.late, 1);
    assert.equal(j.wait, true, j.why);
    setup(["unclaim", "e/table", "--unstarted"], { FACTORY_TAG: "o3" });
  });
});

describe("the estimate goes by the unit's template's units before those using the same resources", () => {
  test("a templated unit, with a two-hour session of another unit of its template", () => {
    setup(["add-unit", "e/tpl-a", "--title", "Templated A", "--uses", "editor"]);
    setup(["add-unit", "e/tpl-b", "--title", "Templated B", "--uses", "editor"]);
    f.edit("tracker/groups/e.json", (g) => { for (const u of g.units) if (u.id.startsWith("e/tpl-")) u.template = "effects"; });
    logLine({ at: ago(4), tag: "t1", cmd: "claim", id: "e/tpl-a", text: "Templated A: claimed" });
    logLine({ at: ago(2), tag: "t1", cmd: "note", id: "e/tpl-a", text: "Templated A: note: two hours" });
    // Its template's sessions are two hours; the editor units' an hour and two (an hour, by the
    // median): 90 minutes isn't enough.
    const j = next(["--time-left", "5400", "--skip-units", "e/mesh,e/spark,e/table,e/tpl-a"]);
    assert.equal(j.late, 1, JSON.stringify(j));
    has(j.why, "usual session (120 min)");
  });
});

describe("next --skip-units: units given back unstarted are passed over", () => {
  test("the next unit in order is offered instead", () => {
    assert.equal(next(["--skip-units", "e/mesh"]).id, "e/spark");
    assert.equal(next(["--skip-units", "e/mesh,e/spark,e/tpl-a,e/tpl-b"]).id, "e/table");
  });
});

describe("a give-back unstarted pushes out no older notes", () => {
  const notes = (id: string) => f.json(`tracker/groups/${id.split("/")[0]}.json`).units.find((u: { id: string }) => u.id === id).notes as { by: string; text: string }[] | undefined;
  test("setup: a unit with three notes from real attempts, in its record and the log", async () => {
    // (Nothing in the tree is the session's work, and the commit comes a second before its claim.)
    f.git("add", "-A", "--", ".", ":!tracker"); f.git("commit", "-q", "-m", "setup");
    await sleep(1100);
    setup(["add-group", "n", "--title", "Noted"]);
    setup(["add-unit", "n/x", "--title", "Noted unit"]);
    setup(["add-unit", "n/y", "--title", "Other noted unit"]);
    setup(["add-unit", "n/z", "--title", "Resumed noted unit"]);
    const at = [ago(3), ago(2), ago(1)];
    f.edit("tracker/groups/n.json", (g) => {
      g.units[0].notes = [3, 2, 1].map((i) => ({ at: at[i - 1], by: `r${i}`, text: `real note ${i}` }));
      g.units[1].notes = [{ at: at[0], by: "r1", text: "only real note" }];
      g.units[2].notes = [3, 2, 1].map((i) => ({ at: at[i - 1], by: `r${i}`, text: `real note ${i}` }));
    });
    for (const i of [1, 2, 3]) for (const [id, title] of [["n/x", "Noted unit"], ["n/z", "Resumed noted unit"]]) logLine({ at: at[i - 1], tag: `r${i}`, cmd: "note", id, text: `${title}: note: real note ${i}` });
    logLine({ at: at[0], tag: "r1", cmd: "note", id: "n/y", text: "Other noted unit: note: only real note" });
  });
  test("  a session notes it, which pushes the oldest out, then gives it back unstarted: the older notes are back", () => {
    setup(["claim", "n/x"], { FACTORY_TAG: "g1" });
    setup(["note", "n/x", "Not started: claimed two minutes before the stop."], { FACTORY_TAG: "g1" });
    assert.deepEqual(notes("n/x")!.map((n) => n.by), ["g1", "r3", "r2"]);
    ok(["unclaim", "n/x"], { FACTORY_TAG: "g1" });
    assert.deepEqual(notes("n/x")!.map((n) => n.text), ["real note 3", "real note 2", "real note 1"]);
  });
  test("  the log marks that give-back unstarted, for the loop", () => {
    const l = f.read("tracker/log.jsonl").split("\n").filter(Boolean).map((x) => JSON.parse(x)).filter((x) => x.cmd === "unclaim" && x.tag === "g1");
    assert.equal(l.length, 1);
    assert.equal(l[0].unstarted, true);
    has(l[0].text, "given back unstarted");
  });
  test("  a later give-back's note doesn't bring the first one's back", () => {
    setup(["claim", "n/x"], { FACTORY_TAG: "g2" });
    setup(["note", "n/x", "Not started again: claimed a minute before the stop."], { FACTORY_TAG: "g2" });
    ok(["unclaim", "n/x"], { FACTORY_TAG: "g2" });
    assert.deepEqual(notes("n/x")!.map((n) => n.text), ["real note 3", "real note 2", "real note 1"]);
  });
  test("  with room to spare, its note stays", () => {
    setup(["claim", "n/y"], { FACTORY_TAG: "g3" });
    setup(["note", "n/y", "Not started: its input isn't there yet."], { FACTORY_TAG: "g3" });
    ok(["unclaim", "n/y"], { FACTORY_TAG: "g3" });
    assert.deepEqual(notes("n/y")!.map((n) => n.by), ["g3", "r1"]);
  });
  test("  a note an earlier give-back left stays while there's room", () => {
    setup(["claim", "n/y"], { FACTORY_TAG: "g5" });
    setup(["note", "n/y", "Not started: claimed a minute before the stop."], { FACTORY_TAG: "g5" });
    ok(["unclaim", "n/y"], { FACTORY_TAG: "g5" });
    assert.deepEqual(notes("n/y")!.map((n) => n.by), ["g5", "g3", "r1"]);
  });
  // 25 Oct, on a lane: the unit had an earlier attempt's work on its branch, so each give-back kept it
  // ("its work kept (an earlier attempt's)"), and the session noted after giving it back.
  test("  one that keeps only an earlier attempt's work counts the same, its note after the give-back too", () => {
    setup(["claim", "n/z"], { FACTORY_TAG: "p1" });
    setup(["settle", "n/z"], { FACTORY_TAG: "p1" });
    setup(["claim", "n/z"], { FACTORY_TAG: "g4" });
    has(ok(["unclaim", "n/z"], { FACTORY_TAG: "g4" }), "its work kept (an earlier attempt's)");
    const l = f.read("tracker/log.jsonl").split("\n").filter(Boolean).map((x) => JSON.parse(x)).filter((x) => x.cmd === "unclaim" && x.tag === "g4");
    assert.equal(l[0].unstarted, true);
    setup(["note", "n/z", "Not started: claimed two minutes before the stop."], { FACTORY_TAG: "g4" });
    ok(["settle", "n/z"], { FACTORY_TAG: "g4" });
    assert.deepEqual(notes("n/z")!.map((n) => n.text), ["real note 3", "real note 2", "real note 1"]);
  });
});
