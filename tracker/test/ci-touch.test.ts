// The tracker CLI end to end: work outside a group makes its CI stale (ci-touch, and the ci.affected
// hook's bookkeeping, ci-affected), and the check before a unit lands (ci-land, land-fail).
// Run: node --test tracker/test/
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { trackerRepo, has, hasnt, sleep, ago } from "../../test/lib/index.ts";

const f = trackerRepo("repo", { FACTORY_TAG: "worker1", FACTORY_EVIDENCE_MIN: "0" });
const { t, ok, setup } = f;
setup(["init", "--title", "Test port"]);
f.edit("tracker/project.json", (p) => { p.ci = { steps: { drill: { cmd: "just drill {group}" } } }; });

// A commit of code (outside tracker/), its full ID.
const commit = (file: string) => {
  f.write(file, `${file}\n`); f.git("add", file); f.git("commit", "-q", "-m", `change ${file}`);
  return f.git("rev-parse", "HEAD").trim();
};
// A group's CI record, edited by hand (to move a time back).
const ciOf = (g: string, fn: (ci: any) => void) => f.edit(`tracker/groups/${g}.json`, (j) => fn(j.ci));

describe("ci-touch: a change outside the group makes its CI stale, then due", () => {
  test("a passed group with work left", () => {
    commit("shared.py");
    setup(["add-group", "ta", "--title", "Touched fighter", "--ci", "drill"]);
    setup(["add-unit", "ta/a", "--title", "Touched unit a"]);
    setup(["add-unit", "ta/b", "--title", "Touched unit b"]);
    setup(["done", "ta/a", "--evidence", "done"]);
    setup(["ci-pass", "ta", "--evidence", "drill matched"]);
    has(ok(["ci", "ta"]), "passed");
  });
  test("ci-touch needs a why, and a group with CI", () => {
    assert.equal(t(["ci-touch", "ta"]).code, 2);
    setup(["add-group", "tn", "--title", "No CI group"]);
    assert.equal(t(["ci-touch", "tn", "--why", "x"]).code, 2);
  });
  test("touched after the pass: stale, with the why and the commit", async () => {
    await sleep(1000);
    const c = commit("hit_fx.py");
    has(ok(["ci-touch", "ta", "--why", "shared code changed: src/hit_fx.py", "--commit", c]), "stale");
    has(ok(["ci", "ta"]), `stale: shared code changed: src/hit_fx.py (${c.slice(0, 8)}); 1 unit still to work tonight`);
  });
  test("  stale ci_every minutes: due", () => {
    f.edit("tracker/groups/ta.json", (g) => { g.units[0].record.at = ago(5); g.ci.passed.at = ago(4); g.ci.touched.at = ago(3); });
    has(ok(["ci", "ta"]), "due: shared code changed: src/hit_fx.py");
  });
  test("  nothing left in the group: due at once", () => {
    ciOf("ta", (ci) => { ci.touched.at = new Date().toISOString().replace(/\.\d+Z$/, "Z"); });
    setup(["drop", "ta/b", "--why", "test"]);
    has(ok(["ci", "ta"]), "due: shared code changed: src/hit_fx.py");
  });
  test("a pass after it covers it", async () => {
    await sleep(1000);
    setup(["ci-pass", "ta", "--evidence", "drill matched again"]);
    has(ok(["ci", "ta"]), "passed");
  });
  test("a touch whose commit the last pass tested isn't news", async () => {
    const c = f.git("log", "-1", "--format=%H", "HEAD~1").trim();
    await sleep(1000);
    ok(["ci-touch", "ta", "--why", "an older change", "--commit", c]);
    has(ok(["ci", "ta"]), "passed");
  });
});

