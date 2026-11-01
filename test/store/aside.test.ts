// Sets aside: a first copy down over data the store doesn't have keeps it aside, with the full event
// and a unit, pinned to the machine, that sorts it, in the sort group (no gates, no parks: never
// waiting on the owner); store.sh aside, aside sort, audit and drop; sets with no kind or no .units;
// a unit filed in its data group by an older store.sh; a set whose group lost its data; a unit the
// tracker won't file; sorting as a lane starts and as the lanes stop; and adopt, for migrations.
// Run: node --test test/store/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { has, hasnt, chomp, readOr, holdLock, ROOT } from "../lib/index.ts";
import { storeFactory } from "./factory.ts";

const f = storeFactory(["a", "d", "h", "u"]);
const { add, drop, store, state, tr, write, touch, asides, asideRead, asideLines } = f;
const [a, d, h, u] = f.lanes;
f.onStore("f2");
add("f2/n1"); drop("f2/n1");   // the unit the copies down are for, dropped since
const ok = (l: typeof a, args: string[], env: NodeJS.ProcessEnv = {}) => { const r = store(l, args, env); assert.equal(r.code, 0, `store.sh ${args.join(" ")}: ${r.stderr}`); return r; };
const asideDir = (l: typeof a) => (fs.existsSync(l.at("work/.store/aside")) ? fs.readdirSync(l.at("work/.store/aside")) : []);
// A unit's record in its group's file, as the tracker in that lane has it.
const unitOf = (l: typeof a, id: string) => JSON.parse(readOr(path.join(chomp(tr(l, ["dir"]).stdout), `groups/${id.split("/")[0]}.json`)) || "{}").units?.find((x: any) => x.id === id);
const NEWER = Date.parse("2099-01-01T00:00:00"), OLD = Date.parse("2001-01-01T00:00:00");

describe("a first copy down over data the store doesn't have (a machine before the migration) keeps it aside", () => {
  test("a first copy down brings the store's copy", () => {
    write(d.at("work/out/f2/mine.txt"), "only on d\n");
    ok(d, ["take", "f2", "--unit", "f2/n1", "--new"]);
    assert.ok(fs.existsSync(d.at("work/out/f2/pad.bin")));
  });
  test("  and keeps what it replaced aside", () => { has(asideRead(d, "f2", "out/mine.txt"), "only on d"); });
  test("one that deletes a file the store doesn't have gives the full event", () => { has(d.events(), "\tstore-aside\t"); });
  test("  not the older-only one", () => { hasnt(d.events(), "store-aside-old"); });
});

// One that replaces a file newer here than the store's, or deletes one, gets a unit that sorts it.
// Its data group waits on a gate (the owner's) and has a priority: the unit doesn't wait, and ranks with it.
describe("a copy down that replaces a newer file", () => {
  add("code/g1", "--gate");
  a.setup(["edit-group", "f2", "--needs", "code/g1", "--priority", "7"]);
  write(h.at("work/out/f2/pad.bin"), "a newer build\n"); touch(h.at("work/out/f2/pad.bin"), NEWER);
  ok(h, ["take", "f2", "--unit", "f2/n1", "--new"]);
  const hb = path.basename(asides(h, "f2")[0] ?? ""), hu = `aside/f2-h-${hb.replace(/^f2-/, "")}`;
  test("a copy down that replaces a newer file gives the full event", () => { has(h.events(), "\tstore-aside\t"); });
  test("  not the older-only one", () => { hasnt(h.events(), "store-aside-old"); });
  test("  saying a unit sorts it", () => { has(h.events(), "a unit sorts it: Sort Fighter f2's set-aside copy on h"); });
  test("  ready though its data group waits on a gate", () => { assert.equal(state(hu), "ready"); });
  test("  the unit is filed in the sort group, not its data group", () => { assert.ok(unitOf(a, hu)); });
  test("  at its data group's priority", () => { assert.equal(unitOf(a, hu)?.priority, 7); });
  test("  pinned to the machine", () => { assert.equal(unitOf(a, hu)?.host, "h"); });
  test("  store.sh aside names it", () => { has(store(h, ["aside"]).stdout, `being sorted by ${hu}`); });
  test("  aside sort leaves it", () => {
    store(h, ["aside", "sort"]);
    assert.ok(fs.statSync(h.at(`work/.store/aside/${hb}`)).isDirectory());
  });
  test("  and files no second unit", () => { assert.equal(tr(a, ["status", "aside", "--all"]).stdout.split("\n").filter((x) => x.includes("set-aside copy on h")).length, 1); });
  let audit = "";
  test("  aside audit lists the newer file", () => {
    audit = store(h, ["aside", "audit", hb]).stdout;
    has(audit, "out/pad.bin\t14\taside-newer");
  });
  test("  and sums it up", () => { has(audit, `# ${hb} same=0 store-newer=0 aside-newer=1 not-on-store=0`); });
  test("  aside drop deletes the set", () => {
    store(h, ["aside", "drop", hb]);
    assert.deepEqual(asideDir(h), []);
  });
  test("  and refuses anything but a set's name", () => { assert.equal(store(h, ["aside", "drop", "../groups"]).code, 2); });
  test("  or ..", () => { assert.equal(store(h, ["aside", "drop", ".."]).code, 2); });
  test("  leaving the store's folder alone", () => { assert.ok(fs.statSync(h.at("work/.store")).isDirectory()); });
  after(() => { a.setup(["edit-group", "f2", "--needs", "", "--priority", "0"]); drop("code/g1"); drop(hu); });
});

