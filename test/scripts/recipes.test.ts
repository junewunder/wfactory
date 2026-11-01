// The recipes in runtime/factory.just that have logic of their own or that no other test calls
// as recipes, in a factory made by init.sh: runs, prompt, oversee-guide, usage, skill-deploy,
// view and pause. Run: node --test test/scripts/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { workspace, cmd, has, chomp, sleep, ROOT } from "../lib/index.ts";

const w = workspace();
w.profile();
const F = w.init("fresh");
const at = (p: string) => path.join(F, p);
const J = (...a: string[]) => w.just(a, F).stdout;
// The same, which must exit 0 (as the bash suite's plain `J …` and `out=$(J …)` under `set -e`).
const Jok = (...a: string[]) => {
  const r = w.just(a, F);
  assert.equal(r.code, 0, `just ${a.join(" ")}: exit ${r.code}\n${r.stdout}`);
  return r.stdout;
};
// The first field of each line (`awk '{print $1}' | paste -sd'|'`).
const firsts = (s: string) => chomp(s).split("\n").map((l) => l.trim().split(/\s+/)[0]).join("|");
const skillFile = (f: string) => fs.readFileSync(path.join(ROOT, f), "utf8");

// runs: every clone's index.tsv on this machine, merged by when each started.
describe("just runs", () => {
  test("just runs: no loop yet", () => { has(J("runs"), "no loop has run on this machine yet"); });
  let out = "";
  test("just runs: a header, a lane column first", () => {
    for (const d of ["runs", "../fresh-lane1/runs", "../fresh-lane2/runs"]) fs.mkdirSync(at(d), { recursive: true });
    const hdr = "started\ttag\tloop\tunit\tresult\tturns\tcost_usd\tminutes";
    fs.writeFileSync(at("runs/index.tsv"), `${hdr}\n2026-10-01T10:00:00\ta\t\tUnit one (g/one)\tdone\t3\t0.10\t2\n2026-10-01T12:00:00\tc\t\tUnit three (g/three)\tdone\t4\t0.20\t5\n`);
    fs.writeFileSync(`${F}-lane1/runs/index.tsv`, `${hdr}\n2026-10-01T11:00:00\tb\t\tUnit two (g/two)\tblocked\t1\t0.05\t1\n`);
    fs.writeFileSync(`${F}-lane2/runs/index.tsv`, `${hdr}\n`);
    out = Jok("runs");
    assert.equal(out.split("\n")[0].replace(/ +/g, " "), "lane started tag loop unit result turns cost_usd minutes");
  });
  test("the rows by start, labelled by clone", () => { assert.equal(firsts(out.split("\n").slice(1, 4).join("\n")), "checkout|lane1|checkout"); });
  test("a row's columns", () => { has(out, "lane1     2026-10-01T11:00:00  b          Unit two (g/two)      blocked  1      0.05      1"); });
  test("then where the transcripts are", () => { assert.equal(chomp(out).split("\n").at(-1), "(transcripts: <that clone>/runs/<started>-<tag>.jsonl; another machine's: just fleet state)"); });
  // Plain tabs, for awk and cut (2026-10-19: the padded columns broke an awk call).
  test("just runs --tsv: the rows as they are, tab-separated", () => {
    const t = Jok("runs", "--tsv");
    assert.equal(t.split("\n")[0], "lane\tstarted\ttag\tloop\tunit\tresult\tturns\tcost_usd\tminutes");
    has(t, "lane1\t2026-10-01T11:00:00\tb\t\tUnit two (g/two)\tblocked\t1\t0.05\t1\n");
  });
  test("  with n", () => { assert.equal(chomp(J("runs", "1", "--tsv")).split("\n").length, 2); });
  test("just runs 0: only the header", () => { assert.equal(firsts(J("runs", "0")), "lane|(transcripts:"); });
  test("just runs 1: the last one", () => { assert.equal(firsts(chomp(J("runs", "1")).split("\n").slice(1).join("\n")), "checkout|(transcripts:"); });
  test("the same from a lane's clone", () => {
    const l = `${F}-lane1`;
    fs.copyFileSync(at("justfile"), path.join(l, "justfile"));
    fs.mkdirSync(path.join(l, "factory"), { recursive: true });
    fs.copyFileSync(at("factory/factory.just"), path.join(l, "factory/factory.just"));
    fs.cpSync(at(".tracker"), path.join(l, ".tracker"), { recursive: true, verbatimSymlinks: true });
    assert.equal(chomp(w.just(["runs"], l).stdout), chomp(out));
  });
  test("just runs: the header from a lane's clone when the checkout has none", () => {
    fs.renameSync(at("runs/index.tsv"), w.at("index.keep"));
    has(J("runs"), "lane1  2026-10-01T11:00:00  b");
  });
  after(() => { fs.renameSync(w.at("index.keep"), at("runs/index.tsv")); });
});

