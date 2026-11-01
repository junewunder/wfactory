// The tracker CLI end to end: group CI through the night. CI on a group that still has work comes
// due once it has been stale ci_every minutes (default 120), and then comes before the group's new
// units; what became of each group's CI since a time (`ci --since`): passed, failed on what, cut
// off, never started; a run's time, kept for last call; and the built-in resource heavy, busy while
// every heavy-job slot on the machine is held. Run: node --test tracker/test/
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { trackerRepo, has, hasnt, ago, sleep } from "../../test/lib/index.ts";

const f = trackerRepo("repo", { FACTORY_TAG: "worker1", FACTORY_EVIDENCE_MIN: "0" });
const { t, ok, setup } = f;
setup(["init", "--title", "CI through the night"]);
f.edit("tracker/project.json", (p) => { p.ci = { steps: { drill: { cmd: "just drill {group}" }, gpu: { cmd: "just gpu {group}", caps: ["gpu"] } } }; });
f.write("code.txt", "code\n"); f.git("add", "code.txt"); f.git("commit", "-q", "-m", "some code");
// A unit's record moved back h hours, as if it had been done then.
const doneAgo = (id: string, h: number) => f.edit(`tracker/groups/${id.split("/")[0]}.json`, (g) => { g.units.find((u: any) => u.id === id).record.at = ago(h); });
const next = (add = {}, args: string[] = []) => t(["next", "--json", ...args], add);
const nextBuild = (add = {}) => next(add, ["--group", "build"]);

