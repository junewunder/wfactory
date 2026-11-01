// The tracker CLI end to end: templates, questions and decisions, withdraw and question IDs,
// gates and the exit codes of next. Run: node --test tracker/test/
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { trackerRepo, has, hasnt, lastLine } from "../../test/lib/index.ts";

const f = trackerRepo("repo", { FACTORY_TAG: "worker1", FACTORY_EVIDENCE_MIN: "0" });
const { t, ok, setup } = f;
setup(["init", "--title", "Test port"]);

const twoOpts = ["--option", "a|A|x", "--option", "b|B|y", "--default", "a"];

describe("templates", () => {
  test("template makes a group", () => {
    f.write("tracker/templates/character.json", `{ "name": "character", "title": "{Name}", "param": "name",
  "units": [
    { "slug": "extract", "title": "Extract {Name}'s data", "check": "recorded" },
    { "each": "work/{name}/moves.json#/attacks", "as": "move", "slug": "{move.slug}",
      "title": "{Name}'s {move.title}", "needs": ["extract"], "tags": ["{move.kind}"],
      "probe": { "file": "work/{name}/{move.slug}.ok" } },
    { "slug": "playtest", "title": "Playtest {Name}", "kind": "gate", "needs": ["*"] }
  ] }
`);
    f.write("work/mira/.keep", "");
    has(ok(["add", "mira", "--template", "character"]), "Mira (mira): 2 units");
  });
  test("sync adds units from data", () => {
    f.write("work/mira/moves.json", '{"attacks":[{"slug":"up-strike","title":"up strike","kind":"multi-hit"},{"slug":"jab","title":"jab","kind":"single"}]}\n');
    has(ok(["sync", "mira"]), "2 units added");
  });
  test("template title", () => { has(ok(["show", "mira/up-strike"]), "Mira's up strike (mira/up-strike)"); });
  // The bash check grepped the file for "mira/jab" within 12 lines after the gate's ID: here,
  // the unit exists and the gate's needs name it.
  test("gate * picks up synced units", () => {
    const units = f.json("tracker/groups/mira.json").units;
    assert.ok(units.some((u: { id: string }) => u.id === "mira/jab"));
    assert.ok(units.find((u: { id: string }) => u.id === "mira/playtest").needs.includes("mira/jab"));
  });
});

