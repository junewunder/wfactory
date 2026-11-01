// The tracker CLI end to end: group data on a store (data --all), leases by hand, and the
// overseer kept with the leases. Run: node --test tracker/test/
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { trackerRepo, has } from "../../test/lib/index.ts";

const f = trackerRepo("repo", { FACTORY_TAG: "worker1", FACTORY_EVIDENCE_MIN: "0" });
const { t, ok, setup } = f;
setup(["init", "--title", "Leases"]);
// The lines of `lease mine`, as `paste -sd,` joins them.
const mine = (...args: string[]) => ok(["lease", "mine", ...args]).replace(/\n+$/, "").split("\n").join(",");
const holder = (g: string) => ok(["lease", "holder", g]).replace(/\n+$/, "");
const line = (text: string, has: string) => text.split("\n").filter((l) => l.includes(has)).join("\n");

describe("leases by hand: --all, --force, --why; unclaim --release-lease; data --all", () => {
  let data: { remote: string; groups: { group: string; paths: unknown; inputs: unknown }[] };
  test("data --all: the store", () => {
    f.edit("tracker/project.json", (p) => {
      p.store = { remote: "store:/s", paths: { out: "work/out/{group}", mod: "mods/{mod}" }, inputs: { game: { local: "/g", parts: { pak: "paks/{mod}" } } }, reads: ["game:pak"] };
    });
    setup(["add-group", "la", "--title", "Lease A", "--data", "mod=11"]); setup(["add-unit", "la/u", "--title", "Lease A unit"]);
    setup(["add-group", "lb", "--title", "Lease B", "--data", "mod=12"]); setup(["add-unit", "lb/u", "--title", "Lease B unit"]);
    setup(["add-group", "lc", "--title", "Lease C", "--data", "mod=13"]);
    data = JSON.parse(ok(["data", "--all"]));
    assert.equal(data.remote, "store:/s");
  });
  test("every group with data, in order", () => { assert.equal(JSON.stringify(data.groups.map((g) => g.group)), '["la","lb","lc"]'); });
  test("each with its paths filled in", () => {
    const pwd = fs.realpathSync(f.dir);
    assert.equal(JSON.stringify(data.groups[0].paths), `[{"name":"out","local":"${pwd}/work/out/la"},{"name":"mod","local":"${pwd}/mods/11"}]`);
  });
  test("and the inputs it reads", () => {
    assert.equal(JSON.stringify(data.groups[0].inputs), '[{"input":"game","part":"pak","rel":"paks/11","local":"/g/paks/11"}]');
  });
  test("rebuilt add: a glob over a data path, with why; listed", () => {
    has(ok(["rebuilt", "add", "out/*.lua", "--why", "lua-install remakes them"]), "store.rebuilt += out/*.lua");
    has(ok(["rebuilt", "add", "out/*.lua", "--why", "again"]), "already in store.rebuilt");
    assert.equal(ok(["rebuilt"]), "out/*.lua\n");
    has(ok(["data", "la"]), '"rebuilt":["out/*.lua"]');
    has(ok(["log", "-n", "1"]), "lua-install remakes them");
  });
  test("rebuilt add refuses no why, another folder, everything", () => {
    assert.notEqual(t(["rebuilt", "add", "out/x"]).code, 0);
    has(t(["rebuilt", "add", "elsewhere/x", "--why", "w"]).stderr, "not a data path name");
    has(t(["rebuilt", "add", "*/*", "--why", "w"]).stderr, "every file");
    has(t(["rebuilt", "add", "out/../x", "--why", "w"]).stderr, "isn't a path inside");
    has(ok(["rebuilt", "add", "*.bin", "--why", "any path's caches"]), "store.rebuilt += *.bin");
  });
  test("FACTORY_STORE overrides the remote", () => { has(ok(["data", "--all"], { FACTORY_STORE: "elsewhere:/x" }), '"remote":"elsewhere:/x"'); });
  test("lease mine: this machine's", () => {
    setup(["lease", "take", "la"], { FACTORY_TAG: "la1" }); setup(["lease", "take", "lb"]);
    setup(["lease", "take", "lc"], { FACTORY_HOST: "otherbox" });
    assert.equal(mine(), "la,lb");
  });
  test("live ones only", () => {
    f.edit("tracker/leases.json", (L) => { L.leases.find((l: { id: string }) => l.id === "lb").beat = "2026-01-01T00:00:00Z"; });
    assert.equal(mine(), "la");
  });
  test("--all: stale ones too", () => { assert.equal(mine("--all"), "la,lb"); });
  test("leases marks a stale one", () => { has(line(ok(["leases"]), "(lb)"), "Lease B (lb): testhost, taken"); });
  test("as stale", () => { has(line(ok(["leases"]), "(lb)"), "(stale: another machine may take it over)"); });
  test("release refuses another machine's lease", () => { assert.equal(t(["lease", "release", "lc"]).code, 2); });
  test("saying how", () => { has(t(["lease", "release", "lc"], {}, { merged: true }).stdout, "--force releases another machine's"); });
  test("(no holder now)", () => {
    setup(["lease", "release", "lc", "--force", "--why", "otherbox is gone for good"]);
    assert.equal(holder("lc"), "");
  });
  test("--why goes in the log, with whose it was", () => { has(ok(["log", "-n", "1"]), "Lease C: released by testhost (it was otherbox's): otherbox is gone for good"); });
  // A lease an earlier claim took stays when a later claim is given back, unless --release-lease.
  test("unclaim keeps a lease another session took", () => {
    setup(["claim", "la/u"], { FACTORY_LEASES: "1", FACTORY_TAG: "la2" });
    ok(["unclaim", "la/u"], { FACTORY_TAG: "la2" });
    has(holder("la"), "testhost");
  });
  test("--release-lease releases it", () => {
    setup(["claim", "la/u"], { FACTORY_LEASES: "1", FACTORY_TAG: "la2" });
    ok(["unclaim", "la/u", "--release-lease"], { FACTORY_TAG: "la2" });
    assert.equal(holder("la"), "");
  });
  test("saying why", () => { has(ok(["log", "-n", "1"]), "Lease A: released by testhost: no room here for its data"); });
  test("and the unit is ready again", () => { has(ok(["state", "la/u"]), "ready"); });
  test("lease release --all: every lease of this machine's", () => {
    setup(["claim", "la/u"], { FACTORY_LEASES: "1" });
    setup(["lease", "take", "lb"]);
    ok(["lease", "release", "--all"]);
    assert.equal(ok(["lease", "mine", "--all"]).replace(/\n+$/, ""), "");
  });
  after(() => {
    setup(["drop", "la/u", "--why", "test"]); setup(["drop", "lb/u", "--why", "test"]);
    for (const g of ["la", "lb", "lc"]) setup(["edit-group", g, "--data", "none"]);
    f.edit("tracker/project.json", (p) => { delete p.store; });
  });
});

describe("the overseer: the newest thread to take it wins, and it's kept with the leases", () => {
  test("overseer: none before the first", () => { has(ok(["overseer"]), "none"); });
  test("overseer take: this thread oversees", () => { has(ok(["overseer", "take", "th1"]), "overseer: th1 on testhost"); });
  test("shown, with its machine", () => { has(ok(["overseer"]), "th1 on testhost, since"); });
  test("kept in leases.json", () => { has(f.read("tracker/leases.json"), '"id": "th1"'); });
  test("a newer one replaces it, saying which it was", () => {
    has(ok(["overseer", "take", "th2", "--machine", "otherbox", "--json"]), '"was":{"id":"th1","host":"testhost"');
  });
  test("and is the one now", () => { has(ok(["overseer", "--json"]), '"id":"th2","host":"otherbox"'); });
  test("logged", () => { has(ok(["log", "-n", "1"]), "overseer th2 on otherbox attached, replacing th1 on testhost"); });
  test("a take with no id is refused", () => { assert.equal(t(["overseer", "take"]).code, 2); });
  test("and so is an id that isn't a plain word", () => { assert.equal(t(["overseer", "take", "a b"]).code, 2); });
});
