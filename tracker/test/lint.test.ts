// The tracker CLI end to end: text checked at write time (bare IDs, long titles and notes),
// lint and lint --broken, a resource's named_by words, the spec's length, the log and
// the view. Run: node --test tracker/test/
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { trackerRepo, has, hasnt, lastLine } from "../../test/lib/index.ts";

const f = trackerRepo("repo", { FACTORY_TAG: "worker1", FACTORY_EVIDENCE_MIN: "0" });
const { t, ok, setup } = f;

// What the earlier sections of the bash suite left that these checks lean on: the editor
// resource, a unit using it, Fenn's rig (renamed there to fenn/rig-import), and a unit to note.
setup(["init", "--title", "Test port"]);
f.edit("tracker/project.json", (p) => { p.resources = { editor: { title: "the level editor", free: { cmd: "test ! -e busy" } } }; });
setup(["add-group", "pipe", "--title", "Pipeline"]);
setup(["add-unit", "pipe/convert", "--title", "Convert the data"]);
setup(["add-unit", "pipe/gui", "--title", "Click through the editor", "--uses", "editor"]);
setup(["add-group", "fenn", "--title", "Fenn"]);
setup(["add-unit", "fenn/rig-import", "--title", "Import Fenn's rig"]);

const LONG_TITLE = "Export every one of Fenn's animations and check each against the frame data";
const viewData = () => { const m = f.read(".tracker/view.html").match(/const D=(.*);\n/); assert.ok(m, "no data in the view"); return JSON.parse(m[1]); };

describe("bare IDs and long text, checked at write time", () => {
  test("bare ID refused at write time, with the fix", () => {
    setup(["add-unit", "fenn/anim", "--title", "Export Fenn's animations", "--needs", "fenn/rig-import"]);
    has(t(["edit", "fenn/anim", "--detail", "Raw ID fenn/rig-import here"], {}, { merged: true }).stdout, "Raw ID {unit:fenn/rig-import} here");
  });
  // Evidence and notes get a bare ID written as {unit:…}, and say so: refusing them cost lanes
  // turns of resending long text, and the owner sees the title either way.
  let out = "";
  test("bare ID in a note written as {unit:…}", () => {
    out = ok(["note", "fenn/anim", "see fenn/rig-import first"], {}, { merged: true });
    const u = f.json("tracker/groups/fenn.json").units.find((u: { id: string }) => u.id === "fenn/anim");
    has(JSON.stringify(u.notes[0].text), '"see {unit:fenn/rig-import} first"');
  });
  test("saying so", () => { has(out, "the note: wrote fenn/rig-import as {unit:fenn/rig-import}"); });
  test("and that it was noted, last", () => { has(lastLine(out), "noted on Export Fenn's animations (fenn/anim)"); });
  test("bare ID in a question refused", () => {
    assert.equal(t(["ask", "--title", "Is fenn/rig-import right?", "--context", "x", "--option", "a|A|x", "--option", "b|B|y", "--default", "a", "--blocks", "fenn/anim"]).code, 2);
  });
  test("bare ID in a decision refused", () => {
    assert.equal(t(["decide", "--title", "fenn/rig-import uses Blender 4", "--why", "x", "--scope", "fenn/anim"]).code, 2);
  });
  test("over-long note refused", () => { assert.equal(t(["note", "fenn/anim", "x".repeat(300)]).code, 2); });
  test("over-long title refused, with a shorter one offered", () => {
    out = t(["add-unit", "fenn/long", "--title", LONG_TITLE], {}, { merged: true }).stdout;
    has(out, '--title "Export every one of Fenn');
  });
  test("and the rest moved to --detail", () => { has(out, "--detail"); });
  test("over-long group title refused", () => {
    assert.equal(t(["add-group", "toolong", "--title", "A group whose title goes on and on well past the sixty character limit"]).code, 2);
  });
  test("bare ID in evidence written as {unit:…}", () => {
    out = ok(["done", "fenn/anim", "--dry-run", "--evidence", "same as fenn/rig-import"], {}, { merged: true });
    has(out, "--evidence: wrote fenn/rig-import as {unit:fenn/rig-import}");
  });
  test("shown as the title the owner reads", () => { has(out, "same as Import Fenn's rig (fenn/rig-import)"); });
  test("over-long title refused on edit too", () => { assert.equal(t(["edit", "fenn/anim", "--title", LONG_TITLE]).code, 2); });
});

