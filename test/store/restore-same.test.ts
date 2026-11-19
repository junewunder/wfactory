// A set built from a commit other than the one the branch is on now: put back only when the
// project's ci.affected hook, asked about the group alone (FACTORY_CI_AFFECTED_ONLY), answers
// "<group>\tunchanged"; refused when it names the group, says nothing of it, or fails. A commit this
// clone hasn't got is fetched from origin first, and one nobody has is refused. And the commit a
// set records is the head of the branch the loop says its session worked on, even when the tracker
// no longer records that branch (a review that asked for fixes clears it before the session's end
// is settled). Driven by store.sh in lane a. Run: node --test test/store/
// Setup goes before a test's checks, so a failing check can't skip it.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { has, hasnt, readOr, cmd, chomp } from "../lib/index.ts";
import { storeFactory, ONE } from "./factory.ts";

const f = storeFactory(["a"]);
const { add, store, asides, group } = f;
const [a] = f.lanes;
const G = "f8";
const log8 = () => readOr(a.at(`work/out/${G}/log.txt`));
const setOf = (u: string) => asides(a, G).find((x) => readOr(path.join(x, ".units")).split("\n").includes(u)) ?? "";
const fromOf = (u: string) => readOr(path.join(setOf(u), ".from")).split("\t")[2] ?? "";
const ok = (args: string[]) => { const r = store(a, args); assert.equal(r.code, 0, `store.sh ${args.join(" ")}: ${r.stdout}${r.stderr}`); return r; };
const git = (...args: string[]) => { const r = cmd("git", args, { cwd: a.dir, env: a.envWith() }); assert.equal(r.code, 0, `git ${args.join(" ")}: ${r.stderr}`); return chomp(r.stdout); };
// The hook: what it was asked, then what MODE says (unchanged, changed, silent, fail).
const lk = (x: string) => path.join(a.locks, x);
fs.writeFileSync(lk("affected.sh"), `#!/bin/bash
echo "$FACTORY_CI_AFFECTED_ONLY $1..$2" >> "${lk("affected.calls")}"
case "$(cat "${lk("affected.mode")}")" in
  unchanged) printf '%s\\tunchanged\\n' "$FACTORY_CI_AFFECTED_ONLY" ;;
  changed) printf '%s\\tstage fx (src/fx.py)\\n' "$FACTORY_CI_AFFECTED_ONLY" ;;
  silent) ;;
  fail) echo "planning failed" >&2; exit 1 ;;
esac
`, { mode: 0o755 });
const mode = (m: string) => fs.writeFileSync(lk("affected.mode"), m);
const calls = () => readOr(lk("affected.calls")).trim().split("\n").filter(Boolean);

group(G);
add(`${G}/r0`, "--reads", "none");
a.loop(ONE);
f.editMain("tracker/project.json", (p) => { p.ci = { ...(p.ci ?? {}), affected: `${lk("affected.sh")} {old} {new}` }; });
git("pull", "-q", "--ff-only", "origin", "main");

// A unit's session ends unfinished on its branch, here at HEAD (tracked: the claim records the
// branch, as the loop's does; given: end is told it): its outputs are set aside.
let leased = false;
function endUnfinished(u: string, { tracked = true, given = "" } = {}) {
  add(u, "--reads", "none");
  if (!leased) { a.setup(["lease", "take", G]); ok(["take", G]); leased = true; }
  a.setup(["claim", u], tracked ? { FACTORY_BRANCHES: "1", FACTORY_TAG: `s-${u}` } : { FACTORY_TAG: `s-${u}` });
  git("branch", "-f", `unit/${u}`, "HEAD");
  ok(["dirty", G, u, String(process.pid)]);
  fs.appendFileSync(a.at(`work/out/${G}/log.txt`), `${u} on a\n`);
  ok(["end", G, u, "c", ...(given ? [given] : [])]);
  assert.ok(setOf(u), `no set for ${u}`);
}
// main moves on in this clone: a code change, so HEAD isn't the commit the set was built from.
let n = 0;
const moveOn = () => { fs.writeFileSync(a.at(`code-${++n}.txt`), `${n}\n`); git("add", "-A"); git("commit", "-qm", `code ${n}`); return git("rev-parse", "HEAD"); };
const restore = (u: string) => store(a, ["restore", G, u]);
const settle = (u: string) => { f.drop(u); store(a, ["aside", "sort"]); assert.equal(setOf(u), "", `${u}'s set stays`); };

