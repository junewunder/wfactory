// The tracker CLI end to end: evidence and notes a lane can get right the first time
// (18-19 Oct: refusals whose reason a `| tail -2` cut off, and units recorded done
// with evidence "x" sent to see why): the evidence floor, --dry-run, bare IDs, and every
// refusal's reason on its last line. Run: node --test tracker/test/
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { trackerRepo, has, lastLine } from "../../test/lib/index.ts";

const f = trackerRepo("repo", { FACTORY_TAG: "worker1", FACTORY_EVIDENCE_MIN: "0" });
const { t, ok, setup } = f;
setup(["init", "--title", "Test port"]);

// The floor these checks are about.
const EV = { FACTORY_EVIDENCE_MIN: "30" };
const unit = (id: string) => f.json("tracker/groups/ev.json").units.find((u: { id: string }) => u.id === id);

describe("evidence and notes a lane can get right the first time", () => {
  let out = "";
  test('evidence "x" is refused', () => {
    setup(["add-group", "ev", "--title", "Evidence"]);
    setup(["add-unit", "ev/a", "--title", "A unit to record", "--check", "recorded"]);
    setup(["add-unit", "ev/b", "--title", "Another unit", "--check", "recorded"]);
    assert.equal(t(["done", "ev/a", "--evidence", "x"], EV).code, 2);
  });
  test("with the reason on the last line", () => {
    has(lastLine(t(["done", "ev/a", "--evidence", "x"], EV, { merged: true }).stdout), 'done needs evidence: "x" is 1 character, under 30, and nothing was recorded');
  });
  test("and nothing recorded", () => { has(ok(["state", "ev/a"]), "ready"); });
  test("a short word is refused", () => { assert.equal(t(["done", "ev/a", "--evidence", "tests pass"], EV).code, 2); });
  test("a run of one character is refused", () => { assert.equal(t(["done", "ev/a", "--evidence", "x".repeat(40)], EV).code, 2); });
  test("and so is a review's", () => { assert.equal(t(["review", "ev/a", "--evidence", "see out/"], EV).code, 2); });
  test("still ready", () => { has(ok(["state", "ev/a"]), "ready"); });
  test("done --dry-run says what it would record", () => {
    out = ok(["done", "ev/a", "--dry-run", "--evidence", "pytest tests/test_a.py: 12 passed, see out/a.json for ev/b"], EV, { merged: true });
    has(out, "dry run, nothing recorded: A unit to record (ev/a) would be done, with this evidence:");
  });
  test("with bare IDs as the owner would read them", () => { has(out, "see out/a.json for Another unit (ev/b)"); });
  test("and records nothing", () => { has(ok(["state", "ev/a"]), "ready"); });
  test("done --dry-run refuses what done refuses", () => { assert.equal(t(["done", "ev/a", "--dry-run", "--evidence", "x"], EV).code, 2); });
  test("real evidence records it, last", () => {
    out = ok(["done", "ev/a", "--evidence", "pytest tests/test_a.py: 12 passed, see out/a.json for ev/b"], EV, { merged: true });
    has(lastLine(out), "A unit to record (ev/a) → done");
  });
  test("with its bare ID written as {unit:…}", () => { has(unit("ev/a").record.evidence, "see out/a.json for {unit:ev/b}"); });
  test("note --dry-run says what it would note", () => {
    out = ok(["note", "ev/b", "--dry-run", "check {unit:ev/a} first"]);
    has(out, "would get this note:");
  });
  // jq printed null for a unit without notes.
  test("and notes nothing", () => { has(JSON.stringify(unit("ev/b").notes ?? null), "null"); });
  const long = "y".repeat(300);
  test("an over-long note is refused", () => { assert.equal(t(["note", "ev/b", long]).code, 2); });
  test("saying how long it was and the limit, on the last line", () => {
    has(lastLine(t(["note", "ev/b", long], {}, { merged: true }).stdout), "notes are at most 280 characters, and this one is 300 (20 over); nothing was recorded.");
  });
  test("and so with --dry-run", () => { assert.equal(t(["note", "ev/b", "--dry-run", long]).code, 2); });
  // An agent copies the "<date> <session>:" the card prints before earlier notes; the card adds its own.
  test("a copied date and session prefix is left out, and not counted", () => {
    const at = unit("ev/b").notes?.length ?? 0;
    assert.equal(t(["note", "ev/b", `2026-10-23 6e0a534b: ${"q".repeat(275)}`]).code, 0);
    const n = unit("ev/b").notes[0].text;
    assert.equal([unit("ev/b").notes.length - at, n].join(" "), `1 ${"q".repeat(275)}`);
  });
  test("  the session's own tag alone too", () => { ok(["note", "ev/b", "6e0a534b: carry on from the branch"], { FACTORY_TAG: "6e0a534b" }); assert.equal(unit("ev/b").notes[0].text, "carry on from the branch"); });
  test("  an author that isn't a hash too", () => { ok(["note", "ev/b", "2026-10-23 manual: the rig moved"]); assert.equal(unit("ev/b").notes[0].text, "the rig moved"); });
  for (const keep of ["8 files: the rest wait", "3e8c371a: this commit regressed the jab", "2026-10-23: the store moved"]) {
    test(`  not the note's own words: ${keep}`, () => { ok(["note", "ev/b", keep]); assert.equal(unit("ev/b").notes[0].text, keep); });
  }
  test("a note's {unit:…} counts as the ID it names", () => { assert.equal(t(["note", "ev/b", `{unit:ev/a} ${"z".repeat(270)}`]).code, 0); });
  // A path or `code` that holds a unit's ID is left as written.
  test("a path holding an ID is left alone", () => {
    out = ok(["done", "ev/b", "--dry-run", "--evidence", "wrote ev/b.json and checked `ev/b` against ev/a, frame by frame"], EV, { merged: true });
    has(out, "wrote ev/b.json and checked");
  });
  test("and so is code", () => { has(out, "checked `ev/b` against"); });
  test("the rest written as a title", () => { has(out, "against A unit to record (ev/a)"); });
  test("--dry-run before the ID still finds the unit", () => {
    assert.equal(t(["done", "--dry-run", "ev/b", "--evidence", "pytest tests/test_b.py: 3 passed, see out/b.json"], EV).code, 0);
  });
  test("and records nothing", () => { has(ok(["state", "ev/b"]), "ready"); });
  test("--dry-run inside unquoted note text is part of the note", () => {
    has(ok(["note", "ev/b", "fix", "the", "--dry-run", "flag", "in", "{unit:ev/a}"]), "noted on");
  });
  test("reopen --note: the log has the note as written for the owner", () => {
    ok(["reopen", "ev/a", "--note", "look at ev/b first"]);
    has(ok(["log", "-n", "1"]), "back to ready: look at Another unit (ev/b) first");
  });
  // Every refusal's reason is its last line.
  test("last line: a bare ID in --detail, after the fixed text", () => {
    has(lastLine(t(["edit", "ev/a", "--detail", "see ev/b"], {}, { merged: true }).stdout), "names ev/b by a bare ID");
  });
  test("last line: an over-long title, after the shorter one offered", () => {
    has(lastLine(t(["edit", "ev/a", "--title", "w".repeat(70)], {}, { merged: true }).stdout), "titles are at most 60 characters");
  });
  test("last line: an unknown command", () => { has(lastLine(t(["dun", "ev/a"], {}, { merged: true }).stdout), 'no command "dun"'); });
  test("which exits 2", () => { assert.equal(t(["dun", "ev/a"]).code, 2); });
});

