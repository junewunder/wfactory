// The tracker CLI end to end: init, --help, unknown commands, rename, templates'
// --set, loops and status, log, memory. Run: node --test tracker/test/
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { trackerRepo, start, has, hasnt, firstLine, ago, TRACKER } from "../../test/lib/index.ts";
import { commands } from "../src/index.ts";

// A repo with no commit and no tracker until init makes one, titled Demo
// ("Demo: " in status all).
const base = { FACTORY_TAG: "worker1", FACTORY_EVIDENCE_MIN: "0" };
const f = trackerRepo("demo", base, { commit: false });
const { t, ok, setup } = f;
setup(["init", "--title", "Demo"]);

describe("every command has --help, and --help never writes", () => {
  const logLines = () => f.read("tracker/log.jsonl").split("\n").filter((l, i, a) => i < a.length - 1 || l !== "").length;
  let before = 0;
  // The bash suite found the commands by grepping the command modules for `C.<name> = `; these
  // are the commands the tracker has registered, which is what that grep stood for.
  const cmds = Object.keys(commands);
  test("the commands are found", () => {
    before = logLines();
    assert.ok(cmds.length >= 50, `only ${cmds.length}`);
  });
  test("every command has --help", async () => {
    const bad: string[] = [];
    for (let i = 0; i < cmds.length; i += 8) {
      await Promise.all(cmds.slice(i, i + 8).map(async (c) => {
        const r = await start(process.execPath, [TRACKER, c, "--help"], { cwd: f.dir, env: f.env });
        const out = r.stdout + r.stderr;
        const named = new RegExp(`^${c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "m").test(out) || out.includes("(just recheck");
        if (r.code !== 0 || out.includes("no help written") || !named) bad.push(`${c} --help: exit ${r.code}: ${out.split("\n").slice(0, 3).join(" / ")}`);
      }));
    }
    assert.deepEqual(bad, []);
  });
  test("--help on a write command shows usage", () => { has(ok(["note", "fenn/anim", "--help"]), "note <id>"); });
  test("--help writes nothing", () => { assert.equal(logLines(), before); });
  test("a command that doesn't exist says so", () => {
    has(t(["list", "group:x", "--state", "merging"], {}, { merged: true }).stdout, 'no command "list"');
  });
  test("in one line, not the whole usage", () => {
    const out = t(["list", "group:x", "--state", "merging"], {}, { merged: true }).stdout;
    assert.equal(out.replace(/\n$/, "").split("\n").length, 1, out);
  });
  test("exit 2", () => { assert.equal(t(["list"]).code, 2); });
});

describe("init: the files it lays down, and a second run leaves them alone", () => {
  const fr = trackerRepo("fresh", base, { commit: false });
  test("init names the project after its folder", () => { has(fr.ok(["init", "--title", "Fresh one"]), "made tracker/ for fresh"); });
  // ranking: a new tracker starts on the one order, so its priorities of 100 or more aren't converted.
  test("project.json: schema, ranking, name, --title, no resources", () => {
    assert.equal(JSON.stringify(fr.json("tracker/project.json")), '{"schema":1,"ranking":2,"name":"fresh","title":"Fresh one","resources":{}}');
  });
  test("empty questions and decisions", () => {
    assert.equal(JSON.stringify(fr.json("tracker/questions.json")) + JSON.stringify(fr.json("tracker/decisions.json")), '{"questions":[]}{"decisions":[]}');
  });
  test("a groups folder and an empty log", () => {
    assert.ok(fs.statSync(fr.at("tracker/groups")).isDirectory());
    assert.ok(fs.statSync(fr.at("tracker/log.jsonl")).isFile());
    assert.equal(fs.statSync(fr.at("tracker/log.jsonl")).size, 0);
  });
  test(".gitattributes merges tracker JSON with the driver", () => { has(fr.read(".gitattributes"), "tracker/**/*.json merge=tracker-json"); });
  test("and the memory index by union", () => { has(fr.read(".gitattributes"), "memory/MEMORY.md merge=union"); });
  test("init again says so", () => {
    fr.write("tracker/project.json", '{"schema":1,"name":"kept"}\n');
    has(fr.ok(["init", "--title", "Other"]), "tracker/ already exists");
  });
  test("and changes nothing", () => { assert.equal(fr.json("tracker/project.json").name, "kept"); });
  test("nor repeats a line", () => { assert.equal(fr.read(".gitattributes").split("\n").filter((l) => l.includes("tracker-json")).length, 1); });
});

describe("rename: every reference follows", () => {
  test("rename says what it did", () => {
    setup(["add-group", "rn", "--title", "Renames"]);
    setup(["add-group", "rn2", "--title", "Rename target"]);
    setup(["add-unit", "rn/old", "--title", "Unit to rename"]);
    setup(["add-unit", "rn/dep", "--title", "Needs the renamed", "--needs", "rn/old", "--detail", "After {unit:rn/old}, not before"]);
    setup(["note", "rn/dep", "check {unit:rn/old} first"]);
    setup(["edit-group", "rn2", "--needs", "rn/old"]);
    setup(["ask", "--title", "Does the renamed unit keep its colour?", "--context", "About {unit:rn/old}.", "--option", "a | Keep | {unit:rn/old} stays | drops: rn/old",
      "--option", "b | Change | it changes | releases: rn/old", "--default", "a", "--blocks", "rn/old", "--id", "rn-colour", "--force"]);
    setup(["decide", "--title", "Colour of {unit:rn/old} is blue", "--why", "{unit:rn/old} reads better", "--scope", "rn/old"]);
    has(ok(["rename", "rn/old", "rn2/new"]), "renamed rn/old → rn2/new");
  });
  const ids = (g: string) => JSON.stringify(f.json(`tracker/groups/${g}.json`).units.map((u: { id: string }) => u.id));
  const dep = () => f.json("tracker/groups/rn.json").units.find((u: { id: string }) => u.id === "rn/dep");
  const q = () => f.json("tracker/questions.json").questions.find((x: { id: string }) => x.id === "q/rn-colour");
  test("moved to its new group", () => { assert.equal(ids("rn2"), '["rn2/new"]'); });
  test("and out of its old one", () => { assert.equal(ids("rn"), '["rn/dep"]'); });
  test("a unit's needs follow", () => { assert.equal(JSON.stringify(dep().needs), '["rn2/new"]'); });
  test("a unit's detail follows", () => { has(JSON.stringify(dep()), "After {unit:rn2/new}, not before"); });
  test("a unit's notes follow", () => { has(JSON.stringify(dep()), "check {unit:rn2/new} first"); });
  test("a group's needs follow", () => { assert.equal(JSON.stringify(f.json("tracker/groups/rn2.json").needs), '["rn2/new"]'); });
  test("a question's blocks follow", () => { assert.equal(JSON.stringify(q().blocks), '["rn2/new"]'); });
  test("its context follows", () => { has(JSON.stringify(q()), "About {unit:rn2/new}."); });
  test("its options' text, drops and releases follow", () => {
    const o = q().options;
    assert.equal(JSON.stringify([o[0].changes, o[0].drops, o[1].releases]), '["{unit:rn2/new} stays",["rn2/new"],["rn2/new"]]');
  });
  test("a decision's scope, title and why follow", () => {
    const ds = f.json("tracker/decisions.json").decisions.filter((d: { id: string }) => d.id.startsWith("d/colour-of"));
    assert.equal(ds.length, 1);
    assert.equal(JSON.stringify([ds[0].scope, ds[0].title, ds[0].why]), '[["rn2/new"],"Colour of {unit:rn2/new} is blue","{unit:rn2/new} reads better"]');
  });
  test("the card shows the new ID", () => { has(ok(["show", "rn2/new"]), "Unit to rename (rn2/new)"); });
  test("and the log says where it came from", () => { has(ok(["log", "-n", "1"]), "Unit to rename: renamed from rn/old"); });
  test("renaming onto an existing ID is refused", () => { assert.equal(t(["rename", "rn2/new", "rn/dep"]).code, 2); });
  test("as is renaming into a missing group", () => {
    assert.equal(t(["rename", "rn2/new", "nogroup/x"]).code, 2);
  });
  after(() => {
    setup(["withdraw", "q/rn-colour", "--why", "test"]);
    for (const u of ["rn2/new", "rn/dep"]) setup(["drop", u, "--why", "test"]);
    setup(["edit-group", "rn2", "--needs", ""]);
  });
});

describe("add --set", () => {
  test("add --set fills the template's parameters", () => {
    f.write("tracker/templates/stage.json", `{ "name": "stage", "title": "{Name} on {venue}", "param": "name",
  "units": [ { "slug": "build", "title": "Build {Name} for {venue}", "detail": "rows: {rows}" } ] }
`);
    has(ok(["add", "yara", "--template", "stage", "--set", "venue=Arena", "--set", "rows=3", "--host", "otherbox"]), "Yara on Arena (yara): 1 unit");
  });
  test("in its units too", () => { has(ok(["show", "yara/build"]), "Build Yara for Arena (yara/build)"); });
  test("even in detail", () => { has(ok(["show", "yara/build"]), "rows: 3"); });
  test("the params are kept with the group, and --host too", () => {
    const g = f.json("tracker/groups/yara.json");
    assert.equal(JSON.stringify([g.params, g.host]), '[{"venue":"Arena","rows":"3","name":"yara"},"otherbox"]');
  });
  after(() => {
    setup(["drop", "yara/build", "--why", "test"]);
  });
});

describe("where <loop>, status with loops", () => {
  test("where prints a loop's spec", () => {
    // What the bash suite had from its earlier sections: a group pinned to another machine whose
    // one unit is dropped, and a group that needs it.
    setup(["add-group", "hg", "--title", "Pinned group", "--host", "otherbox"]);
    setup(["add-unit", "hg/a", "--title", "Pinned unit"]);
    setup(["add-group", "hn", "--title", "Needs group"]); setup(["add-unit", "hn/a", "--title", "Waits for the pin"]);
    setup(["edit-group", "hn", "--needs", "hg/a"]);
    setup(["drop", "hg/a", "--why", "test"]); setup(["drop", "hn/a", "--why", "test"]);
    f.edit("tracker/project.json", (p) => { p.loops = { main: { title: "The main loop", spec: "docs/main-loop.md", groups: ["hn"] }, side: { groups: ["hg"] } }; });
    has(ok(["where", "main"]), "docs/main-loop.md");
  });
  test("a loop without one: docs/factory.md", () => { has(ok(["where", "side"]), "docs/factory.md"); });
  test("an unknown loop: exit 2", () => { assert.equal(t(["where", "nope"]).code, 2); });
  test("status with loops lists them", () => { has(ok(["status"]), "loops: The main loop (main), side (side)"); });
  test("status <loop> through LOOP", () => { has(ok(["status"], { LOOP: "main" }), "/ The main loop:"); });
  test("status all counts every loop", () => { has(ok(["status", "all"]), "Demo: "); });
  test("a unit that sorts a set aside (group aside) is offered to every loop", () => {
    setup(["add-group", "aside", "--title", "Set-aside copies to sort"]); setup(["add-unit", "aside/hg-x-1", "--title", "Sort a set-aside copy"]);
    has(ok(["next"], { LOOP: "main" }), "aside/hg-x-1");
  });
  test("  and so it is to the other", () => {
    has(ok(["next"], { LOOP: "side" }), "aside/hg-x-1");
    setup(["drop", "aside/hg-x-1", "--why", "test"]);
  });
  test("state --host: the machine a unit is pinned to, by its group", () => { assert.equal(ok(["state", "hg/a", "--host"]).trim(), "otherbox"); });
  test("  or by its own", () => {
    setup(["add-unit", "hn/b", "--title", "Pinned unit of its own", "--host", "somebox"]);
    assert.equal(ok(["state", "hn/b", "--host"]).trim(), "somebox");
  });
  test("  empty for any", () => { assert.equal(ok(["state", "hn/a", "--host"]).trim(), ""); setup(["drop", "hn/b", "--why", "test"]); });
  test("status --all lists every group", () => {
    f.edit("tracker/project.json", (p) => { delete p.loops; });
    has(ok(["status", "--all"]), "  Pinned group (hg): 1 dropped");
  });
  test("with each group's CI", () => {
    // The bash suite had groups with CI by now; a group of its own here, with a unit done.
    f.edit("tracker/project.json", (p) => { p.ci = { steps: { drill: { cmd: "just drill {group}" } } }; });
    setup(["add-group", "sc", "--title", "Status CI", "--ci", "drill"]);
    setup(["add-unit", "sc/a", "--title", "Status CI unit"]); setup(["done", "sc/a", "--evidence", "x"]);
    has(ok(["status", "--all"]), "; CI ");
  });
});

describe("log --since, --group", () => {
  test("log --since 8h shows what's newer", () => {
    fs.appendFileSync(f.at("tracker/log.jsonl"), [
      { at: ago(30), actor: "loop", tag: "old1", host: "h", cmd: "note", id: "lg/a", text: "an old line" },
      { at: ago(3), actor: "loop", tag: "mid1", host: "h", cmd: "note", id: "lg/a", text: "a middle line" },
      { at: "2026-01-02T00:00:00Z", actor: "owner", tag: "x", cmd: "note", text: "a january line" },
    ].map((x) => JSON.stringify(x)).join("\n") + "\n");
    has(ok(["log", "--since", "8h"]), "a middle line");
  });
  test("not what's older", () => { hasnt(ok(["log", "--since", "8h"]), "an old line"); });
  test("lines with the owner's name, without a tag", () => { has(ok(["log", "--since", "2026-01-01"]), "owner: a january line"); });
  test("log --since a date starts there", () => { hasnt(ok(["log", "--since", "2026-02-01"]), "a january line"); });
  test("--since 2d", () => { has(ok(["log", "--since", "2d"]), "an old line"); });
  test("log --group: that group's lines", () => { has(ok(["log", "--group", "lg", "-n", "100"]), "a middle line"); });
  test("only", () => { hasnt(ok(["log", "--group", "lg", "-n", "100"]), "Dropped"); });
  test("log -n N: the last N", () => { assert.equal(ok(["log", "-n", "2"]).replace(/\n$/, "").split("\n").length, 2); });
  test("in time order, whatever order they were written in", () => { has(firstLine(ok(["log", "-n", "1000"])), "a january line"); });
  test("nothing in the window says so", () => { has(ok(["log", "--group", "nogroup"]), "(nothing in that window)"); });
});

describe("memory --check", () => {
  test("memory --check: out of date is exit 1", () => {
    f.write("memory/some-fact.md", "---\nname: some-fact\ntitle: Some fact\nhook: a hook for it\n---\nbody\n");
    assert.equal(t(["memory", "--check"]).code, 1);
  });
  test("and says how to fix it", () => { has(t(["memory", "--check"], {}, { merged: true }).stdout, "just memory` rebuilds it"); });
  test("without writing", () => { assert.equal(fs.existsSync(f.at("memory/MEMORY.md")), false); });
  test("memory rebuilds it", () => { has(ok(["memory"]), "rebuilt memory/MEMORY.md"); });
  test("from the frontmatter", () => { has(f.read("memory/MEMORY.md"), "- [Some fact](some-fact.md) — a hook for it"); });
  test("then --check passes", () => { assert.equal(t(["memory", "--check"]).code, 0); });
  test("saying so", () => {
    has(ok(["memory", "--check"]), "memory/MEMORY.md is current");
  });
  after(() => {
    fs.rmSync(f.at("memory"), { recursive: true, force: true });
  });
});

describe("add --set with no value is refused (it used to crash)", () => {
  test("add --set with no value: usage, exit 2", () => { assert.equal(t(["add", "zora", "--template", "stage", "--set"]).code, 2); });
  test("and nothing is made", () => { assert.equal(fs.existsSync(f.at("tracker/groups/zora.json")), false); });
});

// Lanes grepped add-unit's and edit's flags out of --help (2026-10-23): both open on examples, and
// each example runs as written.
describe("add-unit and edit --help: examples that run", () => {
  const ex = () => ok(["edit", "--help"]).split("\n").filter((l) => l.startsWith("  just tracker ")).map((l) => l.replace(/^  just tracker /, "").replace(/\s{2,}\(.*$/, ""));
  test("both show them", () => {
    has(ok(["add-unit", "--help"]), "Examples:\n  just tracker add-unit ");
    assert.equal(ex().length, 3);
  });
  test("each runs", () => {
    const g = trackerRepo("examples", base);
    g.setup(["init", "--title", "Examples"]);
    g.edit("tracker/project.json", (p) => { p.resources = { editor: { title: "the editor" } }; });
    g.setup(["add-group", "parser", "--title", "Parser"]);
    for (const u of ["lexer", "tz"]) g.setup(["add-unit", `parser/${u}`, "--title", `Parser ${u}`]);
    for (const line of ex()) {
      const args = [...line.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);
      const r = g.t(args, {}, { merged: true });
      assert.equal(r.code, 0, `${line}\n${r.stdout}`);
    }
    has(g.ok(["show", "parser/dates"]), "Needs: Parser lexer (parser/lexer), Parser tz (parser/tz)");
  });
});
