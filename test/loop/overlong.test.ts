// A session past twice its estimate (an hour a session, so two hours: FACTORY_SPLIT_AFTER) is told
// once, through its inbox, to write what it learned and split the unit; the overseer hears. And
// every session gets --add-dir for the real directory behind each link out of the lane's clone
// (its work/), so the CLI lets it write there. The loop runs in this process with its clock mocked
// (inproc.ts). Run: node --test test/loop/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { has, hasnt, readOr } from "../lib/index.ts";
import { hold, hmsAt, type Run } from "./inproc.ts";
import { loopFactory } from "./factory.ts";

const f = loopFactory("overlong");
const { a, w, setup, state, loop, seen, events } = f;
const inboxMsgs = () => {
  const inbox = a.at("runs/inbox");
  // Not current: a link to the running session's.
  return fs.readdirSync(inbox).filter((d) => d !== "current").flatMap((d) => { try { return fs.readdirSync(path.join(inbox, d, "new")).map((m) => readOr(path.join(inbox, d, "new", m))); } catch { return []; } });
};

describe("a session that runs two hours is told to write what it learned and split the unit", () => {
  let r: Run, before: string[] = [], beforeOut = "", after: string[] = [];
  test("the session is told once, at two hours, and goes on", async () => {
    fs.mkdirSync(w.at("shared-data"), { recursive: true });
    fs.symlinkSync(w.at("shared-data"), a.at("shared"));
    setup("add-unit", "g/spike", "--title", "A big spike");
    const h = hold(a.locks, "g/spike");
    r = loop(["--hours", "4"]);
    await h.held();
    await r.at(7199);
    before = inboxMsgs(); beforeOut = r.out();
    await r.at(7205);
    await r.at(9000);
    after = inboxMsgs();
    h.go();
    await r.at(9010);
    await r.end();
  });
  test("  through its inbox, saying why and what to do", () => {
    assert.equal(after.length, 1, after.join("\n"));
    has(after[0], "This session has run 2 hours, twice what one should take: the unit is too big for a session.");
    has(after[0], 'write what you learned (`just note g/spike "…"`');
    has(after[0], "and split the unit");
  });
  test("  not a second before", () => { assert.deepEqual(before, []); hasnt(beforeOut, "has run 2 hours"); });
  // The session is looked at every 5 s (FACTORY_POLL), from a second or so after the start.
  test("  the lane log says so, at its first look past two hours", () => {
    const line = r.out().split("\n").find((l) => l.endsWith("loop: A big spike (g/spike) has run 2 hours: told it to write what it learned and split the unit")) ?? "";
    assert.ok([7200, 7201, 7202, 7203, 7204, 7205, 7206].some((s) => line.startsWith(hmsAt(r.t0, s))), line || r.out());
  });
  test("  the overseer hears", () => { has(events(), "overlong\tA big spike (g/spike): session "); });
  test("  the session isn't ended for it", () => { assert.equal(state("g/spike"), "done"); });
  test("every session gets --add-dir for the real directory behind each link out of its clone", () => {
    has(seen("args.seen"), `--add-dir ${fs.realpathSync(w.at("shared-data"))} `);
  });
});
