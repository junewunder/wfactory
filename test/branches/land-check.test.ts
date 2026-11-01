// The check before a unit lands (tracker/project.json ci.land) and the ci.affected hook, through the
// loop: a passing check lands the branch, having seen the unit and its claim time; a failing one
// doesn't, and the unit goes back to ready on its pushed branch with the check's last line; a group
// whose CI is broken lands without one. A code change pushed to main outside the lanes makes the
// groups the hook names due at the next look, and their CI runs. Run: node --test test/branches/
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { has, hasnt, readOr } from "../lib/index.ts";
import { branchFactory, ONE } from "./factory.ts";

const f = branchFactory(["c"]);
const [c] = f.lanes;
const { add } = f;
const lk = (x: string) => path.join(c.locks, x);
const remote = (br: string) => c.git("ls-remote", "origin", `refs/heads/${br}`);
// The check: what it was given, then its verdict, failing while land-rc says so.
fs.writeFileSync(lk("land.sh"), `#!/bin/bash
echo "group=$1 unit=$FACTORY_UNIT since=$FACTORY_UNIT_SINCE" >> "${lk("land.calls")}"
rc=$(cat "${lk("land-rc")}" 2>/dev/null || echo 0)
echo "a row that passed"
echo "drill: out/g-x.txt isn't what HEAD builds (rc $rc)"
exit $rc
`, { mode: 0o755 });
// The hook: the range it was given, and the group g for anything.
fs.writeFileSync(lk("affected.sh"), `#!/bin/bash
echo "$1..$2" >> "${lk("affected.calls")}"
printf 'g\\tshared code changed: shared.txt\\n'
`, { mode: 0o755 });
// (Runs of minutes: no least time before last call for its CI groups' units.)
f.editMain("tracker/project.json", (p) => { p.ci = { steps: { drill: { cmd: "true" } }, land: { cmd: `${lk("land.sh")} {group}` } }; p.ci_every = 0; p.min_unit_minutes = 0; });
c.setup(["edit-group", "g", "--ci", "drill"]);
const calls = () => readOr(lk("land.calls")).split("\n").filter(Boolean);

describe("the check before landing passes: the branch lands", () => {
  let out = "";
  test("a unit finished", () => { add("ok"); out = c.loop(ONE); });
  test("  checked, and landed", () => {
    has(out, `land check: ${lk("land.sh")} g`);
    has(out, "land check: Unit ok (g/ok) passed");
    has(out, "unit/g/ok merged into main");
    assert.ok(f.main("out/g-ok.txt"));
  });
  test("  the check was given the unit and when it was claimed", () => {
    assert.match(calls()[0], /^group=g unit=g\/ok since=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  });
});

describe("the check before landing fails: not landed, the unit back to ready on its branch", () => {
  let out = "";
  test("a unit finished, its check failing", () => {
    fs.writeFileSync(lk("land-rc"), "1\n");
    add("bad");
    out = c.loop(ONE);
  });
  test("  not landed", () => {
    has(out, "land check: Unit bad (g/bad) failed (exit 1): drill: out/g-x.txt isn't what HEAD builds (rc 1)");
    hasnt(out, "unit/g/bad merged into main");
    assert.equal(f.main("out/g-bad.txt"), "");
  });
  test("  its branch pushed, and its unit ready with the check's last line", () => {
    assert.notEqual(remote("unit/g/bad"), "");
    assert.equal(c.ok(["state", "g/bad"]), "ready");
    has(c.ok(["show", "g/bad"]), "The check before landing failed (fix what it found, then finish again): drill: out/g-x.txt isn't what HEAD builds (rc 1)");
  });
  test("  fixed, the next session carries it on and it lands", () => {
    fs.rmSync(lk("land-rc"));
    has(c.loop(ONE), "unit/g/bad merged into main");
    assert.equal(c.ok(["state", "g/bad"]), "done");
  });
});

describe("a group whose CI is broken: no check before landing", () => {
  test("a unit lands without one", () => {
    c.setup(["ci-fail", "g", "--evidence", "drill: broken on purpose"]);
    fs.writeFileSync(lk("land-rc"), "1\n");
    const n = calls().length;
    add("brk");
    const out = c.loop(ONE);
    has(out, "land check: none for Unit brk (g/brk): Group's CI is broken");
    has(out, "unit/g/brk merged into main");
    assert.equal(calls().length, n);
    fs.rmSync(lk("land-rc"));
  });
});

describe("the ci.affected hook: a code change pushed outside the lanes touches the groups it names", () => {
  const scratch = f.w.at("main-edit");
  const pushCode = (file: string) => {
    f.w.git(scratch, "fetch", "-q", "origin"); f.w.git(scratch, "reset", "-q", "--hard", "origin/main");
    fs.appendFileSync(path.join(scratch, file), "more\n");
    f.w.git(scratch, "commit", "-qam", `change ${file}`); f.w.git(scratch, "push", "-q", "origin", "HEAD:main");
    return f.w.git(scratch, "rev-parse", "HEAD").trim();
  };
  let first = "";
  test("the first look records main's code commit, and runs nothing", () => {
    c.setup(["ci-pass", "g", "--evidence", "drill passed by hand"]);
    f.editMain("tracker/project.json", (p) => { p.ci.affected = `${lk("affected.sh")} {old} {new}`; });
    first = f.w.git(scratch, "log", "-1", "--format=%H", "origin/main", "--", ".", ":(exclude)tracker").trim();
    has(c.loop(ONE), "ci.affected: the first run; covering from main's code at");
    assert.equal(readOr(lk("affected.calls")), "");
    assert.equal(JSON.parse(c.ok(["ci-affected", "--json"])).at, first);
  });
  test("  a code change pushed to main: the next look runs it over that range, and the group's CI comes due and runs", () => {
    const second = pushCode("shared.txt");
    const out = c.loop(ONE);
    has(out, `ci.affected: ${first.slice(0, 8)}..${second.slice(0, 8)}: CI touched: Group`);
    assert.equal(readOr(lk("affected.calls")).trim(), `${first}..${second}`);
    assert.ok(out.indexOf("ci: Group (g) passed") > out.indexOf("ci.affected: "), out);
    has(c.ok(["ci", "g"]), `passed (drill) ${second.slice(0, 8)}`);
    has(c.ok(["log", "-n", "40"]), "CI touched: shared code changed: shared.txt");
  });
});
