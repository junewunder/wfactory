// scripts/to-stubs.sh, and factory-diff.sh on the factories it converts: one carrying copies of
// the loop's scripts from before the stubs (refusals, copies with edits of their own, --force,
// what it keeps) and one with a file it can't compare. Run: node --test test/scripts/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { workspace, cmd, has, hasnt, chomp, ROOT } from "../lib/index.ts";

const w = workspace();
const ts = (...a: string[]) => w.script("to-stubs", a, { merged: true });
const fdOut = (...a: string[]) => { const r = w.script("factory-diff", a); assert.equal(r.code, 0, r.stderr); return r.stdout; };
const skillGit = (...a: string[]) => w.git(ROOT, ...a);
// A file as the skill's history has it, byte for byte (as `git show <rev>:<path> > file`).
const blob = (rev: string, p: string) => cmd("git", ["show", `${rev}:${p}`], { cwd: ROOT, env: w.env }).stdout;
const same = (a: string, b: string) => fs.readFileSync(a).equals(fs.readFileSync(b));
const isX = (f: string) => (fs.statSync(f).mode & 0o111) !== 0;
// The skill's first runtime/loop.sh: what a factory from before the stubs carries a copy of.
const first = skillGit("log", "--diff-filter=A", "--format=%H", "--", "runtime/loop.sh").split("\n").at(-1)!;
const T = path.join(ROOT, "template/factory");

// A repo at top/<name> with these files, committed.
// exec: those to make executable first.
function repo(name: string, files: Record<string, string>, { msg = "copies", exec = [] as string[] } = {}) {
  const d = w.at(name);
  fs.mkdirSync(d);
  w.git(d, "init", "-q");
  for (const [f, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), text); }
  for (const f of exec) fs.chmodSync(path.join(d, f), 0o755);
  w.git(d, "add", "-A"); w.git(d, "commit", "-qm", msg);
  return d;
}

// A factory from before the stubs: copies of the loop's scripts.
const C = w.at("copies");
const cat = (f: string) => fs.readFileSync(path.join(C, f), "utf8");
const gitC = (...a: string[]) => w.git(C, ...a);

describe("a factory with copies", () => {
  repo("copies", {
    "factory/loop.sh": blob(first, "runtime/loop.sh"),
    "factory/session.sh": blob(first, "runtime/session.sh"),
    "factory/prompt.local.md": "rules\n",
    "factory/auto-mode.json": '{"autoMode":{"allow":["mine"]}}\n',
    ".gitignore": "/runs/\n",
  }, { exec: ["factory/loop.sh"] });
  const out = fdOut(C);
  test("factory-diff: a factory with copies, says to convert it", () => { has(out, `factory/ carries copies of the loop's scripts, from before the stubs: convert it once with scripts/to-stubs.sh ${C}`); });
  test("the project's own", () => { has(out, "the project's own (kept): prompt.local.md auto-mode.json"); });
});

describe("to-stubs.sh", () => {
  test("to-stubs: no factory/", () => { assert.equal(ts(w.top).code, 2); });
  test("to-stubs --help", () => { has(ts("--help").stdout, "to-stubs.sh <factory repo> [--force]"); });
  test("to-stubs: uncommitted changes in factory/, exit 2", () => {
    fs.appendFileSync(path.join(C, "factory/loop.sh"), "# mine\n");
    assert.equal(ts(C).code, 2);
  });
  test("says so", () => { has(ts(C).stdout, `factory/ in ${C} has uncommitted changes; commit them first`); });
  let r = { code: 0, stdout: "" };
  test("to-stubs: a copy with edits of its own, exit 1", () => {
    gitC("commit", "-qam", "own edit");
    r = ts(C);
    assert.equal(r.code, 1);
  });
  test("names it", () => { has(r.stdout, "have edits of their own (they match no version of the skill's): loop.sh"); });
  test("not a copy that matches a version", () => { hasnt(r.stdout, "session.sh"); });
  test("and converts nothing", () => { assert.ok(!fs.existsSync(path.join(C, "factory/skill"))); });
  test("to-stubs: converts", () => {
    fs.writeFileSync(path.join(C, "factory/loop.sh"), blob(first, "runtime/loop.sh"));
    gitC("commit", "-qam", "back to the skill's");
    r = ts(C);
    assert.equal(r.code, 0, r.stdout);
    has(r.stdout, `${C}: factory/ now holds stubs that run the deployed skill (staged; commit it).`);
  });
  test("says what to run", () => { has(r.stdout, "Run `factory/tracker status` there once"); });
  test("the stubs over the copies", () => {
    assert.ok(same(path.join(C, "factory/loop.sh"), path.join(T, "loop.sh")));
    assert.ok(fs.existsSync(path.join(C, "factory/skill")) && fs.existsSync(path.join(C, "factory/deploy")));
  });
  test("executable", () => { assert.ok(isX(path.join(C, "factory/loop.sh"))); });
  test("removes the copies the stubs replace", () => { assert.ok(!fs.existsSync(path.join(C, "factory/session.sh"))); });
  test("keeps the project's own", () => { assert.equal(chomp(cat("factory/prompt.local.md")), "rules"); });
  test("and its auto-mode.json", () => { assert.equal(chomp(cat("factory/auto-mode.json")), '{"autoMode":{"allow":["mine"]}}'); });
  test("adds /.tracker/ to .gitignore", () => { has(cat(".gitignore"), "/.tracker/"); });
  test("stages it", () => { has(gitC("status", "--porcelain"), "D  factory/session.sh"); });
  test("all of it", () => { has(gitC("status", "--porcelain"), "M  factory/loop.sh"); });
  test("never commits", () => { assert.equal(gitC("log", "--oneline").split("\n").length, 3); });
});

// A file in factory/ git can't hash (an old layout's factory/tracker folder): nothing converted.
describe("a file it can't compare", () => {
  const C3 = repo("copies3", { "factory/tracker/x": "x\n", "factory/loop.sh": blob(first, "runtime/loop.sh") });
  const r = ts(C3, "--force");
  test("to-stubs: a file it can't compare stops it", () => { assert.equal(r.code, 2); });
  test("names it", () => { has(r.stdout, "factory/tracker"); });
  test("converting nothing", () => {
    assert.ok(!fs.existsSync(path.join(C3, "factory/skill")));
    assert.equal(w.git(C3, "status", "--porcelain"), "");
  });
});

// A copy with edits of its own, converted anyway with --force; a factory with no auto-mode.json.
describe("--force", () => {
  const C2 = repo("copies2", { "factory/loop.sh": "# mine\n" });
  test("to-stubs: refuses own edits", () => { assert.equal(ts(C2).code, 1); });
  test("to-stubs --force: converts anyway", () => {
    const r = ts(C2, "--force");
    assert.equal(r.code, 0, `exit ${r.code}\n${r.stdout}${r.stderr}`);
    has(r.stdout, "now holds stubs");
  });
  test("the template's auto-mode.json where there's none", () => { assert.ok(same(path.join(C2, "factory/auto-mode.json"), path.join(T, "auto-mode.json"))); });
});