// A set without a kind (an older store.sh, or a copy down cut short) is never judged by times:
// release-idle's aside sort files a unit for it, holding no lease, unless its group is busy here.
describe("a set without a kind", () => {
  const set = "f2-20010101-000000", su = "aside/f2-h-20010101-000000", X = (p: string) => h.at(`work/.store/aside/${set}/${p}`);
  test("aside sort leaves a set whose group's lock is held", async () => {
    write(X("out/pad.bin"), "old\n"); touch(X("out/pad.bin"), OLD);
    write(X("out/gone.txt"), "gone\n");
    const busy = await holdLock(h.at("work/.store/lock-f2"));
    try { store(h, ["aside", "sort"]); } finally { await busy.release(); }
    assert.ok(!fs.existsSync(X(".unit")));
  });
  test("  then a set without a kind isn't deleted", () => {
    store(h, ["release-idle"]);
    assert.ok(fs.existsSync(h.at(`work/.store/aside/${set}`)));
  });
  test("  release-idle files a unit for it", () => { assert.equal(`${chomp(readOr(X(".kind")))} ${chomp(readOr(X(".unit")))}`, `check ${su}`); });
  test("  pinned to the machine, with no data", () => { const x = unitOf(h, su); assert.equal(`${x?.host} ${x?.data}`, "h none"); });
  let audit = "";
  test("  aside audit calls an older file store-newer", () => {
    audit = store(h, ["aside", "audit", set]).stdout;
    has(audit, "out/pad.bin\t4\tstore-newer");
  });
  test("  and a file the store lacks not-on-store", () => { has(audit, "out/gone.txt\t5\tnot-on-store"); });
  test("  a unit done while its set is still here is reopened", () => {
    a.run("factory/tracker", ["done", su, "--evidence", "test"]);
    store(h, ["aside", "sort"]);
    assert.equal(state(su), "ready");
  });
  test("  and so is one dropped", () => {
    a.run("factory/tracker", ["drop", su, "--why", "test"]);
    store(h, ["aside", "sort"]);
    assert.equal(state(su), "ready");
  });
  after(() => { store(h, ["aside", "drop", set]); });
});

// An unmerged set without its .units (a put-back cut short) can't say whose outputs it holds: one to sort.
describe("an unmerged set without its .units", () => {
  const set = "f2-20020202-000000";
  test("an unmerged set without its .units isn't deleted by aside sort, it's one to sort", () => {
    write(h.at(`work/.store/aside/${set}/out/m.txt`), "mine\n");
    write(h.at(`work/.store/aside/${set}/.kind`), "unmerged\n");
    store(h, ["aside", "sort"]);
    assert.equal(asideLines(h, "f2", "out/m.txt", ".kind", ".unit"), "mine check aside/f2-h-20020202-000000");
  });
  after(() => { a.run("factory/tracker", ["drop", "aside/f2-h-20020202-000000", "--why", "test"]); store(h, ["aside", "drop", set]); });
});

