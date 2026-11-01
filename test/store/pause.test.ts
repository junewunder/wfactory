// The three pause levels, with group data: a good pausing spot (the unit finishes, its data goes
// back, the lease is released), pause asap (the session is cut short, the store keeps the last
// merged unit's data, the partial work is set aside), and stop now (everything killed, the copy
// here marked as worked on); and when an older copy is safe to delete. Run: node --test test/store/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { has, hasnt, readOr, until, groupAlive } from "../lib/index.ts";
import { storeFactory, ONE } from "./factory.ts";

const f = storeFactory(["a", "c", "d"]);
const { add, store, stamp, leases, state, st, asides, asideRead, asideLines } = f;
const [, c, d] = f.lanes;
const storeLog = () => readOr(st("groups/f1/out/log.txt"));

describe("good pausing spot: the unit finishes, its data goes back, the lease is released", () => {
  let c1 = "";
  test("good pausing spot: the unit finishes", async () => {
    add("f1/g1"); add("f1/g2");
    const h = c.hold("f1/g1");
    const l = c.loopBg(["--hours", "0.05"]);
    await h.held();
    c.run("factory/oversee.sh", ["pause"]);
    h.go();
    c1 = (await l.end()).stdout;
    has(c1, "paused at a good point");
  });
  test("  the store has its data", () => { assert.equal(stamp("f1"), "f1/g1"); });
  test("  the lease is released", () => { assert.equal(leases(), ""); });
  test("  the unit is done", () => { assert.equal(state("f1/g1"), "done"); });
  test("  no unit branch is left", () => { assert.equal(c.git("for-each-ref", "--format=x", "refs/heads/unit/"), ""); });
});

// The session ends; its branch goes up, its data doesn't (unfinished: the store keeps the last
// merged unit's, put back over the copy here), the lease is released, the unit is interrupted.
describe("pause asap", () => {
  test("pause asap: the session is cut short", async () => {
    const h = c.hold("f1/g2");
    const l = c.loopBg(["--hours", "0.05"]);
    await h.held();
    c.run("factory/oversee.sh", ["pause", "--now"]);
    const out = (await l.end()).stdout;
    h.go();
    has(out, "paused asap");
  });
  test("  the store keeps the last merged unit's data", () => { assert.equal(stamp("f1"), "f1/g1"); });
  test("  (not the partial work)", () => { hasnt(storeLog(), "f1/g2 on c"); });
  test("  the store's copy is put back over the copy here", () => { hasnt(readOr(c.at("work/out/f1/log.txt")), "f1/g2 on c"); });
  test("  and the partial work is kept aside, for the unit", () => { has(asideRead(c, "f1", "out/log.txt"), "f1/g2 on c"); });
  test("    (as its unmerged outputs)", () => { assert.equal(asideLines(c, "f1", ".kind", ".units"), "unmerged f1/g2"); });
  test("  the lease is released", () => { assert.equal(leases(), ""); });
  test("  the unit shows as interrupted", () => { assert.equal(state("f1/g2"), "interrupted"); });
  test("  its branch is pushed", () => { assert.notEqual(c.git("ls-remote", "origin", "refs/heads/unit/f1/g2"), ""); });
  test("  another machine carries it on from the last merged data", () => {
    d.loop(ONE);
    hasnt(readOr(d.at("work/out/f1/log.txt")), "f1/g2 on c");
  });
  test("  and finishes it", () => { assert.equal(state("f1/g2"), "done"); });
  test("  once it's done, its set aside is deleted", () => {
    store(c, ["aside", "sort"]);
    assert.deepEqual(asides(c, "f1"), []);
  });
});

// Everything is killed; the cut-short unit's data isn't copied back; the lease is released
// because the last finished unit's data is on the store.
describe("stop now", () => {
  let before = "";
  test("stop now: the store keeps the last finished unit's data", async () => {
    add("f1/k1");
    before = stamp("f1");
    assert.ok(before, "the store has a stamp for f1 to keep");
    const h = c.hold("f1/k1");
    const l = c.loopBg(["--hours", "0.05"]);
    await h.held();
    fs.writeFileSync(c.at("runs/.stop-now"), "");   // what `just fleet stop` does before systemd's TERM
    process.kill(-l.pid!, "SIGTERM");
    await l.end();
    await until(() => !groupAlive(l.pid!), "everything the stopped lane started is gone", 30);
    h.go();
    assert.equal(stamp("f1"), before);
  });
  test("  not the killed session's", () => { hasnt(storeLog(), "f1/k1 on c"); });
  test("  the lease is released", () => { assert.equal(leases(), ""); });
  test("  the copy here stays marked as worked on", () => { assert.ok(fs.readdirSync(c.at("work/.store/groups")).some((x) => x.startsWith("f1.dirty.")), "no f1.dirty.*"); });
  test("  so it's never deleted to make room", () => { assert.equal(store(c, ["safe", "f1"]).code, 1); });
  // The other laptop works on the group meanwhile (the cut-short unit waits for its own laptop).
  test("  another laptop takes the group on", () => {
    add("f1/k2");
    has(d.loop(ONE), "iteration 1: Unit k2 of f1");
  });
  let c4 = "";
  test("  back on the stopped laptop, its cut-short unit carries on", () => {
    c4 = c.loop(ONE);
    has(c4, "iteration 1: Unit k1 of f1");
  });
  test("  the killed session's unit ended unmerged: the store's copy is put back first", () => { has(c4, "the outputs of f1/k1"); });
  test("    with no unit to sort it", () => { hasnt(c.events(), "store-aside"); });
  test("    and the copy here has the other laptop's work", () => { has(readOr(c.at("work/out/f1/log.txt")), "f1/k2 on d"); });
  // Its outputs were made over the copy before the other laptop's work: putting them back would undo that.
  test("    its own set isn't put back over it", () => { has(c4, "were made over a copy of the group's data that has moved on since"); });
  test("  and the unit is done", () => { assert.equal(state("f1/k1"), "done"); });
  test("  after which its set aside is deleted", () => { has(c4, "outputs of f1/k1, now done or dropped"); });
});

describe("an older copy changed after its stamp, even with old file times, isn't safe to delete", () => {
  test("an older copy untouched since its stamp is safe to delete", () => { assert.equal(store(d, ["safe", "f1"]).code, 0); });
  test("  one with a file copied in (old time kept) isn't", () => {
    const old = d.at("work/out/f1/old.txt");
    fs.writeFileSync(old, "old\n");
    const t = (Date.now() - 3 * 86400e3) / 1000;
    fs.utimesSync(old, t, t);
    const rc = store(d, ["safe", "f1"]).code;
    fs.rmSync(old);
    assert.equal(rc, 1);
  });
});

f.notBroken();
