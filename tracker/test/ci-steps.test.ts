// The tracker CLI end to end: group CI's steps and the loop's side of CI: a step's resources as
// it starts or for the whole run, work on a group's data elsewhere, ci-next, caps, ci-fail filing
// ci-fix, a step that ships, and lint of the steps. Run: node --test tracker/test/
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { trackerRepo, has, hasnt, sleep } from "../../test/lib/index.ts";

const f = trackerRepo("repo", { FACTORY_TAG: "worker1", FACTORY_EVIDENCE_MIN: "0" });
const { t, ok, setup } = f;
setup(["init", "--title", "Test port"]);
// What earlier sections of the bash suite left: two CI steps, the editor (busy while ./busy
// exists), some code on main, and the fighter template.
f.edit("tracker/project.json", (p) => {
  p.ci = { steps: { drill: { cmd: "just drill {group}" }, publish: { cmd: "just publish {group}" } } };
  p.resources = { editor: { title: "the level editor", free: { cmd: "test ! -e busy" } } };
});
f.write("code.txt", "code\n"); f.git("add", "code.txt"); f.git("commit", "-q", "-m", "some code");
f.write("tracker/templates/fighter.json", `{ "name": "fighter", "title": "{Name}", "ci": { "steps": ["drill", "publish"] },
  "units": [ { "slug": "rig", "title": "{Name}'s rig" } ] }
`);

// Moves a group's unit records a minute back. Times are to the second, and a unit done in the
// same second as a CI failure counts as finished since it, so CI would read due, not broken.
const backdate = (group: string) => f.edit(`tracker/groups/${group}.json`, (g) => {
  const a = new Date(Date.now() - 60e3).toISOString().replace(/\.\d+Z$/, "Z");
  for (const u of g.units) if (u.record && u.record.at > a) u.record.at = a;
});
const busyOn = () => f.write("busy", "");
const busyOff = () => fs.rmSync(f.at("busy"));
const ciFixUses = () => JSON.stringify(f.json("tracker/groups/lp.json").units.find((u: any) => u.id === "lp/ci-fix").uses ?? null);

// 24 Oct: a run that took the editor only at its publish step waited there up to an hour while its
// lane did nothing. A run takes every step's resources as it starts, and waits before it.
describe("CI takes every resource its steps use as the run starts", () => {
  let out = "";
  test("a later step's busy resource holds back the start of the run", () => {
    f.edit("tracker/project.json", (p) => { Object.assign(p.ci.steps, { pre: { cmd: "true" }, ed: { cmd: "true", uses: ["editor"] } }); });
    setup(["add-group", "cr", "--title", "CI resource", "--ci", "pre,ed"]);
    setup(["add-unit", "cr/a", "--title", "CI resource unit"]); setup(["done", "cr/a", "--evidence", "x"]);
    busyOn();
    out = t(["ci-next", "--json", "--group", "cr"]).stdout;
    has(out, "waiting for the level editor");
  });
  test("  a wait, naming the resource, so a unit that gets it as it frees gives way", () => { has(out, '"wait":true,"uses":["editor"],"start":["editor"]'); });
  test("  CI pinned to another machine keeps nothing free here", () => {
    setup(["edit-group", "cr", "--host", "otherbox"]);
    const o = t(["ci-next", "--json", "--group", "cr"]).stdout;
    setup(["edit-group", "cr", "--host", "none"]);
    has(o, '"start":[]');
  });
  test("  is due all the while", () => { has(ok(["ci"]), "CI resource (cr): due"); });
  test("starts once it's free, taking it as it starts", () => {
    busyOff();
    out = ok(["ci-next", "--json", "--group", "cr"]);
    has(out, '"start":["editor"]');
  });
  test("  each step says what it uses, and nothing of when", () => {
    has(out, '"step":"ed","cmd":"true","ships":false,"uses":["editor"],"caps"');
    hasnt(out, '"hold"'); hasnt(out, '"waited"');
  });
  test("an old run's waited (from before) changes nothing: a run whose steps use nothing starts at once", () => {
    setup(["edit-group", "cr", "--ci", "pre"]);
    f.edit("tracker/groups/cr.json", (g) => { g.ci.waited = ["editor"]; });
    busyOn();
    const o = ok(["ci-next", "--json", "--group", "cr"]);
    busyOff();
    has(o, '"start":[]');
    setup(["edit-group", "cr", "--ci", "pre,ed"]);
  });
  test("lint: hold is gone", () => {
    f.edit("tracker/project.json", (p) => { p.ci.steps.ed.hold = "run"; });
    has(t(["lint"], {}, { merged: true }).stdout, "ci.steps.ed: hold is gone (every CI run takes its steps' resources as it starts); remove it");
  });
  test("  a slip, not broken data: a lane still starts", () => { assert.equal(t(["lint", "--broken"], {}, { merged: true }).code, 0); });
  after(() => {
    f.edit("tracker/project.json", (p) => { delete p.ci.steps.ed.hold; });
    setup(["edit-group", "cr", "--ci", "none"]);
  });
});

