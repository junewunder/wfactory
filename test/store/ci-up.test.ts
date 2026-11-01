// A group's CI run copies what it rebuilt back to the store as it ends (store.sh clean --up), so
// the next run or unit on another laptop finds it there: stamped as the group's CI, by the lease
// holder only, only over the copy it came from, tried again at each look if the store is out of
// reach, and dropped (main's outputs, nothing lost) if the store moved on meanwhile. Not when the
// copy held other work, and a live CI run holds up another copy back until it ends.
// Run: node --test test/store/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { has, hasnt, readOr, chomp, cmd } from "../lib/index.ts";
import { storeFactory, NOPE } from "./factory.ts";

const f = storeFactory(["a", "b"]);
const { store, st, write, leases } = f;
const [a, b] = f.lanes;
type Lane = typeof a;
const pid = String(process.pid);
const G = (l: Lane, x: string) => l.at(`work/.store/groups/${x}`);
const ok = (l: Lane, args: string[], env: NodeJS.ProcessEnv = {}) => { const r = store(l, args, env); assert.equal(r.code, 0, `store.sh ${args.join(" ")}: ${r.stdout}${r.stderr}`); return r; };
const stampOf = (g: string) => JSON.parse(readOr(st(`stamps/${g}.json`)) || "{}");
// A CI run's start on group g in lane l, as the loop's: the lease (the claim takes it), the copy
// down, the run's mark. Its time, for clean --since.
const ciStart = (l: Lane, g: string) => {
  l.setup(["lease", "take", g]);
  ok(l, ["take", g, "--new", "--mark", "ci", pid]);
  return String(Math.floor(Date.now() / 1000));
};
for (const g of ["f1", "f2", "f3", "f4"]) f.onStore(g);

describe("a CI run's rebuild goes back to the store as it ends", () => {
  const t0 = ciStart(a, "f3");
  write(a.at("work/out/f3/stage.bin"), "rebuilt by CI\n");
  write(a.at("mods/m-f3/mod.txt"), "CI's mod\n");
  const c = store(a, ["clean", "f3", "--since", t0, "--up", "abc1234"]);
  test("clean --up copies it back", () => {
    assert.equal(c.code, 0, c.stdout + c.stderr);
    has(c.stderr, "f3: copied back after f3's CI run");
    assert.equal(readOr(st("groups/f3/out/stage.bin")), "rebuilt by CI\n");
    assert.equal(readOr(st("groups/f3/mod/mod.txt")), "CI's mod\n");
  });
  test("  stamped as the group's CI: its commit and host, no unit", () => {
    const s = stampOf("f3");
    assert.equal(s.ci, "f3"); assert.equal(s.commit, "abc1234"); assert.equal(s.host, "a");
    assert.ok(!("unit" in s), JSON.stringify(s));
  });
  test("  the copy here is current, nothing owed, the run's mark gone", () => {
    assert.equal(readOr(G(a, "f3.json")), readOr(st("stamps/f3.json")));
    assert.ok(!fs.existsSync(G(a, "f3.unsent")));
    assert.deepEqual(fs.readdirSync(a.at("work/.store/groups")).filter((x) => x.startsWith("f3.dirty.") || x.startsWith("f3.cistart.")), []);
  });
  test("  and the lease goes at the next look", () => {
    ok(a, ["release-idle"]);
    hasnt(leases(), "f3=");
  });
  test("the other laptop's next copy down has the rebuild", () => {
    b.setup(["lease", "take", "f3"]);
    const r = ok(b, ["take", "f3", "--new"]);
    has(r.stderr, "f3: copied down (f3's CI from a)");
    assert.equal(readOr(b.at("work/out/f3/stage.bin")), "rebuilt by CI\n");
  });
  test("a run that rebuilt nothing copies nothing back", () => {
    ok(b, ["release-idle"]);
    const t1 = ciStart(a, "f3");
    const before = readOr(st("stamps/f3.json"));
    const r = ok(a, ["clean", "f3", "--since", t1, "--up", "def5678"]);
    hasnt(r.stderr, "copied back");
    assert.equal(readOr(st("stamps/f3.json")), before);
  });
  after(() => { ok(a, ["release-idle"]); });
});