describe("ci-touch after a failure: tried again", () => {
  test("a broken group", async () => {
    setup(["add-group", "tb", "--title", "Broken fighter", "--ci", "drill"]);
    setup(["add-unit", "tb/a", "--title", "Broken unit a"]);
    setup(["done", "tb/a", "--evidence", "done"]);
    f.edit("tracker/groups/tb.json", (g) => { g.units[0].record.at = ago(1); });
    setup(["ci-fail", "tb", "--evidence", "drill: mismatch"]);
    has(ok(["ci", "tb"]), "broken: drill: mismatch");
  });
  test("  touched since: due again, as for a unit finished since", async () => {
    await sleep(1000);
    const c = commit("tool.py");
    ok(["ci-touch", "tb", "--why", "shared code changed: tool.py", "--commit", c]);
    has(ok(["ci", "tb"]), `due: shared code changed: tool.py (${c.slice(0, 8)}) since it failed`);
  });
});

describe("ci-affected: the hook's bookkeeping", () => {
  test("no hook: none", () => {
    assert.deepEqual(JSON.parse(ok(["ci-affected", "--json"])), { cmd: null, at: null });
  });
  test("with one: the command, nothing covered yet", () => {
    f.edit("tracker/project.json", (p) => { p.ci.affected = "factory/affected {old} {new}"; });
    assert.deepEqual(JSON.parse(ok(["ci-affected", "--json"])), { cmd: "factory/affected {old} {new}", at: null });
    has(ok(["lint", "--broken"]), "");
  });
  test("a run recorded: its groups touched, one with no CI or none such skipped, the commit covered", async () => {
    await sleep(1000);
    const c = commit("shared2.py");
    f.write("touches.tsv", "ta\tshared code changed: shared2.py\ntn\tnot CI\nnope\tno such group\n\n");
    const out = ok(["ci-affected", c, "--touches", f.at("touches.tsv")], { FACTORY_CI_EVIDENCE: "loop" });
    has(out, "CI touched: Touched fighter; skipped: tn (no CI), nope (no such group)");
    assert.equal(JSON.parse(ok(["ci-affected", "--json"])).at, c);
    has(ok(["ci", "ta"]), `shared code changed: shared2.py (${c.slice(0, 8)})`);
  });
  test("  the log says it once per reason, naming the groups, not once per group", async () => {
    setup(["add-group", "t2", "--title", "Second fighter", "--ci", "drill"]);
    await sleep(1000);
    const c = commit("shared3.py");
    f.write("touches.tsv", "ta\tchanged its build: fbx (shared3.py)\nt2\tchanged its build: fbx (shared3.py)\n");
    ok(["ci-affected", c, "--touches", f.at("touches.tsv")], { FACTORY_CI_EVIDENCE: "loop" });
    const lines = ok(["log", "-n", "10"]).split("\n").filter((l) => l.includes("shared3.py"));
    assert.equal(lines.length, 1, lines.join("\n"));
    has(lines[0], "Touched fighter, Second fighter: CI touched: changed its build: fbx (shared3.py)");
  });
  test("  one behind what's covered doesn't move it back (another machine got further)", () => {
    const old = f.git("log", "-1", "--format=%H", "HEAD~1").trim(), cur = JSON.parse(ok(["ci-affected", "--json"])).at;
    has(ok(["ci-affected", old]), `covered already up to ${cur.slice(0, 8)}`);
    assert.equal(JSON.parse(ok(["ci-affected", "--json"])).at, cur);
  });
  test("lint refuses a hook without {old} and {new}", () => {
    f.edit("tracker/project.json", (p) => { p.ci.affected = "factory/affected"; });
    has(f.t(["lint", "--broken"]).stdout + f.t(["lint", "--broken"]).stderr, "ci.affected");
    f.edit("tracker/project.json", (p) => { p.ci.affected = "factory/affected {old} {new}"; });
  });
});

