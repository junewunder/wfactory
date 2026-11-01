// One last-call time per factory per machine: a lane writes its last call to last-call in the
// machine's lock folder, for its stop time, so the daemon bringing a lane back reads the same
// (resume.test.ts). It's "last_call" minutes before the stop, whatever CI is still to run here
// (#159: no CI reserve). The loop runs in this process with its clock mocked (inproc.ts).
// Run: node --test test/loop/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { has, hasnt, readOr } from "../lib/index.ts";
import { hold, hmAt, nextSecond, type Run } from "./inproc.ts";
import { loopFactory } from "./factory.ts";

const f = loopFactory("lcfile");
const { a, setup, state, loop } = f;
const FILE = path.join(a.locks, "last-call");
const written = () => { try { return JSON.parse(readOr(FILE)); } catch { return {}; } };

// Group W's CI uses the desk and is stale (a unit done, never run). Group Z's CI is stale too, and
// took 20 minutes last time; its last unit is another machine's, so it isn't done, and its CI
// isn't due before last call.
setup("add-group", "gw", "--title", "Group W", "--ci", "desk");
setup("add-unit", "gw/done", "--title", "W done"); setup("done", "gw/done", "--evidence", "x");
setup("edit-group", "gw", "--priority", "10");
setup("add-group", "gz", "--title", "Group Z", "--ci", "lc");
setup("add-unit", "gz/a", "--title", "Z a"); setup("done", "gz/a", "--evidence", "x");
setup("ci-start", "gz"); setup("ci-pass", "gz", "--evidence", "same", "--secs", "1200");
setup("add-unit", "gz/b", "--title", "Z b"); setup("done", "gz/b", "--evidence", "x");
setup("add-unit", "gz/c", "--title", "Z c", "--host", "b");

// A stop two hours on and a 10-minute last call: at 6600 s, though Z's 20 minutes of CI is still
// to run here (with a reserve for it and the wrap-up, it was at 4500 s).
describe("last call is last_call minutes before the stop, with CI still to run here", () => {
  let r: Run, before = "", wrote: Record<string, number> = {};
  const t0 = nextSecond();
  test("a session holding the desk is told to wrap up at the lane's last call, not earlier", async () => {
    setup("add-unit", "gw/ed", "--title", "W at the desk", "--uses", "desk");
    const h = hold(a.locks, "gw/ed");
    r = loop(["--hours", "2", "--last-call", "10", "--max", "1"], {}, t0);
    await h.held();
    wrote = written();
    await r.at(6590);
    before = r.out();
    await r.at(6601);
    h.go();
    await r.end();
  });
  test("  the lane wrote its last call, for its stop time", () => { assert.deepEqual(wrote, { at: t0 + 6600, deadline: t0 + 7200, last_call: 10, written: t0 }); });
  test("  its session isn't told before", () => { hasnt(before, "to wrap up by"); hasnt(before, "last call now at"); });
  test("  it's told at last call", () => { has(r.out(), `loop: last call: told W at the desk (gw/ed) to wrap up by ${hmAt(t0, 6601 + 900)}`); });
  test("  (its unit landed)", () => { assert.equal(state("gw/ed"), "done"); });
});

describe("the lane logs its last call when it moves by more than 5 minutes", () => {
  let r: Run;
  const t0 = nextSecond();
  test("an earlier stop time moves it, and the lane says so", async () => {
    setup("edit-group", "gw", "--ci", "none"); setup("edit-group", "gz", "--ci", "none");
    setup("add-group", "gp", "--title", "Group P");
    setup("add-unit", "gp/one", "--title", "P one"); setup("add-unit", "gp/two", "--title", "P two");
    setup("edit-group", "gp", "--priority", "20");
    const h = hold(a.locks, "gp/one");
    r = loop(["--hours", "2", "--last-call", "10", "--max", "2"], {}, t0);
    await h.held();
    fs.writeFileSync(a.at("runs/.stop-at"), `${t0 + 3600}\n`);
    await r.at(10);
    h.go();
    await r.end();
    fs.rmSync(a.at("runs/.stop-at"), { force: true });
  });
  test("  the new time is logged", () => { has(r.out(), `loop: last call now at ${hmAt(t0, 3000)} (was ${hmAt(t0, 6600)})`); });
  test("  and written", () => { const w = written(); assert.deepEqual([w.deadline, w.at], [t0 + 3600, t0 + 3000]); });
});