describe("the store out of reach as the run ends: the run's copy back is owed, and tried again", () => {
  let c: ReturnType<typeof store>;
  test("clean --up fails, saying so", () => {
    const t0 = ciStart(a, "f4");
    write(a.at("work/out/f4/stage.bin"), "rebuilt by CI\n");
    c = store(a, ["clean", "f4", "--since", t0, "--up", "abc1234"], { FACTORY_STORE: NOPE });
    assert.equal(c.code, 2, c.stdout + c.stderr);
    has(a.events(), "couldn't copy f4's data back from a after f4's CI run");
  });
  test("  the copy here is marked unsent, as the run's", () => {
    assert.ok(fs.existsSync(G(a, "f4.unsent")));
    assert.equal(readOr(G(a, "f4.retry")).split("\t")[0], "ci");
  });
  test("  the run's mark is gone all the same", () => { assert.deepEqual(fs.readdirSync(a.at("work/.store/groups")).filter((x) => x.startsWith("f4.dirty.")), []); });
  test("  and a look while it's still down keeps the lease", () => {
    store(a, ["release-idle"], { FACTORY_STORE: NOPE, FACTORY_STORE_RETRY: "0" });
    has(leases(), "f4=a");
  });
  test("  once the store is back, the next look copies it back, stamped as the CI's", () => {
    ok(a, ["release-idle"], { FACTORY_STORE_RETRY: "0" });
    assert.equal(readOr(st("groups/f4/out/stage.bin")), "rebuilt by CI\n");
    assert.equal(stampOf("f4").ci, "f4");
    has(a.events(), "f4's copy back from a after f4's CI run went through on try");
  });
  test("  and releases the lease", () => { hasnt(leases(), "f4="); });
});

describe("the store moved on while the run's copy back was owed: it's dropped, and nothing is set aside", () => {
  test("(f2's run ends with the store out of reach)", () => {
    const t0 = ciStart(a, "f2");
    write(a.at("work/out/f2/stage.bin"), "rebuilt by CI\n");
    assert.equal(store(a, ["clean", "f2", "--since", t0, "--up", "abc1234"], { FACTORY_STORE: NOPE }).code, 2);
  });
  test("another machine's copy back since: the run's isn't sent over it", () => {
    write(st("groups/f2/out/pad.bin"), "another machine's\n");
    fs.writeFileSync(st("stamps/f2.json"), JSON.stringify({ unit: "f2/other", commit: "y", host: "z", at: "2030-01-01T00:00:00Z", bytes: 10 }) + "\n");
    const r = ok(a, ["release-idle"], { FACTORY_STORE_RETRY: "0" });
    has(r.stderr, "f2: the store has moved on since f2's CI run (f2/other from z); its copy back isn't needed");
    assert.ok(!fs.existsSync(st("groups/f2/out/stage.bin")));
    assert.equal(stampOf("f2").unit, "f2/other");
  });
  test("  nothing owed any more, and no store-moved event", () => {
    assert.ok(!fs.existsSync(G(a, "f2.unsent")));
    hasnt(a.events(), "store-moved");
  });
  test("  the next copy down replaces the run's files without keeping them", () => {
    ok(a, ["take", "f2", "--new"]);
    assert.equal(readOr(a.at("work/out/f2/pad.bin")), "another machine's\n");
    assert.ok(!fs.existsSync(a.at("work/out/f2/stage.bin")));
    assert.deepEqual(f.asides(a, "f2"), []);
    hasnt(a.events(), "store-aside");
  });
  after(() => { a.setup(["lease", "release", "f2"]); });
});

// The same, but a copy down comes first, while the failed copy back waits out its retry (take
// doesn't force it): nothing of the run's is set aside either.
describe("a copy down over the run's copy back still owed, in its wait before a retry", () => {
  test("(f7's run ends with the store out of reach, and the store moves on)", () => {
    f.group("f7"); f.onStore("f7");
    const t0 = ciStart(a, "f7");
    write(a.at("work/out/f7/stage.bin"), "rebuilt by CI\n");
    assert.equal(store(a, ["clean", "f7", "--since", t0, "--up", "abc1234"], { FACTORY_STORE: NOPE }).code, 2);
    write(st("groups/f7/out/pad.bin"), "another machine's\n");
    fs.writeFileSync(st("stamps/f7.json"), JSON.stringify({ unit: "f7/other", commit: "y", host: "z", at: "2030-01-01T00:00:00Z", bytes: 10 }) + "\n");
  });
  test("a copy down replaces the run's files without keeping them", () => {
    ok(a, ["take", "f7", "--new"]);
    assert.equal(readOr(a.at("work/out/f7/pad.bin")), "another machine's\n");
    assert.ok(!fs.existsSync(a.at("work/out/f7/stage.bin")));
    assert.deepEqual(f.asides(a, "f7"), []);
    hasnt(a.events(), "store-aside");
  });
  test("  and nothing is owed any more", () => { assert.ok(!fs.existsSync(G(a, "f7.unsent"))); });
  after(() => { a.setup(["lease", "release", "f7"]); });
});