describe("ci-land: the check before a unit lands", () => {
  test("no ci.land: none", () => {
    setup(["add-group", "tl", "--title", "Landing fighter", "--ci", "drill"]);
    setup(["add-unit", "tl/a", "--title", "Landing unit a"]);
    const j = JSON.parse(ok(["ci-land", "tl/a", "--json"]));
    assert.deepEqual({ ...j, since: "" }, { since: "", checks: [], skipped: [], why: "no ci.land in tracker/project.json" });
  });
  test("with one: its command for the unit's group, the default timeout, and when it was claimed", () => {
    f.edit("tracker/project.json", (p) => { p.ci.land = { cmd: "factory/ci {group} land" }; });
    ok(["claim", "tl/a"]);
    const j = JSON.parse(ok(["ci-land", "tl/a", "--json"]));
    assert.deepEqual(j.checks, [{ group: "tl", title: "Landing fighter", cmd: "factory/ci tl land", timeout: 15, own: true }]);
    assert.deepEqual(j.skipped, []);
    const claimed = f.json("tracker/groups/tl.json").units.find((u: any) => u.id === "tl/a").record.at;
    assert.equal(j.since, claimed);
  });
  test("a group with no CI: none", () => {
    setup(["add-unit", "tn/a", "--title", "No CI unit"]);
    has(ok(["ci-land", "tn/a"]), "none: No CI group has no CI");
  });
  test("CI broken: none", () => {
    setup(["done", "tl/a", "--evidence", "done"]);
    setup(["ci-fail", "tl", "--evidence", "drill: mismatch", "--step", "drill"]);
    has(ok(["ci-land", "tl/a"]), "none: Landing fighter's CI is broken");
  });
  test("  passed again, its ci-fix still open: none", async () => {
    await sleep(1000);
    f.edit("tracker/groups/tl.json", (g) => { g.ci.passed = { at: new Date().toISOString().replace(/\.\d+Z$/, "Z"), by: "x", evidence: "x", steps: ["drill"], done: ["tl/a"], open: [] }; });
    hasnt(ok(["state", "tl/ci-fix"]), "done");
    has(ok(["ci-land", "tl/a"]), "is open");
    setup(["drop", "tl/ci-fix", "--why", "test"]);
    has(ok(["ci-land", "tl/a"]), "factory/ci tl land (15 min");
  });
});

describe("land-fail: the check before landing failed; back to ready on the branch, stuck the third time", () => {
  const B = { FACTORY_BRANCHES: "1", FACTORY_TAG: "lftag" };
  const fin = () => { ok(["claim", "tl/b"], B); ok(["done", "tl/b", "--evidence", "on the branch"], B); };
  test("a unit done on a branch: ready again, the evidence as a note", () => {
    setup(["add-unit", "tl/b", "--title", "Landing unit b"]);
    fin();
    has(ok(["land-fail", "unit/tl/b", "--evidence", "drill: work/tl/x.json differs from what HEAD builds"], { FACTORY_ACTOR: "loop" }), "Landing unit b (tl/b) → ready, on its branch");
    has(ok(["show", "tl/b"]), "The check before landing failed (fix what it found, then finish again): drill: work/tl/x.json differs");
  });
  test("  nothing waiting on the branch: refused", () => { assert.equal(t(["land-fail", "unit/tl/b", "--evidence", "x"]).code, 2); });
  test("  a second time: ready; a third: stuck", () => {
    fin(); has(ok(["land-fail", "unit/tl/b", "--evidence", "again"]), "→ ready");
    fin(); has(ok(["land-fail", "unit/tl/b", "--evidence", "a third time"]), "→ stuck");
    has(ok(["state", "tl/b"]), "stuck");
  });
  test("  reopened by hand: the count starts again", () => {
    ok(["reopen", "tl/b"]);
    fin(); has(ok(["land-fail", "unit/tl/b", "--evidence", "once more"]), "→ ready");
    fin(); has(ok(["land-fail", "unit/tl/b", "--evidence", "and again"]), "→ ready");
  });
  test("  landed: the count starts again too", () => {
    fin(); ok(["merged", "--branch", "unit/tl/b"]);
    assert.equal(f.json("tracker/groups/tl.json").units.find((u: any) => u.id === "tl/b").landCheck, undefined);
  });
});