describe("a unit in another group that works on a group's data makes its CI stale", () => {
  test("a unit added in another group on its data: stale", () => {
    f.edit("tracker/project.json", (p) => { p.store = { remote: "/nowhere" }; });
    setup(["add-group", "cd", "--title", "CI data group", "--data", "mod=2", "--ci", "drill"]);
    setup(["add-unit", "cd/a", "--title", "CI data unit"]); setup(["done", "cd/a", "--evidence", "x"]);
    setup(["ci-pass", "cd", "--evidence", "ok"]);
    setup(["add-group", "ce", "--title", "Effects roll-out"]);
    setup(["add-unit", "ce/fx", "--title", "Effects for the data group", "--data", "cd"]);
    has(ok(["ci", "cd"]), "stale: Effects for the data group (ce/fx) added since it passed");
  });
  test("finished: due", () => {
    setup(["done", "ce/fx", "--evidence", "x"]);
    has(ok(["ci", "cd"]), "due: Effects for the data group (ce/fx) finished since it passed");
  });
  test("a pass covers it", () => {
    setup(["ci-pass", "cd", "--evidence", "again"]);
    has(ok(["ci", "cd"]), "passed");
  });
  test("reopened: stale", () => {
    setup(["reopen", "ce/fx"]);
    has(ok(["ci", "cd"]), "stale: Effects for the data group (ce/fx) reopened since it passed");
  });
  test("a unit there on its own group's data doesn't count", () => {
    setup(["add-unit", "ce/own", "--title", "Effects on their own data"]); setup(["done", "ce/fx", "--evidence", "x"]); setup(["ci-pass", "cd", "--evidence", "again"]);
    setup(["done", "ce/own", "--evidence", "x"]);
    has(ok(["ci", "cd"]), "passed");
  });
  after(() => {
    for (const u of ["cd/a", "ce/fx", "ce/own"]) setup(["drop", u, "--why", "test"]);
    setup(["edit", "ce/fx", "--data", "default"]);
    setup(["edit-group", "cd", "--ci", "none"]); setup(["edit-group", "cd", "--data", "none"]);
    f.edit("tracker/project.json", (p) => { delete p.store; });
  });
});

