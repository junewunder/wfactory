// Before last call, a lane doesn't claim a unit last call will hold back with too little time left
// before it (#159: sessions claimed an editor unit 40 minutes before last call, read its card, saw
// it couldn't fit and gave it back). A unit using nothing CI needs is taken instead, and the
// morning summary hears what was held back. The loop runs in this process with its clock mocked
// (inproc.ts). Run: node --test test/loop/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { has, hasnt } from "../lib/index.ts";
import { hold, hmAt, type Run } from "./inproc.ts";
import { loopFactory, order } from "./factory.ts";
import { EVENTS_SUMMARY } from "../../runtime/src/fleet-help.ts";

const f = loopFactory("lcfit");
const { a, setup, state, loop, events } = f;

// Group E's CI uses the desk and is stale (a unit done, never run): last call holds back E's units
// and the desk. A stop in 2 hours, last call 30 minutes before it (at 90 min); min_unit_minutes
// 45 (its default). P one runs first, to 50 min: 40 minutes before last call.
describe("40 minutes before last call, a desk unit isn't claimed, and a unit using nothing is", () => {
  let r: Run, at50 = "";
  test("P one ends 40 minutes before last call: the lane takes P two, not E at the desk", async () => {
    setup("add-group", "ge", "--title", "Group E", "--ci", "desk", "--priority", "10");
    setup("add-unit", "ge/done", "--title", "E done"); setup("done", "ge/done", "--evidence", "x");
    setup("add-unit", "ge/ed", "--title", "E at the desk", "--uses", "desk");
    setup("add-group", "gp", "--title", "Group P");
    setup("add-unit", "gp/one", "--title", "P one", "--priority", "20");
    setup("add-unit", "gp/two", "--title", "P two");
    const one = hold(a.locks, "gp/one"), two = hold(a.locks, "gp/two");
    r = loop(["--hours", "2", "--last-call", "30", "--max", "2"]);
    await one.held();
    await r.at(50 * 60);
    one.go();
    await two.held();
    at50 = r.out();
    two.go();
    await r.end();
  });
  test("  P two is claimed after P one", () => { assert.equal(order(at50, /iteration [0-9]+: [PE] [a-z]+( [a-z]+)*(?= \()/), "P one,P two"); });
  test("  E at the desk isn't", () => { hasnt(at50, "E at the desk (ge/ed)"); });
  test("  the log says why", () => {
    has(at50, `1 unit using the desktop, held back: too little time before last call (45 min needed, 40 left); last call at ${hmAt(r.t0, 90 * 60)}`);
  });
  test("  the morning summary hears it", () => {
    assert.equal(events().split("\n").filter((l) => l.includes("\theld-back\t")).length, 1, events());
    has(events(), "1 unit using the desktop, held back: too little time before last call");
    assert.ok(EVENTS_SUMMARY.includes("held-back"));
  });
  test("  no session claimed it and gave it back", () => { hasnt(r.out(), "given back unstarted"); assert.equal(state("ge/ed"), "ready"); });
});