describe("CI falls due through the night: a group with work left, stale for ci_every minutes", () => {
  test("(a group with one unit done and two to go, and another group with work)", () => {
    setup(["add-group", "fern", "--title", "Fern", "--ci", "drill"]);
    for (const n of ["one", "two", "three"]) setup(["add-unit", `fern/${n}`, "--title", `Fern ${n}`]);
    setup(["add-group", "kip", "--title", "Kip"]);
    setup(["add-unit", "kip/one", "--title", "Kip one"]);
    setup(["done", "fern/one", "--evidence", "x"]);
  });
  test("just finished: stale, and it says when it comes due", () => {
    const o = ok(["ci", "fern"]);
    has(o, "Fern (fern): stale: it hasn't passed yet; 2 units still to work tonight; due at ");
  });
  test("  the group's units go on meanwhile", () => { has(next().stdout, '"id":"fern/two"'); });
  test("two hours on: due, with work left", () => {
    doneAgo("fern/one", 2.1);
    has(ok(["ci", "fern"]), "Fern (fern): due: it hasn't passed yet, 2 h 6 min ago; it runs before the group's other new units (2 units still to work tonight)");
  });
  test("  ci-next offers it", () => { has(ok(["ci-next"]), "Fern (fern): CI due"); });
  test("  next skips the group's new units for another group's", () => { has(next().stdout, '"id":"kip/one"'); });
  test("  and with nothing else to take, the lane waits for the CI instead of stopping", () => {
    setup(["park", "kip/one", "--why", "test"]);
    const r = next();
    assert.equal(r.code, 1);
    has(r.stdout, '"wait":true');
    has(r.stdout, "new units of Fern wait for its CI, which is due and runs first");
  });
  test("  the group's ci-fix isn't held back", () => {
    f.edit("tracker/groups/fern.json", (g) => { g.units.push({ id: "fern/ci-fix", title: "Fix Fern's CI", tags: ["ci-fix"], check: "recorded" }); });
    has(next().stdout, '"id":"fern/ci-fix"');
    f.edit("tracker/groups/fern.json", (g) => { g.units = g.units.filter((u: any) => u.id !== "fern/ci-fix"); });
  });
  test("  nor one already in progress (it isn't new)", () => {
    f.tryIn(["claim", "fern/two"], { FACTORY_PID: "999999" });
    f.edit("tracker/groups/fern.json", (g) => { const u = g.units.find((u: any) => u.id === "fern/two"); u.record.pid = 999999; u.record.start = "1"; });
    has(ok(["state", "fern/two"]), "interrupted");
    has(next().stdout, '"id":"fern/two"');
  });
  test("ci_every 0: only once the group is done for the night", () => {
    f.edit("tracker/project.json", (p) => { p.ci_every = 0; });
    has(ok(["ci", "fern"]), "Fern (fern): stale: it hasn't passed yet; 2 units still to work tonight");
    hasnt(ok(["ci", "fern"]), "due at");
  });
  test("ci_every 300: not yet", () => {
    f.edit("tracker/project.json", (p) => { p.ci_every = 300; });
    has(ok(["ci", "fern"]), "stale");
  });
  test("lint wants minutes", () => {
    f.edit("tracker/project.json", (p) => { p.ci_every = "soon"; });
    has(t(["lint"]).stdout + t(["lint"]).stderr, "ci_every: minutes");
    f.edit("tracker/project.json", (p) => { delete p.ci_every; });
  });
  test("CI no machine can run (caps) holds nothing back", () => {
    setup(["edit-group", "fern", "--ci", "gpu"]);
    f.write("docs/machines.md", "| Machine | ssh | Lanes | Takes | Checkout | Can | Cache | Heavy | Reserve | GPU |\n|---|---|---|---|---|---|---|---|---|---|\n| testhost | - | 1 | any | ~/x | - | - | 1 | - | - |\n");
    has(ok(["ci", "fern"]), "due");
    has(next().stdout, '"id":"fern/two"');
    fs.rmSync(f.at("docs/machines.md"));
    setup(["edit-group", "fern", "--ci", "drill"]);
  });
  test("CI only another machine can run, with no heartbeat there, holds nothing back (no lane there runs it)", () => {
    setup(["edit-group", "fern", "--ci", "gpu"]);
    f.write("docs/machines.md", "| Machine | ssh | Lanes | Takes | Checkout | Can | Cache | Heavy | Reserve | GPU |\n|---|---|---|---|---|---|---|---|---|---|\n| testhost | - | 1 | any | ~/x | - | - | 1 | - | - |\n| otherhost | - | 1 | any | ~/x | gpu | - | 1 | - | - |\n");
    f.write("tracker/leases.json", JSON.stringify({ leases: [], hosts: { otherhost: ago(2) } }));
    has(ok(["ci", "fern"]), "due");
    has(ok(["queue", "-n", "5"]), "Fern three (fern/three)");
  });
  test("  but while that machine's lanes are up (its heartbeat fresh), they wait for it", () => {
    f.write("tracker/leases.json", JSON.stringify({ leases: [], hosts: { otherhost: ago(0) } }));
    hasnt(ok(["queue", "-n", "5"]), "Fern three (fern/three)");
    fs.rmSync(f.at("docs/machines.md"));
    setup(["edit-group", "fern", "--ci", "drill"]);
  });
  test("in last call it waits for the work in flight instead", () => {
    has(ok(["ci", "fern"], { FACTORY_LAST_CALL: "1" }), "due");   // nothing in flight: due
    setup(["claim", "fern/three"]);
    has(ok(["ci", "fern"], { FACTORY_LAST_CALL: "1" }), "stale");
    setup(["unclaim", "fern/three"]);
  });
});

