// The tracker CLI end to end: group CI worked out from a group's units: off, stale, due, running,
// passed and broken; last call; publishing off; a dead run, a failure and the 6-hour rule; a
// failure a merge kept; a step that ships; a template's CI. Run: node --test tracker/test/
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { trackerRepo, has, hasnt, sleep, ago } from "../../test/lib/index.ts";

const f = trackerRepo("repo", { FACTORY_TAG: "worker1", FACTORY_EVIDENCE_MIN: "0" });
const { t, ok, setup } = f;
setup(["init", "--title", "Test port"]);

// Moves a group's unit records a minute back. Times are to the second, and a unit done in the
// same second as a CI failure counts as finished since it, so CI would read due, not broken.
const backdate = (group: string) => f.edit(`tracker/groups/${group}.json`, (g) => {
  const a = new Date(Date.now() - 60e3).toISOString().replace(/\.\d+Z$/, "Z");
  for (const u of g.units) if (u.record && u.record.at > a) u.record.at = a;
});
// Is <group> among the busy groups `tracker busy` printed (space-separated)?
const busy = (out: string, group: string) => ` ${out.replace(/\n+$/, "")} `.includes(` ${group} `);
const codeHead = (...fmt: string[]) => f.git("log", "-1", ...fmt, "--", ".", ":(exclude)tracker");