describe("questions and decisions", () => {
  test("ask without options refused", () => {
    assert.equal(t(["ask", "--title", "How?", "--context", "x", "--blocks", "mira/up-strike"]).code, 2);
  });
  test("ask needs a question mark", () => {
    assert.equal(t(["ask", "--title", "One hitbox per hit", "--context", "x", ...twoOpts, "--blocks", "x"]).code, 2);
  });
  test("ask reports what it blocks", () => {
    setup(["done", "mira/extract", "--evidence", "ok"]);
    setup(["claim", "mira/up-strike"]);
    has(ok(["ask", "--title", "Should multi-hit moves use one hitbox per hit?", "--context", "Moves like {unit:mira/up-strike} hit several times.",
      "--option", "a | One hitbox per hit | Matches frame data", "--option", "b | One refreshing hitbox | Fewer assets",
      "--default", "a", "--blocks", "tag:multi-hit", "--scope", "tag:multi-hit", "--id", "multi-hit-hitboxes"]), "It blocks 1 unit");
  });
  test("unit waits on the owner's question", () => { has(ok(["show", "mira/up-strike"]), "waiting on you: Should multi-hit moves use one hitbox per hit?"); });
  test("questions expand refs to titles", () => { has(ok(["questions"]), "Moves like Mira's up strike (mira/up-strike) hit"); });
  test("questions show the default", () => { has(ok(["questions"]), "a) One hitbox per hit (default): Matches frame data"); });
  const dup = ["ask", "--title", "Should multi-hit moves get one hitbox per hit?", "--context", "y", ...twoOpts, "--blocks", "mira/jab"];
  test("duplicate question refused", () => { assert.equal(t(dup).code, 2); });
  test("the reason on the last line, after the question it matches", () => {
    has(lastLine(t(dup, {}, { merged: true }).stdout), "The owner already has a question like this, above, so nothing was asked.");
  });
  test("next exits 0 while other work exists", () => { assert.equal(t(["next"]).code, 0); });
  test("answer releases units", () => { has(ok(["answer", "q/multi-hit-hitboxes", "a", "--note", "keep it simple"]), "Released 1 unit"); });
  test("decision shows on the card", () => { has(ok(["show", "mira/up-strike"]), "Decisions for this unit (why:"); });
  test("answered question can't be re-asked", () => {
    assert.equal(t(["ask", "--title", "Should multi-hit moves use one hitbox per hit?", "--context", "y", ...twoOpts, "--blocks", "mira/jab"]).code, 2);
  });
  test("decision search", () => { has(ok(["decisions", "hitbox"]), "the owner"); });
  test("agent decision scoped to units", () => {
    setup(["decide", "--title", "Jabs use the new jab timing", "--why", "it reads better in game", "--scope", "*/jab"]);
    has(ok(["show", "mira/jab"]), "Jabs use the new jab timing");
  });
  // A card names decisions by title alone, this unit's own before those for every unit; --full adds why.
  test("card: this unit's decisions first", () => {
    setup(["decide", "--title", "Every move keeps its Classic frame data", "--why", "faithful first", "--scope", "*"]);
    const out = ok(["show", "mira/jab"]);
    const at = (s: string) => { const i = out.indexOf(s); assert.ok(i >= 0, `wanted: ${s}\ngot: ${out}`); return i; };
    const a = at("Decisions for this unit (why: `just decisions <words>`):");
    const b = at("- Jabs use the new jab timing");
    const c = at("Decisions for every unit:");
    const d = at("- Every move keeps its Classic frame data");
    assert.ok(a < b && b < c && c < d, out);
  });
  test("card: no why without --full", () => { hasnt(ok(["show", "mira/jab"]), "reads better in game"); });
  test("show --full: the why", () => { has(ok(["show", "mira/jab", "--full"]), "Why: it reads better in game"); });
  test("show --full before the ID", () => { has(ok(["show", "--full", "mira/jab"]), "Why: it reads better in game"); });
  // --full gives this unit's decisions' why, and of those for every unit only where they are: the
  // card has their titles (2026-10-23: with every why, a card ran to 42k characters; 2026-10-28:
  // with every title, --full ran to 13-18k, and every session ran it first); --why-all gives them all.
  test("show --full: not the decisions for every unit, but where they are", () => {
    const out = ok(["show", "mira/jab", "--full"]);
    hasnt(out, "Why: faithful first");
    hasnt(out, "Every move keeps its Classic frame data");
    has(out, "Decisions for every unit: 1, on the card by title (`just show mira/jab`); `just decisions <words>` finds one and gives its why, `just show mira/jab --why-all` all of them");
  });
  test("show --why-all: every why", () => { has(ok(["show", "mira/jab", "--why-all"]), "Why: faithful first"); });
  test("notes come right after what done means, before the decisions", () => {
    setup(["note", "mira/jab", "the hitbox moved a frame"]);
    const out = ok(["show", "mira/jab", "--full"]);
    const i = out.indexOf("  Done when:"), n = out.indexOf("  Notes from earlier attempts:"), d = out.indexOf("  Decisions for");
    assert.ok(i >= 0 && i < n && n < d, out);
  });
  // Without a scope a decision would reach no card: refused, saying how to scope it to everything.
  let nd = 0, out = "";
  test("decide without --scope is refused", () => {
    nd = f.json("tracker/decisions.json").decisions.length;
    out = t(["decide", "--title", "Everything uses one rig", "--why", "simpler"], {}, { merged: true }).stdout;
    has(out, "decide needs --scope");
  });
  test("saying how to scope it to every unit", () => { has(out, "--scope '*'"); });
  test("and nothing is recorded", () => { assert.equal(f.json("tracker/decisions.json").decisions.length, nd); });
  test("--scope '*' reaches every card", () => {
    setup(["decide", "--title", "Everything uses one rig", "--why", "simpler", "--scope", "*"]);
    has(ok(["show", "mira/up-strike"]), "Everything uses one rig");
  });
  test("a replacement keeps the scope of what it replaces", () => {
    setup(["decide", "--title", "Everything uses two rigs", "--why", "better", "--replaces", "d/everything-uses-one-rig"]);
    has(ok(["show", "mira/up-strike"]), "Everything uses two rigs");
  });
});

// show --json: notes and the decisions that apply, for the loop's inbox hook.
describe("show --json", () => {
  let j: { id: string; notes: unknown; decisions: { title: string; at: unknown }[] };
  test("show --json lists the decisions that apply", () => {
    j = JSON.parse(ok(["show", "mira/jab", "--json"]));
    assert.ok(j.decisions.map((d) => d.title).includes("Jabs use the new jab timing"));
  });
  test("with the unit and its notes, each dated", () => {
    assert.equal(j.id, "mira/jab");
    assert.ok(Array.isArray(j.notes));
    assert.equal(typeof j.decisions[0].at, "string");
  });
});