describe("group CI, the loop's side: ci-next picks due CI this lane can run, ci-fail files ci-fix", () => {
  let out = "";
  test("ci-next: nothing due", () => {
    setup(["add-group", "lp", "--title", "Loop CI", "--ci", "drill"]);
    setup(["add-unit", "lp/a", "--title", "Loop CI unit"]);
    out = t(["ci-next", "--json", "--group", "lp"]).stdout;
    has(out, '"code":1');
  });
  test("and nothing to wait for", () => { has(out, '"wait":false'); });
  test("ci-next offers due CI", () => {
    setup(["done", "lp/a", "--evidence", "x"]);
    out = ok(["ci-next", "--json", "--group", "lp"]);
    has(out, '"group":"lp"');
  });
  test("with its steps' commands filled in", () => { has(out, '"cmd":"just drill lp"'); });
  test("their defaults: 2 hours, one retry, a ci-fix unit on failure", () => { has(out, '"timeout":120,"retries":1,"on_fail":"unit"'); });
  test("a group pinned to another machine: not here", () => {
    setup(["edit-group", "lp", "--host", "otherbox"]);
    has(t(["ci-next", "--json", "--group", "lp"]).stdout, '"code":1');
  });
  test("a step needing caps this machine lacks: not here", () => {
    setup(["edit-group", "lp", "--host", "none"]);
    f.edit("tracker/project.json", (p) => { p.ci.steps.drill.uses = ["editor"]; p.ci.steps.drill.caps = ["steam"]; });
    has(t(["ci-next", "--group", "lp"], { FACTORY_CAPS: "" }, { merged: true }).stdout, "its steps need steam");
  });
  test("its resource busy: not now", () => {
    busyOn();
    out = t(["ci-next", "--json", "--group", "lp"], { FACTORY_CAPS: "steam" }).stdout;
    has(out, '"code":1');
  });
  test("but the lane waits for it", () => { has(out, '"wait":true'); });
  test("naming the busy resource, so a unit that gets it as it frees gives way", () => { has(out, '"uses":["editor"]'); });
  test("ci-next --claim: running", () => {
    busyOff();
    out = ok(["ci-next", "--claim", "--json", "--group", "lp"], { FACTORY_CAPS: "steam" });
    has(out, '"group":"lp"');
  });
  test("the steps say what they use", () => { has(out, '"uses":["editor"]'); });
  test("recorded as running", () => { has(ok(["ci", "lp"]), "running (session worker1"); });
  test("not offered again", () => { assert.equal(t(["ci-next", "--group", "lp"], { FACTORY_CAPS: "steam" }).code, 1); });
  test("ci-unclaim gives it back", () => {
    ok(["ci-unclaim", "lp"]);
    has(ok(["ci", "lp"]), "due");
  });
  test("a failed step that's the lanes' to fix files ci-fix", () => {
    f.edit("tracker/project.json", (p) => { delete p.ci.steps.drill.uses; delete p.ci.steps.drill.caps; });
    setup(["ci-next", "--claim", "--group", "lp"]); backdate("lp");
    has(ok(["ci-fail", "lp", "--step", "drill", "--evidence", "drill: lp/a differs", "--log", "/x/runs/ci.log"], { FACTORY_CI_EVIDENCE: "loop" }), "Filed Fix Loop CI's CI (lp/ci-fix)");
  });
  test("broken", () => { has(ok(["ci", "lp"]), "broken: drill: Loop CI unit (lp/a) differs"); });
  test("a person's evidence with a bare ID is refused, as everywhere", () => { assert.equal(t(["ci-fail", "lp", "--evidence", "lp/a differs"]).code, 2); });
  test("the loop's evidence gets its bare IDs written as titles", () => { has(f.json("tracker/groups/lp.json").ci.failed.evidence, "{unit:lp/a}"); });
  test("ci-fix has the failure and the log", () => { has(ok(["show", "lp/ci-fix"]), "The whole output is in /x/runs/ci.log"); });
  test("and is the next unit", () => { has(ok(["next", "--group", "lp"]), "Fix Loop CI's CI (lp/ci-fix)"); });
  test("it takes the failed step's resources: drill's, none", () => { assert.equal(ciFixUses(), "null"); });
  test("CI waits for it", () => { hasnt(ok(["ci", "lp"]), "due"); });
  test("ci-fix done: due again at once", async () => {
    await sleep(1000); setup(["done", "lp/ci-fix", "--evidence", "fixed"]);
    has(ok(["ci", "lp"]), "due: Fix Loop CI's CI (lp/ci-fix) finished since it failed");
  });
  // A fix that didn't cure it: known failing (#92). It used to leave the fix stuck, for the overseer.
  test("failing again on the same step after its fix: known failing, not a stuck fix", () => {
    setup(["note", "lp/ci-fix", "the drill's seed changed upstream"]);
    setup(["ci-next", "--claim", "--group", "lp"]);
    has(ok(["ci-fail", "lp", "--step", "drill", "--evidence", "drill: differs again"]), "Loop CI's CI is known failing now (drill still fails after Fix Loop CI's CI (lp/ci-fix): the drill's seed changed upstream)");
  });
  test("  the fix stays done", () => { assert.equal(ok(["state", "lp/ci-fix"]).trim(), "done"); });
  test("  CI says known failing, with the step and the fix's last note", () => { has(ok(["ci", "lp"]), "known failing: drill still fails after Fix Loop CI's CI (lp/ci-fix): the drill's seed changed upstream (drill: differs again"); });
  test("  it isn't due (ci --json), and gives its reason", () => {
    const j = JSON.parse(ok(["ci", "--json"])).find((c: any) => c.group === "lp");
    assert.equal(j.state, "known"); has(j.why, "drill still fails after");
  });
  test("  ci-next offers nothing", () => { assert.equal(t(["ci-next", "--group", "lp"]).code, 1); });
  test("  status lists it with its reason", () => { has(ok(["status", "all"]), "CI known failing: Loop CI (lp): drill still fails after Fix Loop CI's CI (lp/ci-fix): the drill's seed changed upstream"); });
  test("  the morning summary gives the reason", () => { has(ok(["ci", "--since", "2000-01-01T00:00:00Z"]), "known failing: drill still fails after"); });
  test("  nothing more is filed", () => {
    assert.equal(f.json("tracker/groups/lp.json").units.filter((u: any) => u.id === "lp/ci-fix").length, 1);
  });
  test("  failing again while known failing: still known failing, not news again", () => {
    setup(["ci-retry", "lp"]); setup(["ci-next", "--claim", "--group", "lp"]);
    const out = ok(["ci-fail", "lp", "--step", "drill", "--evidence", "drill: differs a third time"]);
    has(out, "still known failing"); hasnt(out, "known failing now");
    has(ok(["ci", "lp"]), "known failing: drill still fails after");
  });
  test("  a unit of the group done after the mark: due again", async () => {
    await sleep(1000);
    setup(["add-unit", "lp/k", "--title", "Loop CI unit k"]); setup(["done", "lp/k", "--evidence", "x"]);
    has(ok(["ci", "lp"]), "due: Loop CI unit k (lp/k) finished since it failed");
  });
  test("  a pass clears it", () => {
    setup(["ci-next", "--claim", "--group", "lp"]); setup(["ci-pass", "lp", "--evidence", "ok"]);
    hasnt(ok(["ci", "lp"]), "known failing"); hasnt(ok(["status", "all"]), "known failing");
    assert.equal(f.json("tracker/groups/lp.json").ci.failed, undefined);
  });
  test("another step failing after the fix starts a new cycle: the fix reopens", async () => {
    // The fix done, for a drill failure; then the drill passes and publish (the lanes' here) fails.
    f.edit("tracker/project.json", (p) => { p.ci.steps.drill.on_fail = "unit"; });
    await sleep(1000); setup(["add-unit", "lp/m", "--title", "Loop CI unit m"]); setup(["done", "lp/m", "--evidence", "x"]);
    setup(["ci-next", "--claim", "--group", "lp", "--force"]);
    has(ok(["ci-fail", "lp", "--step", "drill", "--evidence", "drill broke"]), "Reopened");
    await sleep(1000); setup(["done", "lp/ci-fix", "--evidence", "fixed the drill"]);
    f.edit("tracker/groups/lp.json", (g) => { g.ci.steps = ["drill", "check"]; });
    f.edit("tracker/project.json", (p) => { p.ci.steps.check = { cmd: "true" }; });
    setup(["ci-next", "--claim", "--group", "lp"]);
    has(ok(["ci-fail", "lp", "--step", "check", "--evidence", "check broke"]), "Reopened");
    hasnt(ok(["ci", "lp"]), "known failing");
  });
  test("a dropped ci-fix is reopened by the next failure", () => {
    setup(["drop", "lp/ci-fix", "--why", "test"]); setup(["edit", "lp/ci-fix", "--uses", "editor"]); setup(["ci-retry", "lp"]); setup(["ci-next", "--claim", "--group", "lp"]);
    has(ok(["ci-fail", "lp", "--step", "drill", "--evidence", "again"]), "Reopened");
  });
  test("without a resource an earlier fix added", () => {
    assert.equal(ciFixUses(), "null");
  });
  // a pass, then a new failure: the old ci-fix's cycle is over, so it's reopened, not stuck
  test("a failure after CI passed since the last fix reopens ci-fix", async () => {
    setup(["drop", "lp/ci-fix", "--why", "test"]); setup(["ci-retry", "lp"]);
    setup(["reopen", "lp/ci-fix"]); setup(["done", "lp/ci-fix", "--evidence", "fixed again"]); await sleep(1000);
    setup(["ci-next", "--claim", "--group", "lp"]); setup(["ci-pass", "lp", "--evidence", "ok"]);
    setup(["add-unit", "lp/b", "--title", "Loop CI unit b"]); setup(["done", "lp/b", "--evidence", "x"]);
    setup(["ci-next", "--claim", "--group", "lp"]);
    has(ok(["ci-fail", "lp", "--step", "drill", "--evidence", "a new break"]), "Reopened");
  });
  test("with the new failure", () => {
    has(ok(["show", "lp/ci-fix"]), "a new break");
  });
  // a unit finished while CI runs isn't covered by that run
  test("a unit finished during a CI run makes it stale again", async () => {
    setup(["drop", "lp/ci-fix", "--why", "test"]); setup(["ci-retry", "lp"]);
    setup(["ci-next", "--claim", "--group", "lp"]); await sleep(1000);
    setup(["add-unit", "lp/c", "--title", "Loop CI unit c"]); setup(["done", "lp/c", "--evidence", "x"]);
    setup(["ci-pass", "lp", "--evidence", "ok"]);
    has(ok(["ci", "lp"]), "Loop CI unit c (lp/c) finished since it passed");
  });
  test("a step that's the owner's to look at files nothing", () => {
    f.edit("tracker/project.json", (p) => { p.ci.steps.drill.on_fail = "owner"; });
    setup(["ci-next", "--claim", "--group", "lp"]);
    has(ok(["ci-fail", "lp", "--step", "drill", "--evidence", "x"]), "the owner's to look at: no unit filed");
  });
  test("ci-fix stays dropped", () => { has(ok(["state", "lp/ci-fix"]), "dropped"); });
  test("a template's params are filled into a step's cmd", () => {
    setup(["add-group", "ls", "--title", "Ships", "--ci", "drill,publish"]); setup(["add-unit", "ls/a", "--title", "Ships unit"]); setup(["done", "ls/a", "--evidence", "x"]);
    setup(["add", "rook", "--template", "fighter"]); setup(["done", "rook/rig", "--evidence", "x"]);
    has(ok(["ci-next", "--json", "--group", "rook"]), '"cmd":"just publish rook"');
  });
  test("a step that ships is the owner's by default", () => {
    has(ok(["ci-next", "--json", "--group", "ls"]), '"step":"publish","cmd":"just publish ls","ships":true,"uses":[],"caps":[],"timeout":120,"retries":1,"on_fail":"owner"');
  });
  test("lint: on_fail", () => {
    f.edit("tracker/project.json", (p) => { Object.assign(p.ci.steps.drill, { on_fail: "nobody", uses: ["nosuch"], timeout: "long", later: 1 }); });
    out = t(["lint"], {}, { merged: true }).stdout;
    has(out, 'on_fail is "unit" or "owner"');
  });
  test("lint: a step's unknown resource", () => { has(out, "uses unknown resource nosuch"); });
  test("lint: timeout", () => { has(out, "timeout is a whole number"); });
  test("lint: an unknown key is a slip, not broken", () => { has(out, "unknown key later"); });
  test("fixed: lint is happy", () => {
    f.edit("tracker/project.json", (p) => { p.ci.steps.drill = { cmd: p.ci.steps.drill.cmd }; });
    assert.equal(t(["lint", "--broken"]).code, 0);
  });
});