describe("group CI: stale, due, passed, worked out from the group's units", () => {
  test("--ci with an unknown step is refused", () => {
    f.edit("tracker/project.json", (p) => { p.ci = { steps: { drill: { cmd: "just drill {group}" }, publish: { cmd: "just publish {group}" } } }; });
    f.write("code.txt", "code\n"); f.git("add", "code.txt"); f.git("commit", "-q", "-m", "some code");
    assert.equal(t(["add-group", "cx", "--title", "CI typo", "--ci", "drill,lint"]).code, 2);
  });
  test("a group with nothing done has CI off", () => {
    setup(["add-group", "ca", "--title", "CI fighter", "--ci", "drill,publish"]);
    setup(["add-unit", "ca/a", "--title", "CI unit a"]);
    setup(["add-unit", "ca/b", "--title", "CI unit b"]);
    setup(["add-group", "cb", "--title", "CI other group"]);
    setup(["add-unit", "cb/x", "--title", "Other group's unit"]);
    has(ok(["ci"]), "off (nothing done yet)");
  });
  test("and a group without a ci block is listed as no CI", () => { has(ok(["ci"]), "No CI:"); });
  test("work left tonight: stale", () => {
    setup(["done", "ca/a", "--evidence", "x"]);
    has(ok(["ci"]), "CI fighter (ca): stale: it hasn't passed yet; 1 unit still to work tonight");
  });
  test("ci-start refuses CI that isn't due", () => { assert.equal(t(["ci-start", "ca"]).code, 2); });
  test("an interrupted unit keeps it stale", () => {
    setup(["claim", "ca/b"]); f.tryIn(["claim", "ca/b"], { FACTORY_PID: "999999" });
    f.edit("tracker/groups/ca.json", (g) => { const u = g.units.find((u: any) => u.id === "ca/b"); u.record.pid = 999999; u.record.start = "1"; });
    has(ok(["ci", "ca"]), "stale");
  });
  test("everything left waits on the owner: due", () => {
    setup(["ask", "--title", "Which way should CI unit b go?", "--context", "x", "--option", "a|A|x", "--option", "b|B|y", "--default", "a", "--blocks", "ca/b", "--force"]);
    setup(["reopen", "ca/b"]);
    has(ok(["ci"]), "CI fighter (ca): due: it hasn't passed yet");
  });
  test("status shows it", () => { has(ok(["status"]), "CI: 1 due (CI fighter)"); });
  test("status <group> too", () => { has(ok(["status", "ca"]), "CI: due"); });
  test("--json for the loop", () => { has(ok(["ci", "--json"]), '"group":"ca","state":"due"'); });
  test("ci-start prints the steps", () => { has(ok(["ci-start", "ca"]), "drill (just drill {group}); publish"); });
  test("running", () => { has(ok(["ci", "ca"]), "running (session worker1"); });
  test("busy: a group whose CI runs here", () => { assert.ok(busy(ok(["busy"]), "ca")); });
  test("a second start is refused", () => { assert.equal(t(["ci-start", "ca"]).code, 2); });
  test("ci-pass needs evidence", () => { assert.equal(t(["ci-pass", "ca"]).code, 2); });
  test("passed, with the commit", () => {
    setup(["ci-pass", "ca", "--evidence", "drill matched; published v3"]);
    has(ok(["ci", "ca"]), `passed (drill, publish) ${codeHead("--format=%h", "--abbrev=8")}`);
  });
  test("an answer alone leaves it passed", () => {
    setup(["answer", f.json("tracker/questions.json").questions.at(-1).id, "a"]);
    has(ok(["ci", "ca"]), "passed");
  });
  test("a unit finished after the pass: stale, and due once nothing's left", () => {
    setup(["done", "ca/b", "--evidence", "y"]);
    has(ok(["ci", "ca"]), "due: CI unit b (ca/b) finished since it passed");
  });
  test("a reopened unit makes it stale", async () => {
    setup(["ci-pass", "ca", "--evidence", "again"]);
    await sleep(1000);
    setup(["reopen", "ca/a"]);
    has(ok(["ci", "ca"]), "stale: CI unit a (ca/a) reopened since it passed");
  });
  test("done again: due", () => {
    setup(["done", "ca/a", "--evidence", "z"]);
    has(ok(["ci", "ca"]), "due: CI unit a (ca/a) finished since it passed");
  });
  test("a new unit makes it stale", () => {
    setup(["ci-pass", "ca", "--evidence", "again"]);
    setup(["add-unit", "ca/c", "--title", "CI unit c"]);
    has(ok(["ci", "ca"]), "stale: CI unit c (ca/c) added since it passed");
  });
  test("last call: a ready unit is done for the night, so it's due", () => {
    has(ok(["ci", "ca"], { FACTORY_LAST_CALL: "1" }), "due: CI unit c (ca/c) added since it passed");
  });
  test("one in progress keeps it stale", () => {
    setup(["claim", "ca/c"]);
    has(ok(["ci", "ca"], { FACTORY_LAST_CALL: "1" }), "1 unit still to land before last call ends");
  });
  test("and ci-next says to wait for it", () => { has(t(["ci-next", "--json"], { FACTORY_LAST_CALL: "1" }).stdout, '"wait":true'); });
  test("without last call, nothing to wait for", () => { has(t(["ci-next", "--json"]).stdout, '"wait":false'); });
  test("parked: due", () => {
    setup(["unclaim", "ca/c"]);
    setup(["park", "ca/c", "--why", "after the playtest"]);
    has(ok(["ci", "ca"]), "due: CI unit c (ca/c) added since it passed");
  });
  test("parking or dropping doesn't make it stale", () => {
    setup(["ci-pass", "ca", "--evidence", "again"]);
    setup(["drop", "ca/c", "--why", "test"]);
    has(ok(["ci", "ca"]), "passed");
  });
});

describe("needs in another group: done for the night only if what they need is", () => {
  test("a need elsewhere that's ready: stale", () => {
    setup(["add-unit", "ca/d", "--title", "CI unit d", "--needs", "cb/x"]);
    has(ok(["ci", "ca"]), "stale: CI unit d (ca/d) added");
  });
  test("that need stuck: due", () => {
    setup(["block", "cb/x", "--why", "Steam is down"]);
    has(ok(["ci", "ca"]), "due: CI unit d (ca/d) added");
  });
  after(() => {
    setup(["reopen", "cb/x"]); setup(["done", "cb/x", "--evidence", "x"]); setup(["done", "ca/d", "--evidence", "x"]);
    setup(["ci-pass", "ca", "--evidence", "again"]);
  });
});