describe("what became of each group's CI since a time (`ci --since`, the morning summary's)", () => {
  const night = ago(0.01);
  test("never started: CI that was due and didn't run", () => {
    has(ok(["ci", "--since", night]), "Fern (fern): never started: due: it hasn't passed yet");
  });
  test("a run is timed: ci-pass --secs, and ci --json gives it", () => {
    setup(["ci-start", "fern"]);
    setup(["ci-pass", "fern", "--evidence", "drill: same", "--secs", "1800"]);
    has(ok(["ci", "--json"]), '"group":"fern","state":"passed"');
    has(ok(["ci", "--json"]), '"secs":1800');
  });
  test("  --secs wants seconds", () => { assert.equal(t(["ci-pass", "fern", "--evidence", "x", "--secs", "half"]).code, 2); });
  test("passed: its steps and commit", () => { has(ok(["ci", "--since", night]), "Fern (fern): passed (drill) at "); });
  test("cut off: the run was given back with --cut, at the step it was on", () => {
    setup(["done", "fern/two", "--evidence", "x"]);
    f.edit("tracker/groups/fern.json", (g) => { g.ci.passed.at = ago(3); }); doneAgo("fern/two", 2.5);
    setup(["ci-start", "fern"]);
    setup(["ci-unclaim", "fern", "--cut", "paused asap", "--step", "drill"]);
    has(ok(["ci", "--since", night]), "Fern (fern): cut off: at drill, paused asap; started ");
  });
  test("  and it's due again", () => { has(ok(["ci", "fern"]), "due: "); });
  test("  the view, which looks at no night, has it as cut off too", () => {
    ok(["view"]);
    has(fs.readFileSync(f.at(".tracker/view.html"), "utf8"), '"ci":{"s":"cut","text":"cut off: at drill, paused asap');
  });
  test("  ci says so too", () => { has(ok(["ci", "fern"]), "its last run was cut off (at drill, paused asap"); });
  test("  --cut wants a reason", () => {
    setup(["ci-start", "fern"]);
    assert.equal(t(["ci-unclaim", "fern", "--cut"]).code, 2);
  });
  test("cut off: a run whose lane is gone without a result (the machine froze)", () => {
    f.edit("tracker/groups/fern.json", (g) => { g.ci.running.pid = 999999; g.ci.running.start = "1"; });
    has(ok(["ci", "--since", night]), "Fern (fern): cut off: its lane stopped without a result");
  });
  test("failed: on which step, and how", () => {
    setup(["ci-fail", "fern", "--evidence", "drill: 2 files differ", "--step", "drill", "--secs", "60"]);
    has(ok(["ci", "--since", night]), "Fern (fern): failed on drill: drill: 2 files differ");
  });
  test("  first in the list, before what passed", () => {
    setup(["add-group", "pip", "--title", "Pip", "--ci", "drill"]);
    setup(["add-unit", "pip/one", "--title", "Pip one"]); setup(["done", "pip/one", "--evidence", "x"]);
    setup(["ci-start", "pip"]); setup(["ci-pass", "pip", "--evidence", "same"]);
    const o = ok(["ci", "--since", night]);
    assert.ok(o.indexOf("Fern (fern): failed") < o.indexOf("Pip (pip): passed"), o);
  });
  test("a run before the time doesn't count: what was needed since is never started", () => {
    const later = new Date(Date.now() + 60e3).toISOString();
    has(ok(["ci", "--since", later]), "Fern (fern): never started: still broken from ");
    hasnt(ok(["ci", "--since", later]), "Pip");   // passed before, and nothing needed since
  });
  test("  a group without CI isn't listed", () => { hasnt(ok(["ci", "--since", night]), "Kip"); });
  test("--since wants a time", () => { assert.equal(t(["ci", "--since", "dawn"]).code, 2); });
  test("the view has each group's CI", () => {
    ok(["view"]);
    const html = fs.readFileSync(f.at(".tracker/view.html"), "utf8");
    has(html, '"ci":{"s":"failed","text":"failed on drill');
  });
});

describe("what brings CI due by time, and what doesn't", () => {
  test("a retry with work left: due now, saying so plainly", () => {
    setup(["add-group", "zora", "--title", "Zora", "--ci", "drill"]);
    for (const n of ["one", "two"]) setup(["add-unit", `zora/${n}`, "--title", `Zora ${n}`]);
    setup(["done", "zora/one", "--evidence", "x"]);
    setup(["ci-start", "zora", "--force"]); setup(["ci-fail", "zora", "--evidence", "drill: differs"]);
    setup(["ci-retry", "zora"]);
    const o = ok(["ci", "zora"]);
    has(o, "Zora (zora): due: a retry was asked for; it runs before");
    hasnt(o, " ago");
  });
  test("its ci-fix done: due now, not two hours on", () => {
    f.edit("tracker/groups/zora.json", (g) => { g.ci.failed.at = ago(1); delete g.ci.failed.retry; g.units.push({ id: "zora/ci-fix", title: "Fix Zora's CI", tags: ["ci-fix"], check: "recorded" }); });
    setup(["done", "zora/ci-fix", "--evidence", "fixed"]);
    has(ok(["ci", "zora"]), "Zora (zora): due: Fix Zora's CI (zora/ci-fix) finished since it failed; it runs before");
  });
  test("a unit added since a pass changes no code: stale, never due by time alone", () => {
    setup(["ci-start", "zora"]); setup(["ci-pass", "zora", "--evidence", "same"]);
    // (All of it hours back: the pass, and the units it covered before it.)
    f.edit("tracker/groups/zora.json", (g) => { g.ci.passed.at = ago(5); for (const u of g.units) if (u.record) u.record.at = ago(6); });
    setup(["add-unit", "zora/three", "--title", "Zora three"]);
    const o = ok(["ci", "zora"]);
    has(o, "Zora (zora): stale: Zora three (zora/three) added since it passed; 2 units still to work tonight");
    hasnt(o, "due at");
  });
  test("  nor a unit reopened", () => {
    setup(["drop", "zora/three", "--why", "test"]);
    setup(["reopen", "zora/one"]);
    has(ok(["ci", "zora"]), "stale: Zora one (zora/one) reopened since it passed");
    setup(["edit-group", "zora", "--ci", "none"]);
  });
});

