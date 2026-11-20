// drop, park and unpark take several units in one write: several IDs and the selectors the tracker
// already has (group:<g>, tag:<t>, a glob), one --why for all, one commit and push, a log line per
// unit. Every unit is checked first: one that can't go leaves all as they were. Run: node --test tracker/test/
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { trackerRepo, has, hasnt, cmd, TRACKER, STATE_BRANCH } from "../../test/lib/index.ts";

const f = trackerRepo("repo", { FACTORY_TAG: "worker1", FACTORY_EVIDENCE_MIN: "0" });
const { setup, ok } = f;
setup(["init", "--title", "Bulk"]);
setup(["add-group", "old", "--title", "Old units"]);
setup(["add-group", "new", "--title", "New units"]);
for (const [g, s, tags] of [["old", "a", "stale"], ["old", "b", "stale"], ["old", "c", ""], ["old", "d", ""], ["new", "e", "stale"], ["new", "f", ""], ["new", "g", ""]])
  setup(["add-unit", `${g}/${s}`, "--title", `Unit ${s.toUpperCase()}`, ...(tags ? ["--tags", tags] : [])]);
setup(["add-unit", "new/h", "--title", "Unit H"]);
setup(["done", "new/h", "--evidence", "done"]);
f.git("add", "-A"); f.git("commit", "-qm", "tracker");
const bare = path.join(f.top, "origin.git");
f.git("clone", "-q", "--bare", f.dir, bare);
f.git("remote", "add", "origin", bare);
setup(["state-branch"]);
const commits = () => Number(cmd("git", ["--git-dir", bare, "rev-list", "--count", STATE_BRANCH], { cwd: f.top, env: f.env }).stdout.trim());
const run = (a: string[]) => cmd(process.execPath, [TRACKER, ...a], { cwd: f.dir, env: f.env });
const state = (id: string) => JSON.parse(ok(["show", id, "--json"])).status;

describe("drop several units in one write", () => {
  test("three IDs, one --why: one commit, a log line each", () => {
    const before = commits();
    const out = ok(["drop", "old/a", "old/b", "old/c", "--why", "the old scheme is gone"]);
    assert.equal(commits(), before + 1);
    for (const id of ["old/a", "old/b", "old/c"]) assert.equal(state(id), "dropped");
    has(out, "dropped 3 units");
    const lines = ok(["log", "-n", "100"]).split("\n").filter((l) => l.includes("dropped: the old scheme is gone"));
    assert.equal(lines.length, 3);
    has(ok(["show", "old/b"]), "the old scheme is gone");
  });
  test("one bad ID among three leaves all three as they were", () => {
    const before = commits();
    const r = run(["drop", "old/d", "new/f", "new/nope", "--why", "tidy"]);
    assert.equal(r.code, 2);
    has(r.stderr, "new/nope");
    has(r.stderr, "Nothing was written");
    assert.equal(commits(), before);
    assert.equal(state("old/d"), "ready");
    assert.equal(state("new/f"), "ready");
  });
  test("every unit that can't go is named, title then ID, and nothing is written", () => {
    const before = commits();
    const r = run(["drop", "old/a", "new/h", "new/f", "--why", "tidy"]);
    assert.equal(r.code, 2);
    has(r.stderr, "Unit A (old/a)");
    has(r.stderr, "Unit H (new/h)");
    hasnt(r.stderr, "Unit F");
    assert.equal(commits(), before);
    assert.equal(state("new/f"), "ready");
  });
  test("a unit in progress is refused, with the others", () => {
    ok(["claim", "new/g"], { FACTORY_TAG: "other" });
    const before = commits();
    const r = run(["drop", "new/f", "new/g", "--why", "tidy"]);
    assert.equal(r.code, 2);
    has(r.stderr, "Unit G (new/g)");
    assert.equal(commits(), before);
    assert.equal(state("new/f"), "ready");
    ok(["reopen", "new/g"]);
  });
  test("a selector says how many and which groups, and --dry-run writes nothing", () => {
    const before = commits();
    const out = ok(["drop", "tag:stale", "--why", "tidy", "--dry-run"]);
    has(out, "1 unit in New units (new)");   // old/a, old/b are dropped already: left out
    has(out, "Unit E (new/e)");
    assert.equal(commits(), before);
    assert.equal(state("new/e"), "ready");
  });
  test("a selector and IDs together, in one commit, with the count and groups said", () => {
    const before = commits();
    const out = ok(["drop", "tag:stale", "old/d", "--why", "tidy"]);
    has(out, "2 units in 2 groups: Old units (old) 1, New units (new) 1");
    assert.equal(commits(), before + 1);
    assert.equal(state("new/e"), "dropped");
    assert.equal(state("old/d"), "dropped");
  });
  test("one ID behaves as before", () => {
    const before = commits();
    const out = ok(["drop", "new/f", "--why", "single"]);
    assert.equal(out, "Unit F (new/f) → dropped\n");
    assert.equal(commits(), before + 1);
    assert.equal(run(["drop", "nope/x", "--why", "x"]).code, 2);
    assert.equal(run(["drop", "new/g"]).code, 2);
  });
  test("a done unit named alone is dropped, as before", () => {
    has(ok(["drop", "new/h", "--why", "never mind"]), "Unit H (new/h) → dropped");
  });
});

