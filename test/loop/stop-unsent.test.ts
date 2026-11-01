// A stop that touched runs/.stop-now and then never signalled (systemctl failed, or the stop died
// between the two): a session that ends meanwhile is left to the stop for a minute only (#127,
// #125's fix waits for the signal), then the stale file goes and the loop settles the unit itself,
// rather than wait forever with its claim held. The loop runs in this process with its clock
// mocked (inproc.ts): the minute is exact. Run: node --test test/loop/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { has, hasnt, readOr } from "../lib/index.ts";
import { hold, type Run } from "./inproc.ts";
import { loopFactory } from "./factory.ts";

const f = loopFactory("stopunsent");
const { a, setup, loop } = f;
const HELD = "Unit left (g/ul)'s session ended as the lane is being stopped; the stop settles it";
const GAVE_UP = "no signal came within a minute: the stop didn't happen, so the loop settles the unit itself";

describe("a stop asked for that never signals: after a minute the loop settles the unit itself", () => {
  let r: Run, at59 = "", t = 0;
  test("the session ends with runs/.stop-now there, and no signal comes", async () => {
    setup("add-unit", "g/ul", "--title", "Unit left");
    const h = hold(a.locks, "g/ul");
    r = loop(["--hours", "1", "--max", "1", "--no-wait"]);
    await h.held();
    fs.writeFileSync(a.at("runs/.stop-now"), "");
    process.kill(Number(readOr(path.join(a.locks, "held.g-ul"))), "SIGTERM");
    // The session's end is seen at one of its looks, a second apart at most.
    for (t = r.now() + 1; !r.out().includes(HELD); t++) {
      assert.ok(t < 600, `the loop never acted on the session's end:\n${r.out()}`);
      await r.at(t);
    }
    await r.flow(t + 58);
    at59 = r.out();
    await r.flow(t + 62);
    await r.until(GAVE_UP);
    await r.end();
  });
  test("  it waits for the signal for a minute", () => { has(at59, HELD); hasnt(at59, GAVE_UP); hasnt(at59, "the session ended without recording it"); });
  test("  then the stale file goes", () => { assert.ok(!fs.existsSync(a.at("runs/.stop-now"))); });
  test("  and the unit is settled as before: interrupted, its work pushed", () => {
    has(r.out(), "Unit left (g/ul): the session ended without recording it; it shows as interrupted");
    has(r.out(), "git: unit/g/ul pushed, for whoever takes it next");
  });
});
