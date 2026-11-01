// The tracker CLI end to end: what a lane is offered on this machine: resources and hosts, wait
// or stop when nothing's workable, the locks lanes on one machine share, units on branches, a
// lane's own units, and busy groups. Run: node --test tracker/test/
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { trackerRepo, has, hasnt, until } from "../../test/lib/index.ts";

const f = trackerRepo("repo", { FACTORY_TAG: "worker1", FACTORY_EVIDENCE_MIN: "0" });
const { t, ok, setup } = f;
setup(["init", "--title", "Test port"]);

// A lock another lane holds: flock in a process group of its own, holding it until released.
function hold(file: string): Promise<() => void> {
  return new Promise((resolve, reject) => {
    const p = spawn("flock", ["-o", file, "sh", "-c", "echo held; exec sleep 600"], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    p.on("error", reject);
    p.stdout.on("data", (d) => { if (String(d).includes("held")) resolve(() => { try { process.kill(-p.pid!, "SIGKILL"); } catch { /* gone */ } }); });
  });
}
// Whether a group is a word of `tracker busy`'s output.
const busyHas = (out: string, g: string) => out.split(/\s+/).includes(g);

describe("resources and hosts", () => {
  test("busy resource reported", () => {
    f.edit("tracker/project.json", (p) => { p.resources = { editor: { title: "the level editor", free: { cmd: "test ! -e busy" } } }; });
    setup(["add-group", "pipe", "--title", "Pipeline"]);
    setup(["add-unit", "pipe/gui", "--title", "Click through the editor", "--uses", "editor"]);
    f.write("busy", "");
    has(ok(["status"]), "Waiting for a resource: 1 unit (the level editor)");
  });
  test("free resource is workable", () => {
    fs.rmSync(f.at("busy"));
    has(ok(["next"]), "Click through the editor");
  });
  test("other machine's unit skipped", () => {
    setup(["edit", "pipe/gui", "--host", "otherbox"]);
    has(t(["next"], {}, { merged: true }).stdout, "for another machine");
  });
  // --skip-uses: units using those resources aren't taken (the loop keeps them free for CI), and
  // count as moving, so a lane waits for them instead of stopping.
  test("next --skip-uses skips units using it, and says wait", () => {
    setup(["edit", "pipe/gui", "--host", "none"]);
    setup(["add-group", "edq", "--title", "Editor queue"]); setup(["add-unit", "edq/one", "--title", "Needs the editor", "--uses", "editor"]);
    const out = t(["next", "--group", "edq", "--skip-uses", "editor", "--json"]).stdout;
    const j = JSON.parse(out);
    assert.equal([j.code, j.wait].join(","), "1,true", out);
  });
  test("saying why", () => { has(t(["next", "--group", "edq", "--skip-uses", "editor", "--json"]).stdout, "1 unit using the level editor, which this lane keeps free for CI"); });
  test("other resources don't hold it back", () => {
    has(ok(["next", "--group", "edq", "--skip-uses", "desk,other", "--json"]), '"id":"edq/one"');
  });
  after(() => {
    setup(["drop", "edq/one", "--why", "test"]);
    // As in the bash suite, where it was dropped before the next section: nothing else workable.
    setup(["drop", "pipe/gui", "--why", "not needed"]);
  });
});

// --skip-groups (the loop's last call): units of those groups aren't taken, and count as moving
// only while the group's CI is running, due or stale; then the lane stops.
describe("next --skip-groups holds back a group's units while its CI may still run", () => {
  test("a group whose CI is stale: held back, and wait", () => {
    f.edit("tracker/project.json", (p) => { p.ci = { steps: { lc: { cmd: "true" } } }; });
    setup(["add-group", "skg", "--title", "Skip test", "--ci", "lc"]);
    setup(["add-unit", "skg/one", "--title", "Skip one"]); setup(["done", "skg/one", "--evidence", "x"]);
    setup(["add-unit", "skg/two", "--title", "Skip two"]);
    const out = t(["next", "--group", "skg", "--skip-groups", "skg", "--json"]).stdout, j = JSON.parse(out);
    assert.equal([j.code, j.wait].join(","), "1,true", out);
  });
  test("saying why", () => { has(t(["next", "--group", "skg", "--skip-groups", "skg", "--json"]).stdout, "1 unit of Skip test or on its data, held back"); });
  test("without it, the unit is offered", () => { has(ok(["next", "--group", "skg", "--json"]), '"id":"skg/two"'); });
  test("its CI passed, and the rest waits on the owner: exit 3, no wait, and the stop says so", () => {
    setup(["add-unit", "skg/q", "--title", "Skip question"]);
    setup(["ask", "--title", "Is a held-back group allowed a gate before its CI?", "--context", "x", "--option", "a|A|x", "--option", "b|B|y", "--default", "a", "--blocks", "skg/q"]);
    setup(["ci-start", "skg", "--force"]); setup(["ci-pass", "skg", "--evidence", "x"]);
    const r = t(["next", "--group", "skg", "--skip-groups", "skg", "--json"]), j = JSON.parse(r.stdout);
    assert.equal([r.code, j.wait].join(","), "3,false", r.stdout);
    has(r.stdout, "1 unit waiting on you");
  });
  test("one waiting for a busy resource, its CI passed: held back, no wait", () => {
    setup(["edit", "skg/two", "--uses", "editor"]);
    f.write("busy", "");
    const r = t(["next", "--group", "skg", "--skip-groups", "skg", "--json"]), j = JSON.parse(r.stdout);
    fs.rmSync(f.at("busy"));
    assert.equal(j.wait, false, r.stdout);
    has(r.stdout, "1 unit of Skip test or on its data, held back");
  });
  after(() => { for (const u of ["skg/two", "skg/q"]) setup(["drop", u, "--why", "test"]); });
});

describe("nothing to do: wait while other work moves, stop when only the owner is left", () => {
  test("nothing here but another machine's unit: wait", () => {
    setup(["add-group", "wt", "--title", "Waiting test"]);
    setup(["add-unit", "wt/elsewhere", "--title", "Done on another box", "--host", "otherbox"]);
    setup(["add-unit", "wt/q", "--title", "Needs the owner"]);
    setup(["ask", "--title", "Which way should the waiting test go?", "--context", "x", "--option", "a|A|x", "--option", "b|B|y", "--default", "a", "--blocks", "wt/q"]);
    has(t(["next", "--json"]).stdout, '"wait":true');
  });
  test("with exit 1, not 3", () => { assert.equal(t(["next"]).code, 1); });
  test("only the owner's question left: exit 3", () => {
    setup(["drop", "wt/elsewhere", "--why", "test"]);
    assert.equal(t(["next"]).code, 3);
  });
  test("and no wait", () => {
    has(t(["next", "--json"]).stdout, '"wait":false');
  });
  after(() => {
    setup(["drop", "wt/q", "--why", "test"]);
    setup(["withdraw", f.json("tracker/questions.json").questions.at(-1).id, "--why", "test"]);
  });
});

describe("lanes on one machine: a unit or resource another lane holds is skipped", () => {
  const LOCKS = path.join(f.top, "locks");
  const L = { FACTORY_LOCKS: LOCKS };
  let release7 = () => {}, release8 = () => {};
  after(() => { release7(); release8(); });
  test("a unit another lane holds is skipped", async () => {
    fs.mkdirSync(LOCKS);
    setup(["add-unit", "wt/one", "--title", "Lane test one"], L);
    setup(["add-unit", "wt/two", "--title", "Lane test two", "--uses", "editor"], L);
    release7 = await hold(path.join(LOCKS, "unit-wt__one.lock"));
    has(ok(["next"], L), "Lane test two");
  });
  test("and a held resource is busy, so wait", async () => {
    release8 = await hold(path.join(LOCKS, "res-editor.lock"));
    has(t(["next", "--json"], L).stdout, '"wait":true');
  });
  test("an interrupted unit whose resource is held waits too", () => {
    f.edit("tracker/groups/wt.json", (g) => {
      g.units.find((u: { id: string }) => u.id === "wt/two").record = { state: "claimed", by: "dead", host: "testhost", pid: 999999, start: "1", at: "2026-10-10T00:00:00Z" };
    });
    has(t(["next", "--json"], L).stdout, '"wait":true');
  });
  test("locks released: the interrupted unit goes first", () => {
    release7(); release8();
    has(ok(["next"], L), "Lane test two");
  });
  test("but not with --skip-uses for its resource (last call)", () => { has(ok(["next", "--skip-uses", "editor"], L), "Lane test one"); });
  test("locks released: back to the first", () => {
    setup(["reopen", "wt/two"], L);
    has(ok(["next"], L), "Lane test one");
  });
  after(() => {
    setup(["drop", "wt/one", "--why", "test"]); setup(["drop", "wt/two", "--why", "test"]);
  });
});

describe("branches: done on a branch is \"merging\" until the loop says it's on main", () => {
  const B = { FACTORY_BRANCHES: "1", FACTORY_TAG: "brtag" };
  test("a claim on a branch records it", () => {
    setup(["add-group", "br", "--title", "Branches"]);
    setup(["add-unit", "br/one", "--title", "Branch unit one"]);
    setup(["add-unit", "br/two", "--title", "Branch unit two", "--needs", "br/one"]);
    ok(["claim", "br/one"], B);
    has(ok(["state", "br/one", "--branch"]), "unit/br/one");
  });
  test("done on a branch shows as merging", () => {
    ok(["done", "br/one", "--evidence", "on the branch"], B);
    has(ok(["state", "br/one"]), "merging");
  });
  test("and what needs it waits", () => { has(ok(["show", "br/two"]), "can't start until Branch unit one (br/one)"); });
  test("merged: done", () => {
    ok(["merged", "--branch", "unit/br/one"]);
    has(ok(["state", "br/one"]), "done");
  });
  test("and what needs it is ready", () => { has(ok(["state", "br/two"]), "ready"); });
});

describe("landing: the lane that worked a unit lands it while it lives; then any lane may, one at a time", () => {
  // Lane 1's loop, alive until killed; this test's own process is the lane asking (FACTORY_PID).
  const lane1 = spawn("sleep", ["600"], { stdio: "ignore" });
  const L1 = { FACTORY_BRANCHES: "1", FACTORY_TAG: "l1", FACTORY_PID: String(lane1.pid), FACTORY_ACTOR: "loop" };
  const rec = () => f.json(path.join(ok(["dir"]).trim().replace(f.dir + "/", ""), "groups/ld.json")).units.find((u: any) => u.id === "ld/one").record;
  after(() => { lane1.kill("SIGKILL"); });
  test("done on a branch: the lane that worked it holds its landing", () => {
    setup(["add-group", "ld", "--title", "Landing"]);
    setup(["add-unit", "ld/one", "--title", "Landing unit one"]);
    ok(["claim", "ld/one"], L1);
    ok(["done", "ld/one", "--evidence", "on the branch"], L1);
    assert.equal(rec().landing?.pid, lane1.pid);
  });
  test("  no other lane is offered it while that lane lives", () => { assert.equal(ok(["landing"]), ""); });
  test("  nor once it's pushed (origin's copy is the finished one), while that lane lives", () => {
    ok(["settle", "ld/one", "--pushed"], L1);
    assert.equal(ok(["landing"]), "");
  });
  test("  nor can take it", () => {
    const r = t(["landing", "claim", "unit/ld/one"]);
    assert.equal(r.code, 1);
    has(r.stdout, "unit/ld/one is being landed by session l1 on testhost");
  });
  test("  the lane that holds it can", () => { ok(["landing", "claim", "unit/ld/one"], L1); });
  test("once that lane is gone, any lane is offered it", async () => {
    lane1.kill("SIGKILL");
    await until(() => ok(["landing"]) !== "", "lane 1 is gone");
    assert.equal(ok(["landing"]), "unit/ld/one\tld/one\tLanding unit one\n");
  });
  test("  and takes it", () => {
    ok(["landing", "claim", "unit/ld/one"], { FACTORY_TAG: "l2" });
    assert.equal(rec().landing?.pid, process.pid);
  });
  test("  and then no other lane can", () => {
    const r = t(["landing", "claim", "unit/ld/one"], { FACTORY_TAG: "l3", FACTORY_PID: "1" });
    assert.equal(r.code, 1);
    has(r.stdout, "being landed by session l2");
  });
  test("merged: the landing claim goes with the branch", () => {
    ok(["merged", "--branch", "unit/ld/one"]);
    assert.equal(rec().landing, undefined);
    assert.equal(ok(["landing"]), "");
  });
  test("a branch with nothing waiting to merge needs no claim", () => { ok(["landing", "claim", "unit/ld/none"]); });
  test("one worked on another machine is never offered here, nor taken", () => {
    setup(["add-unit", "ld/away", "--title", "Landing unit away"]);
    ok(["claim", "ld/away"], { ...L1, FACTORY_HOST: "otherbox", FACTORY_PID: "1" });
    ok(["done", "ld/away", "--evidence", "on the branch"], { ...L1, FACTORY_HOST: "otherbox", FACTORY_PID: "1" });
    ok(["settle", "ld/away", "--pushed"], { FACTORY_HOST: "otherbox" });
    assert.equal(ok(["landing"], { FACTORY_LEASE_STALE: "0" }), "");
    const r = t(["landing", "claim", "unit/ld/away"], { FACTORY_LEASE_STALE: "0" });
    assert.equal(r.code, 1);
    has(r.stdout, "was worked on otherbox");
  });
});

describe("a unit filed for one lane is offered to that lane only", () => {
  test("another lane isn't offered a lane's unit", () => {
    setup(["add-group", "merge", "--title", "Merges"]);
    setup(["add-unit", "merge/x", "--title", "Merge main on box lane 1", "--lane", "box/1"]);
    hasnt(t(["next", "--json", "--group", "merge"], { FACTORY_LANE: "box/2" }).stdout, "merge/x");
  });
  test("its own lane is", () => {
    has(t(["next", "--json", "--group", "merge"], { FACTORY_LANE: "box/1" }).stdout, "merge/x");
  });
  after(() => {
    setup(["drop", "merge/x", "--why", "test"]);
  });
});

describe("the slow-check tag shows on the card", () => {
  test("a slow check says so on the card", () => {
    setup(["edit", "br/two", "--tags", "slow-check"]);
    has(ok(["show", "br/two"]), "Its own check is slow");
  });
});

describe("busy: groups with outputs on this machine that aren't on main yet (lanes there share work/)", () => {
  let out = "";
  test("busy: a unit in progress here", () => {
    for (const g of ["qa", "qb", "qc"]) { setup(["add-group", g, "--title", `Busy ${g}`]); setup(["add-unit", `${g}/a`, "--title", "Busy unit"]); }
    setup(["claim", "qa/a"], { FACTORY_TAG: "lane1" });
    setup(["claim", "qb/a"], { FACTORY_HOST: "elsewhere", FACTORY_TAG: "far" });
    setup(["claim", "qc/a"], { FACTORY_BRANCHES: "1", FACTORY_TAG: "lane2" });
    setup(["done", "qc/a", "--evidence", "on its branch"], { FACTORY_BRANCHES: "1", FACTORY_TAG: "lane2" });
    out = ok(["busy"], { FACTORY_TAG: "other" });
    assert.ok(busyHas(out, "qa"), `busy: ${out}`);
  });
  test("not one claimed on another machine", () => { assert.ok(!busyHas(out, "qb"), `busy: ${out}`); });
  test("a unit finished here whose branch isn't on main yet", () => { assert.ok(busyHas(out, "qc"), `busy: ${out}`); });
  test("never the caller's own unit", () => { const o = ok(["busy"], { FACTORY_TAG: "lane1" }); assert.ok(!busyHas(o, "qa"), `busy: ${o}`); });
  test("nor --except's", () => { const o = ok(["busy", "--except", "qc/a"], { FACTORY_TAG: "other" }); assert.ok(!busyHas(o, "qc"), `busy: ${o}`); });
  test("once its branch is on main, not busy", () => {
    setup(["merged", "--branch", "unit/qc/a"]);
    const o = ok(["busy"], { FACTORY_TAG: "other" });
    assert.ok(!busyHas(o, "qc"), `busy: ${o}`);
  });
  // a unit that works in another group's data makes that group busy too
  test("a unit working in another group's data: its own group", () => {
    for (const g of ["qa", "qb", "qc"]) setup(["drop", `${g}/a`, "--why", "test"]);
    f.edit("tracker/project.json", (p) => { p.store = { remote: "/nowhere" }; });
    setup(["add-group", "qd", "--title", "Busy qd", "--data", "mod=1"]); setup(["add-group", "qe", "--title", "Busy qe"]);
    setup(["add-unit", "qe/a", "--title", "Busy unit", "--data", "qd"]);
    f.edit("tracker/groups/qe.json", (g) => { g.units[0].record = { state: "claimed", by: "lane1", host: "testhost", at: new Date().toISOString().replace(/\.\d+Z$/, "Z") }; });
    out = ok(["busy"], { FACTORY_TAG: "other" });
    assert.ok(busyHas(out, "qe"), `busy: ${out}`);
  });
  test("and the data's group", () => {
    assert.ok(busyHas(out, "qd"), `busy: ${out}`);
  });
  after(() => {
    setup(["drop", "qe/a", "--why", "test"]); setup(["edit", "qe/a", "--data", "default"]); setup(["edit-group", "qd", "--data", "none"]);
    f.edit("tracker/project.json", (p) => { delete p.store; });
  });
});

describe("add-group --host, edit-group --needs", () => {
  test("add-group --host pins the group", () => {
    ok(["add-group", "hg", "--title", "Pinned group", "--host", "otherbox"]);
    assert.equal(f.json("tracker/groups/hg.json").host, "otherbox");
  });
  test("its units run on that machine", () => {
    setup(["add-unit", "hg/a", "--title", "Pinned unit"]);
    has(ok(["show", "hg/a"]), "Machine: otherbox");
  });
  test("status <group> says so", () => { has(ok(["status", "hg"]), "[runs on otherbox]"); });
  test("and aren't offered here", () => { has(t(["next", "--group", "hg"], {}, { merged: true }).stdout, "1 unit for another machine"); });
  test("edit-group --needs sets the group's needs", () => {
    setup(["add-group", "hn", "--title", "Needs group"]); setup(["add-unit", "hn/a", "--title", "Waits for the pin"]);
    ok(["edit-group", "hn", "--needs", "hg/a"]);
    assert.equal(JSON.stringify(f.json("tracker/groups/hn.json").needs), '["hg/a"]');
  });
  test("every unit of the group waits for them", () => { has(ok(["show", "hn/a"]), "can't start until Pinned unit (hg/a) is done"); });
  test("an unknown unit is refused", () => { assert.equal(t(["edit-group", "hn", "--needs", "hg/nope"]).code, 2); });
  test("done or dropped, they're met", () => {
    setup(["drop", "hg/a", "--why", "test"]);
    has(ok(["state", "hn/a"]), "ready");
  });
  after(() => {
    setup(["drop", "hn/a", "--why", "test"]);
  });
});

describe("review-fix: the loop's review asks for fixes; back to ready on the branch, stuck the second time", () => {
  const B = { FACTORY_BRANCHES: "1", FACTORY_TAG: "rvtag" };
  const long = "x.ts:1: " + "the reason is long ".repeat(30);
  test("a unit done on a branch, its review asking for fixes: ready again", () => {
    setup(["add-group", "rv", "--title", "Reviews"]);
    setup(["add-unit", "rv/one", "--title", "Reviewed unit one"]);
    ok(["claim", "rv/one"], B);
    ok(["done", "rv/one", "--evidence", "on the branch"], B);
    has(ok(["review-fix", "unit/rv/one", "--findings", `- ${long}`], { FACTORY_ACTOR: "loop" }), "Reviewed unit one (rv/one) → ready, on its branch");
    assert.equal(ok(["state", "rv/one"]), "ready\n");
  });
  test("  the findings whole on its card, and a note within a note's length", () => {
    const card = ok(["show", "rv/one"]);
    has(card, "The loop's review asked for these fixes before it lands");
    has(card, long.trim());
    const note = card.split("\n").find((l) => l.includes("The loop's review asked for fixes before landing"))!;
    assert.ok(note && note.length < 340, note);
  });
  test("  a second time: stuck, for the overseer", () => {
    ok(["claim", "rv/one"], B);
    ok(["done", "rv/one", "--evidence", "on the branch"], B);
    has(ok(["review-fix", "unit/rv/one", "--findings", "- still wrong"]), "→ stuck");
    has(ok(["state", "rv/one"]), "stuck");
    has(ok(["show", "rv/one"]), "asked for fixes a second time");
  });
  test("  reopened by hand: two more rounds", () => {
    ok(["reopen", "rv/one"]);
    ok(["claim", "rv/one"], B);
    ok(["done", "rv/one", "--evidence", "on the branch"], B);
    has(ok(["review-fix", "unit/rv/one", "--findings", "- once more"]), "→ ready");
  });
  test("  landed: what it asked for goes with the branch, and the count starts afresh", () => {
    ok(["claim", "rv/one"], B);
    ok(["done", "rv/one", "--evidence", "on the branch"], B);
    ok(["merged", "--branch", "unit/rv/one"]);
    hasnt(ok(["show", "rv/one"]), "The loop's review asked for these fixes");
    ok(["reopen", "rv/one"]);
    ok(["claim", "rv/one"], B);
    ok(["done", "rv/one", "--evidence", "on the branch"], B);
    has(ok(["review-fix", "unit/rv/one", "--findings", "- a new round"]), "→ ready");
  });
  test("a merge unit's branch: the unit whose work it is goes back, and the merge unit is done with it", () => {
    setup(["add-unit", "rv/two", "--title", "Reviewed unit two"]);
    ok(["claim", "rv/two"], B);
    ok(["done", "rv/two", "--evidence", "on the branch"], B);
    t(["add-group", "merge", "--title", "Merges"]);   // (an earlier test may have made it)
    setup(["add-unit", "merge/m", "--title", "Merge main on a lane", "--branch", "unit/rv/two"]);
    ok(["claim", "merge/m"], B);
    ok(["done", "merge/m", "--evidence", "merged"], B);
    assert.equal(ok(["state", "merge/m"]), "merging\n");
    ok(["review-fix", "unit/rv/two", "--findings", "- fix it"]);
    assert.equal(ok(["state", "rv/two"]), "ready\n");
    assert.equal(ok(["state", "merge/m"]), "done\n");
  });
  test("nothing waiting to merge on the branch: refused", () => {
    assert.notEqual(t(["review-fix", "unit/rv/none", "--findings", "- x"]).code, 0);
  });
});
