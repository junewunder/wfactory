// A session whose transcript goes silent, with no tool call open, is ended after
// tracker/project.json "session_silence" minutes (30): its unit is interrupted, its work pushed,
// and the lane takes its next unit. One silent inside a tool call (a long Bash call), or one that
// writes now and then, isn't. The loop runs in this process with its clock mocked (inproc.ts):
// the moment is exact. Run: node --test test/loop/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { has, hasnt, readOr } from "../lib/index.ts";
import { hold, hmsAt, waitFor, type Run } from "./inproc.ts";
import { loopFactory, order } from "./factory.ts";

const f = loopFactory("silent");
const { a, setup, state, loop, events } = f;

// How many lines of its transcripts (runs/*.jsonl) say text.
const said = (text: string) => {
  let n = 0;
  for (const x of fs.readdirSync(a.at("runs")).filter((y) => y.endsWith(".jsonl"))) n += readOr(path.join(a.at("runs"), x)).split("\n").filter((l) => l.includes(text)).length;
  return n;
};

// The session's first look at its stream is at 0 s or 5 s (FACTORY_POLL), so it's ended at a look
// between 30 minutes after that and the next.
describe("a session silent for 30 minutes with no tool call open is ended, and the lane goes on", () => {
  let r: Run, before = "", runningBefore = false;
  test("the silent session is ended", async () => {
    setup("add-unit", "g/quiet", "--title", "A quiet unit");
    setup("add-unit", "g/after", "--title", "The unit after");
    const h = hold(a.locks, "g/quiet");
    r = loop(["--hours", "4", "--max", "3", "--no-wait"], { FACTORY_FAKE_SILENT: "1" });
    await h.held();
    await r.at(5);
    await r.at(1799);
    before = r.out(); runningBefore = h.holding();
    await r.at(1810);
    await r.until("silent: ");
    // The next session takes the interrupted unit again: let that one finish.
    h.go();
    await r.at(1820);
    await r.at(1830);
    await r.end();
    const line = r.out().split("\n").find((l) => l.endsWith("loop: the session has written nothing for 30 min and has no tool call open: ending it")) ?? "";
    assert.ok(Array.from({ length: 11 }, (_, i) => 1800 + i).some((s) => line.startsWith(hmsAt(r.t0, s))), line || r.out());
  });
  test("  not a second before", () => {
    hasnt(before, "has written nothing");
    assert.ok(runningBefore, "the session had ended before");
  });
  test("  the lane log says why", () => {
    has(r.out(), "loop: silent: A quiet unit (g/quiet) wrote nothing for 30 minutes with no tool call open, so it was ended; it shows as interrupted, its work pushed to its branch");
  });
  test("  the overseer hears", () => { has(events(), "silent\tA quiet unit (g/quiet) wrote nothing for 30 minutes"); });
  test("  the unit is interrupted", () => { has(r.out(), "A quiet unit (g/quiet): the session ended without recording it; it shows as interrupted"); });
  test("  its work so far is pushed as its branch", () => { has(r.out(), "loop: git: unit/g/quiet pushed, for whoever takes it next"); });
  test("  and the lane goes on: the unit again, then the next", () => {
    assert.equal(order(r.out(), /iteration [0-9]+: [^(]*\([a-z/]+\)/), "A quiet unit (g/quiet),A quiet unit (g/quiet),The unit after (g/after)");
    assert.equal(state("g/quiet"), "done"); assert.equal(state("g/after"), "done");
  });
});

describe("a session silent for an hour inside a tool call isn't ended", () => {
  let r: Run, before = "";
  test("the session runs on until its tool call ends", async () => {
    setup("add-unit", "g/long", "--title", "A long build");
    const h = hold(a.locks, "g/long");
    r = loop(["--hours", "4", "--max", "1", "--no-wait"]);
    await h.held();
    await r.at(5);
    await r.at(3600);
    await r.at(3605);
    before = r.out();
    assert.ok(h.holding(), "the session was ended");
    h.go();
    await r.at(3615);
    await r.end();
  });
  test("  it wasn't ended for its silence", () => { hasnt(before, "has written nothing"); hasnt(r.out(), "loop: silent:"); });
  test("  and its unit is done", () => { assert.equal(state("g/long"), "done"); });
});

describe("a session that writes every 9 minutes for an hour isn't ended", () => {
  let r: Run, before = "";
  test("the session runs on", async () => {
    setup("add-unit", "g/chatty", "--title", "A chatty unit");
    const h = hold(a.locks, "g/chatty");
    r = loop(["--hours", "4", "--max", "1", "--no-wait"], { FACTORY_FAKE_SILENT: "1" });
    await h.held();
    await r.at(5);
    for (let t = 540; t <= 3600; t += 540) {
      const n = said("still here");
      fs.writeFileSync(path.join(a.locks, "poke.g-chatty"), "");
      await waitFor(() => said("still here") > n, `the session wrote at ${t} s`);
      await r.at(t);
    }
    await r.at(3605);
    before = r.out();
    assert.ok(h.holding(), "the session was ended");
    h.go();
    await r.at(3615);
    await r.end();
  });
  test("  it wasn't ended for its silence", () => { hasnt(before, "has written nothing"); hasnt(r.out(), "loop: silent:"); });
  test("  and its unit is done", () => { assert.equal(state("g/chatty"), "done"); });
});
