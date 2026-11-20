// With an origin, the tracker's state is a branch of it that holds tracker/ and nothing else:
// `state-branch` moves it there from main once (both branches in one push), every other command
// refuses until then, and after it a write is a commit on that branch and never on main. A new
// clone finds the state with no tracker/ of its own. The settings and the templates, which are
// in no checkout then, are read and changed through `project` and `template`.
// Run: node --test tracker/test/
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { trackerRepo, has, hasnt, cmd, TRACKER, STATE_BRANCH } from "../../test/lib/index.ts";

const f = trackerRepo("repo");
const { setup, ok } = f;
setup(["init", "--title", "State branch"]);
setup(["add-group", "g", "--title", "Group"]);
setup(["add-unit", "g/a", "--title", "First unit"]);
f.git("add", "-A"); f.git("commit", "-qm", "a tracker");
f.git("branch", "-q", "-M", "main");
const bare = path.join(f.top, "origin.git");
f.git("clone", "-q", "--bare", f.dir, bare);
f.git("remote", "add", "origin", bare);
const origin = (...a: string[]) => cmd("git", ["--git-dir", bare, ...a], { cwd: f.top, env: f.env });
const count = (branch: string) => Number(origin("rev-list", "--count", branch).stdout.trim());
const files = (branch: string, dir = "") => origin("ls-tree", "--name-only", branch, ...(dir ? [dir] : [])).stdout.trim().split("\n").filter(Boolean);
const run = (a: string[], cwd = f.dir) => cmd(process.execPath, [TRACKER, ...a], { cwd, env: f.env });

describe("a factory that has an origin, its state still on main", () => {
  test("a command refuses, and says how to move it", () => {
    const r = run(["status"]);
    assert.equal(r.code, 2, r.stdout + r.stderr);
    has(r.stderr, "tracker state-branch");
    has(r.stderr, "FACTORY_STATE=local");
  });
  test("  a write too, and nothing is written", () => {
    const before = count("main");
    assert.equal(run(["note", "g/a", "A note that must not land"]).code, 2);
    assert.equal(count("main"), before);
    hasnt(f.read("tracker/groups/g.json"), "must not land");
  });
  test("  FACTORY_STATE=local keeps the state in this checkout", () => { has(ok(["status"], { FACTORY_STATE: "local" }), "0 of 1 done"); });
  test("state-branch refuses while this checkout's tracker/ has what origin's main lacks", () => {
    f.edit("tracker/groups/g.json", (g) => { g.title = "Changed here only"; });
    const r = run(["state-branch"]);
    assert.equal(r.code, 2, r.stdout);
    has(r.stderr, "isn't what origin's main has");
    f.git("checkout", "-q", "--", "tracker");
  });
  test("  and nothing moved", () => { assert.equal(origin("rev-parse", "-q", "--verify", STATE_BRANCH).code, 1); has(files("main").join(" "), "tracker"); });
});

describe("state-branch moves the state to its branch", () => {
  let mainBefore = 0;
  test("it says so", () => {
    mainBefore = count("main");
    has(ok(["state-branch"]), `the state is origin's ${STATE_BRANCH} branch now`);
  });
  test("  the branch holds tracker/ and nothing else, in one commit", () => { assert.deepEqual(files(STATE_BRANCH), ["tracker"]); assert.equal(count(STATE_BRANCH), 1); });
  test("  with the state as it was", () => { has(origin("show", `${STATE_BRANCH}:tracker/groups/g.json`).stdout, "First unit"); });
  test("  main has one more commit, which takes tracker/ out and nothing else", () => {
    assert.equal(count("main"), mainBefore + 1);
    assert.ok(!files("main").includes("tracker"), files("main").join(" "));
    assert.ok(origin("diff", "--name-only", "main~1", "main").stdout.trim().split("\n").every((x) => x.startsWith("tracker/")));
  });
  test("  this checkout came along: on that commit, with no tracker/ folder", () => {
    assert.equal(f.git("rev-parse", "HEAD"), origin("rev-parse", "main").stdout.trim());
    assert.ok(!fs.existsSync(f.at("tracker")));
  });
  test("  and the tracker works from the branch", () => { has(ok(["status"]), "0 of 1 done"); });
  test("a second time, there's nothing to move", () => { has(ok(["state-branch"]), "already"); assert.equal(count(STATE_BRANCH), 1); });
});

describe("a write is a commit on the state branch, and never on main", () => {
  test("a note: one commit on the state branch, none on main", () => {
    const s = count(STATE_BRANCH), m = count("main");
    ok(["note", "g/a", "Seen on the branch"]);
    assert.equal(count(STATE_BRANCH), s + 1);
    assert.equal(count("main"), m);
    has(origin("log", "-1", "--format=%s", STATE_BRANCH).stdout, "tracker: First unit");
  });
  test("  this checkout's tree is as it was", () => { assert.equal(f.git("status", "--porcelain"), ""); });
  test("main's newest commit is still what CI goes by: the state's clone has main's commits too", () => {
    setup(["project", "set", "ci", JSON.stringify({ steps: { drill: { cmd: "true" } } })]);
    setup(["edit-group", "g", "--ci", "drill"]);
    f.write("code.txt", "work\n"); f.git("add", "code.txt"); f.git("commit", "-qm", "work"); f.git("push", "-q", "origin", "main");
    setup(["ci-start", "g", "--force"], { FACTORY_FETCH_EVERY: "0" }); setup(["ci-pass", "g", "--evidence", "drill passed on main's code"]);
    has(ok(["ci", "g"]), f.git("rev-parse", "HEAD").slice(0, 8));
  });
});