describe("withdraw, key-word question IDs", () => {
  test("question ID from key words", () => {
    has(ok(["ask", "--title", "Do we keep the old grab range for every character?", "--context", "x", "--option", "a | Keep | x", "--option", "b | Change | y", "--default", "a", "--blocks", "mira/jab"]),
      "q/old-grab-range-every-character");
  });
  test("--id names the question", () => {
    setup(["block", "mira/jab", "--on", "q/old-grab-range-every-character"]);
    has(ok(["ask", "--title", "Which grab range should all characters share?", "--context", "x", "--option", "a | New | x", "--option", "b | Old | y", "--default", "a", "--blocks", "mira/jab", "--id", "grab-range", "--force"]),
      "q/grab-range");
  });
  test("withdraw records no decision", () => {
    const nd = f.json("tracker/decisions.json").decisions.length;
    ok(["withdraw", "q/old-grab-range-every-character", "--why", "re-asked as q/grab-range"]);
    assert.equal(f.json("tracker/decisions.json").decisions.length, nd);
  });
  test("withdraw moves the block to the new question", () => {
    assert.equal(f.json("tracker/groups/mira.json").units.find((u: { id: string }) => u.id === "mira/jab").record.on, "q/grab-range");
  });
  test("withdrawn question gone", () => {
    hasnt(ok(["questions"]), "old grab range");
  });
  after(() => {
    setup(["answer", "q/grab-range", "a"]);
  });
});

describe("gates, exit codes", () => {
  test("gate waits on the owner", () => {
    for (const u of ["up-strike", "jab"]) f.write(`work/mira/${u}.ok`, "");
    setup(["refresh"]);
    has(ok(["questions"]), "Gate: Playtest Mira (mira/playtest)");
  });
  test("only the owner's work left: exit 3", () => { assert.equal(t(["next"]).code, 3); });
  test("all done: exit 1", () => {
    setup(["pass", "mira/playtest", "--note", "feels right"]);
    assert.equal(t(["next"]).code, 1);
  });
});

// Passing the opening's gate while the probe's review was open counted the opening as over and
// left the review waiting on the owner forever.
describe("passing a gate whose needs aren't done", () => {
  let r = { code: 0, stdout: "" };
  test("is refused", () => {
    setup(["add-group", "gpass", "--title", "Gate needs"]);
    setup(["add-unit", "gpass/probe", "--gate", "--title", "The probe's result: go or stop"]);
    setup(["add-unit", "gpass/work", "--title", "Some unfinished work"]);
    setup(["add-unit", "gpass/ready", "--gate", "--title", "Ready for lanes", "--needs", "gpass/probe,gpass/work"]);
    r = t(["pass", "gpass/ready"], {}, { merged: true });
    assert.equal(r.code, 2);
  });
  test("naming each open need", () => { has(r.stdout, "The probe's result: go or stop (gpass/probe)"); has(r.stdout, "Some unfinished work (gpass/work)"); });
  test("and nothing is passed", () => {
    has(r.stdout, "nothing was passed");
    assert.equal(f.json("tracker/groups/gpass.json").units.find((u: { id: string }) => u.id === "gpass/ready").record, undefined);
  });
  test("--force passes it, with a warning naming them", () => {
    r = t(["pass", "gpass/ready", "--force"], {}, { merged: true });
    assert.equal(r.code, 0);
    has(r.stdout, "warning: passed with --force while 2 units it needs aren't done");
    has(r.stdout, "Some unfinished work (gpass/work)");
  });
  test("a need that names no unit counts as open", () => {
    setup(["add-unit", "gpass/typo", "--gate", "--title", "A gate with a typo"]);
    f.edit("tracker/groups/gpass.json", (g) => { g.units.find((u: { id: string }) => u.id === "gpass/typo").needs = ["gpass/nowhere"]; });
    r = t(["pass", "gpass/typo"], {}, { merged: true });
    assert.equal(r.code, 2); has(r.stdout, "gpass/nowhere: no such unit");
  });
  test("so does a need of its group's", () => {
    setup(["add-group", "gneeds", "--title", "Group needs"]);
    setup(["add-unit", "gneeds/gate", "--gate", "--title", "The group's gate"]);
    setup(["edit-group", "gneeds", "--needs", "gpass/work"]);
    has(t(["pass", "gneeds/gate"], {}, { merged: true }).stdout, "Some unfinished work (gpass/work)");
  });
  test("with its needs done it passes without a word", () => {
    setup(["add-unit", "gpass/next", "--gate", "--title", "The next step", "--needs", "gpass/probe"]);
    setup(["pass", "gpass/probe"]);
    hasnt(ok(["pass", "gpass/next"], {}, { merged: true }), "warning");
  });
  after(() => { f.tryIn(["edit-group", "gneeds", "--needs", ""]); for (const u of ["work", "ready", "probe", "next", "typo"]) f.tryIn(["drop", `gpass/${u}`, "--why", "test done"]); });
});