describe("lint and lint --broken", () => {
  test("lint passes", () => {
    setup(["edit", "fenn/anim", "--detail", "After {unit:fenn/rig-import}"]);
    assert.equal(t(["lint"]).code, 0);
  });
  // a slip that got in anyway (a hand edit, a merge): lint reports it, but only broken data stops a loop
  test("lint catches a bare unit ID", () => {
    f.edit("tracker/groups/fenn.json", (g) => {
      g.units.find((u: { id: string }) => u.id === "fenn/anim").notes = [{ at: "2026-10-10T00:00:00Z", by: "x", text: "see fenn/rig-import" }];
    });
    assert.equal(t(["lint"]).code, 1);
  });
  test("lint --broken lets a slip through", () => { assert.equal(t(["lint", "--broken"]).code, 0); });
  test("and lists it as a warning", () => {
    has(ok(["lint", "--broken"], {}, { merged: true }), "warning: fenn/anim note: names fenn/rig-import bare");
  });
  test("lint --broken fails on broken data", () => {
    f.edit("tracker/groups/fenn.json", (g) => {
      const u = g.units.find((u: { id: string }) => u.id === "fenn/anim"); u.notes = []; u.needs = ["fenn/nowhere"];
    });
    assert.equal(t(["lint", "--broken"]).code, 1);
  });
  test("lint passes again", () => {
    setup(["edit", "fenn/anim", "--needs", "fenn/rig-import"]);
    assert.equal(t(["lint"]).code, 0);
  });
});

// Agents write {d:<slug>} without the d/ a decision's ID starts with: it shows as the decision
// all the same, and a reference to nothing is a slip lint reports.
describe("references to decisions and questions by their slug", () => {
  let out = "";
  test("{d:<slug>} shows the decision's title, then its ID", () => {
    setup(["decide", "--title", "Rigs come from Blender 4", "--why", "the exporter needs it", "--scope", "fenn/*"]);
    setup(["decide", "--title", "Fenn's rig is exported once", "--why", "same rules as {d:rigs-come-from-blender-4}", "--scope", "fenn/*"]);
    has(ok(["show", "d/fenn-s-rig-is-exported-once"]), "Why: same rules as Rigs come from Blender 4 (d/rigs-come-from-blender-4)");
  });
  test("{d:d/<slug>} still does", () => {
    setup(["edit", "fenn/anim", "--detail", "per {d:d/rigs-come-from-blender-4}"]);
    has(ok(["show", "fenn/anim"]), "per Rigs come from Blender 4 (d/rigs-come-from-blender-4)");
  });
  test("{q:<slug>} shows the question's title", () => {
    setup(["ask", "--title", "Which Blender for the rigs?", "--context", "x", "--option", "a|Blender 4|x", "--option", "b|Blender 3|y", "--default", "a", "--blocks", "fenn/anim", "--id", "which-blender", "--force"]);
    setup(["note", "fenn/anim", "waits on {q:which-blender}"]);
    has(ok(["show", "fenn/anim"]), "waits on Which Blender for the rigs? (q/which-blender)");
    setup(["withdraw", "q/which-blender", "--why", "moot"]);
  });
  test("and lint passes on both", () => { assert.equal(t(["lint"]).code, 0); });
  test("a reference to a decision that doesn't exist fails lint", () => {
    setup(["decide", "--title", "Fenn's jab is frame-exact", "--why", "as {d:no-such-decision} says", "--scope", "fenn/*"]);
    out = t(["lint"], {}, { merged: true }).stdout;
    has(out, "d/fenn-s-jab-is-frame-exact why: {d:no-such-decision} names no decision");
  });
  test("so does one to a question that doesn't exist", () => {
    setup(["edit", "fenn/anim", "--detail", "waits on {q:no-such-question}"]);
    has(t(["lint"], {}, { merged: true }).stdout, "fenn/anim detail: {q:no-such-question} names no question");
  });
  after(() => {
    setup(["edit", "fenn/anim", "--detail", "After {unit:fenn/rig-import}"]);
    f.edit("tracker/decisions.json", (d) => { d.decisions = d.decisions.filter((x: { id: string }) => x.id !== "d/fenn-s-jab-is-frame-exact"); });
  });
});