// A unit an older store.sh filed in the set's data group took that group's gates and parks: aside
// sort drops it and files one in the sort group. One its session is working on now, or one asking the
// owner a question, is left alone.
describe("a sort unit filed in its data group", () => {
  const set = "f2-20030303-000000", old = "f2/aside-h-20030303-000000", su = "aside/f2-h-20030303-000000";
  test("a parked sort unit in the data group is dropped by aside sort", () => {
    write(h.at(`work/.store/aside/${set}/out/m.txt`), "mine\n");
    write(h.at(`work/.store/aside/${set}/.kind`), "check\n");
    add(old, "--host", "h", "--data", "none"); a.setup(["park", old, "--why", "test"]);
    write(h.at(`work/.store/aside/${set}/.unit`), `${old}\n`);
    store(h, ["aside", "sort"]);
    assert.equal(state(old), "dropped");
  });
  test("  saying where it went", () => { has(unitOf(a, old)?.record?.why ?? "", `filed again in it as ${su.split("/")[1]}`); });
  test("  and filed again in the sort group", () => { assert.equal(asideLines(h, "f2", ".unit").split(" ").filter((x) => x === su).length, 1); });
  test("    ready", () => { assert.equal(state(su), "ready"); });
  test("  one its session is sorting now is left alone", () => {
    const set2 = "f2-20030304-000000", old2 = "f2/aside-h-20030304-000000";
    write(h.at(`work/.store/aside/${set2}/out/m.txt`), "mine\n");
    write(h.at(`work/.store/aside/${set2}/.kind`), "check\n");
    add(old2, "--host", "h", "--data", "none"); a.setup(["claim", old2]);
    write(h.at(`work/.store/aside/${set2}/.unit`), `${old2}\n`);
    store(h, ["aside", "sort"]);
    assert.equal(`${state(old2)} ${chomp(readOr(h.at(`work/.store/aside/${set2}/.unit`)))}`, `doing ${old2}`);
  });
  test("  and so is one asking the owner a question", () => {
    const set3 = "f2-20030305-000000", old3 = "f2/aside-h-20030305-000000";
    write(h.at(`work/.store/aside/${set3}/out/m.txt`), "mine\n");
    write(h.at(`work/.store/aside/${set3}/.kind`), "check\n");
    add(old3, "--host", "h", "--data", "none");
    a.setup(["ask", "--title", "Which copy of m.txt is right?", "--context", "test", "--option", "a | mine | keep it", "--option", "b | the store's | drop it", "--default", "a", "--blocks", old3]);
    write(h.at(`work/.store/aside/${set3}/.unit`), `${old3}\n`);
    store(h, ["aside", "sort"]);
    assert.equal(`${state(old3)} ${chomp(readOr(h.at(`work/.store/aside/${set3}/.unit`)))}`, `you ${old3}`);
  });
  after(() => {
    for (const x of [su, "f2/aside-h-20030304-000000", "f2/aside-h-20030305-000000"]) a.run("factory/tracker", ["drop", x, "--why", "test"]);
    for (const x of [set, "f2-20030304-000000", "f2-20030305-000000"]) store(h, ["aside", "drop", x]);
  });
});

// A set whose group keeps no data on the store any more (or is gone) gets a unit too, never "for the
// owner"; its audit compares it with what the store still holds for that group.
describe("a set whose group lost its data", () => {
  const set = "gone-20040404-000000", su = "aside/gone-h-20040404-000000";
  test("a set of a group the tracker doesn't have gets a unit", () => {
    write(h.at(`work/.store/aside/${set}/out/lost.txt`), "lost\n");
    write(h.at(`work/.store/aside/${set}/.kind`), "check\n");
    store(h, ["aside", "sort"]);
    assert.equal(chomp(readOr(h.at(`work/.store/aside/${set}/.unit`))), su);
  });
  test("  ready, pinned here", () => { assert.equal(`${state(su)} ${unitOf(a, su)?.host}`, "ready h"); });
  test("  its card says the group keeps no data on the store", () => { has(unitOf(a, su)?.detail ?? "", "keeps no data on the store for gone any more"); });
  test("  its audit lists the file the store lacks", () => { has(store(h, ["aside", "audit", set]).stdout, "out/lost.txt\t5\tnot-on-store"); });
  test("  and so does one of a group set to keep no data", () => {
    const s2 = "code-20040405-000000";
    write(h.at(`work/.store/aside/${s2}/out/x.txt`), "x\n");
    write(h.at(`work/.store/aside/${s2}/.kind`), "check\n");
    store(h, ["aside", "sort"]);
    assert.equal(chomp(readOr(h.at(`work/.store/aside/${s2}/.unit`))), "aside/code-h-20040405-000000");
  });
  after(() => {
    for (const x of [su, "aside/code-h-20040405-000000"]) a.run("factory/tracker", ["drop", x, "--why", "test"]);
    for (const x of [set, "code-20040405-000000"]) store(h, ["aside", "drop", x]);
  });
});

