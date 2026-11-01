// The tracker CLI end to end: a group another session on this machine is working on now. Lanes
// here share work/, so `next` takes no unit working on that group's data, and the group's CI
// waits (rather than fails) while the session lives; `busy --live` names those groups. A claim
// whose session is gone holds nothing. Run: node --test tracker/test/
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { trackerRepo, has, hasnt } from "../../test/lib/index.ts";

const f = trackerRepo("repo", { FACTORY_TAG: "lb", FACTORY_EVIDENCE_MIN: "0", FACTORY_LEASES: "1" });
const { t, ok, setup } = f;
setup(["init", "--title", "Held here"]);
const json = (args: string[], add = {}) => JSON.parse(t(args, add).stdout);
// A claim's session gone: its pid no longer the process it was.
const kill = (g: string, id: string) => f.edit(`tracker/groups/${g}.json`, (j) => { const u = j.units.find((x: { id: string }) => x.id === id); u.record.pid = 999999; u.record.start = "1"; });

describe("next: a unit on data another session here is working on", () => {
  test("setup: a group with data, leased here", () => {
    f.edit("tracker/project.json", (p) => { p.store = { remote: "store:/s", paths: { out: "work/out/{group}" } }; p.ci = { steps: { drill: { cmd: "true" } } }; });
    setup(["add-group", "mar", "--title", "Marble", "--data", "mod=1"]);
    for (const x of ["a", "b", "c"]) setup(["add-unit", `mar/${x}`, "--title", `Marble unit ${x}`]);
    setup(["add-group", "fx", "--title", "Effects"]);
    setup(["add-unit", "fx/e", "--title", "Effects on Marble's data", "--data", "mar"]);
    setup(["add-unit", "fx/code", "--title", "Effects code only"]);
    setup(["lease", "take", "mar"]);
    setup(["claim", "mar/a"], { FACTORY_TAG: "la" });
  });
  test("another lane's live claim holds the group's other units", () => {
    const j = json(["next", "--json"]);
    assert.equal(j.id, "fx/code", JSON.stringify(j));
  });
  test("and a unit of another group working on its data", () => {
    setup(["claim", "fx/code"], { FACTORY_TAG: "lc" });
    const j = json(["next", "--json"]);
    assert.equal([j.code, j.wait].join(","), "1,true", JSON.stringify(j));
  });
  test("saying which session holds it", () => {
    has(t(["next", "--json"]).stdout, "3 units working on Marble's data, which session la here (Marble unit a (mar/a)) is working on");
  });
  test("busy --live names the group", () => { assert.deepEqual(ok(["busy", "--live"]).trim().split(" "), ["fx", "mar"]); });
  test("but not to the session that holds it", () => { assert.deepEqual(ok(["busy", "--live"], { FACTORY_TAG: "la" }).trim().split(" "), ["fx"]); });
  test("a claim on another machine holds nothing here", () => {
    // (As a merge of another machine's write could leave it: the lease is this machine's.)
    const was = f.read("tracker/groups/mar.json");
    f.edit("tracker/groups/mar.json", (j) => { j.units[0].record.host = "otherbox"; });
    const id = json(["next", "--json"]).id;
    f.write("tracker/groups/mar.json", was);
    assert.equal(id, "mar/b");
  });
  test("a claim whose session is gone holds nothing", () => {
    kill("mar", "mar/a");
    // (The interrupted unit comes back first.)
    assert.equal(json(["next", "--json"]).id, "mar/a");
  });
  test("busy still counts it, busy --live doesn't", () => {
    assert.ok(ok(["busy"]).split(/\s+/).includes("mar"));
    assert.ok(!ok(["busy", "--live"]).split(/\s+/).includes("mar"));
  });
});

describe("CI: waits while a session here works on the group", () => {
  test("setup: CI due, with work left", () => {
    // ci_every a moment: CI stale with work left comes due at once.
    f.edit("tracker/project.json", (p) => { p.ci_every = 0.001; });
    setup(["edit-group", "mar", "--ci", "drill"]);
    setup(["claim", "mar/b"]); setup(["done", "mar/b", "--evidence", "made"]);
    setup(["claim", "mar/a"], { FACTORY_TAG: "la" });
    has(ok(["ci", "mar"]), "due:");
  });
  test("ci-next waits, naming the session", () => {
    const j = json(["ci-next", "--json"]);
    assert.equal([j.code, j.wait].join(","), "1,true", JSON.stringify(j));
    has(j.why, "Marble (waiting for Marble unit a (mar/a), which session la here is working on)");
  });
  test("ci-next --claim takes nothing", () => {
    assert.equal(t(["ci-next", "--claim", "--json"]).code, 1);
    hasnt(ok(["ci", "mar"]), "running");
  });
  test("the group's new units still wait for its CI", () => { hasnt(t(["next", "--json"]).stdout, '"id":"mar/c"'); });
  test("once the session is gone, CI runs", () => {
    kill("mar", "mar/a");
    assert.equal(json(["ci-next", "--json"]).group, "mar");
  });
  test("a live unit of another group on its data holds it too", () => {
    setup(["unclaim", "fx/code"], { FACTORY_TAG: "lc" });
    setup(["claim", "fx/e"], { FACTORY_TAG: "lc" });
    has(json(["ci-next", "--json"]).why, "Effects on Marble's data (fx/e), which session lc here is working on");
  });
});
