// Last call now (`just fleet last-call` runs this in every lane): no new unit, the one in flight
// lands, the group's CI runs and passes, and the lane stops. And last call gets CI its resources
// back: a session holding one is told to wrap up, and ended once its grace (15 minutes) is over.
// The loop runs in this process with its clock mocked (inproc.ts). Run: node --test test/loop/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { has, hasnt, readOr } from "../lib/index.ts";
import { hold, hmAt, hmsAt, type Run } from "./inproc.ts";
import { loopFactory, order } from "./factory.ts";

const f = loopFactory("lastcall");
const { a, w, setup, t, state, loop, events, onBranch } = f;
const lastCall = () => a.run("factory/oversee.sh", ["last-call"]);

describe("last call now: no new unit, the one in flight lands, the group's CI runs and passes, and the lane stops", () => {
  let r: Run;
  test("last call now: the lane wraps up and stops", async () => {
    setup("add-group", "gl", "--title", "Group L", "--ci", "lc");
    for (const n of ["one", "two", "three"]) setup("add-unit", `gl/${n}`, "--title", `L ${n}`);
    const h = hold(a.locks, "gl/one");
    r = loop(["--hours", "0.1"]);
    await h.held();
    assert.equal(lastCall().code, 0);
    // The clock a minute on before the session goes on: what it records (its unit done) is in
    // real time, and must not come after the loop's CI pass, at a clock that would otherwise
    // still be at 0 s (a session slow under load finishing a second or two after the start
    // would leave CI stale for good, and the loop running it again at the same moment).
    await r.at(60);
    h.go();
    await r.end();
    has(r.out(), "last call is over");
  });
  test("  the unit in flight lands", () => { assert.equal(state("gl/one"), "done"); });
  test("  no new unit is taken", () => { assert.equal(state("gl/two"), "ready"); });
  test("  its group's CI runs and passes, with units left", () => { has(t("ci", "gl"), "passed (lc)"); });
  test("  in that order", () => { assert.equal(order(r.out(), /iteration [0-9]+: L [a-z]+|ci: Group L \(gl\): lc|last call is over/), "L one,ci: Group L (gl): lc,last call is over"); });
  test("  last call ends with the lane", () => { assert.ok(!fs.existsSync(a.at("runs/.last-call"))); });
  test("  one a lane didn't finish (a crash, its --max) outlives a restart", async () => {
    fs.writeFileSync(a.at("runs/.last-call"), "");
    await loop(["--max", "0"]).end();
    const kept = fs.existsSync(a.at("runs/.last-call"));
    fs.rmSync(a.at("runs/.last-call"), { force: true });
    assert.ok(kept);
  });
});

// Group R's CI uses the desk; R at the desk holds it when last call comes.
describe("last call gets CI its resources back: a session holding one is told through its inbox to wrap up, and ended after the grace; then CI runs", () => {
  let r: Run, told = 0, before = "", runningBefore = false;
  test("last call ends a session holding what CI needs, and the lane goes on", async () => {
    setup("drop", "gl/two", "--why", "test"); setup("drop", "gl/three", "--why", "test");
    setup("add-group", "gr", "--title", "Group R", "--ci", "desk");
    setup("add-unit", "gr/done", "--title", "R done"); setup("done", "gr/done", "--evidence", "x");
    setup("add-unit", "gr/ed", "--title", "R at the desk", "--uses", "desk");
    setup("add-unit", "gr/plain", "--title", "R plain");
    setup("edit-group", "gr", "--priority", "10");
    const h = hold(a.locks, "gr/ed");
    r = loop(["--hours", "1"]);
    await h.held();
    await r.at(10);
    assert.equal(lastCall().code, 0);
    // The session's next look (its poll) finds last call, and tells it.
    await r.at(11);
    told = 11;
    await r.at(told + 899);
    before = r.out(); runningBefore = h.holding();
    await r.at(told + 900);
    await r.end();
    h.go();
    has(r.out(), "last call is over");
  });
  test("  it was told to wrap up", () => { has(r.out(), `${hmsAt(r.t0, told)} loop: last call: told R at the desk (gr/ed) to wrap up by ${hmAt(r.t0, told + 900)}`); });
  test("  through its inbox, saying what CI needs and by when", () => {
    const inbox = a.at("runs/inbox"), msgs = fs.readdirSync(inbox).flatMap((d) => { try { return fs.readdirSync(path.join(inbox, d, "new")).map((m) => readOr(path.join(inbox, d, "new", m))); } catch { return []; } }).join("");
    has(msgs, `Last call: CI needs the desktop. Within 15 minutes commit what works on your branch (the loop pushes it), leave a note for the next attempt (\`just note gr/ed "…"\`), and end the session. At ${hmAt(r.t0, told + 900)} the loop ends it.`);
  });
  test("  then ended after the grace", () => { has(r.out(), `${hmsAt(r.t0, told + 900)} loop: last call: R at the desk (gr/ed) was ended after its wrap-up time, so CI can have the desktop`); });
  test("  not a second before", () => { hasnt(before, "was ended after its wrap-up time"); assert.ok(runningBefore, "the session had ended before"); });
  test("  both reach the overseer", () => { has(events(), "wrap-up\tlast call: R at the desk (gr/ed) holds the desktop"); });
  test("  (the ending too)", () => { has(events(), "wrapped-up\tlast call: R at the desk (gr/ed)"); });
  test("  its unit is interrupted", () => { assert.equal(state("gr/ed"), "interrupted"); });
  test("  its work so far pushed as its branch", () => { assert.equal(onBranch("unit/gr/ed", "out/gr-ed.txt"), "work on gr/ed"); });
  test("  then CI runs with the desk", () => {
    assert.equal(order(r.out(), /iteration [0-9]+: R [a-z ]+|ci: Group R \(gr\): desk|last call is over/), "R at the desk ,ci: Group R (gr): desk,last call is over");
    assert.equal(readOr(w.at("order.log")), "gr\n");
  });
  test("  and passes", () => { has(t("ci", "gr"), "passed (desk)"); });
  // The claim last call ended holds nothing by then: a guard asking which groups a session here
  // is working on (`busy --live`) lets CI's step through.
  test("  the claim last call ended holds nothing when CI runs", () => { assert.equal(readOr(w.at("busy-live.log")), "\n"); });
});