describe("a new clone finds the state, with no tracker/ of its own", () => {
  const c = path.join(f.top, "clone");
  test("a command in a new clone reads the state", () => {
    cmd("git", ["clone", "-q", bare, c], { cwd: f.top, env: f.env });
    assert.ok(!fs.existsSync(path.join(c, "tracker")));
    has(run(["show", "g/a"], c).stdout, "Seen on the branch");
  });
  test("  from a folder inside it too", () => {
    fs.mkdirSync(path.join(c, "src", "deep"), { recursive: true });
    has(run(["status"], path.join(c, "src", "deep")).stdout, "0 of 1 done");
    assert.ok(!fs.existsSync(path.join(c, "src", "deep", ".tracker")), "a second .tracker/ was made in the subfolder");
  });
  test("  its write reaches the first checkout", () => {
    assert.equal(run(["note", "g/a", "Written in the clone"], c).code, 0);
    has(ok(["show", "g/a"], { FACTORY_FETCH_EVERY: "0" }), "Written in the clone");
  });
  test("  and init there makes no second tracker", () => {
    has(run(["init"], c).stdout, "on origin's state branch already");
    assert.ok(!fs.existsSync(path.join(c, "tracker")));
  });
  test("a worktree inside the checkout has a root, and a copy of the state, of its own", () => {
    const wt = f.at("wt");
    f.git("worktree", "add", "-q", "-b", "side", wt);
    try {
      assert.equal(run(["dir", "--sync"], wt).stdout.trim(), path.join(wt, ".tracker", "state", "tracker"));
      has(run(["show", "g/a"], wt).stdout, "Written in the clone");
    } finally { f.git("worktree", "remove", "--force", wt); f.git("branch", "-q", "-D", "side"); }
  });
});

describe("the settings, which are in no checkout: project", () => {
  test("project prints them", () => { has(ok(["project"]), '"title": "State branch"'); });
  test("project set writes one, as JSON", () => {
    has(ok(["project", "set", "resources.desk", '{"title": "The desk"}']), "resources.desk set");
    assert.equal(JSON.parse(ok(["project", "get", "resources.desk"])).title, "The desk");
  });
  test("  in one commit on the state branch", () => { has(origin("log", "-1", "--format=%s", STATE_BRANCH).stdout, "settings: resources.desk set"); });
  test("  a value that isn't JSON is a string", () => { ok(["project", "set", "review_model", "some-model"]); assert.equal(ok(["project", "get", "review_model"]).trim(), "some-model"); });
  test("  a number stays a number", () => { ok(["project", "set", "ci_every", "0"]); assert.equal(JSON.parse(ok(["project"])).ci_every, 0); });
  test("project unset takes one out", () => {
    has(ok(["project", "unset", "review_model"]), "review_model taken out");
    assert.equal(run(["project", "get", "review_model"]).code, 1);
  });
  test("a change that would break the data is refused, and nothing is written", () => {
    const before = count(STATE_BRANCH);
    const r = run(["project", "set", "publish", "maybe"]);
    assert.equal(r.code, 2, r.stdout);
    has(r.stderr, "would be broken");
    has(r.stderr, "neither on nor off");
    assert.equal(count(STATE_BRANCH), before);
    assert.equal(run(["project", "get", "publish"]).code, 1);
  });
  test("  taking out what a unit needs, too", () => {
    setup(["add-unit", "g/desk", "--title", "A unit at the desk", "--uses", "desk"]);
    const r = run(["project", "unset", "resources.desk"]);
    assert.equal(r.code, 2, r.stdout);
    has(r.stderr, "uses unknown resource desk");
  });
  test("the tracker's own keys aren't settings", () => { assert.equal(run(["project", "set", "schema", "9"]).code, 2); });
});

describe("the templates, which are in no checkout: template", () => {
  const file = path.join(f.top, "module.json");
  test("none yet", () => { has(ok(["template"]), "(no templates)"); });
  test("template <name> --from <file> writes one", () => {
    fs.writeFileSync(file, JSON.stringify({ title: "Module {name}", units: [{ slug: "parse", title: "Parse {name}" }] }));
    has(ok(["template", "module", "--from", file]), "template module added");
    assert.deepEqual(files(STATE_BRANCH, "tracker/templates/"), ["tracker/templates/module.json"]);
  });
  test("  it's listed, and printed", () => { assert.equal(ok(["template"]).trim(), "module"); has(ok(["template", "module"]), "Parse {name}"); });
  test("  and makes a group's units", () => {
    ok(["add", "lexer", "--template", "module"]);
    has(ok(["status", "lexer"]), "Parse lexer (lexer/parse)");
  });
  test("  written again, it's replaced, and sync adds what it now makes", () => {
    fs.writeFileSync(file, JSON.stringify({ title: "Module {name}", units: [{ slug: "parse", title: "Parse {name}" }, { slug: "print", title: "Print {name}" }] }));
    has(ok(["template", "module", "--from", file]), "template module replaced");
    ok(["sync", "lexer"]);
    has(ok(["status", "lexer"]), "Print lexer (lexer/print)");
  });
  test("a file that isn't a template is refused", () => {
    fs.writeFileSync(file, "[1, 2]");
    assert.equal(run(["template", "other", "--from", file]).code, 2);
    assert.equal(ok(["template"]).trim(), "module");
  });
  test("the data isn't broken after all that", () => { has(ok(["lint", "--broken"]), "no broken data"); });
});
