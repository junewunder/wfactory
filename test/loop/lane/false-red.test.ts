// A landing check that fails for something other than the branch or main's code doesn't stop the
// lane, each as one factory met it over two weeks of lanes stopping on "main is red" with main
// fine: a slip in one of the tracker's records (the project's check runs lint), a check that ran
// out of time, and a heavy job in the check that couldn't get its turn. (A file left in the work/
// the lanes share, or a broken tool, is in red-main.test.ts: a session puts it right.) The loop is
// the real factory/loop.sh, in the file's lane. Run: node --test test/loop/
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { has, hasnt } from "../../lib/index.ts";
import { laneFactory } from "./helpers.ts";

// A project's check: its tests (slow while <locks>/slow is there, as a check that outlasts its
// time limit; exit 75 while <locks>/no-turn is, as a `just capped` in it that gave up its wait for
// memory), then the tracker's lint, as `just lint` runs it.
const CHECK = `#!/usr/bin/env bash
[ ! -e "$FACTORY_LOCKS/slow" ] || sleep 60
[ ! -e "$FACTORY_LOCKS/no-turn" ] || { echo "capped: queued 8 min and still waiting (memory: needs 12G, held by editor)"; exit 75; }
factory/tracker lint
`;
const f = laneFactory("lane-false-red", "lane-false-red", { check: "bash check.sh", files: { "check.sh": CHECK } });
const { setup, state, events, a } = f;
const lk = (x: string) => path.join(a.locks, x);
const of = (kind: string) => events().split("\n").filter((l) => l.split("\t")[3] === kind);
const FIX = `merge/${a.n.toLowerCase()}-main-check`;
const filed = () => a.tracker(["state", FIX]).code === 0;

describe("a slip in one of the tracker's records fails no landing", () => {
  let out = "";
  test("a record on main that lint rejects (a note naming a unit by its bare ID), and a unit to land", () => {
    setup("add-unit", "g/one", "--title", "Unit one");
    setup("add-unit", "g/two", "--title", "Unit two");
    f.editMain("tracker/groups/g.json", (g) => { g.units.find((u: { id: string }) => u.id === "g/two").notes = [{ at: "2026-11-08T06:51:00Z", by: "x", text: "after g/one" }]; });
    const lint = a.tracker(["lint"]);
    assert.equal(lint.code, 1, lint.stdout);
    has(lint.stdout, "g/two note: names g/one bare");
    out = f.loopSh(["--max", "2", "--hours", "0.05"]).stdout;
    has(out, "unit/g/one merged into main");
  });
  test("  the lane carries on", () => { has(out, "unit/g/two merged into main"); assert.equal(state("g/two"), "done"); });
  test("  nobody is told main is broken, and no unit is filed to fix it", () => {
    hasnt(out, "main is red"); hasnt(out, "main itself fails");
    assert.equal(of("main-broken").length, 0, events());
    assert.ok(!filed());
  });
});

// (The slip stays on main from here on: every landing below passes lint with it there.)
describe("a landing check that runs out of time gives no verdict", () => {
  let out = "";
  test("the branch waits, and the lane takes the next unit", () => {
    setup("add-unit", "g/three", "--title", "Unit three");
    setup("add-unit", "g/four", "--title", "Unit four");
    fs.writeFileSync(lk("slow"), "");
    out = f.loopSh(["--max", "2", "--hours", "0.05"], { FACTORY_CHECK_TIMEOUT: "2" }).stdout;
    has(out, "Unit three (g/three): `just check` gave no verdict on it: it ran out of time");
    has(out, "iteration 2: Unit four (g/four)");
  });
  test("  its work is pushed, waiting, and not sent back", () => {
    assert.equal(f.onBranch("unit/g/three", "out/g-three.txt"), "work on g/three");
    assert.equal(state("g/three"), "merging");
  });
  test("  the overseer hears once, and that the lane goes on", () => {
    assert.equal(of("check-unrun").length, 1, events());
    has(of("check-unrun")[0], "keeps taking units");
  });
  test("  nobody is told main is broken, and no unit is filed to fix it", () => {
    hasnt(out, "main is red");
    assert.equal(of("main-broken").length, 0, events());
    assert.ok(!filed());
  });
  test("once the check fits its time again, the waiting branches land", () => {
    fs.rmSync(lk("slow"));
    const later = f.loopSh(["--max", "1", "--hours", "0.05"], { FACTORY_CHECK_RETRY: "0" }).stdout;
    has(later, "unit/g/three merged into main");
    has(later, "unit/g/four merged into main");
  });
});

describe("a heavy job in the check that couldn't get its turn (exit 75) gives no verdict either", () => {
  let out = "";
  test("the branch waits, and the overseer hears what it waited on", () => {
    setup("add-unit", "g/five", "--title", "Unit five");
    fs.writeFileSync(lk("no-turn"), "");
    out = f.loopSh(["--max", "1", "--hours", "0.05"]).stdout;
    has(of("check-unrun").at(-1) ?? "", "Unit five (g/five): `just check` gave no verdict on it: a heavy job in it couldn't get its turn (exit 75)");
    has(of("check-unrun").at(-1) ?? "", "memory: needs 12G, held by editor");
  });
  test("  nobody is told main is broken", () => { hasnt(out, "main is red"); assert.equal(of("main-broken").length, 0, events()); assert.ok(!filed()); });
  test("once there's room, it lands", () => {
    fs.rmSync(lk("no-turn"));
    has(f.loopSh(["--max", "1", "--hours", "0.05"], { FACTORY_CHECK_RETRY: "0" }).stdout, "unit/g/five merged into main");
  });
});