describe("more of what CI's state reads as", () => {
  test("a step the last pass skipped (publishing was off) brings CI stale, not due by time", () => {
    f.edit("tracker/project.json", (p) => { p.ci.steps.publish = { cmd: "just publish {group}" }; });
    setup(["add-group", "lark", "--title", "Lark", "--ci", "drill,publish"]);
    for (const n of ["one", "two"]) setup(["add-unit", `lark/${n}`, "--title", `Lark ${n}`]);
    setup(["done", "lark/one", "--evidence", "x"]);
    setup(["publish", "off"]);
    setup(["ci-start", "lark", "--force"]); setup(["ci-pass", "lark", "--evidence", "same", "--steps", "drill"]);
    setup(["publish", "on"]);
    f.edit("tracker/groups/lark.json", (g) => { g.ci.passed.at = ago(5); for (const u of g.units) if (u.record) u.record.at = ago(6); });
    const o = ok(["ci", "lark"]);
    has(o, "Lark (lark): stale: its last pass didn't run publish");
    hasnt(o, "due at");
  });
  test("the view: stale after a pass is still that pass, changed since (not a red never started)", () => {
    ok(["view"]);
    has(fs.readFileSync(f.at(".tracker/view.html"), "utf8"), '"ci":{"s":"passed","text":"passed (drill) at ');
  });
  test("  due after a pass and not run: never started since it came due", () => {
    setup(["drop", "lark/two", "--why", "test"]);
    has(ok(["ci", "lark"]), "Lark (lark): due: ");
    ok(["view"]);
    has(fs.readFileSync(f.at(".tracker/view.html"), "utf8"), '"ci":{"s":"never","text":"never started since it came due: due: its last pass didn');
    setup(["edit-group", "lark", "--ci", "none"]);
  });
  test("last call goes by the longer of a group's last pass and last failure", () => {
    setup(["add-group", "nell", "--title", "Nell", "--ci", "drill"]);
    setup(["add-unit", "nell/one", "--title", "Nell one"]); setup(["done", "nell/one", "--evidence", "x"]);
    setup(["ci-start", "nell"]); setup(["ci-pass", "nell", "--evidence", "same", "--secs", "3000"]);
    setup(["ci-start", "nell", "--force"]); setup(["ci-fail", "nell", "--evidence", "drill: broke at once", "--secs", "20"]);
    has(ok(["ci", "--json"]), '"group":"nell"');
    assert.match(ok(["ci", "--json"]), /"group":"nell"[^}]*\}[^}]*"secs":3000/);
    setup(["edit-group", "nell", "--ci", "none"]);
  });
});