describe("CI passing again settles its group's ci-fix, stuck or open", () => {
  const fixState = () => f.json("tracker/groups/cp.json").units.find((u: any) => u.id === "cp/ci-fix").record;
  test("a ci-fix stuck (its session couldn't find the cause)", () => {
    setup(["add-group", "cp", "--title", "Passes again", "--ci", "drill"]);
    setup(["add-unit", "cp/a", "--title", "Passes again unit"]); setup(["done", "cp/a", "--evidence", "x"]);
    setup(["ci-next", "--claim", "--group", "cp"]); backdate("cp");
    setup(["ci-fail", "cp", "--step", "drill", "--evidence", "drill differs"]);
    setup(["block", "cp/ci-fix", "--why", "can't find what differs"]);
    has(ok(["state", "cp/ci-fix"]), "stuck");
  });
  test("is done once CI passes", () => {
    setup(["ci-retry", "cp"]); setup(["ci-next", "--claim", "--group", "cp"]);
    has(ok(["ci-pass", "cp", "--evidence", "ok"]), "Fix Passes again's CI (cp/ci-fix) is done: CI passed since.");
    assert.equal(fixState().state, "done");
    assert.equal(fixState().evidence, "CI passed since");
  });
  test("logged", () => { has(ok(["log"]), "Fix Passes again's CI: done: CI passed since"); });
  test("and counts as covered by the pass: CI isn't stale again", () => { has(ok(["ci", "cp"]), "Passes again (cp): passed"); });
  test("the next failure starts a new cycle: reopened, not stuck", () => {
    setup(["ci-start", "cp", "--force"]);
    has(ok(["ci-fail", "cp", "--step", "drill", "--evidence", "a new break"]), "Reopened");
  });
  test("an open ci-fix is done once CI passes too", () => {
    assert.equal(fixState(), undefined);
    setup(["ci-retry", "cp"]); setup(["ci-next", "--claim", "--group", "cp"]);
    has(ok(["ci-pass", "cp", "--evidence", "ok"]), "is done: CI passed since.");
    assert.equal(fixState().state, "done");
  });
  test("a pass with no ci-fix open says nothing of one", () => {
    setup(["ci-start", "cp", "--force"]);
    hasnt(ok(["ci-pass", "cp", "--evidence", "ok"]), "ci-fix");
  });
});

