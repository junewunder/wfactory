// CI and the resources it uses: CI and a ready unit both need the desk, and when it frees CI gets
// it; a run takes every resource its steps use as it starts (held while its first step runs, even
// when only a later one uses it), so it waits before its first step, never mid-run; while it
// waits, the lane goes on with other work. The desk is held by another process (holdLock), as
// another lane on the machine would. The loop is the real factory/loop.sh, in the file's lane.
// Run: node --test test/loop/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { has, holdLock, lockHeld, readOr, newest } from "../../lib/index.ts";
import { laneFactory } from "./helpers.ts";
import { order } from "../factory.ts";

const f = laneFactory("lane-desk");
const { a, w, setup, t, until } = f;
const desk = path.join(a.locks, "res-desk.lock");
f.steps({
  first: { cmd: `touch ${w.at("first.on")}; until [ -e ${w.at("first.go")} ]; do sleep 0.1; done; echo first` },
  second: { cmd: "echo used the desk second", uses: ["desk"] },
  quick: { cmd: "echo quick" },
  mid: { cmd: `flock -n ${desk} true && echo desk free || echo desk held` },
  deskq: { cmd: "echo used the desk at once", uses: ["desk"], timeout: 0 },
});
const ciLogs = (re: RegExp) => fs.readdirSync(a.at("runs")).filter((n) => re.test(n)).map((n) => readOr(a.at(`runs/${n}`))).join("");

describe("CI and a ready unit both need the desk: when it frees, CI gets it", () => {
  let b: ReturnType<typeof f.loopBg>;
  test("  both wait while the desk is busy", async () => {
    setup("add-group", "gc", "--title", "Group C", "--ci", "desk");
    setup("add-unit", "gc/one", "--title", "C one"); setup("done", "gc/one", "--evidence", "x");
    setup("add-group", "gd", "--title", "Group D");
    setup("add-unit", "gd/one", "--title", "D one", "--uses", "desk");
    // Held until the lane is napping between looks: freed between its CI look and its unit look,
    // the unit would win that race.
    const held = await holdLock(desk);
    b = f.loopBg(["--hours", "0.05"]);
    await b.until("waiting:");
    await held.release();
  });
  test("  the lane says CI waits for it", () => { has(b.out(), "Group C (waiting for the desktop)"); });
  test("  when it frees, CI gets it first", async () => {
    await b.until("every unit is done", 40);
    await b.end();
    assert.equal(order(b.out(), /iteration [0-9]+: D one|ci: Group C \(gc\): desk/), "ci: Group C (gc): desk,D one");
  });
});

// 24 Oct: a run took the editor only at its publish step, and waited there up to an hour while
// its lane did nothing.
describe("a run takes every resource its steps use as it starts", () => {
  let b: ReturnType<typeof f.loopBg>;
  test("a two-step CI holds the second step's resource while the first runs", async () => {
    setup("add-group", "gt", "--title", "Group T", "--ci", "first,second");
    setup("add-unit", "gt/one", "--title", "T one"); setup("done", "gt/one", "--evidence", "x");
    b = f.loopBg(["--hours", "0.05"]);
    await b.until("ci: first:");
    await until(() => fs.existsSync(w.at("first.on")), "the first step is running");
    assert.ok(lockHeld(desk), "the desk is held while the first step runs");
    fs.writeFileSync(w.at("first.go"), "");
  });
  test("  the second step runs with it, never waiting, and CI passes", async () => {
    await b.until("ci: Group T (gt) passed", 30);
    await b.until("every unit is done", 40);
    await b.end();
    assert.ok(!b.out().includes("is busy; waiting for it"), b.out());
  });
  test("  holding the desk for its step", () => { has(ciLogs(/^ci-.*-gt-second\.log$/), "used the desk second"); });
});

// The desk is held through the first test (holdLock lets go when the test that took it ends):
// what's checked while it's busy is kept for the tests after.
describe("a run whose later step's resource is busy waits before its first step; its lane works other units", () => {
  let b: ReturnType<typeof f.loopBg>, due = "", atU = "", whileBusy = "";
  test("a run whose later step's resource is busy doesn't start; the lane works other units", async () => {
    setup("edit-group", "gt", "--ci", "none");
    setup("add-group", "gq", "--title", "Group Q", "--ci", "quick,mid,deskq");
    setup("add-unit", "gq/one", "--title", "Q one"); setup("done", "gq/one", "--evidence", "x");
    setup("add-group", "gu", "--title", "Group U"); setup("add-unit", "gu/one", "--title", "U one");
    const held = await holdLock(desk);
    b = f.loopBg(["--hours", "0.05"]);
    try {
      await b.until(": U one (gu/one)");
      due = t("ci");
      atU = b.out();
      // Its unit worked, the lane waits for the desk.
      await until(() => /: U one \(gu\/one\)[^]*waiting:/.test(b.out()), "the lane waits after U one");
      whileBusy = b.out();
    } finally { await held.release(); }
  });
  test("  still due", () => { has(due, "Group Q (gq): due"); });
  test("  the lane goes on with other work", () => { has(atU, ": U one (gu/one)"); });
  test("  and doesn't start the run while the desk is busy", () => {
    assert.equal(atU.split("ci: quick:").length - 1, 0);
    assert.equal(whileBusy.split("ci: quick:").length - 1, 0, whileBusy);
  });
  test("  the lane says CI waits for it", () => { has(whileBusy, "Group Q (waiting for the desktop)"); });
  test("  freed: it runs and passes", async () => {
    await b.until("ci: Group Q (gq) passed", 40);
    await b.until("every unit is done", 40);
    await b.end();
  });
  test("  it took the desk as it started, and kept it through the steps before", () => { has(readOr(newest(a.at("runs"), /^ci-.*-gq-mid\.log$/)), "desk held"); });
  test("  and never gave the run back", () => { assert.ok(!readOr(a.at("runs/index.tsv")).includes("given back"), readOr(a.at("runs/index.tsv"))); });
});