describe("heavy, the machine's heavy-job slots: no heavy unit for a lane while every slot is held", () => {
  const cpu = f.at("cpu");
  const env = { FACTORY_CPU_LOCKS: cpu };
  let holder: ReturnType<typeof spawn> | null = null;
  test("--uses heavy is a resource with nothing in project.json", () => {
    setup(["add-group", "build", "--title", "Builds"]);
    setup(["add-unit", "build/fbx", "--title", "Rebuild the stages", "--uses", "heavy"]);
    has(ok(["show", "build/fbx"]), "build/fbx");
    assert.equal(t(["lint", "--broken"]).code, 0);
  });
  test("a slot free: the unit is offered", () => {
    fs.mkdirSync(cpu, { recursive: true });
    has(nextBuild(env).stdout, '"id":"build/fbx"');
  });
  test("every slot held: waiting on the heavy-job slots", async () => {
    holder = spawn("flock", [`${cpu}/slot-1.lock`, "sleep", "60"], { stdio: "ignore" });
    for (let i = 0; i < 100 && !fs.existsSync(`${cpu}/slot-1.lock`); i++) await sleep(50);
    await sleep(200);
    has(ok(["show", "build/fbx"], env), "waiting for this machine's heavy-job slots to be free");
    hasnt(nextBuild(env).stdout, '"id":"build/fbx"');
  });
  test("  two slots (FACTORY_HEAVY), one held: offered", () => { has(nextBuild({ ...env, FACTORY_HEAVY: "2" }).stdout, '"id":"build/fbx"'); });
  test("  or the machines file's Heavy column", () => {
    f.write("docs/machines.md", "| Machine | ssh | Lanes | Takes | Checkout | Can | Cache | Heavy | Reserve | GPU |\n|---|---|---|---|---|---|---|---|---|---|\n| testhost | - | 2 | any | ~/x | - | - | 2 | - | - |\n");
    has(nextBuild(env).stdout, '"id":"build/fbx"');
    fs.rmSync(f.at("docs/machines.md"));
  });
  test("a project's own resource named heavy is its own", () => {
    f.edit("tracker/project.json", (p) => { p.resources = { heavy: { title: "the big press" } }; });
    has(nextBuild(env).stdout, '"id":"build/fbx"');
    f.edit("tracker/project.json", (p) => { delete p.resources; });
  });
  test("any other unknown resource is still refused", () => { assert.equal(t(["add-unit", "build/x", "--title", "X", "--uses", "heavyish"]).code, 2); });
  after(() => { holder?.kill(); });
});

// `ci --json`'s runs_here: whether this machine runs the group's CI tonight, which last call plans
// for. Pinned elsewhere, steps this machine can't do, or data another machine leases: not here.
describe("ci --json says which groups' CI this machine runs tonight (runs_here)", () => {
  const runsHere = (g: string, add = {}) => JSON.parse(ok(["ci", "--json"], add)).find((c: { group: string }) => c.group === g).runs_here;
  test("(groups with CI: one free, one pinned to another machine, one with a step needing a gpu, two with data)", () => {
    f.edit("tracker/project.json", (p) => { p.store = { remote: "store:/s", paths: { out: "work/out/{group}" } }; });
    setup(["add-group", "rfree", "--title", "Free", "--ci", "drill"]);
    setup(["add-group", "rpin", "--title", "Pinned", "--ci", "drill", "--host", "otherbox"]);
    setup(["add-group", "rgpu", "--title", "On a gpu", "--ci", "drill,gpu"]);
    setup(["add-group", "rmine", "--title", "Leased here", "--ci", "drill", "--data", "x=1"]);
    setup(["add-group", "rtheirs", "--title", "Leased there", "--ci", "drill", "--data", "x=2"]);
    setup(["lease", "take", "rmine"]); setup(["lease", "take", "rtheirs"], { FACTORY_HOST: "otherbox" });
  });
  test("free: here", () => { assert.equal(runsHere("rfree"), true); });
  test("pinned to another machine: not here", () => { assert.equal(runsHere("rpin"), false); });
  test("a step needing caps this machine lacks: not here", () => { assert.equal(runsHere("rgpu", { FACTORY_CAPS: "" }), false); });
  test("  with them: here", () => { assert.equal(runsHere("rgpu", { FACTORY_CAPS: "gpu" }), true); });
  test("its data leased here: here", () => { assert.equal(runsHere("rmine"), true); });
  test("its data leased by another machine: not here", () => { assert.equal(runsHere("rtheirs"), false); });
  test("  that lease gone stale: here again", () => { assert.equal(runsHere("rtheirs", { FACTORY_LEASE_STALE: "0" }), true); });
  after(() => {
    setup(["lease", "release", "rmine", "rtheirs", "--force"]);
    for (const g of ["rfree", "rpin", "rgpu", "rmine", "rtheirs"]) setup(["edit-group", g, "--ci", "none"]);
    f.edit("tracker/project.json", (p) => { delete p.store; });
  });
});