describe("CI passing leaves a ci-fix that isn't the pass's to settle", () => {
  const fixState = () => f.json("tracker/groups/cq.json").units.find((u: any) => u.id === "cq/ci-fix").record?.state;
  test("a pass that didn't run the step that failed", () => {
    setup(["add-group", "cq", "--title", "Partly passes", "--ci", "pre,drill"]);
    setup(["add-unit", "cq/a", "--title", "Partly passes unit"]); setup(["done", "cq/a", "--evidence", "x"]);
    setup(["ci-next", "--claim", "--group", "cq"]); backdate("cq");
    setup(["ci-fail", "cq", "--step", "drill", "--evidence", "drill differs"]);
    setup(["ci-retry", "cq"]); setup(["ci-next", "--claim", "--group", "cq"]);
    hasnt(ok(["ci-pass", "cq", "--steps", "pre", "--evidence", "ok"]), "ci-fix");
  });
  test("  leaves it open", () => { assert.equal(fixState(), undefined); });
  test("a parked one is the owner's", () => {
    setup(["park", "cq/ci-fix", "--why", "test"]);
    setup(["ci-start", "cq", "--force"]); setup(["ci-pass", "cq", "--evidence", "ok"]);
    assert.equal(fixState(), "parked");
  });
});

describe("known failing: only a failure the done fix was for, and what brings it due", () => {
  const G = () => f.json("tracker/groups/kf.json");
  const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
  test("a fix recorded done during a passing run, then a new failure: the fix reopens, not known failing", async () => {
    f.edit("tracker/project.json", (p) => { p.ci.steps.check = { cmd: "true" }; });
    setup(["add-group", "kf", "--title", "Known", "--ci", "drill,check"]);
    setup(["add-unit", "kf/a", "--title", "Known unit"]); setup(["done", "kf/a", "--evidence", "x"]);
    setup(["ci-next", "--claim", "--group", "kf"]); backdate("kf");
    setup(["ci-fail", "kf", "--step", "drill", "--evidence", "drill differs"]);
    setup(["ci-start", "kf", "--force"]); await sleep(1000);
    setup(["done", "kf/ci-fix", "--evidence", "fixed the drill"]);
    setup(["ci-pass", "kf", "--evidence", "ok"]);
    await sleep(1000); setup(["add-unit", "kf/b", "--title", "Known unit b"]); setup(["done", "kf/b", "--evidence", "x"]);
    setup(["ci-start", "kf", "--force"]);
    has(ok(["ci-fail", "kf", "--step", "drill", "--evidence", "drill differs anew"]), "Reopened");
    hasnt(ok(["ci", "kf"]), "known failing");
  });
  test("a failure older than the last pass (two machines' writes merged) isn't what the fix was for", async () => {
    setup(["done", "kf/ci-fix", "--evidence", "fixed"]); await sleep(1000);
    f.edit("tracker/groups/kf.json", (g) => { g.ci.passed = { ...g.ci.passed, at: iso(Date.now()) }; g.ci.failed.at = iso(Date.now() - 60e3); });
    setup(["ci-start", "kf", "--force"]);
    has(ok(["ci-fail", "kf", "--step", "drill", "--evidence", "drill differs"]), "Reopened");
  });
  test("a step that's the owner's, failing after the fix: broken, not known failing", async () => {
    await sleep(1000); setup(["done", "kf/ci-fix", "--evidence", "fixed"]); await sleep(1000);
    f.edit("tracker/project.json", (p) => { p.ci.steps.check.on_fail = "owner"; });
    setup(["ci-start", "kf", "--force"]);
    has(ok(["ci-fail", "kf", "--step", "check", "--evidence", "check differs"]), "the owner's to look at");
    has(ok(["ci", "kf"]), "broken: check differs");
    f.edit("tracker/project.json", (p) => { delete p.ci.steps.check.on_fail; });
  });
  test("the fix done in the same second as the mark doesn't bring it due", () => {
    setup(["ci-retry", "kf"]); setup(["ci-next", "--claim", "--group", "kf"]);
    setup(["ci-fail", "kf", "--step", "drill", "--evidence", "drill differs"]);
    // The failure before this one was check's: drill's fix starts a cycle; the next drill failure is known.
    setup(["done", "kf/ci-fix", "--evidence", "fixed"]); backdate("kf");
    f.edit("tracker/groups/kf.json", (g) => { g.ci.passed.at = iso(Date.now() - 180e3); g.ci.failed.at = iso(Date.now() - 120e3); });
    setup(["ci-start", "kf", "--force"]);
    has(ok(["ci-fail", "kf", "--step", "drill", "--evidence", "drill differs again"]), "known failing now");
    f.edit("tracker/groups/kf.json", (g) => { g.units.find((u: any) => u.id === "kf/ci-fix").record.at = g.ci.failed.at; });
    has(ok(["ci", "kf"]), "known failing");
  });
  test("main moved and 6 hours passed: due again", () => {
    f.edit("tracker/groups/kf.json", (g) => {
      for (const u of g.units) if (u.record) u.record.at = iso(Date.now() - 8 * 3600e3);
      g.ci.passed.at = iso(Date.now() - 9 * 3600e3);
      g.ci.failed.at = iso(Date.now() - 7 * 3600e3); g.ci.failed.commit = "0000000000";
    });
    has(ok(["ci", "kf"]), "due: main has moved since it failed");
  });
  test("a fix done while a failing run was under way wasn't in it: not known failing, due again at once", async () => {
    setup(["ci-start", "kf"]); setup(["reopen", "kf/ci-fix"]); await sleep(1000);
    setup(["done", "kf/ci-fix", "--evidence", "fixed during the run"]);
    has(ok(["ci-fail", "kf", "--step", "drill", "--evidence", "drill differs"]), "was done after this run started, so the run didn't have it: CI runs again at once");
    has(ok(["ci", "kf"]), "Known (kf): due:");
    assert.equal(ok(["state", "kf/ci-fix"]).trim(), "done");
  });
});