// Sorting runs as a lane starts and as the lanes stop, not only at a lane's idle looks.
describe("sorting as the lanes start and stop", () => {
  const s1 = "f2-20050505-000000", s2 = "f2-20050506-000000";
  test("the lanes stopping (leave) file a set's unit", () => {
    write(h.at(`work/.store/aside/${s1}/out/m.txt`), "mine\n");
    ok(h, ["leave"]);
    assert.equal(chomp(readOr(h.at(`work/.store/aside/${s1}/.unit`))), "aside/f2-h-20050505-000000");
  });
  test("a lane starting files one, another lane still running (so no leave)", async () => {
    write(h.at(`work/.store/aside/${s2}/out/m.txt`), "mine\n");
    const other = await holdLock(path.join(h.envWith().FACTORY_LOCKS!, "lane-other.lock"));
    try { h.loop(["--max", "0", "--hours", "0.01"]); } finally { await other.release(); }
    assert.equal(chomp(readOr(h.at(`work/.store/aside/${s2}/.unit`))), "aside/f2-h-20050506-000000");
  });
  after(() => {
    for (const x of ["aside/f2-h-20050505-000000", "aside/f2-h-20050506-000000"]) a.run("factory/tracker", ["drop", x, "--why", "test"]);
    for (const x of [s1, s2]) store(h, ["aside", "drop", x]);
  });
});

// A set to sort whose unit the tracker won't file says so once, and the next aside sort files it.
describe("store-aside-unfiled", () => {
  const noadd = f.w.at("tracker-noadd.mjs");
  fs.writeFileSync(noadd, `if (process.argv[2] === "add-unit") { console.error("tracker: refused for this test"); process.exit(1); }\nawait import(${JSON.stringify(path.join(ROOT, "tracker/tracker.mjs"))});\n`);
  write(u.at("work/out/f2/pad.bin"), "a newer build\n"); touch(u.at("work/out/f2/pad.bin"), NEWER);
  ok(u, ["take", "f2", "--unit", "f2/n1", "--new"], { FACTORY_TRACKER: noadd });
  test("a set to sort whose unit can't be filed raises store-aside-unfiled", () => { has(u.events(), "store-aside-unfiled\t"); });
  test("  with the tracker's reason", () => { has(u.events(), "has no unit to sort it: tracker: refused for this test"); });
  test("  the store-aside event says no unit is filed yet", () => { has(u.events(), "no unit filed yet (tracker: refused for this test)"); });
  test("  said once, however often aside sort tries", () => {
    store(u, ["aside", "sort"], { FACTORY_TRACKER: noadd });
    assert.equal(u.events().split("\n").filter((x) => x.includes("store-aside-unfiled")).length, 1);
  });
  let ub = "";
  test("  the next aside sort files it", () => {
    store(u, ["aside", "sort"]);
    ub = path.basename(asides(u, "f2")[0] ?? "");
    assert.equal(chomp(readOr(u.at(`work/.store/aside/${ub}/.unit`))), `aside/f2-u-${ub.replace(/^f2-/, "")}`);
  });
  test("    and forgets it was unfiled", () => { assert.ok(!fs.existsSync(u.at(`work/.store/aside/${ub}/.unfiled`))); });
  after(() => { a.run("factory/tracker", ["drop", `aside/f2-u-${ub.replace(/^f2-/, "")}`, "--why", "test"]); store(u, ["aside", "drop", ub]); });
});

describe("adopt (migrations): a copy identical to the store's is stamped current; a different one isn't", () => {
  test("adopt stamps a copy identical to the store's", () => { assert.equal(store(d, ["adopt", "f2"]).code, 0); });
  test("  and refuses one with a file the store doesn't have", () => {
    write(d.at("work/out/f2/extra.txt"), "extra\n"); fs.rmSync(d.at("work/.store/groups/f2.json"), { force: true });
    assert.equal(store(d, ["adopt", "f2"]).code, 1);
  });
  test("  leaving it unstamped", () => { assert.ok(!fs.existsSync(d.at("work/.store/groups/f2.json"))); });
});

f.notBroken();