describe("work not on main yet", () => {
  test("a unit still merging keeps it stale", async () => {
    await sleep(1000);
    setup(["reopen", "ca/d"]);
    setup(["claim", "ca/d"], { FACTORY_BRANCHES: "1" }); setup(["done", "ca/d", "--evidence", "br"], { FACTORY_BRANCHES: "1" });
    has(ok(["ci", "ca"]), "stale");
  });
  test("merged: due", () => {
    setup(["merged", "ca/d"]);
    has(ok(["ci", "ca"]), "due");
  });
});

describe("last call: work that can't start any more doesn't hold CI back (issue #27)", () => {
  const B = { FACTORY_BRANCHES: "1" };
  test("last call: a unit done since the pass and one ready: due", async () => {
    setup(["add-group", "lf", "--title", "Last call fighter", "--ci", "drill"]);
    for (const u of ["a", "b", "c"]) setup(["add-unit", `lf/${u}`, "--title", `Last call unit ${u}`]);
    setup(["done", "lf/a", "--evidence", "x"]); setup(["ci-pass", "lf", "--evidence", "first"]);
    await sleep(1000);
    setup(["done", "lf/b", "--evidence", "y"]);
    has(ok(["ci", "lf"], { FACTORY_LAST_CALL: "1" }), "due: Last call unit b (lf/b) finished since it passed");
  });
  // A session that claims a second unit works it on its own branch, so the two land together; the
  // second's own branch would never exist, and it showed as merging (holding CI) all night.
  test("a session's second claim is on the branch it's working", () => {
    setup(["reopen", "lf/b"]); setup(["claim", "lf/b"], { ...B, FACTORY_TAG: "lcs" });
    setup(["claim", "lf/c"], { ...B, FACTORY_TAG: "lcs" });
    has(ok(["state", "lf/c", "--branch"]), "unit/lf/b");
  });
  test("last call waits for the session's unit", () => {
    setup(["done", "lf/c", "--evidence", "done alongside b"], { ...B, FACTORY_TAG: "lcs" });
    has(t(["ci-next", "--json", "--group", "lf"], { FACTORY_LAST_CALL: "1" }).stdout, '"wait":true');
  });
  test("and the wait names the work in flight", () => {
    has(t(["ci-next", "--json", "--group", "lf"], { FACTORY_LAST_CALL: "1" }).stdout,
      "Last call fighter: Last call unit b (lf/b) in progress on testhost, Last call unit c (lf/c) merging on testhost");
  });
  test("landing that branch lands both", () => {
    setup(["done", "lf/b", "--evidence", "on its branch"], { ...B, FACTORY_TAG: "lcs" });
    setup(["merged", "--branch", "unit/lf/b"]);
    has(ok(["state", "lf/c"]), "done");
  });
  test("and last call's CI is due", () => { has(ok(["ci", "lf"], { FACTORY_LAST_CALL: "1" }), "due"); });
  // The other order: the session's first unit is recorded (merging) before it claims the second.
  test("a claim after the session's first unit is recorded: that unit's branch too", () => {
    setup(["reopen", "lf/b"]); setup(["reopen", "lf/c"]);
    setup(["claim", "lf/b"], { ...B, FACTORY_TAG: "lct" }); setup(["done", "lf/b", "--evidence", "first"], { ...B, FACTORY_TAG: "lct" });
    setup(["claim", "lf/c"], { ...B, FACTORY_TAG: "lct" });
    has(ok(["state", "lf/c", "--branch"]), "unit/lf/b");
  });
  test("and it lands with it", () => {
    setup(["done", "lf/c", "--evidence", "second"], { ...B, FACTORY_TAG: "lct" });
    setup(["merged", "--branch", "unit/lf/b"]);
    has(ok(["state", "lf/c"]), "done");
  });
  after(() => {
    setup(["ci-pass", "lf", "--evidence", "again"]);
  });
});

