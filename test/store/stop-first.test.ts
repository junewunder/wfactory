// Stop now with group data, when the session ends before the loop has handled its own signal:
// the cut-short unit is the stop's (its copy here stays marked as worked on, and it waits for its
// own laptop), so another laptop takes the group's next unit, not that one (#125). The ordering is
// made, not hoped for: the session alone is killed first, and the lane's TERM comes only once the
// loop has acted on the session's end. Run: node --test test/store/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { has, hasnt, readOr, until, groupAlive } from "../lib/index.ts";
import { storeFactory, ONE } from "./factory.ts";

const f = storeFactory(["a", "c", "d"]);
const { add, state } = f;
const [, c, d] = f.lanes;
const SETTLED = "Unit k1 of f1 (f1/k1): the session ended without recording it";
const HELD = "Unit k1 of f1 (f1/k1)'s session ended as the lane is being stopped; the stop settles it";

describe("stop now, the session ending first", () => {
  let out = "";
  test("a unit finished on c, so the store has the group's data", () => {
    add("f1/k0");
    has(c.loop(ONE), "iteration 1: Unit k0 of f1");
    assert.equal(state("f1/k0"), "done");
  });
  test("stop now: the session ends of it; the lane's TERM comes after", async () => {
    add("f1/k1");
    const h = c.hold("f1/k1");
    const l = c.loopBg(["--hours", "0.05"]);
    try {
      await h.held();
      fs.writeFileSync(c.at("runs/.stop-now"), "");
      process.kill(Number(readOr(`${c.locks}/held.f1-k1`)), "SIGTERM");
      await until(() => l.out().includes(SETTLED) || l.out().includes(HELD), "the loop acts on the session's end", 60);
      process.kill(-l.pid!, "SIGTERM");
      out = (await l.end()).stdout;
      await until(() => !groupAlive(l.pid!), "everything the stopped lane started is gone", 30);
    } finally { h.go(); }
  });
  test("  the loop leaves the unit to the stop", () => { has(out, HELD); hasnt(out, SETTLED); });
  test("  the copy here stays marked as worked on", () => { assert.ok(fs.readdirSync(c.at("work/.store/groups")).some((x) => x.startsWith("f1.dirty.")), "no f1.dirty.*"); });
  test("  another laptop takes the group's next unit, not the cut-short one", () => {
    add("f1/k2");
    has(d.loop(ONE), "iteration 1: Unit k2 of f1");
  });
  test("  back on the stopped laptop, its cut-short unit carries on", () => { has(c.loop(ONE), "iteration 1: Unit k1 of f1"); });
  test("  and is done", () => { assert.equal(state("f1/k1"), "done"); });
});

f.notBroken();
