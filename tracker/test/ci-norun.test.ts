// The tracker CLI end to end: a CI run that couldn't run to a result isn't a failure. A step out of
// time, killed, or one that said it didn't run (ci-norun) leaves the group "couldn't run": nothing
// filed, nothing held, tried again when something changes; the second timeout in a row on a step
// counts as failing after all. CI waits for a fix in flight to reach main before it runs again, and
// for a unit's unlanded outputs in the copy of its data here. A fix's card says what changed since
// CI last passed. Run: node --test tracker/test/
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { trackerRepo, has, hasnt, ago } from "../../test/lib/index.ts";

const f = trackerRepo("repo", { FACTORY_TAG: "worker1", FACTORY_EVIDENCE_MIN: "0" });
const { t, ok, setup } = f;
setup(["init", "--title", "CI that couldn't run"]);
f.edit("tracker/project.json", (p) => { p.ci = { steps: { drill: { cmd: "just drill {group}" }, check: { cmd: "just check {group}" } } }; });
f.write("code.txt", "code\n"); f.git("add", "code.txt"); f.git("commit", "-q", "-m", "some code");

// A group with CI and one unit done a minute ago.
const group = (id: string, title: string) => {
  setup(["add-group", id, "--title", title, "--ci", "drill,check"]);
  setup(["add-unit", `${id}/a`, "--title", `${title} unit`]); setup(["done", `${id}/a`, "--evidence", "x"]);
  f.edit(`tracker/groups/${id}.json`, (g) => { g.units[0].record.at = ago(1 / 60); });
};
const claim = (id: string) => setup(["ci-next", "--claim", "--group", id]);
const norun = (id: string, kind: string, why: string, step = "check") => ok(["ci-norun", id, "--step", step, "--kind", kind, "--why", why, "--commit", "c0ffee11"]);
const ci = (id: string) => f.json(`tracker/groups/${id}.json`).ci;
const unit = (id: string) => f.json(`tracker/groups/${id.split("/")[0]}.json`).units.find((u: any) => u.id === id);
// A record moved back h hours, as if it had happened then.
const back = (id: string, h: number) => f.edit(`tracker/groups/${id}.json`, (g) => { g.ci.norun.at = ago(h); g.ci.norun.ran = ago(h); if (g.ci.norun.retry) g.ci.norun.retry = g.ci.norun.at; });

describe("a step out of time: the run couldn't run, which is no failure of the group's work", () => {
  let out = "";
  test("(a group whose CI is due and claimed; its check step runs out of time)", () => {
    group("elm", "Elm"); claim("elm");
    out = norun("elm", "time", "check ran out of time after 60 min");
  });
  test("it says so, and that nothing is filed", () => { has(out, "Elm: CI couldn't run. Nothing is filed and nothing held"); });
  test("  the group isn't broken", () => { assert.equal(ci("elm").failed, undefined); hasnt(ok(["ci", "elm"]), "broken"); });
  test("  its CI reads as couldn't run, with the step and the reason", () => {
    has(ok(["ci", "elm"]), "Elm (elm): couldn't run: check ran out of time after 60 min (check, at c0ffee11");
  });
  test("  no fix unit", () => { assert.equal(unit("elm/ci-fix"), undefined); });
  test("  it isn't run again at once: nothing has changed", () => {
    const r = t(["ci-next", "--json"]);
    assert.equal(r.code, 1); has(r.stdout, "no CI due");
  });
  test("  status counts it apart from broken", () => { has(ok(["status"]), "CI: 1 couldn't run (Elm)"); });
  test("  the morning summary's line: couldn't run, not failed", () => {
    const o = ok(["ci", "--since", ago(1)]);
    has(o, "Elm (elm): couldn't run (no verdict on its work; nothing filed): check ran out of time after 60 min");
    hasnt(o, "failed");
  });
  test("  the check before landing still runs for the group (its last result stands)", () => {
    f.edit("tracker/project.json", (p) => { p.ci.land = { cmd: "factory/ci {group} land" }; });
    setup(["add-unit", "elm/b", "--title", "Elm second"]);
    assert.deepEqual(JSON.parse(ok(["ci-land", "elm/b", "--json"])).checks.map((c: any) => c.group), ["elm"]);
  });
  test("a unit of the group done since: due again", () => {
    setup(["done", "elm/b", "--evidence", "x"]);
    f.edit("tracker/groups/elm.json", (g) => { g.ci.norun.at = ago(2 / 60); g.ci.norun.ran = ago(2 / 60); });
    has(ok(["ci", "elm"]), "Elm (elm): due");
  });
  test("out of time on the same step at the next run too: it counts as failing, with a fix for the lanes", () => {
    claim("elm");
    const o = norun("elm", "time", "check ran out of time after 60 min");
    has(o, "Elm: CI broken. Filed Fix Elm's CI (elm/ci-fix) for the lanes.");
    has(ci("elm").failed.evidence, "check ran out of time after 60 min; 2 runs in a row ended so on check, so it counts as failing");
    assert.equal(ci("elm").norun, undefined);
  });
});