describe("ci-land's since: the round's first claim, not the latest", () => {
  const B = { FACTORY_BRANCHES: "1", FACTORY_TAG: "rdtag" };
  const unit = () => f.json("tracker/groups/tl.json").units.find((u: any) => u.id === "tl/r");
  const since = () => JSON.parse(ok(["ci-land", "tl/r", "--json"])).since;
  let first = "";
  test("a second claim after a failed check still sees the first attempt's drift", async () => {
    setup(["add-unit", "tl/r", "--title", "Landing unit r"]);
    ok(["claim", "tl/r"], B); first = unit().record.at;
    ok(["done", "tl/r", "--evidence", "on the branch"], B);
    has(ok(["land-fail", "unit/tl/r", "--evidence", "drill: work/tl/r.json differs"], { FACTORY_ACTOR: "loop" }), "→ ready");
    await sleep(1100);
    ok(["claim", "tl/r"], B);
    assert.notEqual(unit().record.at, first, "the second claim is later");
    assert.equal(since(), first);
  });
  test("  a session that ran out and handed it back: the next claim keeps it too", async () => {
    ok(["unclaim", "tl/r"], B);
    await sleep(1100);
    ok(["claim", "tl/r"], B);
    assert.equal(since(), first);
  });
  test("  landed: the next round starts at its own first claim", async () => {
    ok(["done", "tl/r", "--evidence", "fixed"], B); ok(["merged", "--branch", "unit/tl/r"]);
    assert.equal(unit().round, undefined);
    ok(["reopen", "tl/r"]);
    await sleep(1100);
    ok(["claim", "tl/r"], B);
    assert.notEqual(since(), first);
    assert.equal(since(), unit().record.at);
  });
  test("  reopened from done (no branch): a new round too; from stuck: the same round", async () => {
    ok(["done", "tl/r", "--evidence", "fixed"], B); ok(["merged", "--branch", "unit/tl/r"]); ok(["reopen", "tl/r"]);
    ok(["claim", "tl/r"]); ok(["done", "tl/r", "--evidence", "fixed"]);
    has(ok(["state", "tl/r"]), "done");
    assert.ok(unit().round, "done without a branch: nothing landed it");
    ok(["reopen", "tl/r"]); assert.equal(unit().round, undefined);
    ok(["claim", "tl/r"]); const r2 = unit().round;
    ok(["block", "tl/r", "--why", "waits on the overseer"]);
    ok(["reopen", "tl/r"]);
    await sleep(1100);
    ok(["claim", "tl/r"]);
    assert.equal(since(), r2);
  });
  test("  a unit claimed before rounds were kept: its first claim in the log since it last landed", () => {
    f.edit("tracker/groups/tl.json", (g) => { delete g.units.find((u: any) => u.id === "tl/r").round; });
    const log = f.read("tracker/log.jsonl").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.id === "tl/r");
    const after = log.slice(log.map((e) => e.cmd).lastIndexOf("merged") + 1);
    assert.equal(since(), after.find((e) => e.cmd === "claim").at);
    assert.notEqual(since(), log.filter((e) => e.cmd === "claim").at(-1).at);
  });
});

