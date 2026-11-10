// scripts/profile.sh: the user's profile (path, new, check, get, machines). Run: node --test test/scripts/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { workspace, has, chomp, HOST } from "../lib/index.ts";

const w = workspace();
const P = w.env.WFACTORY_PROFILE!;
const pf = (...a: string[]) => w.script("profile", a);
const pfAll = (...a: string[]) => w.script("profile", a, { merged: true });
const out = (...a: string[]) => chomp(pf(...a).stdout);

describe("path and help", () => {
  test("profile.sh path: WFACTORY_PROFILE", () => { assert.equal(out("path"), P); });
  test("else under XDG_CONFIG_HOME", () => {
    const r = w.script("profile", ["path"], { add: { WFACTORY_PROFILE: undefined, XDG_CONFIG_HOME: w.at("xdg") } });
    assert.equal(chomp(r.stdout), w.at("xdg/wfactory/profile.md"));
  });
  test("profile.sh --help", () => { has(pf("--help").stdout, "profile.sh new"); });
  test("and with no command", () => { has(pf().stdout, "profile.sh check"); });
});

describe("new and check", () => {
  test("profile.sh check: no profile, exit 2", () => { assert.equal(pf("check").code, 2); });
  test("and says how to make one", () => { has(pfAll("check").stdout, `no profile at ${P} (make one: scripts/profile.sh new)`); });
  test("profile.sh new: writes it", () => { has(pf("new").stdout, `wrote ${P}; fill in every <fill: …>`); });
  test("with this machine's hostname", () => { has(fs.readFileSync(P, "utf8"), `| ${HOST} | ${HOST} | 1 | 1 | — | — |`); });
  test("refuses to overwrite one", () => { assert.equal(pf("new").code, 2); });
  test("and says so", () => { has(pfAll("new").stdout, "already exists; edit it instead"); });
  test("profile.sh check: placeholders left, exit 2", () => { assert.equal(pf("check").code, 2); });
  test("lists them by line", () => { has(pfAll("check").stdout, "still has placeholders:"); });
  test("each as line <n>:<placeholder>", () => { has(pfAll("check").stdout, "  line 9:<fill: your name, as it appears in reports>"); });
  test("profile.sh check: complete", () => {
    fs.writeFileSync(P, fs.readFileSync(P, "utf8").replace(/<fill[^>]*>/g, "filled"));
    assert.equal(out("check"), `profile: ${P} is complete`);
  });
});

describe("get and machines", () => {
  test("profile.sh get: a setting", () => { assert.equal(out("get", "pause below"), "8"); });
  test("an unset one takes the default", () => { assert.equal(out("get", "nothing", "x"), "x"); });
  test("profile.sh machines: tab-separated", () => { assert.equal(out("machines"), `${HOST}\t${HOST}\t1\t1\t—\t—`); });
  test("profile.sh: an unknown command", () => { assert.equal(pf("frob").code, 2); });
  test("profile.sh get with no setting: exit 1", () => { assert.equal(pf("get").code, 1); });
  test("asks which", () => { has(pfAll("get").stdout, "which setting?"); });
});

// "stop below" was the fixed floor under the week's usage; the row is "keep back" now.
describe("a row under its old name", () => {
  let full = "", r = { code: -1, stdout: "", stderr: "" }, both = "";
  test("profile.sh check: a profile with \"stop below\" is complete still", () => {
    full = fs.readFileSync(P, "utf8");
    fs.writeFileSync(P, full.replace("| keep back | 15 |", "| stop below | 20 |"));
    r = pf("check");
    fs.writeFileSync(P, full.replace("| keep back | 15 |", "| keep back | 15 |\n| stop below | 20 |"));
    both = pf("check").stderr;
    assert.equal(r.code, 0);
    assert.equal(chomp(r.stdout), `profile: ${P} is complete`);
  });
  test("  and says to rename it", () => { has(r.stderr, `has a "stop below" row: rename it to "keep back"`); });
  test("  or to remove it, beside a \"keep back\" row", () => { has(both, `has a "stop below" row beside its "keep back" row: remove it`); });
  test("  its value still parses", () => {
    fs.writeFileSync(P, full.replace("| keep back | 15 |", "| stop below | 20 |"));
    assert.equal(out("get", "stop below"), "20");
  });
  test("a profile without it: check says nothing more", () => {
    fs.writeFileSync(P, full);
    assert.equal(pf("check").stderr, "");
  });
  test("the template's row is keep back, 15", () => { assert.equal(out("get", "keep back"), "15"); });
  after(() => { if (full) fs.writeFileSync(P, full); });
});

describe("no machines", () => {
  let full = "";
  test("profile.sh check: no machines, exit 2", () => {
    full = fs.readFileSync(P, "utf8");
    fs.writeFileSync(P, full.replace(new RegExp(`^\\| ${HOST.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\|.*\\n`, "m"), ""));
    assert.equal(pf("check").code, 2);
  });
  test("and says so", () => { has(pfAll("check").stdout, "has no Machines table rows"); });
  after(() => { fs.writeFileSync(P, full); });
});