describe("a unit that names a resource's words (named_by) without --uses: a warning when filed and in lint, never a failure", () => {
  let out = "";
  test("add-unit still succeeds when it warns", () => {
    f.edit("tracker/project.json", (p) => { p.resources.editor.named_by = ["\\bPIE\\b", "just look"]; p.resources.screen = { title: "the screen" }; });
    assert.equal(t(["add-unit", "fenn/jab-look", "--title", "See Fenn's jab", "--detail", "Check it in PIE"]).code, 0);
  });
  test("edit warns on PIE without --uses", () => {
    has(ok(["edit", "fenn/jab-look", "--detail", "Check it in PIE"], {}, { merged: true }), "fenn/jab-look: says it needs the level editor but doesn't use it; add --uses editor");
  });
  test("but not on a lowercase pie", () => {
    hasnt(ok(["add-unit", "fenn/chart", "--title", "Draw a pie chart of Fenn's moves"], {}, { merged: true }), "warning");
  });
  test("a probe match keeps the other resources in the hint", () => {
    has(ok(["add-unit", "fenn/probe-look", "--title", "Fenn's dash", "--probe-cmd", "just look fenn dash", "--uses", "screen"], {}, { merged: true }), "add --uses screen,editor");
  });
  test("lint doesn't fail on it", () => { assert.equal(t(["lint"]).code, 0); });
  test("but warns", () => {
    out = ok(["lint"], {}, { merged: true });
    has(out, "warning: fenn/jab-look: says it needs the level editor");
  });
  test("and says so in its summary", () => { has(out, "lint ok but 2 warnings"); });
  test("no warning once they use the editor", () => {
    setup(["edit", "fenn/jab-look", "--uses", "editor"]); setup(["edit", "fenn/probe-look", "--uses", "screen,editor"]);
    hasnt(ok(["lint"], {}, { merged: true }), "warning");
  });
  test("dropped units aren't warned about on edit", () => {
    setup(["add-unit", "fenn/old-look", "--title", "An old look", "--detail", "just look fenn"]);
    setup(["drop", "fenn/old-look", "--why", "superseded"]);
    hasnt(ok(["edit", "fenn/old-look", "--detail", "just look fenn, later"], {}, { merged: true }), "warning");
  });
  test("dropped units and gates aren't flagged", () => {
    setup(["add-unit", "fenn/pie-gate", "--gate", "--title", "Playtest Fenn", "--detail", "the owner plays him in PIE"]);
    hasnt(ok(["lint"], {}, { merged: true }), "warning");
  });
  test("a string named_by is one regex, commas and all", () => {
    f.edit("tracker/project.json", (p) => { p.resources.editor.named_by = "Debug Room{1,2}"; });
    setup(["edit", "fenn/chart", "--detail", "in the Debug Room"]);
    has(ok(["lint"], {}, { merged: true }), "warning: fenn/chart: says it needs the level editor");
  });
  test("a bad named_by regex doesn't stop a loop", () => {
    f.edit("tracker/project.json", (p) => { p.resources.editor.named_by = ["(PIE"]; });
    assert.equal(t(["lint", "--broken"]).code, 0);
  });
  test("but is a warning", () => {
    has(ok(["lint"], {}, { merged: true }), 'named_by: "(PIE" isn\'t a regex');
  });
  after(() => {
    f.edit("tracker/project.json", (p) => { delete p.resources.editor.named_by; });
    for (const u of ["jab-look", "chart", "probe-look", "pie-gate"]) f.tryIn(["drop", `fenn/${u}`, "--why", "test done"]);
  });
});

describe("the spec holds rules: lint counts its words and its line lengths, since page-long lines passed a line count", () => {
  let out = "";
  test("a short spec passes lint", () => {
    f.write("docs/factory.md", "# Spec\n\nShort rules.\n");
    assert.equal(t(["lint"]).code, 0);
  });
  test("a long spec fails lint, by words", () => {
    f.write("docs/factory.md", "# Spec\n\n" + "rule ".repeat(4100) + "\n");
    out = t(["lint"], {}, { merged: true }).stdout;
    has(out, "docs/factory.md is 4102 words (max 4000)");
  });
  test("and says where the detail goes", () => { has(out, "docs/tools/<tool>.md"); });
  test("and by line length", () => { has(out, "docs/factory.md:3: line is"); });
  test("lint passes without the spec", () => {
    fs.rmSync(f.at("docs/factory.md"));
    assert.equal(t(["lint"]).code, 0);
  });
});