describe("only the run's own work goes back", () => {
  test("a copy with another lane's session mark in it isn't copied back", () => {
    const t0 = ciStart(a, "f1");
    write(a.at("work/out/f1/stage.bin"), "rebuilt by CI\n");
    write(G(a, "f1.dirty.a-lane9"), "f1/s\t\t\n");
    const r = ok(a, ["clean", "f1", "--since", t0, "--up", "abc1234"]);
    has(r.stderr, "f1: the CI run's outputs aren't copied back: the copy here wasn't the store's alone");
    assert.ok(!fs.existsSync(st("groups/f1/out/stage.bin")));
    assert.equal(stampOf("f1").unit, "seed");
    assert.ok(!fs.existsSync(G(a, "f1.unsent")));
    fs.rmSync(G(a, "f1.dirty.a-lane9"));
  });
  test("a run cut short (no --up) copies nothing back", () => {
    const t0 = String(Math.floor(Date.now() / 1000));
    ok(a, ["take", "f1", "--mark", "ci", pid]);
    write(a.at("work/out/f1/half.bin"), "half written\n");
    ok(a, ["clean", "f1", "--since", t0]);
    assert.ok(!fs.existsSync(st("groups/f1/out/half.bin")));
    assert.ok(!fs.existsSync(G(a, "f1.unsent")));
  });
  // A copy back owed meanwhile (here a unit's, with the store out of reach) waits for a CI run on
  // the group: the run writes the copy too, and its outputs would go half-written.
  test("a live CI run in another lane holds up a copy back owed here", () => {
    write(a.at("work/out/f1/w.txt"), "a unit's work\n");
    assert.notEqual(store(a, ["up", "f1", "f1/x", "c"], { FACTORY_STORE: NOPE }).code, 0);
    const lstart = chomp(cmd("ps", ["-o", "lstart=", "-p", pid], { cwd: a.dir, env: process.env }).stdout);
    write(G(a, "f1.dirty.a-lane3"), `ci\t${pid}\t${lstart}\n`);
    const r = ok(a, ["release-idle"], { FACTORY_STORE_RETRY: "0" });
    has(r.stderr, "f1: its copy back waits for the CI run here, which writes the copy too");
    assert.ok(!fs.existsSync(st("groups/f1/out/w.txt")));
  });
  test("  then it goes", () => {
    fs.rmSync(G(a, "f1.dirty.a-lane3"));
    ok(a, ["release-idle"], { FACTORY_STORE_RETRY: "0" });
    assert.equal(readOr(st("groups/f1/out/w.txt")), "a unit's work\n");
    assert.equal(stampOf("f1").unit, "f1/x");
  });
  after(() => { ok(a, ["release-idle"]); });
});

// An unfinished unit's put-back while a CI run's copy back is owed: what the run wrote is main's, so
// the set is the unit's own (restorable), not one to sort.
describe("a put-back over a CI run's copy back still owed", () => {
  test("(f6's run ends with the store out of reach; then a unit there ends unfinished)", () => {
    f.group("f6"); f.onStore("f6");
    const t0 = ciStart(a, "f6");
    write(a.at("work/out/f6/stage.bin"), "rebuilt by CI\n");
    assert.equal(store(a, ["clean", "f6", "--since", t0, "--up", "abc1234"], { FACTORY_STORE: NOPE }).code, 2);
    f.add("f6/u"); write(a.at("work/out/f6/u.txt"), "U\n"); write(G(a, "f6.unmerged.f6+u"), "f6/u\t\n");
  });
  test("the store's copy is put back, the unit's outputs kept as its own set", () => {
    ok(a, ["release-idle"], { FACTORY_STORE_RETRY: "0" });
    assert.ok(!fs.existsSync(a.at("work/out/f6/u.txt")));
    assert.equal(f.asideLines(a, "f6", ".kind", ".units"), "unmerged f6/u");
    hasnt(a.events(), "\tstore-aside\t");
  });
  test("  and the run's copy back isn't owed any more", () => { assert.ok(!fs.existsSync(G(a, "f6.unsent"))); });
  after(() => { f.drop("f6/u"); a.setup(["lease", "release", "f6"]); });
});

describe("not leased here: nothing copied back", () => {
  test("a run whose lease went to another laptop meanwhile copies nothing back", () => {
    const t0 = ciStart(b, "f4");
    write(b.at("work/out/f4/late.bin"), "rebuilt by CI on b\n");
    b.setup(["lease", "release", "f4"]); a.setup(["lease", "take", "f4"]);
    const r = store(b, ["clean", "f4", "--since", t0, "--up", "abc1234"]);
    assert.equal(r.code, 2, r.stdout + r.stderr);
    assert.ok(!fs.existsSync(st("groups/f4/out/late.bin")));
    has(b.events(), "f4's lease isn't b's any more, or origin couldn't confirm it, after f4's CI run");
  });
  after(() => { a.setup(["lease", "release", "f4"]); });
});

f.notBroken();