describe("built from another commit: put back only when the hook says the group's build is unchanged", () => {
  test("the hook says unchanged: put back, and the session is told whose commit they're from", () => {
    endUnfinished(`${G}/u1`);
    const built = fromOf(`${G}/u1`), now = moveOn();
    assert.equal(built, git("rev-parse", "HEAD~1"));
    mode("unchanged");
    const r = restore(`${G}/u1`);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    has(r.stdout, `built from ${built.slice(0, 8)}, whose inputs to ${G}'s build are the same as your branch's) are back in work/`);
    has(r.stderr, `${G}'s build inputs are unchanged`);
    assert.deepEqual(calls().slice(-1), [`${G} ${built}..${now}`]);
    has(log8(), `${G}/u1 on a`);
    assert.equal(setOf(`${G}/u1`), "");
  });
  test("the hook names the group: not put back, with its why", () => {
    endUnfinished(`${G}/u2`);
    moveOn(); mode("changed");
    const r = restore(`${G}/u2`);
    assert.equal(r.code, 3, r.stdout + r.stderr);
    has(r.stdout, `they were not put back (ci.affected over`);
    has(r.stdout, `says ${G}'s build changed: stage fx (src/fx.py)). Rebuild them`);
    hasnt(log8(), `${G}/u2 on a`);
    assert.ok(setOf(`${G}/u2`), "the set went");
  });
  test("the hook says nothing of the group (one that ignores FACTORY_CI_AFFECTED_ONLY): not put back", () => {
    mode("silent");
    const r = restore(`${G}/u2`);
    assert.equal(r.code, 3);
    has(r.stdout, `didn't say ${G}'s build is unchanged`);
    hasnt(log8(), `${G}/u2 on a`);
  });
  test("the hook fails: not put back, with its last line", () => {
    mode("fail");
    const r = restore(`${G}/u2`);
    assert.equal(r.code, 3);
    has(r.stdout, `couldn't say whether ${G}'s build changed (exit 1: planning failed)`);
    hasnt(log8(), `${G}/u2 on a`);
    settle(`${G}/u2`);
  });
});

describe("a commit this clone hasn't got", () => {
  test("on origin only (pushed from another clone): fetched, then judged", () => {
    endUnfinished(`${G}/u3`);
    // The branch went on elsewhere: its head now is a commit only origin has.
    const other = f.w.at("other-clone");
    f.w.git(f.w.top, "clone", "-q", f.origin, other);
    fs.writeFileSync(path.join(other, "elsewhere.txt"), "x\n");
    f.w.git(other, "add", "-A"); f.w.git(other, "commit", "-qm", "elsewhere");
    const far = f.w.git(other, "rev-parse", "HEAD").trim();
    f.w.git(other, "push", "-q", "origin", "HEAD:refs/heads/unit/elsewhere");
    assert.notEqual(cmd("git", ["cat-file", "-e", `${far}^{commit}`], { cwd: a.dir, env: a.envWith() }).code, 0, "lane a has it already");
    const fp = path.join(setOf(`${G}/u3`), ".from");
    fs.writeFileSync(fp, readOr(fp).replace(/^([^\t]*\t[^\t]*\t)[^\t]*/, `$1${far}`));
    mode("unchanged");
    const r = restore(`${G}/u3`);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    has(r.stdout, `built from ${far.slice(0, 8)}, whose inputs`);
    has(log8(), `${G}/u3 on a`);
  });
  test("one nobody has: not put back", () => {
    endUnfinished(`${G}/u4`);
    const fp = path.join(setOf(`${G}/u4`), ".from");
    fs.writeFileSync(fp, readOr(fp).replace(/^([^\t]*\t[^\t]*\t)[^\t]*/, `$1${"d".repeat(40)}`));
    const r = restore(`${G}/u4`);
    assert.equal(r.code, 3);
    has(r.stdout, "which this clone hasn't got and couldn't fetch from origin");
    hasnt(log8(), `${G}/u4 on a`);
    settle(`${G}/u4`);
  });
});

describe("the commit a set records", () => {
  test("the tracker records no branch for the unit: the branch end is given says it", () => {
    endUnfinished(`${G}/u5`, { tracked: false, given: `unit/${G}/u5` });
    assert.equal(chomp(a.run("factory/tracker", ["state", `${G}/u5`, "--branch"]).stdout), "");
    assert.equal(fromOf(`${G}/u5`), git("rev-parse", "HEAD"));
    settle(`${G}/u5`);
  });
  test("  and with neither, none is recorded, and it's never put back", () => {
    endUnfinished(`${G}/u6`, { tracked: false });
    assert.equal(fromOf(`${G}/u6`), "");
    mode("unchanged");
    const r = restore(`${G}/u6`);
    assert.equal(r.code, 3);
    has(r.stdout, "were built from commit (unknown)");
    has(r.stdout, "no record of the commit they were built from");
    settle(`${G}/u6`);
  });
});
