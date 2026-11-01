// scripts/factory-diff.sh on a factory made by init.sh: stubs same, differing and missing, the
// project's own files, the tracker's format, origin, uncommitted changes, --diff, a loop running
// in a lane's clone; and to-stubs.sh's refusals while lanes run. Run: node --test test/scripts/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { workspace, background, has, ROOT } from "../lib/index.ts";

const w = workspace();
w.profile();
const F = w.init("fresh");
const fd = (...a: string[]) => w.script("factory-diff", a);
const fdOut = (...a: string[]) => { const r = fd(...a); assert.equal(r.code, 0, r.stderr); return r.stdout; };
const ts = (...a: string[]) => w.script("to-stubs", a, { merged: true });
const at = (p: string) => path.join(F, p);
const git = (...a: string[]) => w.git(F, ...a);
// The template's stubs, but auto-mode.json (the project's own once it's there).
const n = fs.readdirSync(path.join(ROOT, "template/factory")).filter((f) => f !== "auto-mode.json").length;

describe("a factory just made", () => {
  const out = fdOut(F);
  test("factory-diff: names the factory", () => { has(out, `== ${F}`); });
  test("the stubs all the same", () => { has(out, `the stubs: ${n} same, 0 differ, 0 missing`); });
  test("the project's own: the template's auto-mode.json", () => { has(out, "the project's own (kept): auto-mode.json"); });
  test("what's deployed", () => { has(out, `deployed on this machine: nothing deployed in ${w.at("deploy")}`); });
  test("the tracker", () => { has(out, "tracker: tracker/"); });
  test("no origin", () => { has(out, "origin: none (the state is tracker/ in the checkout; no branches)"); });
  test("nothing running", () => { has(out, "running here: nothing"); });
});

describe("a stub edited, one missing, the project's own files, an origin", () => {
  let out = "";
  const d = new Date(), today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  test("one differs, one missing", () => {
    git("add", "-A"); git("commit", "-qm", "init");
    fs.appendFileSync(at("factory/loop.sh"), "# edited\n"); git("commit", "-qm", "edit the loop stub", "--", "factory/loop.sh");
    fs.rmSync(at("factory/usage.sh"));
    fs.writeFileSync(at("factory/prompt.local.md"), "own\n"); fs.writeFileSync(at("factory/extra.txt"), "x\n"); fs.writeFileSync(at("factory/.hidden"), "x\n");
    git("remote", "add", "origin", w.at("somewhere.git"));
    out = fdOut(F);
    has(out, `the stubs: ${n - 2} same, 1 differ, 1 missing`);
  });
  test("the one that differs, with its last commit", () => { has(out, `differs  loop.sh           1 lines   last commit there: ${today} edit the loop stub`); });
  test("the one missing", () => { has(out, "missing  usage.sh"); });
  test("the project's own", () => { has(out, "the project's own (kept): prompt.local.md auto-mode.json"); });
  test("other files, but not hidden ones", () => { assert.deepEqual(out.split("\n").filter((l) => l.startsWith("other files")), ["other files in factory/ (not stubs): extra.txt"]); });
  test("the origin", () => { has(out, `origin: ${w.at("somewhere.git")}`); });
  test("uncommitted changes", () => { has(out, "uncommitted changes in factory/ or the justfile: 4"); });
  test("factory-diff --diff: the diff for one file", () => { has(fdOut(F, "--diff", "loop.sh"), "+++ skill: template/factory/loop.sh"); });
  test("what the factory's copy has", () => { has(fdOut(F, "--diff", "loop.sh"), "-# edited"); });
  after(() => { git("checkout", "-q", "--", "factory"); git("clean", "-qfd", "factory"); git("remote", "remove", "origin"); });
});

// A real loop in a lane's clone beside the checkout, waiting for a unit pinned to another
// machine: factory-diff and to-stubs find it by its working folder.
describe("a loop running in a lane's clone", () => {
  const lane = `${F}-lane3`;
  let loop: ReturnType<typeof background> | undefined;
  test("factory-diff: a loop running in a lane's clone", async () => {
    fs.cpSync(F, lane, { recursive: true, verbatimSymlinks: true });
    for (const f of ["docs/factory.md", "docs/machines.md"]) { const p = path.join(lane, f); fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace(/<fill[^>]*>/g, "filled")); }
    const jf = path.join(lane, "justfile");
    fs.writeFileSync(jf, fs.readFileSync(jf, "utf8").replace(/@echo "TODO.*/, "@true"));
    w.setup(["pass", "opening/ready"], lane);   // past its opening
    w.setup(["add-group", "g", "--title", "Group"], lane);
    w.setup(["add-unit", "g/far", "--title", "Pinned elsewhere", "--host", "otherbox"], lane);
    loop = background(path.join(lane, "factory/loop.sh"), ["--no-awake", "--hours", "1"], { cwd: lane, env: w.envWith({ FACTORY_NOCAP: "1" }) });
    await loop.until("waiting:");
    has(fdOut(F), `running here: ${path.basename(F)}-lane3`);
  });
  test("to-stubs: refuses while a loop runs, exit 2", () => { assert.equal(ts(F).code, 2); });
  test("says so", () => { has(ts(F).stdout, `a loop is running in ${F} (or a lane beside it); stop it first`); });
  after(async () => { await loop?.stop(); fs.rmSync(lane, { recursive: true, force: true }); });
});

// Lanes on another machine: its fleet.sh beat says so.
describe("lanes busy on another machine", () => {
  const keep = fs.readFileSync(at("factory/fleet.sh"));
  test("to-stubs: refuses while lanes run on another machine, exit 2", () => {
    fs.writeFileSync(at("factory/fleet.sh"), '#!/bin/sh\necho "otherbox: 1 busy, 0 waiting"\n');
    git("commit", "-qam", "a fleet that's busy");
    assert.equal(ts(F).code, 2);
  });
  test("says so", () => { has(ts(F).stdout, "lanes may be running on another machine (otherbox: 1 busy, 0 waiting)"); });
  after(() => { fs.writeFileSync(at("factory/fleet.sh"), keep); git("commit", "-qam", "the fleet stub back"); });
});

describe("factory-diff's refusals and help", () => {
  test("factory-diff: no factory/", () => { assert.equal(fd(w.top).code, 2); });
  test("factory-diff --help", () => { has(fd("--help").stdout, "factory-diff.sh <factory repo>"); });
});