describe("publish off: CI passes without the publish step; on again, it's stale", () => {
  test("publish off: only the drill runs", () => {
    setup(["publish", "off"]);
    has(ok(["ci-start", "ca"]), "drill (just drill {group})");
  });
  test("and it's off in tracker ci", () => { has(ok(["ci"]), "Publishing: off"); });
  test("a drill-only pass", () => {
    setup(["ci-pass", "ca", "--evidence", "drill-only"]);
    has(ok(["ci", "ca"]), "passed (drill)");
  });
  test("publish on again: due", () => {
    setup(["publish", "on"]);
    has(ok(["ci", "ca"]), "due: its last pass didn't run publish");
  });
});

// A changed command in project.json is a tracker-only commit, which the ci.affected hook never
// sees: groups that passed under the old command stayed green under the new one.
describe("a step's command changed since the pass: due", () => {
  test("the pass records a hash of each step's command", () => {
    setup(["ci-pass", "ca", "--evidence", "both steps"]);
    assert.deepEqual(Object.keys(f.json("tracker/groups/ca.json").ci.passed.cmds), ["drill", "publish"]);
    has(ok(["ci", "ca"]), "passed (drill, publish)");
  });
  test("a changed command makes it due, naming the step", () => {
    f.edit("tracker/project.json", (p) => { p.ci.steps.drill.cmd = "just drill --strict {group}"; });
    has(ok(["ci", "ca"]), "due: the command of its drill step changed since it passed");
  });
  test("a pass under the new command settles it", () => {
    setup(["ci-pass", "ca", "--evidence", "strict drill"]);
    has(ok(["ci", "ca"]), "passed (drill, publish)");
  });
  test("a pass from before the hashes were kept isn't compared", () => {
    f.edit("tracker/groups/ca.json", (g) => { delete g.ci.passed.cmds; });
    f.edit("tracker/project.json", (p) => { p.ci.steps.drill.cmd = "just drill {group}"; });
    has(ok(["ci", "ca"]), "passed (drill, publish)");
  });
  // Due again, as the drill-only pass above left it, for the checks below.
  after(() => { f.edit("tracker/groups/ca.json", (g) => { g.ci.passed.steps = ["drill"]; }); });
});

describe("a run whose session died, then a failure", () => {
  test("a dead run is due again", () => {
    setup(["ci-start", "ca"]);
    f.edit("tracker/groups/ca.json", (g) => { g.ci.running.pid = 999999; g.ci.running.start = "1"; });
    has(ok(["ci", "ca"]), "due: its last run (session worker1 on testhost) stopped without a result");
  });
  test("failed: broken", () => {
    // ca/d was done moments ago
    backdate("ca");
    setup(["ci-fail", "ca", "--evidence", "drill: 3 files differ"]);
    has(ok(["ci", "ca"]), "broken: drill: 3 files differ");
  });
  test("status says so", () => { has(ok(["status"]), "CI: 1 broken (CI fighter)"); });
  test("main moved, but not 6 hours yet: still broken", () => {
    f.write("code.txt", "more\n"); f.git("commit", "-q", "-am", "a fix");
    has(ok(["ci", "ca"]), "broken");
  });
  test("main moved and 6 hours passed: due", () => {
    f.edit("tracker/groups/ca.json", (g) => {
      g.ci.passed.at = ago(8); g.ci.failed.at = ago(7);
      for (const u of g.units) if (u.record) u.record.at = ago(9);
    });
    has(ok(["ci", "ca"]), "due: main has moved since it failed");
  });
  test("broken, and a step's command changed since it failed: due now", () => {
    setup(["ci-fail", "ca", "--evidence", "drill: wrong flag"]);
    has(ok(["ci", "ca"]), "broken: drill: wrong flag");
    f.edit("tracker/project.json", (p) => { p.ci.steps.drill.cmd = "just drill --fixed {group}"; });
    has(ok(["ci", "ca"]), "due: the command of its drill step changed since it failed");
    f.edit("tracker/project.json", (p) => { p.ci.steps.drill.cmd = "just drill {group}"; });
  });
  test("ci-retry: due now", () => {
    setup(["ci-fail", "ca", "--evidence", "drill: still differs"]);
    setup(["ci-retry", "ca"]);
    has(ok(["ci", "ca"]), "due: a retry was asked for");
  });
  test("a pass clears it", () => {
    setup(["ci-pass", "ca", "--evidence", "fixed"]);
    has(ok(["ci", "ca"]), "passed");
  });
  test("a rename doesn't make it stale", () => {
    setup(["rename", "ca/d", "ca/dee"]);
    has(ok(["ci", "ca"]), "passed");
  });
  test("lint accepts CI", () => { assert.equal(t(["lint", "--broken"]).code, 0); });
  test("--ci none turns it off", () => {
    setup(["edit-group", "ca", "--ci", "none"]);
    has(ok(["ci", "ca"]), "No CI: ");
  });
});