// With a store, the checks cover each group whose data the unit wrote here since its round began
// (#149): its own first, then the others, less those without CI or another unit's at work here.
describe("ci-land: every group whose data the unit wrote here", () => {
  const s = trackerRepo("landrepo", { FACTORY_TAG: "worker1", FACTORY_EVIDENCE_MIN: "0" });
  const json = () => JSON.parse(s.ok(["ci-land", "sa/u", "--json"]));
  const old = new Date(Date.now() - 3600_000);
  test("groups with data, files in each one's copy here from before the claim", () => {
    s.setup(["init", "--title", "Store port"]);
    s.edit("tracker/project.json", (p) => {
      p.ci = { steps: { drill: { cmd: "just drill {group}" } }, land: { cmd: "factory/ci {group} land", timeout: 5 } };
      p.store = { remote: "/nowhere", paths: { out: "work/out/{group}" } };
    });
    for (const [g, title, ci] of [["sa", "Fighter a", true], ["sb", "Fighter b", true], ["sc", "Fighter c", false], ["sd", "Fighter d", true], ["se", "Fighter e", true]] as const) {
      s.setup(["add-group", g, "--title", title, "--data", `fighter=${g}`, ...(ci ? ["--ci", "drill"] : [])]);
      s.setup(["add-unit", `${g}/u`, "--title", `${title}'s unit`]);
      s.write(`work/out/${g}/old.txt`, "from before\n");
      fs.utimesSync(s.at(`work/out/${g}/old.txt`), old, old);
      fs.utimesSync(s.at(`work/out/${g}`), old, old);
    }
    // (As the loop claims, taking the group's lease.)
    s.ok(["claim", "se/u"], { FACTORY_TAG: "other", FACTORY_LEASES: "1" });
    s.ok(["claim", "sa/u"], { FACTORY_LEASES: "1" });
  });
  test("nothing written elsewhere: its own group's check alone", () => {
    const j = json();
    assert.deepEqual(j.checks.map((c: any) => c.group), ["sa"]);
    assert.deepEqual(j.skipped, []);
  });
  test("its session writes b, c and e's data: b's check too; c (no CI) and e (another unit's at work here) skipped and named", () => {
    for (const g of ["sb", "sc", "se"]) s.write(`work/out/${g}/new.txt`, "written by sa/u's session\n");
    const j = json();
    assert.deepEqual(j.checks, [{ group: "sa", title: "Fighter a", cmd: "factory/ci sa land", timeout: 5, own: true }, { group: "sb", title: "Fighter b", cmd: "factory/ci sb land", timeout: 5, own: false }]);
    assert.deepEqual(j.skipped, [{ group: "sc", why: "Fighter c has no CI" }, { group: "se", why: "Fighter e: another unit or CI run here has its data at work, or outputs in it waiting to land" }]);
    const txt = s.ok(["ci-land", "sa/u"]);
    has(txt, "factory/ci sa land (5 min"); has(txt, "factory/ci sb land (5 min");
    has(txt, "skipped: Fighter c has no CI; Fighter e: another unit or CI run here has its data at work, or outputs in it waiting to land");
  });
  test("  the store's marks: another unit's outputs waiting to land in b, or a session working on it, skip it; its own don't", () => {
    s.write("work/.store/groups/sb.unmerged.sd+u", "sd/u\tabc123\n");
    assert.deepEqual(json().checks.map((c: any) => c.group), ["sa"]);
    fs.rmSync(s.at("work/.store/groups/sb.unmerged.sd+u"));
    s.write("work/.store/groups/sb.unmerged.sd+v1.2", "sd/v1.2\tabc123\n");
    assert.deepEqual(json().checks.map((c: any) => c.group), ["sa"], "a unit with a dot in its ID");
    fs.rmSync(s.at("work/.store/groups/sb.unmerged.sd+v1.2"));
    s.write("work/.store/groups/sb.dirty.lane2", "ci\t123\t\n");
    assert.deepEqual(json().checks.map((c: any) => c.group), ["sa"]);
    fs.rmSync(s.at("work/.store/groups/sb.dirty.lane2"));
    s.write("work/.store/groups/sb.unmerged.sa+u", "sa/u\tabc123\n");
    assert.deepEqual(json().checks.map((c: any) => c.group), ["sa", "sb"]);
    fs.rmSync(s.at("work/.store/groups/sb.unmerged.sa+u"));
  });
  test("  a group whose CI is broken: skipped, as for its own", () => {
    s.setup(["ci-fail", "sb", "--evidence", "drill: mismatch", "--step", "drill"]);
    assert.deepEqual(json().checks.map((c: any) => c.group), ["sa"]);
    has(s.ok(["ci-land", "sa/u"]), "Fighter b's CI is broken");
  });
  test("without a store: its own group's check alone, as before", () => {
    s.edit("tracker/project.json", (p) => { delete p.store; });
    const j = json();
    assert.deepEqual(j.checks.map((c: any) => c.group), ["sa"]);
    assert.deepEqual(j.skipped, []);
  });
});
