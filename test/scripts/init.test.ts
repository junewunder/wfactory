// scripts/init.sh in a new folder: what it lays down, the machines file from the profile, --dir,
// and its refusals. Run: node --test test/scripts/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { workspace, cmd, has, hasnt, HOST } from "../lib/index.ts";

const w = workspace();
const P = w.profile();
const full = fs.readFileSync(P, "utf8");
const F = w.at("fresh");
const read = (p: string) => fs.readFileSync(path.join(F, p), "utf8");
const isX = (f: string) => (fs.statSync(f).mode & 0o111) !== 0;

describe("init.sh in a new folder", () => {
  const r = w.script("init", ["fresh"]);
  test("init.sh: says where", () => { assert.equal(r.code, 0); has(r.stdout, `Factory layer for 'fresh' in ${F}`); });
  test("lists what it made", () => { has(r.stdout, "created: AGENTS.md"); });
  test("the tracker", () => { has(r.stdout, "created: tracker/"); });
  test("and a repo", () => { has(r.stdout, "created: .git"); });
  test("and what's next: the opening", () => { has(r.stdout, "Next: the opening"); });
  test("the tracker holds the opening's gate, waiting on the owner", () => {
    const s = cmd(path.join(F, "factory/tracker"), ["state", "opening/ready"], { cwd: F, env: w.env });
    assert.equal(s.stdout.trim(), "you");
  });
  for (const f of ["AGENTS.md", "CLAUDE.md", "justfile", "docs/factory.md", "docs/machines.md", "docs/tools.md", "memory/MEMORY.md", "factory/factory.just", "factory/skill", "factory/tracker", "factory/loop.sh", "tracker/project.json"]) {
    test(`makes ${f}`, () => { assert.ok(fs.existsSync(path.join(F, f))); });
  }
  test("keeps the stubs executable", () => { assert.ok(isX(path.join(F, "factory/loop.sh")) && isX(path.join(F, "factory/tracker"))); });
  test("and the sourced ones not", () => { assert.ok(!isX(path.join(F, "factory/skill"))); });
  test("fills in the project's name", () => {
    const docs = fs.readdirSync(path.join(F, "docs")).filter((f) => f.endsWith(".md")).map((f) => read(`docs/${f}`));
    hasnt([read("AGENTS.md"), ...docs].join(""), "__PROJECT__");
  });
  test("the tracker's title is the project's", () => { has(read("tracker/project.json"), '"title": "fresh"'); });
  const co = F.startsWith(`${os.homedir()}/`) ? `~/${F.slice(os.homedir().length + 1)}` : F;
  test("the machines file, a row per machine", () => { has(read("docs/machines.md"), `| ${HOST} | ${HOST} | 1 | any | ${co} | — | — | 1 |`); });
  test("a section per machine", () => { has(read("docs/machines.md"), `## ${HOST}`); });
  test("no store", () => { has(read("docs/machines.md"), "- **Cache:** `work/` in the checkout; no store"); });
  test("can do anything", () => { has(read("docs/machines.md"), "- **Can do:** anything any machine can"); });
  test("no markers left", () => { hasnt(read("docs/machines.md"), "__MACHINE_"); });
  test("just finds the recipes (.tracker/skill)", () => { assert.ok(fs.lstatSync(path.join(F, ".tracker/skill")).isSymbolicLink()); });
  test("never commits", () => { assert.equal(cmd("git", ["log", "--oneline"], { cwd: F, env: w.env }).stdout, ""); });
});

describe("init.sh --dir, with a store and a machine that can do something only it can", () => {
  fs.writeFileSync(P, full
    .replace(/^\| store \| none \|/m, "| store | nas:/tank/f |")
    .replace(`| ${HOST} | ${HOST} | 1 | 1 | — | — |`, `| ${HOST} | box.lan | 2 | 3 | gpu | /scratch |`));
  w.init("two", { dir: w.at("sub") });
  fs.writeFileSync(P, full);
  const m = fs.readFileSync(w.at("sub/two/docs/machines.md"), "utf8");
  test("init.sh --dir: under that folder, the profile's columns", () => { has(m, `| ${HOST} | box.lan | 2 | any |`); });
  test("can and cache", () => { has(m, "| gpu | /scratch | 3 |"); });
  test("a store", () => { has(m, "- **Cache:** `work/` in the checkout; the store is `nas:/tank/f` (the profile)"); });
  test("what the Can column means is the owner's to fill", () => { has(m, "- **Can do:** <fill: what each name in this machine's Can column (gpu) means>"); });
});

describe("init.sh refusals", () => {
  test("init.sh: no name", () => { assert.equal(w.script("init", []).code, 2); });
  test("an unknown option", () => { assert.equal(w.script("init", ["x", "--frob"]).code, 2); });
  test("two names", () => { assert.equal(w.script("init", ["x", "y"]).code, 2); });
  test("init.sh --help", () => { has(w.script("init", ["--help"]).stdout, "init.sh <project-name> [--dir <parent>]"); });
  const half = w.at("half.md");
  fs.writeFileSync(half, `${full}<fill: more>\n`);
  const r = w.script("init", ["half"], { add: { WFACTORY_PROFILE: half }, merged: true });
  test("refuses with a profile not filled in", () => { assert.equal(r.code, 2); });
  test("and says so", () => { has(r.stdout, `init: fill in the profile first (${half}; install.md says how)`); });
  test("making nothing", () => { assert.ok(!fs.existsSync(w.at("half"))); });
});