describe("park and unpark several units in one write", () => {
  const ids = ["pk/a", "pk/b", "pk/c", "pk/d"];
  test("three IDs, one --why: one commit, a log line each, and unpark takes them back in one", () => {
    setup(["add-group", "pk", "--title", "Parkable"]);
    for (const id of ids) setup(["add-unit", id, "--title", `Park ${id.slice(3).toUpperCase()}`]);
    const before = commits();
    const out = ok(["park", "pk/a", "pk/b", "pk/c", "--why", "after the playtest"]);
    assert.equal(commits(), before + 1);
    has(out, "parked 3 units");
    for (const id of ids.slice(0, 3)) assert.equal(state(id), "parked");
    assert.equal(state("pk/d"), "ready");
    assert.equal(ok(["log", "-n", "100"]).split("\n").filter((l) => l.includes("parked: after the playtest")).length, 3);
    const mid = commits();
    has(ok(["unpark", "pk/a", "pk/b"]), "back to work");
    assert.equal(commits(), mid + 1);
    assert.equal(state("pk/a"), "ready");
    assert.equal(state("pk/c"), "parked");
    ok(["unpark", "pk/c"]);
  });
  test("one bad ID among three leaves all three as they were", () => {
    const before = commits();
    const r = run(["park", "pk/a", "pk/nope", "pk/b", "--why", "later"]);
    assert.equal(r.code, 2);
    has(r.stderr, "pk/nope");
    has(r.stderr, "Nothing was written");
    assert.equal(commits(), before);
    assert.equal(state("pk/a"), "ready");
    assert.equal(state("pk/b"), "ready");
  });
  test("a unit in progress or already dropped is named with the rest, and nothing is written", () => {
    ok(["claim", "pk/c"], { FACTORY_TAG: "other" });
    ok(["drop", "pk/d", "--why", "gone"]);
    const before = commits();
    const r = run(["park", "pk/a", "pk/c", "pk/d", "--why", "later"]);
    assert.equal(r.code, 2);
    has(r.stderr, "Park C (pk/c)");
    has(r.stderr, "Park D (pk/d)");
    hasnt(r.stderr, "Park A");
    assert.equal(commits(), before);
    assert.equal(state("pk/a"), "ready");
    ok(["reopen", "pk/c"]);
  });
  test("unpark: a unit that isn't parked is named with the rest, and nothing is written", () => {
    ok(["park", "pk/a", "--why", "later"]);
    const before = commits();
    const r = run(["unpark", "pk/a", "pk/b"]);
    assert.equal(r.code, 2);
    has(r.stderr, "Park B (pk/b)");
    assert.equal(commits(), before);
    assert.equal(state("pk/a"), "parked");
    ok(["unpark", "pk/a"]);
  });
  test("a selector says how many and which groups; --dry-run writes nothing", () => {
    const before = commits();
    const out = ok(["park", "group:pk", "--why", "later", "--dry-run"]);
    has(out, "3 units in Parkable (pk)");
    assert.equal(commits(), before);
    assert.equal(state("pk/a"), "ready");
    const real = ok(["park", "group:pk", "--why", "later"]);
    has(real, "3 units in Parkable (pk)");
    assert.equal(commits(), before + 1);
    has(ok(["unpark", "group:pk", "--dry-run"]), "3 units in Parkable (pk)");
    assert.equal(state("pk/a"), "parked");
  });
  test("one ID behaves as before", () => {
    const before = commits();
    ok(["unpark", "pk/a"]);
    assert.equal(commits(), before + 1);
    has(ok(["park", "pk/a", "--why", "again"]), "parked Park A (pk/a). `just tracker unpark pk/a` brings it back.");
    assert.equal(run(["park", "pk/nope", "--why", "x"]).code, 2);
    assert.equal(run(["park", "pk/b"]).code, 2);
    assert.equal(run(["unpark", "pk/d"]).code, 2);
  });
});
