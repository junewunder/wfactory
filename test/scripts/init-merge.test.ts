// scripts/init.sh merged into an existing project: AGENTS.md, the justfile's import, placeholder
// recipes, clashing recipe names, .gitignore, a hand-written memory index, CLAUDE.md,
// never overwriting, a second run; and a stub that can't run. Run: node --test test/scripts/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { workspace, has, hasnt } from "../lib/index.ts";

const w = workspace();
w.profile();
// A project at top/<name>, a repo with these files.
function project(name: string, files: Record<string, string>) {
  const d = w.at(name);
  fs.mkdirSync(d);
  w.git(d, "init", "-q");
  for (const [f, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), text); }
  return d;
}
const initIn = (d: string) => {
  const r = w.script("init", ["."], { cwd: d });
  assert.equal(r.code, 0, `init.sh .: exit ${r.code}\n${r.stdout}${r.stderr}`);
  return r.stdout;
};

describe("init.sh merged into an existing project", () => {
  const E = project("existing", {
    "AGENTS.md": "# Existing\n\nOwn rules.\n",
    "docs/factory.md": "# My spec\n",
    "justfile": 'set shell := ["bash", "-c"]\n# a comment between settings\nset dotenv-load\n\nbuild:\n    echo build\n\nstatus:\n    echo mine\n',
    ".gitignore": "/runs/\nnode_modules\n",
    "memory/MEMORY.md": "# Memory\n\n- [A note](a.md)\n",
    "CLAUDE.md": "Own claude rules.\n",
  });
  const read = (f: string) => fs.readFileSync(path.join(E, f), "utf8");
  const out = initIn(E);
  test("init.sh .: the current folder", () => { has(out, `Factory layer for 'existing' in ${E}`); });
  test("appends a Factory section to AGENTS.md", () => { has(out, "merged:  AGENTS.md (Factory section)"); });
  test("the section", () => { has(read("AGENTS.md"), "## Factory"); });
  test("which points at the reference's departures", () => { has(read("AGENTS.md"), "unless `docs/departures.md` says otherwise"); });
  test("and lays that page down", () => { has(out, "created: docs/departures.md"); });
  test("after what was there", () => { has(read("AGENTS.md").split("\n").slice(0, 3).join("\n"), "Own rules."); });
  test("never overwrites a file", () => { assert.equal(read("docs/factory.md"), "# My spec\n"); });
  test("so doesn't list it as made", () => { hasnt(out, "created: docs/factory.md"); });
  test("adds the import to the justfile", () => { has(out, "merged:  justfile (import)"); });
  test("after the last setting", () => { assert.equal(read("justfile").split("\n").slice(2, 6).join("|"), "set dotenv-load||import 'factory/factory.just'|"); });
  test("a placeholder check", () => { has(out, "merged:  justfile (placeholder check)"); });
  test("and rebuildable", () => { has(out, "merged:  justfile (placeholder rebuildable)"); });
  test("the placeholder recipe", () => { has(read("justfile"), "check:"); });
  test("warns of a recipe named like the factory's", () => { has(out, "CHECK:   justfile already has a 'status' recipe: the project's wins over the factory's"); });
  test("adds the missing .gitignore lines", () => { has(out, "merged:  .gitignore (/.tracker/)"); });
  test("and only those", () => { hasnt(out, "merged:  .gitignore (/runs/)"); });
  test(".gitignore", () => { assert.equal(read(".gitignore").replace(/\n+$/, "").split("\n").join("|"), "/runs/|node_modules|/.scratch/|/.tracker/|/work"); });
  test("a hand-written memory index", () => { has(out, "CHECK:   memory/MEMORY.md is written by hand"); });
  test("a CLAUDE.md without AGENTS.md", () => { has(out, "CHECK:   CLAUDE.md exists and doesn't import AGENTS.md"); });
  test("makes the tracker", () => { assert.ok(fs.statSync(path.join(E, "tracker/project.json")).isFile()); });

  describe("init.sh again", () => {
    // Run in its first test, not here: a describe's body runs before any test, and the checks
    // above read the files as the first run left them.
    let again = "";
    test("init.sh again: nothing more merged", () => { again = initIn(E); hasnt(again, "merged:"); });
    test("nothing more made", () => { hasnt(again, "created:"); });
    test("one import", () => { assert.equal(read("justfile").split("\n").filter((l) => l.includes("factory/factory.just")).length, 1); });
    test("still warns", () => { has(again, "CHECK:   justfile already has a 'status' recipe"); });
    test("its tracker already there: no opening's gate to pass", () => { hasnt(again, "just pass opening/ready"); });
  });
});

describe("a justfile spelled Justfile, with no settings and a check of its own", () => {
  const E2 = project("existing2", { "Justfile": "check:\n    echo own\n" });
  const out = initIn(E2);
  test("init.sh: merges into Justfile", () => { assert.ok(!fs.readdirSync(E2).includes("justfile")); });
  test("the import first, with no settings", () => { assert.equal(fs.readFileSync(path.join(E2, "Justfile"), "utf8").split("\n")[0], "import 'factory/factory.just'"); });
  test("keeps the project's check, and says it's the oracle", () => { has(out, "CHECK:   Justfile already has a 'check' recipe: the factory treats it as the oracle"); });
  test("no placeholder check", () => { hasnt(out, "placeholder check"); });
});

// No deployed skill, none chosen by hand, no checkout to deploy from: just can't find the recipes.
describe("nothing deployed", () => {
  const r = w.script("init", ["nodeploy"], { add: { FACTORY_SKILL: undefined } });
  test("init.sh: a stub that can't run says what to do", () => { assert.equal(r.code, 0); has(r.stdout, "CHECK:   factory/tracker didn't run: deploy the skill"); });
});
