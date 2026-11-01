// The tracker CLI end to end: find <words>, a guessed ID's suggestions, add-unit listing the open
// units like a new one, and --uses naming a resource. Run: node --test tracker/test/
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { trackerRepo, has, hasnt, firstLine, lastLine } from "../../test/lib/index.ts";

const f = trackerRepo("repo", { FACTORY_TAG: "worker1", FACTORY_EVIDENCE_MIN: "0" });
const { t, ok, setup } = f;
setup(["init", "--title", "Test port"]);

describe("find: units by their words, best first; add-unit lists the open units like it and warns when one may be the same work; --uses must name a resource", () => {
  let out = "";
  test("find names the unit, title first, with its status", () => {
    setup(["add-group", "fd", "--title", "Find test"]);
    setup(["add-unit", "fd/look-shots-pause", "--title", "just look's shots pause without the menu's Frame Advance"]);
    setup(["add-unit", "fd/dash", "--title", "Mira's dash frames", "--detail", "Measure the dash in the editor"]);
    setup(["add-unit", "fd/editor-crash", "--title", "The editor crashes on save", "--detail", "Seen after a long dash test"]);
    setup(["add-unit", "fd/old-dash", "--title", "Old dash frames"]); setup(["drop", "fd/old-dash", "--why", "test"]);
    out = ok(["find", "dash", "frame"]);
    has(firstLine(out), "- Mira's dash frames (fd/dash): ready");
  });
  test("a word in the detail only is found too, after title matches", () => { has(lastLine(out), "- The editor crashes on save (fd/editor-crash): ready"); });
  test("done and dropped units are found", () => { has(out, "Old dash frames (fd/old-dash): dropped"); });
  test("but not with --open", () => { hasnt(ok(["find", "dash", "frame", "--open"]), "Old dash frames"); });
  test("--open before the words keeps them all", () => { has(firstLine(ok(["find", "--open", "dash", "frames"])), "- Mira's dash frames (fd/dash): ready"); });
  test("a word's other endings match (crash, crashes)", () => { has(ok(["find", "crash"]), "The editor crashes on save"); });
  test("(saving, save)", () => { has(ok(["find", "saving"]), "The editor crashes on save"); });
  test("words of a guessed ID find it", () => { has(ok(["find", "mira/dash-frames"]), "Mira's dash frames"); });
  test("no match says so", () => { has(ok(["find", "zebra"]), 'No unit matches "zebra"'); });
  test("no words: usage, exit 2", () => { assert.equal(t(["find"]).code, 2); });
  test("a guessed ID suggests units with its words", () => {
    out = t(["show", "mira/dash-frames"], {}, { merged: true }).stdout;
    has(out, "Did you mean: Mira's dash frames (fd/dash)");
  });
  test("and points to find", () => { has(out, "just find <words>"); });
  test("its group's word alone suggests nothing", () => { hasnt(t(["show", "fd/zebra"], {}, { merged: true }).stdout, "Did you mean"); });
  test("add-unit with a near-duplicate still adds it", () => {
    const r = t(["add-unit", "fd/look-frame-advance", "--title", "Look shots: pause menu has no Frame Advance row"], {}, { merged: true });
    out = r.stdout;
    assert.equal(r.code, 0);
  });
  test("lists the open units like it", () => { has(out, "  - just look's shots pause without the menu's Frame Advance (fd/look-shots-pause): ready"); });
  test("and warns it may be the same work, suggesting a note on that one", () => {
    has(out, "warning: just look's shots pause without the menu's Frame Advance (fd/look-shots-pause) may already be this work");
  });
  test("saying how", () => { has(out, "just note fd/look-shots-pause"); });
  test("the unit is there", () => { has(ok(["state", "fd/look-frame-advance"]), "ready"); });
  test("add-unit with nothing like it lists nothing", () => {
    out = ok(["add-unit", "fd/sound", "--title", "Sound effects for the victory screen"], {}, { merged: true });
    hasnt(out, "most like it");
  });
  test("and doesn't warn", () => { hasnt(out, "warning:"); });
  test("add-unit doesn't list dropped units", () => {
    hasnt(ok(["add-unit", "fd/dash-old", "--title", "Old dash frames again"], {}, { merged: true }), "Old dash frames (fd/old-dash)");
  });
  test("add-unit --uses an unknown resource is refused", () => {
    f.edit("tracker/project.json", (p) => { p.resources = { editor: { title: "the level editor" } }; });
    const r = t(["add-unit", "fd/gui", "--title", "Click the editor", "--uses", "the level editor"], {}, { merged: true });
    out = r.stdout;
    assert.equal(r.code, 2);
  });
  test("naming the resources there are", () => { has(out, "editor (the level editor)"); });
  test("and nothing is added", () => { assert.equal(t(["state", "fd/gui"]).code, 2); });
  test("add-unit --uses a known resource is fine", () => {
    assert.equal(t(["add-unit", "fd/gui", "--title", "Click the editor", "--uses", "editor"]).code, 0);
  });
  test("edit --uses an unknown resource is refused too", () => { assert.equal(t(["edit", "fd/gui", "--uses", "editr"]).code, 2); });
  test("and leaves the unit as it was", () => {
    has(JSON.stringify(f.json("tracker/groups/fd.json").units.find((u: { id: string }) => u.id === "fd/gui").uses), '["editor"]');
  });
  test("lint is still clean", () => { assert.equal(t(["lint", "--broken"]).code, 0); });
});
