// The tracker CLI end to end: of the decisions for every unit, a card lists the owner's and ten
// more (those that share two words with the unit, then the newest) and counts the rest;
// show --full doesn't add them (only the why of the unit's own), and --why-all lists them all. Run: node --test tracker/test/
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { trackerRepo, has, hasnt } from "../../test/lib/index.ts";

const f = trackerRepo("cards", { FACTORY_TAG: "worker1", FACTORY_EVIDENCE_MIN: "0" });
const { ok, setup } = f;
setup(["init", "--title", "Card cap"]);
setup(["add-group", "cap", "--title", "Card cap"]);
setup(["add-unit", "cap/fire-shader", "--title", "Port the fire shader's glow"]);
const decide = (title: string, ...more: string[]) => setup(["decide", "--title", title, "--why", "w", "--scope", "*", ...more]);
// The owner's and the one sharing the unit's words come first, the oldest: each is kept only by its own rule.
decide("Nothing ships without a look", "--by", "owner");
decide("The fire shader glow stays additive");
for (let i = 1; i <= 12; i++) decide(`Old rule number ${i} about logging`);
for (let i = 13; i <= 20; i++) decide(`Newer rule number ${i} about caches`);

describe("a card's decisions for every unit", () => {
  const card = () => ok(["show", "cap/fire-shader"]);
  test("the owner's is kept", () => { has(card(), "Nothing ships without a look (the owner)"); });
  test("  one sharing the unit's words is kept", () => { has(card(), "The fire shader glow stays additive"); });
  test("  the newest are kept", () => { has(card(), "Newer rule number 20 about caches"); });
  test("  an old one about other work is left off", () => { hasnt(card(), "Old rule number 3 about logging"); });
  test("  the owner's and ten more listed, then one line for the rest", () => {
    const part = card().split("Decisions for every unit")[1].split("\n").filter((l) => l.startsWith("    - "));
    assert.equal(part.length, 12, part.join("\n"));
  });
  test("  which counts them and says how to find one", () => { has(card(), "and 11 more for every unit (`just decisions <words>` finds one"); });
  // (2026-10-28: --full listed all ~60 a card by title, and every session ran it first thing.)
  test("  show --full lists no more of them", () => { hasnt(ok(["show", "cap/fire-shader", "--full"]), "Old rule number 3 about logging"); });
  test("  and says where they are", () => { has(ok(["show", "cap/fire-shader", "--full"]), "Decisions for every unit: 22, 11 of them on the card by title"); });
  test("  show --why-all lists them all", () => { has(ok(["show", "cap/fire-shader", "--why-all"]), "Old rule number 3 about logging"); });
});

// Where an unfinished unit's outputs went when the store's copy was put back over them (store.sh
// aside-set): its card says so, and to rebuild before trusting notes about work/; not once it's
// back (--clear) or settled.
describe("a card names where its last attempt's outputs were set aside", () => {
  test("aside-set: the card says where, built from which commit, and to rebuild", () => {
    setup(["add-unit", "cap/set", "--title", "Set aside unit"]);
    setup(["aside-set", "cap/set", "work/.store/aside/cap-20261023-041324", "--commit", "0123456789abcdef", "--by", "6e0a534b"]);
    has(ok(["show", "cap/set"]), "  Set aside: when session 6e0a534b ended it unfinished, its outputs went to work/.store/aside/cap-20261023-041324 on testhost, built from commit 01234567, and the store's copy was put back in work/.");
    has(ok(["show", "cap/set"]), "otherwise rebuild them before trusting earlier notes about what's in work/.");
  });
  test("  --clear: no line", () => {
    setup(["aside-set", "cap/set", "--clear"]);
    hasnt(ok(["show", "cap/set"]), "Set aside:");
  });
  test("  nor once the unit is done", () => {
    setup(["aside-set", "cap/set", "work/.store/aside/cap-x"]);
    setup(["claim", "cap/set"]); setup(["done", "cap/set", "--evidence", "rebuilt and checked"]);
    hasnt(ok(["show", "cap/set"]), "Set aside:");
  });
  test("state --by: the session its record names", () => { assert.equal(ok(["state", "cap/set", "--by"]).trim(), "worker1"); });
});
describe("a set mixed with other work: the card says it isn't put back", () => {
  test("aside-set --mixed", () => {
    setup(["add-unit", "cap/mix", "--title", "Mixed set unit"]);
    setup(["aside-set", "cap/mix", "work/.store/aside/cap-y", "--mixed"]);
    has(ok(["show", "cap/mix"]), "its outputs went to work/.store/aside/cap-y on testhost, mixed with other work, and the store's copy was put back in work/. They aren't put back: rebuild them");
  });
});
