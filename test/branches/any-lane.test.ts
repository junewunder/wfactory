// A finished branch lands from any lane on its machine, not only the one whose clone made it: one
// that couldn't land is pushed, and once its lane is gone another lane there takes its landing.
// Never from another machine (the unit's outputs in work/ are on the first). A finished branch is
// pushed before it lands, so one whose lane dies landing it is landed by another lane, and the dead
// lane's copy is dropped when it starts again (#135). And a clone whose copy of a branch is only
// behind origin's raises nothing. Run: node --test test/branches/
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { has, hasnt, lines } from "../lib/index.ts";
import { branchFactory, ONE } from "./factory.ts";

const f = branchFactory(["b", "x", "y"]);
const [b, x, y] = f.lanes;
// A second lane on b's machine, and a lane on another machine.
const b2 = f.lane("b", { k: 2, locks: "b2" });
const d = f.lane("d");
const { add, drop } = f;
const remote = (l: typeof b, br: string) => l.git("ls-remote", "origin", `refs/heads/${br}`);

describe("a finished branch its lane couldn't land: another lane lands it once that lane is gone", () => {
  // Lane b's check always fails (main looks red to it alone), so its finished branch is pushed and waits.
  test("lane b finishes a unit and pushes its branch, not landed", () => {
    const hook = path.join(b.locks, "check-hook");
    fs.writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    add("fin");
    has(b.loop(ONE), "main itself fails");
    assert.equal(b.ok(["state", "g/fin"]), "merging");
    assert.notEqual(remote(b, "unit/g/fin"), "");
  });
  // Lane b is removed (its loop has ended and never runs again): the other lane on its machine lands it.
  let log = "";
  test("  another lane on that machine lands it", () => {
    log = b2.loop(ONE);
    has(log, "landing unit/g/fin, finished elsewhere");
    has(log, "unit/g/fin merged into main");
  });
  test("  the unit is done", () => { assert.equal(b2.ok(["state", "g/fin"]), "done"); });
  test("  its work is on main", () => { assert.ok(f.main("out/g-fin.txt")); });
  test("  and its branch is gone from origin", () => { assert.equal(remote(b2, "unit/g/fin"), ""); });

  test("lane b finishes another, pushed, not landed", () => {
    add("fin2");
    has(b.loop(ONE), "main itself fails");
    assert.equal(b.ok(["state", "g/fin2"]), "merging");
  });
  test("  a lane on another machine never lands it, even once b's heartbeat is stale", async () => {
    await sleep(2000);
    hasnt(d.loop(ONE, { FACTORY_LEASE_STALE: "1" }), "unit/g/fin2 merged into main");
    assert.equal(d.ok(["state", "g/fin2"]), "merging");
  });
  test("  a lane on b's machine does", () => {
    has(b2.loop(ONE), "unit/g/fin2 merged into main");
    assert.equal(b2.ok(["state", "g/fin2"]), "done");
  });
});

describe("a lane that dies landing a unit: its finished branch was pushed first, so another lane lands it", () => {
  const hook = path.join(b.locks, "check-hook");
  test("lane b leaves a unit unfinished, its branch pushed", () => {
    fs.rmSync(hook, { force: true });
    add("redo");
    has(b.loop(ONE, { FACTORY_FAKE_NODONE: "1" }), "unit/g/redo pushed");
  });
  test("  carries it on and finishes it, and dies landing it", async () => {
    // The landing's check kills the lane (everything it started), after its finished branch is pushed.
    fs.writeFileSync(hook, `#!/bin/sh\nkill -KILL -- -$(cat "${b.locks}/lane-pgid")\n`, { mode: 0o755 });
    const k = b.loopBg(ONE);
    fs.writeFileSync(path.join(b.locks, "lane-pgid"), String(k.pid));
    await k.end();
    assert.notEqual(remote(b, "unit/g/redo"), "", "origin has the finished copy");
    assert.equal(b.ok(["state", "g/redo"]), "merging");
  });
  // (Until #135 it waited for lane b's restart: origin had only the earlier attempt's copy.)
  test("  the other lane on its machine lands the finished copy", () => {
    fs.rmSync(hook, { force: true });
    has(b2.loop(ONE), "unit/g/redo merged into main");
    assert.equal(b2.ok(["state", "g/redo"]), "done");
    assert.equal(lines(f.main("out/g-redo.txt")), 2);
  });
  let log = "";
  test("  lane b, started again, drops its own copy", () => {
    log = b.loop(ONE);
    has(log, "unit/g/redo's unit was done elsewhere; this clone's earlier copy");
    assert.equal(b.git("branch", "--list", "unit/g/redo"), "");
  });
  test("  pushing nothing back to origin", () => { hasnt(log, "unit/g/redo pushed"); assert.equal(remote(b, "unit/g/redo"), ""); });
});

describe("a clone whose copy of a branch is only behind origin's: no stuck-branch event", () => {
  test("lane x leaves a unit unfinished, its branch pushed and kept in its clone", () => {
    add("behind");
    has(x.loop(ONE, { FACTORY_FAKE_NODONE: "1" }), "unit/g/behind pushed");
    assert.notEqual(x.git("branch", "--list", "unit/g/behind"), "");
  });
  test("  lane y carries it on and pushes more", () => {
    const out = y.loop(ONE, { FACTORY_FAKE_NODONE: "1" });
    has(out, "carrying on from unit/g/behind");
    has(out, "unit/g/behind pushed");
    drop("g/behind");
  });
  let log = "";
  test("  lane x's next look raises no stuck-branch", () => {
    log = x.loop(ONE);
    hasnt(x.events(), "stuck-branch");
  });
  test("  and drops its copy, all of it on origin", () => {
    has(log, "unit/g/behind was carried on elsewhere");
    assert.equal(x.git("branch", "--list", "unit/g/behind"), "");
    assert.notEqual(remote(x, "unit/g/behind"), "");
  });
});
