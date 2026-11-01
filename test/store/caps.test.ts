// Capabilities: a unit that needs one goes only to a machine that has it, as the machines file says
// (a can do "steam", b can't). Run: node --test test/store/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test } from "node:test";
import { has, hasnt } from "../lib/index.ts";
import { storeFactory, ONE } from "./factory.ts";

const f = storeFactory(["a", "b"]);
const { add, tr } = f;
const [a, b] = f.lanes;

describe("capabilities: a unit that needs one goes only to a machine that has it", () => {
  let b5 = "";
  test("a machine without the capability isn't offered the unit", () => {
    add("code/steam", "--caps", "steam");
    has(tr(b, ["next", "--json"], { FACTORY_CAPS: "" }).stdout, "for another machine");
  });
  test("  one with it is", () => { has(tr(a, ["next", "--json"], { FACTORY_CAPS: "steam" }).stdout, '"id":"code/steam"'); });
  test("  the loop reads Can from the machines file: b doesn't take it", () => {
    b5 = b.loop(ONE);
    hasnt(b5, "iteration 1: Unit steam");
  });
  // A unit an earlier test left open, its data not on the store, kept this loop and the next one
  // trying it every few seconds until last call, a minute and a half each (1d7060f).
  test("  (and finds nothing else to take)", () => { hasnt(b5, "data ready"); });
  test("  a does", () => { has(a.loop(ONE), "iteration 1: Unit steam of code"); });
});

f.notBroken();