// prompt and oversee-guide: the skill's, then the project's additions.
describe("just prompt and oversee-guide", () => {
  test("just prompt: the skill's prompt", () => { assert.equal(chomp(J("prompt")), chomp(skillFile("runtime/prompt.md"))); });
  test("then the project's (prompt)", () => {
    fs.writeFileSync(at("factory/prompt.local.md"), "Local prompt rule.\n");
    assert.equal(chomp(J("prompt")), `${skillFile("runtime/prompt.md")}\n---\n\nLocal prompt rule.`);
  });
  // The card, not the 35k guide, at the start of every overseer session (2026-10-18).
  test("just oversee-guide: the skill's overseer card", () => { assert.equal(chomp(J("oversee-guide")), chomp(skillFile("runtime/oversee-card.md"))); });
  test("  short", () => { assert.ok(skillFile("runtime/oversee-card.md").length < 4000, "under 4k characters"); });
  test("  pointing to the whole guide", () => { has(J("oversee-guide"), "just oversee-guide --full"); });
  test("just oversee-guide --full: the whole guide", () => { assert.equal(chomp(J("oversee-guide", "--full")), chomp(skillFile("runtime/oversee.md"))); });
  test("then the project's (oversee-guide)", () => {
    fs.writeFileSync(at("factory/oversee.local.md"), "Local overseer rule.\n");
    assert.equal(chomp(J("oversee-guide")), `${skillFile("runtime/oversee-card.md")}\n---\n\nLocal overseer rule.`);
  });
  test("  (with --full too)", () => { assert.equal(chomp(J("oversee-guide", "--full")), `${skillFile("runtime/oversee.md")}\n---\n\nLocal overseer rule.`); });
});

describe("just usage, skill-deploy, view", () => {
  // usage: factory/usage.sh show.
  test("just usage: usage.sh show", () => {
    const u = cmd(at("factory/usage.sh"), ["show"], { cwd: F, env: w.env, merged: true });
    assert.equal(chomp(J("usage")), chomp(u.stdout));
  });
  // skill-deploy: the skill checkout's deploy.sh.
  test("just skill-deploy: the checkout's deploy.sh", () => {
    fs.mkdirSync(w.at("checkout/scripts"), { recursive: true });
    fs.writeFileSync(w.at("checkout/scripts/deploy.sh"), '#!/bin/sh\necho "deploy ran: $*"\n', { mode: 0o755 });
    assert.equal(chomp(w.just(["skill-deploy"], F, { FACTORY_SKILL_CHECKOUT: w.at("checkout") }).stdout), "deploy ran: ");
  });
  // view: the viewer, opened.
  test("just view: builds the viewer and opens it", async () => {
    const opened = w.at("opened");
    fs.writeFileSync(w.at("bin/xdg-open"), `#!/bin/sh\necho "$1" > "${opened}"\n`, { mode: 0o755 });
    Jok("view");
    for (let i = 0; i < 50 && !(fs.existsSync(opened) && fs.statSync(opened).size); i++) await sleep(100);
    assert.ok(fs.existsSync(opened) && fs.statSync(opened).size, "xdg-open never ran");
    assert.ok(fs.statSync(chomp(fs.readFileSync(opened, "utf8"))).isFile());
  });
});

describe("just pause", () => {
  // pause: oversee.sh pause.
  test("just pause: asks the loop to stop after its unit", () => {
    fs.rmSync(at("runs/.pause"), { force: true });
    Jok("pause");
    assert.ok(fs.existsSync(at("runs/.pause")));
  });
  test("--now: and to end the session", () => {
    fs.rmSync(at("runs/.pause"), { force: true }); fs.rmSync(at("runs/.pause-now"), { force: true });
    Jok("pause", "--now");
    assert.ok(fs.existsSync(at("runs/.pause-now")));
  });
});
