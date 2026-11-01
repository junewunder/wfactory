// A lane stopped (oversee.sh stop, or `just fleet stop`: runs/.stop-now, then a TERM to every
// process in the lane's unit) whose session ends before the loop has handled its own signal:
// the loop must not settle the unit as a session that ended and go back to main (#127, #125).
// Here the ordering is made, not hoped for: the session alone is killed first, and the loop's
// TERM comes only once the loop has acted on the session's end (it settled the unit, or it says
// the stop settles it). The loop is the real factory/loop.sh, in the file's lane.
// Run: node --test test/loop/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { has, hasnt, readOr } from "../../lib/index.ts";
import { hold } from "../inproc.ts";
import { laneFactory } from "./helpers.ts";

const f = laneFactory("lane-stopfirst");
const { a, w, setup, until } = f;
const SETTLED = "Unit stopped (g/sf): the session ended without recording it";
const HELD = "Unit stopped (g/sf)'s session ended as the lane is being stopped; the stop settles it";

describe("a lane stopped whose session ends before the loop's signal reaches it", () => {
  let out = "";
  const h = hold(a.locks, "g/sf");
  test("the session ends of the stop; the loop's TERM comes after", async () => {
    setup("add-unit", "g/sf", "--title", "Unit stopped");
    const b = f.loopBg(["--hours", "0.05"]);
    await b.until("iteration 1: Unit stopped");
    await h.held();
    fs.writeFileSync(a.at("runs/.stop-now"), "");
    process.kill(Number(readOr(path.join(a.locks, "held.g-sf"))), "SIGTERM");
    await until(() => b.out().includes(SETTLED) || b.out().includes(HELD), "the loop acts on the session's end", 60);
    process.kill(-b.pid!, "SIGTERM");
    out = (await b.end()).stdout;
  });
  test("  the loop leaves the unit to the stop", () => { has(out, HELD); hasnt(out, SETTLED); });
  test("  the lane is still on its unit's branch", () => { assert.equal(w.git(a.dir, "rev-parse", "--abbrev-ref", "HEAD"), "unit/g/sf"); });
  test("  and it stopped on the signal", () => { has(f.events(), "\tlane-stop\tstopped (signal)"); });
});