describe("a step killed, then a pass: the pass clears it", () => {
  test("killed by a signal: couldn't run", () => {
    group("fir", "Fir"); claim("fir");
    has(norun("fir", "killed", "drill was killed by signal 9 (its memory cap, or the machine's)", "drill"), "Fir: CI couldn't run.");
  });
  test("  ci-retry runs it again now", () => { has(ok(["ci-retry", "fir"]), "Fir: due: it hasn't passed yet"); });
  test("  a pass clears it", () => {
    claim("fir"); setup(["ci-pass", "fir", "--evidence", "drill: ok"]);
    assert.equal(ci("fir").norun, undefined);
    has(ok(["ci", "fir"]), "Fir (fir): passed");
  });
});

describe("a step that says it didn't run (unmet): given back once, kept as couldn't run the second time", () => {
  test("the first time: given back, due again", () => {
    group("gum", "Gum"); claim("gum");
    has(norun("gum", "unmet", "Gum's copy here has 3 files of another unit's (run 41)", "drill"), "Gum: CI given back, due again.");
    has(ok(["ci", "gum"]), "Gum (gum): due");
  });
  test("  for another reason the next time: given back again", () => {
    claim("gum");
    has(norun("gum", "unmet", "Gum's mod isn't on this machine", "drill"), "Gum: CI given back, due again.");
  });
  test("the same reason twice in a row (its numbers aside): couldn't run, and not offered again", () => {
    claim("gum"); norun("gum", "unmet", "Gum's copy here has 3 files of another unit's (run 41)", "drill");
    claim("gum");
    has(norun("gum", "unmet", "Gum's copy here has 5 files of another unit's (run 42)", "drill"), "Gum: CI couldn't run (2 runs in a row). Nothing is filed");
    has(ok(["ci", "gum"]), "Gum (gum): couldn't run: Gum's copy here has 5 files of another unit's (run 42) (drill, at c0ffee11");
    assert.equal(t(["ci-next", "--group", "gum"]).code, 1);
  });
  test("  never a failure, however often", () => { assert.equal(ci("gum").failed, undefined); assert.equal(unit("gum/ci-fix"), undefined); });
  test("  an hour on, it's looked at again", () => { back("gum", 1.1); has(ok(["ci", "gum"]), "Gum (gum): due"); });
  test("  and a third time for the same reason holds it again", () => {
    claim("gum"); norun("gum", "unmet", "Gum's copy here has 5 files of another unit's (run 43)", "drill");
    has(ok(["ci", "gum"]), "couldn't run"); has(ok(["ci", "gum"]), "3 runs in a row");
  });
  test("only the session running it may say so", () => {
    const r = t(["ci-norun", "elm", "--step", "check", "--kind", "time", "--why", "x"]);
    assert.notEqual(r.code, 0); has(r.stderr, "isn't running in this session");
  });
});

describe("broken CI whose fix is in flight runs again once the fix is on main, not before", () => {
  test("(a group broken, its fix finished on a branch and waiting to land)", () => {
    group("hop", "Hop"); claim("hop");
    setup(["ci-fail", "hop", "--step", "drill", "--commit", "c0ffee11", "--evidence", "drill: 2 rows differ"]);
    f.edit("tracker/groups/hop.json", (g) => {
      g.ci.failed.at = ago(10 / 60);
      const u = g.units.find((x: any) => x.id === "hop/ci-fix");
      u.record = { state: "done", by: "worker2", at: ago(5 / 60), evidence: "fixed the rows", branch: "unit/hop/ci-fix" };
    });
    has(ok(["state", "hop/ci-fix"]), "merging");
  });
  test("a change from outside the group meanwhile doesn't run it: main hasn't got the fix", () => {
    setup(["ci-touch", "hop", "--why", "shared code changed: src/x.py"]);
    const o = ok(["ci", "hop"]);
    has(o, "Hop (hop): broken"); has(o, "It runs again once Fix Hop's CI (hop/ci-fix) (merging) is on main");
    assert.equal(t(["ci-next", "--group", "hop"]).code, 1);
  });
  test("  ci-retry still does", () => {
    has(ok(["ci-retry", "hop"]), "Hop: due: a retry was asked for");
    f.edit("tracker/groups/hop.json", (g) => { delete g.ci.failed.retry; });
  });
  test("the fix on main: due at once", () => {
    setup(["merged", "hop/ci-fix"]);
    has(ok(["ci", "hop"]), "Hop (hop): due: Fix Hop's CI (hop/ci-fix) finished since it failed");
  });
});