describe("log, view", () => {
  test("log uses titles", () => {
    // The view is removed first, so the check below sees this write rebuild it.
    fs.rmSync(f.at(".tracker/view.html"), { force: true });
    ok(["drop", "pipe/gui", "--why", "not needed"]);
    has(ok(["log", "-n", "5"]), "Click through the editor: dropped");
  });
  test("view rebuilt on write", () => {
    assert.ok(fs.statSync(f.at(".tracker/view.html")).size > 0);
    has(f.read(".tracker/view.html"), "Needs you");
  });
  test("view data parses", () => { viewData(); });
  // Text with replace() patterns ($' $& $`) in it, as a sed one-liner has, must reach the page as written.
  test("and still parses with $' in a note", () => {
    ok(["note", "pipe/convert", "split with sed $'s/\\t/,/g' and $& and $`"]);
    viewData();
  });
  // The units list sorts by these: the order next takes them, priority, and when each was added and last changed.
  test("each unit carries its order, priority and log times", () => {
    const us = viewData().groups.flatMap((g: { units: { id: string }[] }) => g.units);
    const conv = us.find((u: { id: string }) => u.id === "pipe/convert");
    assert.equal(typeof conv.o, "number");
    assert.equal(conv.p, 0);
    assert.ok(conv.first && conv.last && conv.first <= conv.last, "added and changed times from the log");
    assert.deepEqual(us.map((u: { o: number }) => u.o).sort((a: number, b: number) => a - b), us.map((_: unknown, i: number) => i));
  });
  test("the page has the units list's search, group and sort", () => {
    const html = f.read(".tracker/view.html");
    has(html, 'id="units"'); has(html, "search units"); has(html, "every group"); has(html, "sort: the order next takes them");
  });
});

// A probe that runs close to its timeout is a timeout waiting to happen, and a timeout fails it.
describe("a probe whose last run took most of its timeout: a lint warning", () => {
  const cached = (id: string, secs: number) => {
    const c = fs.existsSync(f.at(".tracker/cache.json")) ? f.json(".tracker/cache.json") : {};
    c[id] = { fp: null, pass: true, at: "2026-10-22T00:00:00Z", evidence: "ok", secs };
    f.write(".tracker/cache.json", JSON.stringify(c));
  };
  test("85% of its timeout warns, saying how long it took", () => {
    setup(["add-group", "slow", "--title", "Slow checks"]);
    setup(["add-unit", "slow/near", "--title", "Near its timeout", "--probe-cmd", "true"]);
    f.edit("tracker/groups/slow.json", (g) => { g.units[0].probe.timeout = 100; });
    cached("slow/near", 85);
    const out = ok(["lint"], {}, { merged: true });
    has(out, "warning: Near its timeout (slow/near): its check took 85s last time, 85% of its 100s timeout");
  });
  test("without failing lint", () => { assert.equal(t(["lint"]).code, 0); });
  test("70% doesn't", () => {
    cached("slow/near", 70);
    hasnt(ok(["lint"], {}, { merged: true }), "slow/near");
  });
  test("the default timeout is 900s", () => {
    setup(["add-unit", "slow/dflt", "--title", "Default timeout", "--probe-cmd", "true"]);
    cached("slow/dflt", 800);
    has(ok(["lint"], {}, { merged: true }), "its check took 800s last time, 89% of its 900s timeout");
  });
  test("a probe cache that won't parse doesn't stop lint: it's rebuilt, not data", () => {
    const keep = f.read(".tracker/cache.json");
    f.write(".tracker/cache.json", "{not json");
    assert.equal(t(["lint", "--broken"]).code, 0);
    f.write(".tracker/cache.json", keep);
  });
  after(() => { for (const u of ["slow/near", "slow/dflt"]) setup(["drop", u, "--why", "test"]); });
});