describe("group CI: more ways a group is or isn't done for the night", () => {
  test("needs two groups away that are ready: stale", () => {
    // Done for the night alone, not the time it has been stale (ci_every; that has tests of its own).
    f.edit("tracker/project.json", (p) => { p.ci_every = 0; });
    setup(["edit-group", "ca", "--ci", "drill,publish"]);
    setup(["add-group", "cc", "--title", "CI chain end"]);
    setup(["add-unit", "cc/y", "--title", "End of a chain"]);
    setup(["add-unit", "cb/z", "--title", "Middle of a chain", "--needs", "cc/y"]);
    setup(["add-unit", "ca/e", "--title", "Start of a chain", "--needs", "cb/z"]);
    has(ok(["ci", "ca"]), "stale");
  });
  test("and waiting on the owner two groups away: due", () => {
    setup(["ask", "--title", "Should the chain end go left or right?", "--context", "x", "--option", "a|A|x", "--option", "b|B|y", "--default", "a", "--blocks", "cc/y", "--force"]);
    has(ok(["ci", "ca"]), "due");
  });
  test("a gate waiting on the owner doesn't hold CI back", () => {
    f.edit("tracker/groups/ca.json", (g) => { g.units.push({ id: "ca/g", title: "A gate in a CI group", kind: "gate" }); });
    has(ok(["ci", "ca"]), "due");
  });
  test("(the unit waits on the editor)", () => {
    f.edit("tracker/project.json", (p) => { p.resources = { editor: { title: "the level editor", free: { cmd: "test ! -e busy" } } }; });
    setup(["add-unit", "ca/r", "--title", "Uses the editor", "--uses", "editor"]);
    f.write("busy", "");
    has(ok(["state", "ca/r"]), "resource");
  });
  test("a unit waiting on a resource is work left", () => {
    has(ok(["ci", "ca"]), "stale");
  });
  after(() => {
    fs.rmSync(f.at("busy"));
    setup(["drop", "ca/r", "--why", "test"]); setup(["drop", "ca/e", "--why", "test"]);
    f.edit("tracker/project.json", (p) => { delete p.ci_every; });
  });
});

describe("a failure a merge kept", () => {
  test("so the newer failure isn't retried", () => {
    f.edit("tracker/groups/ca.json", (g) => {
      if (g.ci.passed) g.ci.passed.at = ago(8);
      g.ci.failed = { commit: "x", at: ago(1), evidence: "newer fail", retry: ago(2) };
      for (const u of g.units) if (u.record) u.record.at = ago(9);
    });
    has(ok(["ci", "ca"]), "broken: newer fail");
  });
  test("a failure older than the last pass (both kept by a merge) isn't broken", () => {
    f.edit("tracker/groups/ca.json", (g) => {
      g.ci.failed = { commit: "x", at: "2026-01-01T00:00:00Z", evidence: "old fail" };
      g.ci.passed = { commit: "x", at: "2026-06-01T00:00:00Z", evidence: "ok", steps: ["drill", "publish"], done: [], open: [] };
    });
    hasnt(ok(["ci", "ca"]), "broken");
  });
  test("6 hours passed but main hasn't moved (a short commit): still broken", () => {
    const short = codeHead("--format=%h");
    f.edit("tracker/groups/ca.json", (g) => { g.ci.failed = { commit: short, at: ago(7), evidence: "new fail" }; });
    has(ok(["ci", "ca"]), "broken: new fail");
  });
  test("ci-pass --steps must be the group's", () => {
    setup(["ci-retry", "ca"]); setup(["ci-start", "ca"]); setup(["ci-pass", "ca", "--evidence", "ok"]);
    assert.equal(t(["ci-pass", "ca", "--evidence", "x", "--steps", "lint"]).code, 2);
  });
});

