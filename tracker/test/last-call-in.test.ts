// The tracker CLI end to end: what a lane passes over before its last call (#159). `next
// --last-call-in` takes no unit its last call will hold back (of --last-call-groups, on their data,
// or using --last-call-uses) whose least time is longer than the time left before it: the unit's
// --min-minutes, else its usual session, else tracker/project.json "min_unit_minutes" (default 45).
// Other units are taken as before; those passed over count as moving, since last call comes.
// Run: node --test tracker/test/
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { trackerRepo, ago, has } from "../../test/lib/index.ts";

const f = trackerRepo("repo", { FACTORY_TAG: "s1", FACTORY_EVIDENCE_MIN: "0" });
const { t, setup } = f;
setup(["init", "--title", "Last call in"]);
const logLine = (x: Record<string, unknown>) => fs.appendFileSync(f.at("tracker/log.jsonl"), JSON.stringify({ actor: "loop", host: "testhost", ...x }) + "\n");
const next = (args: string[], add = {}) => JSON.parse(t(["next", "--json", ...args], add).stdout);
// 40 minutes before last call, which holds back units using the editor.
const lc = (mins: number, more: string[] = []) => ["--last-call-in", String(mins * 60), "--last-call-uses", "editor", ...more];

describe("next --last-call-in: a unit last call holds back isn't taken with too little time before it", () => {
  test("setup: an editor unit first in order, and a unit using nothing", () => {
    f.edit("tracker/project.json", (p) => { p.resources = { editor: { title: "the editor" } }; });
    setup(["add-group", "e", "--title", "Effects", "--priority", "10"]);
    setup(["add-unit", "e/mesh", "--title", "Mesh emitters", "--uses", "editor"]);
    setup(["add-group", "p", "--title", "Plain"]);
    setup(["add-unit", "p/doc", "--title", "Write the doc"]);
  });
  test("  40 min before last call, with min_unit_minutes at its 45: the editor unit isn't taken, the unit using nothing is", () => {
    const j = next(lc(40));
    assert.equal(j.id, "p/doc");
    assert.equal(j.lc_late, 1);
    has(j.lc_why, "1 unit using the editor, held back: too little time before last call (45 min needed, 40 left)");
  });
  test("  --claim passes it over the same way", () => {
    const r = t(["next", "--claim", "--json", ...lc(40)]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).id, "p/doc");
    assert.equal(JSON.parse(r.stdout).lc_late, 1);
    setup(["unclaim", "p/doc", "--unstarted"]);
  });
  test("  50 min before it, the editor unit is taken", () => {
    const j = next(lc(50));
    assert.equal(j.id, "e/mesh");
    assert.equal(j.lc_late, undefined);
  });
  test("  without --last-call-in, nothing changes", () => { assert.equal(next([]).id, "e/mesh"); });
  test("  a unit of a group last call holds back counts the same", () => {
    assert.equal(next(["--last-call-in", "2400", "--last-call-groups", "e"]).id, "p/doc");
    assert.equal(next(["--last-call-in", "2400", "--last-call-groups", "p"]).id, "e/mesh");
  });
  test("  with only units too long for the time left, nothing is offered, but the lane waits: last call comes", () => {
    const j = next(lc(40, ["--skip-units", "p/doc"]));
    assert.equal(j.code, 1);
    assert.equal(j.wait, true, j.why);
    assert.equal(j.lc_late, 1);
    has(j.why, "1 unit using the editor, held back: too little time before last call (45 min needed, 40 left)");
  });
});

describe("the least time: the unit's --min-minutes, else its usual session, else min_unit_minutes", () => {
  test("min_unit_minutes 30: taken 40 min before last call", () => {
    f.edit("tracker/project.json", (p) => { p.min_unit_minutes = 30; });
    assert.equal(next(lc(40)).id, "e/mesh");
  });
  test("  a unit's --min-minutes 60 outranks it", () => {
    setup(["edit", "e/mesh", "--min-minutes", "60"]);
    const j = next(lc(50));
    assert.equal(j.id, "p/doc");
    has(j.lc_why, "(60 min needed, 50 left)");
  });
  test("  and goes for the stop too (--time-left)", () => {
    assert.equal(next(["--time-left", "3000"]).id, "p/doc");
    assert.equal(next(["--time-left", "3600"]).id, "e/mesh");
  });
  test("  --min-minutes none clears it", () => {
    setup(["edit", "e/mesh", "--min-minutes", "none"]);
    assert.equal(next(lc(40)).id, "e/mesh");
  });
  test("  --min-minutes takes whole minutes", () => {
    const r = t(["edit", "e/mesh", "--min-minutes", "1.5"]);
    assert.notEqual(r.code, 0);
    has(r.stderr, "--min-minutes takes whole minutes or none");
  });
  test("  min_unit_minutes 0: no least time for a unit with nothing else to go by", () => {
    f.edit("tracker/project.json", (p) => { p.min_unit_minutes = 0; });
    assert.equal(next(lc(1)).id, "e/mesh");
  });
  test("  lint takes a whole number of minutes", () => {
    f.edit("tracker/project.json", (p) => { p.min_unit_minutes = "45"; });
    has(t(["lint"]).stdout + t(["lint"]).stderr, "project.json min_unit_minutes: minutes, a whole number");
  });
  test("  past sessions of units using the same resources: their median, over min_unit_minutes", () => {
    f.edit("tracker/project.json", (p) => { p.min_unit_minutes = 45; });
    setup(["add-unit", "e/spark", "--title", "Spark emitters", "--uses", "editor"]);
    // Two 20-minute sessions of the spark unit: the mesh unit, with none of its own, goes by them.
    for (const [k, at] of [[1, 5], [2, 3]] as const) {
      logLine({ at: ago(at), tag: `w${k}`, cmd: "claim", id: "e/spark", text: "Spark emitters: claimed" });
      logLine({ at: ago(at - 1 / 3), tag: `w${k}`, cmd: "note", id: "e/spark", text: "Spark emitters: note: done" });
    }
    assert.equal(next(lc(25)).id, "e/mesh");
    const j = next(lc(15));
    assert.equal(j.id, "p/doc");
    has(j.lc_why, "2 units using the editor, held back: too little time before last call (20 min needed, 15 left)");
  });
});
