// A lane whose merge unit can't move (it waits on the owner's question) takes other work
// meanwhile, and the merge comes first again once it can. Run: node --test test/branches/
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { has, hasnt, readOr } from "../lib/index.ts";
import { branchFactory, ONE } from "./factory.ts";

const f = branchFactory(["a"]);
const [a] = f.lanes;
const { add } = f;

describe("a lane whose merge unit waits on a question works other units", () => {
  let mu = "";
  test("a branch that fails the check becomes this lane's merge unit", () => {
    add("mq");
    has(a.loop(ONE, { FACTORY_FAKE_BREAK: "1" }), "filed Merge main on a lane 1");
    mu = readOr(a.at("runs/.merge-unit")).trim();
    assert.ok(mu);
  });
  let log = "";
  test("its merge unit waits on the owner's question", () => {
    a.setup(["ask", "--title", "Keep which side of the break?", "--context", "test", "--option", "a | keep | keep it", "--option", "b | drop | drop it", "--default", "a", "--blocks", mu, "--id", "mq-side"]);
    add("other");
    log = a.loop(ONE);
  });
  test("  the lane works another unit meanwhile", () => { has(log, "iteration 1: Unit other (g/other)"); });
  test("  saying why its merge waits", () => { has(log, `this lane's merge (${mu}) can't move yet`); });
  test("  the merge unit is still this lane's", () => { assert.equal(readOr(a.at("runs/.merge-unit")).trim(), mu); });
  test("once the question is answered, the merge comes first again", () => {
    a.setup(["answer", "q/mq-side", "a"]);
    add("later");
    const out = a.loop(ONE);
    has(out, "iteration 1: Merge main on a lane 1");
    hasnt(out, "Unit later (g/later)");
  });
});