describe("a fix's card says what changed since CI last passed", () => {
  test("(a group that passed, then a unit of its own and a change outside it, then a failure)", () => {
    group("ivy", "Ivy"); claim("ivy"); setup(["ci-pass", "ivy", "--evidence", "drill: ok", "--commit", "aaaa1111"]);
    setup(["add-unit", "ivy/b", "--title", "Ivy's second move"]); setup(["done", "ivy/b", "--evidence", "x"]);
    setup(["ci-touch", "ivy", "--why", "shared code changed: src/pose.py"]);
    claim("ivy");
    setup(["ci-fail", "ivy", "--step", "drill", "--commit", "bbbb2222", "--evidence", "drill: 4 rows differ"]);
  });
  test("its own unit finished since, and the change from outside, with the commit it last passed at", () => {
    const d = unit("ivy/ci-fix").detail;
    has(d, "Since it last passed (at aaaa1111): Ivy's second move (ivy/b) finished; shared code changed: src/pose.py.");
  });
});

// With data on a store: the copy of a group's data here can hold outputs of a unit that isn't on
// main yet (the store marks them, work/.store/groups/<g>.unmerged.<unit>). CI's steps run main's
// code on that copy, so CI waits for the unit to land.
describe("CI waits for a unit's unlanded outputs in the copy of its data here", () => {
  const s = trackerRepo("storerepo", { FACTORY_TAG: "worker1", FACTORY_EVIDENCE_MIN: "0", FACTORY_LEASES: "1" });
  test("(a group with data, its CI due, and another group's unit waiting to land with outputs in its copy)", () => {
    s.setup(["init", "--title", "Unlanded outputs"]);
    s.edit("tracker/project.json", (p) => { p.ci = { steps: { drill: { cmd: "just drill {group}" } } }; p.store = { remote: "/nowhere", paths: { out: "work/out/{group}" } }; });
    s.write("code.txt", "code\n"); s.git("add", "code.txt"); s.git("commit", "-q", "-m", "some code");
    s.setup(["add-group", "jay", "--title", "Jay", "--data", "fighter=jay", "--ci", "drill"]);
    s.setup(["add-unit", "jay/a", "--title", "Jay unit"]); s.setup(["done", "jay/a", "--evidence", "x"]);
    s.setup(["add-group", "tools", "--title", "Tools"]);
    s.setup(["add-unit", "tools/fx", "--title", "Effects for every fighter"]);
    s.edit("tracker/groups/tools.json", (g) => { g.units[0].record = { state: "done", by: "worker2", at: ago(5 / 60), evidence: "x", branch: "unit/tools/fx" }; });
    has(s.ok(["ci", "jay"]), "Jay (jay): due");
  });
  test("with nothing marked, the lane is offered it", () => { has(s.ok(["ci-next"]), "Jay (jay): CI due"); });
  test("the store's mark for the unit waiting to land: not offered, and the lane waits, told what for", () => {
    s.write("work/.store/groups/jay.unmerged.tools+fx", "tools/fx\tabc123\n");
    const r = s.t(["ci-next", "--json"]);
    assert.equal(r.code, 1);
    has(r.stdout, '"wait":true');
    has(r.stdout, "Jay (waiting for Effects for every fighter (tools/fx) (merging) to land: its outputs are in the copy of its data here, made by code main hasn't got)");
  });
  test("  the unit on main: offered", () => {
    s.setup(["merged", "tools/fx"]);
    has(s.ok(["ci-next"]), "Jay (jay): CI due");
  });
  test("  a unit stuck on the owner holds nothing (CI would wait on them)", () => {
    s.setup(["add-unit", "tools/gx", "--title", "More effects"]);
    s.setup(["block", "tools/gx", "--why", "needs a call"]);
    s.write("work/.store/groups/jay.unmerged.tools+gx", "tools/gx\tabc123\n");
    has(s.ok(["ci-next"]), "Jay (jay): CI due");
  });
});