// 18 Oct: a session said none of 150 failing rows came from its sprint, and nobody had checked.
// Evidence saying a failure predates the work names the commit it was compared at, or is warned.
describe("evidence that says a failure predates the work", () => {
  let r = { code: 0, stdout: "" };
  test("without a commit: a warning", () => {
    setup(["add-unit", "ev/pre", "--title", "A unit with an old failure", "--check", "recorded"]);
    r = t(["done", "ev/pre", "--evidence", "tests pass but rows 3 and 9 fail; that's pre-existing"], {}, { merged: true });
    has(r.stdout, `warning: the done evidence says "pre-existing" but names no commit it was compared at`);
  });
  test("  saying to rerun at the commit before the change", () => { has(r.stdout, "Rerun the check at the commit before the change"); });
  test("  but not a refusal: it's recorded", () => { assert.equal(r.code, 0); has(ok(["state", "ev/pre"]), "done"); });
  test("from review too, and --dry-run", () => {
    setup(["reopen", "ev/pre", "--why", "again"]);
    has(t(["review", "ev/pre", "--dry-run", "--evidence", "the parser test was already failing before this"], {}, { merged: true }).stdout, `says "was already failing before"`);
  });
  test("naming the commit it was compared at: no warning", () => {
    const out = t(["done", "ev/pre", "--evidence", "rows 3 and 9 fail at 4f2a9c1 too (the commit before the change): pre-existing"], {}, { merged: true }).stdout;
    assert.doesNotMatch(out, /warning/);
  });
  test("or HEAD~1", () => {
    setup(["reopen", "ev/pre", "--why", "again"]);
    assert.doesNotMatch(t(["done", "ev/pre", "--dry-run", "--evidence", "rows 3 and 9 fail at HEAD~1 as well, so pre-existing"], {}, { merged: true }).stdout, /warning/);
  });
  test("evidence that says nothing of the kind: no warning", () => {
    assert.doesNotMatch(t(["done", "ev/b", "--dry-run", "--evidence", "all 40 rows pass in the report"], {}, { merged: true }).stdout, /warning/);
  });
});
