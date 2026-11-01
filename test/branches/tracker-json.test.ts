// The tracker's JSON merges itself when two clones both changed it (and a real clash is named,
// field and all), and the memory index is rebuilt from its files, never merged by hand.
// Run: node --test test/branches/
import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { cmd, has, TRACKER } from "../lib/index.ts";
import { branchFactory } from "./factory.ts";

const f = branchFactory(["a"]);
const { w } = f;

// Two plain clones whose tracker is local (FACTORY_STATE=local): their tracker/ changes are
// commits of their own, merged by git (through the tracker's merge driver).
const j1 = w.at("j1"), j2 = w.at("j2");
w.git(w.top, "clone", "-q", f.origin, j1); w.git(w.top, "clone", "-q", f.origin, j2);
const jenv = (d: string) => w.envWith({ FACTORY_STATE: "local", FACTORY_HOST: path.basename(d) });
const j = (d: string, args: string[]) => cmd(path.join(d, "factory/tracker"), args, { cwd: d, env: jenv(d), merged: true }).stdout;
const jset = (d: string, args: string[]) => w.setup(args, d, { FACTORY_STATE: "local", FACTORY_HOST: path.basename(d) });
const gitIn = (d: string, args: string[]) => cmd("git", args, { cwd: d, env: w.env, merged: true });

describe("tracker JSON merges itself (two branches that both changed tracker/)", () => {
  test("two branches add to the same group and decisions: the merge goes through", () => {
    jset(j1, ["add-unit", "g/from-one", "--title", "From clone one"]); jset(j1, ["decide", "--title", "One's call", "--why", "test", "--scope", "*"]);
    jset(j2, ["add-unit", "g/from-two", "--title", "From clone two"]); jset(j2, ["decide", "--title", "Two's call", "--why", "test", "--scope", "*"]);
    w.git(j1, "add", "-A", "tracker"); w.git(j1, "commit", "-qm", "one"); w.git(j1, "push", "-q", "origin", "main");
    w.git(j2, "add", "-A", "tracker"); w.git(j2, "commit", "-qm", "two");
    const r = gitIn(j2, ["pull", "-q", "--no-rebase", "--no-edit", "origin", "main"]);
    assert.equal(r.code, 0, r.stdout);
  });
  test("  both units are there", () => { has(j(j2, ["status", "g"]), "From clone one (g/from-one)"); });
  test("  both units are there (2)", () => { has(j(j2, ["status", "g"]), "From clone two (g/from-two)"); });
  test("  both decisions too", () => { has(j(j2, ["decisions", "--all"]), "One's call"); });
  test("  both decisions too (2)", () => { has(j(j2, ["decisions", "--all"]), "Two's call"); });
  test("  and the data isn't broken", () => { has(j(j2, ["lint", "--broken"]), "no broken data"); });

  // The same field changed two ways is a real clash.
  let out = "";
  test("a real clash (one title changed two ways) is a conflict", () => {
    w.git(j2, "push", "-q", "origin", "main");
    w.git(j1, "pull", "-q", "--no-edit", "origin", "main");
    jset(j1, ["edit", "g/from-one", "--title", "Renamed by one"]); w.git(j1, "commit", "-qam", "r1"); w.git(j1, "push", "-q", "origin", "main");
    jset(j2, ["edit", "g/from-one", "--title", "Renamed by two"]); w.git(j2, "commit", "-qam", "r2");
    out = gitIn(j2, ["pull", "--no-rebase", "--no-edit", "origin", "main"]).stdout;
    has(out, "CONFLICT");
  });
  test("  named by the merge driver", () => { has(out, "the same thing changed both ways"); });
  test("  with the field", () => { has(out, "title"); });
  after(() => { gitIn(j2, ["merge", "--abort"]); });
});

describe("the memory index is rebuilt, never merged by hand", () => {
  const m = w.at("m");
  const mem = (args: string[]) => cmd(process.execPath, [TRACKER, "memory", ...args], { cwd: m, env: w.env });
  const index = () => fs.readFileSync(path.join(m, "memory/MEMORY.md"), "utf8");
  test("just memory: one line per file from its frontmatter", () => {
    fs.mkdirSync(path.join(m, "memory"), { recursive: true });
    fs.writeFileSync(path.join(m, "memory/tool-quirk.md"), "---\nname: tool-quirk\ntitle: Tool quirk\nhook: the flag that matters\n---\nx\n");
    fs.writeFileSync(path.join(m, "memory/open-thing.md"), "---\nname: open-thing\ndescription: still looking\nopen: true\n---\nx\n");
    assert.equal(mem([]).code, 0);
    has(index(), "- [Tool quirk](tool-quirk.md) — the flag that matters");
  });
  test("  open investigations under Open", () => {
    const open = index().split("\n");
    const at = open.findIndex((l) => l.startsWith("## Open"));
    assert.ok(at >= 0, index());
    assert.ok(open.slice(at).some((l) => l.includes("open-thing")), index());
  });
  test("  memory --check fails when a file has no line yet", () => {
    fs.writeFileSync(path.join(m, "memory/new-one.md"), "---\nname: new-one\ntitle: New one\nhook: added later\n---\nx\n");
    assert.equal(mem(["--check"]).code, 1);
  });
});
