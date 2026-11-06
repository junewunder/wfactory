// The owner's "later": an option asked with --parks parks what the question blocks, and the
// decision it records is a postponement: the units it's tied to aren't offered (reopened too), and
// asking about them again is refused, --force or not, until an unpark. Run: node --test tracker/test/
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { trackerRepo, has, hasnt } from "../../test/lib/index.ts";

const f = trackerRepo("repo", { FACTORY_TAG: "worker1", FACTORY_EVIDENCE_MIN: "0" });
const { t, ok, setup } = f;
setup(["init", "--title", "Test port"]);
setup(["add-group", "pp", "--title", "Postponed work"]);
for (const [u, title] of [["later", "Port the old menus"], ["scoped", "Port the old menu sounds"], ["other", "Port the new menus"]]) setup(["add-unit", `pp/${u}`, "--title", title]);

const state = (id: string) => ok(["state", id]).replace(/\n+$/, "");
const nextFor = (tag: string) => JSON.parse(t(["next", "--json"], { FACTORY_TAG: tag }).stdout);
const askLater = (extra: string[], tag = "lane1") => t(["ask", "--title", "Should the old menus be ported now?", "--context", "x",
  "--option", "now | Now | they're ported tonight", "--option", "later | Leave it for later | they wait", "--default", "now", "--blocks", "pp/later", ...extra], { FACTORY_TAG: tag }, { merged: true });

describe("an answer that puts the work off parks it, and keeps it parked", () => {
  test("--parks names an option", () => {
    has(askLater(["--parks", "soon"]).stdout, "--parks soon isn't one of the options (now, later)");
  });
  test("ask: the question says which option puts it off", () => {
    setup(["claim", "pp/later"], { FACTORY_TAG: "lane1" });
    const r = askLater(["--parks", "later", "--scope", "pp/scoped", "--id", "old-menus"]);
    assert.equal(r.code, 0, r.stdout);
    has(ok(["show", "q/old-menus"]), "→ puts it off: parks everything it blocks");
  });
  test("and remembers the unit it was asked from", () => {
    assert.equal(f.json("tracker/questions.json").questions.find((q: { id: string }) => q.id === "q/old-menus").asked.unit, "pp/later");
  });
  test("lint finds nothing to say about it", () => { hasnt(t(["lint"], {}, { merged: true }).stdout, "old-menus"); });
  let out = "";
  test("answer parks the unit", () => {
    out = ok(["answer", "q/old-menus", "later"]);
    has(out, "Parked, as the owner put it off: 1 unit: Port the old menus (pp/later)");
    assert.equal(state("pp/later"), "parked");
  });
  test("the park names the question and the answer", () => {
    has(ok(["show", "pp/later"]), "put off by the owner's answer to Should the old menus be ported now?");
  });
  test("the decision remembers it put the work off", () => {
    const d = f.json("tracker/decisions.json").decisions.find((x: { id: string }) => x.id === "d/old-menus");
    assert.equal(d.postpones, true);
    has(ok(["decisions"]), "Should the old menus be ported now: Leave it for later (the owner");
    has(ok(["decisions"]), "[put off]");
  });
  test("reopened, it's still parked", () => {
    setup(["reopen", "pp/later"]);
    assert.equal(state("pp/later"), "parked");
    has(ok(["show", "pp/later"]), "the owner put it off: Should the old menus be ported now: Leave it for later");
  });
  test("so is a unit the decision's scope names", () => { assert.equal(state("pp/scoped"), "parked"); });
  test("next never offers them", () => {
    assert.equal(nextFor("lane2").id, "pp/other");
    setup(["drop", "pp/other", "--why", "test"]);
    assert.notEqual(nextFor("lane2").code, 0);
  });
  test("asking again is refused, even with --force", () => {
    const r = askLater(["--force", "--id", "old-menus-again"], "lane2");
    assert.equal(r.code, 2);
    has(r.stdout, "The owner put this off, above, so nothing was asked");
    has(r.stdout, "Port the old menus (pp/later)");
  });
  test("unpark brings it back", () => {
    has(ok(["unpark", "pp/later"]), "back to work: Port the old menus (pp/later) (ready)");
    assert.equal(state("pp/later"), "ready");
    assert.equal(nextFor("lane2").id, "pp/later");
  });
  test("and only it: the scoped unit stays put off", () => { assert.equal(state("pp/scoped"), "parked"); });
  test("a decision without the flag parks nothing", () => {
    setup(["ask", "--title", "Do the old menu sounds keep their mix?", "--context", "x", "--option", "a | Keep | x", "--option", "b | Remix | y", "--default", "a", "--blocks", "pp/later", "--id", "mix"]);
    has(ok(["answer", "q/mix", "a"]), "Released 1 unit: Port the old menus (pp/later)");
    assert.equal(state("pp/later"), "ready");
  });
});