describe("a step that ships under another name; a publish-only group with publishing off", () => {
  test("edit-group --ci keeps the CI history", () => {
    f.edit("tracker/project.json", (p) => { p.ci.steps.upload = { cmd: "just upload", publish: true }; });
    setup(["edit-group", "ca", "--ci", "drill,upload"]);
    has(ok(["ci", "ca"]), "last passed");
  });
  let out = "";
  test("a step marked publish is skipped while publishing is off", () => {
    setup(["publish", "off"]);
    out = ok(["ci-start", "ca", "--force"]);
    has(out, "Steps: drill (just drill {group})");
  });
  test("only the drill", () => { hasnt(out, "upload"); });
  test("a publish-only group with publishing off is off", () => {
    setup(["ci-pass", "ca", "--evidence", "ok"]);
    setup(["add-group", "cp", "--title", "Publish only", "--ci", "upload"]); setup(["add-unit", "cp/a", "--title", "Publish-only unit"]); setup(["done", "cp/a", "--evidence", "x"]);
    has(ok(["ci", "cp"]), "off (publishing is off, and it only publishes)");
  });
  after(() => {
    setup(["publish", "on"]);
  });
});

describe("a template's CI; a unit moved to another group", () => {
  test("a group from a template with ci gets it", () => {
    f.write("tracker/templates/fighter.json", `{ "name": "fighter", "title": "{Name}", "ci": { "steps": ["drill", "publish"] },
  "units": [ { "slug": "rig", "title": "{Name}'s rig" } ] }
`);
    setup(["add", "sol", "--template", "fighter"]);
    has(ok(["ci", "sol"]), "Sol (sol): off (nothing done yet)");
  });
  test("a unit moved out leaves the old group with nothing done", () => {
    setup(["done", "sol/rig", "--evidence", "x"]); setup(["ci-pass", "sol", "--evidence", "ok"]);
    setup(["rename", "sol/rig", "ca/rig"]);
    has(ok(["ci", "sol"]), "Sol (sol): off (nothing done yet)");
  });
  test("and leaves its old group's CI lists", () => {
    hasnt(JSON.stringify(f.json("tracker/groups/sol.json").ci.passed ?? null), "rig");
  });
  test("lint accepts all that", () => { assert.equal(t(["lint", "--broken"]).code, 0); });
});

describe("a group's needs hold its CI as they hold its units", () => {
  test("a gate the group needs holds its CI until it's passed", () => {
    setup(["add-group", "cgate", "--title", "Gates for CI"]);
    setup(["add-unit", "cgate/crew", "--gate", "--title", "The crew is ready"]);
    setup(["add-group", "cheld", "--title", "Fighter behind a gate", "--ci", "drill"]);
    setup(["add-unit", "cheld/a", "--title", "Held fighter's unit"]);
    setup(["done", "cheld/a", "--evidence", "x"]);
    setup(["edit-group", "cheld", "--needs", "cgate/crew"]);
    has(ok(["ci"]), "Fighter behind a gate (cheld): off (it waits on The crew is ready (cgate/crew))");
  });
  test("and passing the gate lets it run", () => {
    setup(["pass", "cgate/crew"]);
    hasnt(ok(["ci"]), "it waits on The crew is ready");
  });
});
