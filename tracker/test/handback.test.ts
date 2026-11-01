// The tracker CLI end to end: a session giving its unit back (`unclaim`). One that did work
// (commits since its claim, changes in its tree, its group's data written) hands the unit back
// with that work kept: it shows by its needs and resources, not as interrupted, the loop's settle
// leaves it so, and whoever claims it next picks up after it. One that did nothing gives it back
// unstarted; the loop's own give-back before a session (--unstarted) is as it was.
// Run: node --test tracker/test/
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { trackerRepo, has, hasnt, sleep } from "../../test/lib/index.ts";

const f = trackerRepo("repo", { FACTORY_TAG: "s1", FACTORY_EVIDENCE_MIN: "0" });
const { t, ok, setup } = f;
setup(["init", "--title", "Handing back"]);
const state = (id: string, add = {}) => ok(["state", id], add).trim();
const rec = (g: string, id: string) => f.json(`tracker/groups/${g}.json`).units.find((u: { id: string }) => u.id === id).record;
const logOf = (id: string) => f.read("tracker/log.jsonl").split("\n").filter((l) => l.includes(`"id":"${id}"`)).join("\n");

describe("unclaim after work: handed back with it kept", () => {
  test("setup", () => {
    f.write(".gitignore", f.read(".gitignore") + "/work/\n");
    f.git("add", "-A", "--", ".", ":!tracker"); f.git("commit", "-q", "-m", "setup");
    f.edit("tracker/project.json", (p) => { p.store = { remote: "store:/s", paths: { out: "work/out/{group}" } }; p.resources = { desk: { title: "the desk", free: { cmd: "test ! -e desk-busy" } } }; });
    setup(["add-group", "h", "--title", "Hand"]);
    for (const x of ["tree", "commit", "none", "dep", "loop"]) setup(["add-unit", `h/${x}`, "--title", `Hand ${x}`, "--uses", "desk"]);
    setup(["add-group", "d", "--title", "Data", "--data", "mod=1"]);
    setup(["add-unit", "d/x", "--title", "Data unit"]);
    setup(["lease", "take", "d"]);
  });
  // (Times are to the second: each claim comes a second after what was written before it, and
  // the session's work a second after the claim.)
  test("a change in its tree: handed back, saying so", async () => {
    f.write(".gitignore", f.read(".gitignore") + "/desk-busy\n"); f.git("commit", "-q", "-am", "ignore");
    fs.writeFileSync(f.at("desk-busy"), "");
    await sleep(1100);
    setup(["claim", "h/tree"]);
    await sleep(1100);
    f.write("made.txt", "work\n");
    has(ok(["unclaim", "h/tree"]), "Hand tree (h/tree): handed back, its work kept (1 file changed in its tree): waiting for the desk to be free.");
  });
  // Until its session ends, the claim holds: no lane takes the unit before the loop has pushed its
  // branch and settled its data.
  test("  while its session runs, it's still in progress: no other lane takes it", () => {
    assert.equal(state("h/tree"), "doing");
    fs.rmSync(f.at("desk-busy"));
    const j = JSON.parse(t(["next", "--json"], { FACTORY_TAG: "other" }).stdout);
    fs.writeFileSync(f.at("desk-busy"), "");
    assert.notEqual(j.id, "h/tree", JSON.stringify(j));
  });
  test("  once its session has ended (the loop's settle), it shows by its resources, not as interrupted", () => {
    ok(["settle", "h/tree"]);
    assert.equal(state("h/tree"), "resource");
  });
  test("  and its card says it was handed back, with no session to resume", () => {
    const c = ok(["show", "h/tree"]);
    has(c, "Handed back: session s1 on testhost gave it back at");
    hasnt(c, "claude --resume");
  });
  test("  the log says so", () => { has(logOf("h/tree"), "Hand tree: handed back by its session, its work kept (1 file changed in its tree); waiting for the desk to be free"); });
  test("  the loop's settle after the session leaves it so", () => {
    ok(["settle", "h/tree"]);
    assert.equal(state("h/tree"), "resource");
    hasnt(logOf("h/tree"), "session ended mid-unit");
  });
  test("  a second unclaim says it's handed back already", () => { has(ok(["unclaim", "h/tree"]), "handed back already"); });
  test("  the next claim picks up after it", () => {
    fs.rmSync(f.at("desk-busy"));
    setup(["claim", "h/tree"], { FACTORY_TAG: "s2" });
    assert.equal(rec("h", "h/tree").resumed, "s1");
    has(logOf("h/tree"), "claimed (picking up after s1)");
    setup(["unclaim", "h/tree", "--unstarted"], { FACTORY_TAG: "s2" });
  });
  test("a commit since the claim: handed back", async () => {
    f.git("add", "made.txt"); f.git("commit", "-q", "-m", "earlier work");
    await sleep(1100);
    setup(["claim", "h/commit"]);
    await sleep(1100);
    f.write("code.txt", "code\n"); f.git("add", "code.txt"); f.git("commit", "-q", "-m", "work");
    has(ok(["unclaim", "h/commit"]), "handed back, its work kept (1 commit on its branch): ready");
    ok(["settle", "h/commit"]);
    assert.equal(state("h/commit"), "ready");
  });
  test("its group's data written since the claim: handed back", async () => {
    fs.mkdirSync(f.at("work/out/d"), { recursive: true });
    f.write("work/out/d/old.bin", "old\n");
    await sleep(1100);
    setup(["claim", "d/x"]);
    await sleep(1100);
    f.write("work/out/d/sub/new.bin", "new\n");
    has(ok(["unclaim", "d/x"]), "handed back, its work kept (Data's data changed)");
  });
  // The data written isn't on the store yet: the loop copies it, then lets the lease go.
  test("  its lease stays", () => { has(ok(["leases"]), "Data (d): testhost"); ok(["settle", "d/x"]); });
  // A second unit the session works on its first one's branch: that one's work isn't this one's.
  test("a second unit on the session's first unit's branch: only commits naming it count", async () => {
    setup(["add-unit", "h/first2", "--title", "Hand first two"]); setup(["add-unit", "h/second", "--title", "Hand second"]);
    const B = { FACTORY_TAG: "s5", FACTORY_BRANCHES: "1" };
    await sleep(1100);
    setup(["claim", "h/first2"], B);
    await sleep(1100);
    f.write("first.txt", "first\n"); f.git("add", "first.txt"); f.git("commit", "-q", "-m", "h/first2: half");
    setup(["claim", "h/second"], B);
    f.write("first.txt", "first, more\n");
    ok(["unclaim", "h/second"], B);
    has(logOf("h/second"), "Hand second: given back unstarted");
    setup(["unclaim", "h/first2", "--unstarted"], B);
  });
  test("nothing done: given back unstarted", async () => {
    await sleep(1100);
    setup(["claim", "h/none"]);
    ok(["unclaim", "h/none"]);
    assert.equal(rec("h", "h/none"), undefined);
    has(logOf("h/none"), "Hand none: given back unstarted");
  });
  // A unit picked up after an interrupted attempt, whose session found it needs other work first
  // and handed it back: waiting on that work, not interrupted (and not to be resumed).
  test("picked up after an earlier attempt, a dependency added: waiting", () => {
    setup(["claim", "h/dep"], { FACTORY_TAG: "s0" });
    f.edit("tracker/groups/h.json", (g) => { const r = g.units.find((u: { id: string }) => u.id === "h/dep").record; r.pid = 999999; r.start = "1"; r.session = "sess-0"; });
    setup(["claim", "h/dep"]);
    setup(["add-unit", "h/first", "--title", "Hand first"]);
    setup(["edit", "h/dep", "--needs", "h/first"]);
    has(ok(["unclaim", "h/dep"]), "handed back, its work kept (an earlier attempt's): can't start until Hand first (h/first) is done");
    ok(["settle", "h/dep"]);
    assert.equal(state("h/dep"), "waiting");
    hasnt(ok(["show", "h/dep"]), "claude --resume");
  });
  test("the loop's give-back before a session (--unstarted) keeps an earlier attempt interrupted", () => {
    setup(["claim", "h/loop"], { FACTORY_TAG: "s0" });
    f.edit("tracker/groups/h.json", (g) => { const r = g.units.find((u: { id: string }) => u.id === "h/loop").record; r.pid = 999999; r.start = "1"; });
    setup(["claim", "h/loop"]);
    f.write("made.txt", "more work\n");
    ok(["unclaim", "h/loop", "--unstarted"]);
    assert.equal(state("h/loop"), "interrupted");
  });
  test("when git can't say, it refuses, naming what to run instead", () => {
    setup(["claim", "h/none"]);
    const r = t(["unclaim", "h/none"], { GIT_DIR: f.at("no-such-git") }, { merged: true });
    assert.equal(r.code, 2, r.stdout);
    has(r.stdout, "isn't given back: that would lose what it did. Leave a note for the next attempt (`just note h/none \"…\"`) and end the session");
    assert.equal(state("h/none"), "doing");
  });
});
