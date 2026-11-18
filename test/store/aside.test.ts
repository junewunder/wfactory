// Sets aside: a first copy down over data the store doesn't have keeps it aside, with the full event
// and no unit (nothing says whose work it is, so it stays where it is); store.sh aside, aside sort,
// audit and drop; sets with no kind or no .units; a unit an older store.sh filed to sort one, in its
// data group; a set whose group lost its data; the rule applied as a lane starts and as the lanes
// stop; and adopt, for migrations. (The rule itself: aside-rule.test.ts.)
// Run: node --test test/store/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { has, hasnt, chomp, readOr, holdLock } from "../lib/index.ts";
import { storeFactory } from "./factory.ts";

const f = storeFactory(["a", "d", "h"]);
const { add, drop, store, state, tr, write, touch, asides, asideRead, asideLines } = f;
const [a, d, h] = f.lanes;
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

// One that replaces a file newer here than the store's, or deletes one: nothing says whose work it
// is, so it stays where it is, with no unit to sort it.
describe("a copy down that replaces a newer file", () => {
  write(h.at("work/out/f2/pad.bin"), "a newer build\n"); touch(h.at("work/out/f2/pad.bin"), NEWER);
  ok(h, ["take", "f2", "--unit", "f2/n1", "--new"]);
  const hb = path.basename(asides(h, "f2")[0] ?? "");
  test("a copy down that replaces a newer file gives the full event", () => { has(h.events(), "\tstore-aside\t"); });
  test("  not the older-only one", () => { hasnt(h.events(), "store-aside-old"); });
  test("  saying it stays there, and that no session sorts it", () => { has(h.events(), "nothing recorded whose work all of it is, so it stays there: no session sorts it"); });
  test("  store.sh aside says why it stays", () => { has(store(h, ["aside"]).stdout, "stays: nothing recorded whose work it holds"); });
  test("  aside sort leaves it", () => {
    store(h, ["aside", "sort"]);
    assert.ok(fs.statSync(h.at(`work/.store/aside/${hb}`)).isDirectory());
  });
  test("  and files no unit", () => { assert.equal(`${fs.existsSync(h.at(`work/.store/aside/${hb}/.unit`))} ${tr(a, ["show", "aside"]).code !== 0}`, "false true"); });
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
});

// A set without a kind (an older store.sh, or a copy down cut short) is never judged by times:
// release-idle's aside sort tags it as one nothing accounts for, unless its group is busy here.
describe("a set without a kind", () => {
  const set = "f2-20010101-000000", X = (p: string) => h.at(`work/.store/aside/${set}/${p}`);
  test("aside sort leaves a set whose group's lock is held", async () => {
    write(X("out/pad.bin"), "old\n"); touch(X("out/pad.bin"), OLD);
    write(X("out/gone.txt"), "gone\n");
    const busy = await holdLock(h.at("work/.store/lock-f2"));
    try { store(h, ["aside", "sort"]); } finally { await busy.release(); }
    assert.ok(!fs.existsSync(X(".kind")));
  });
  test("  then a set without a kind isn't deleted", () => {
    store(h, ["release-idle"]);
    assert.ok(fs.existsSync(h.at(`work/.store/aside/${set}`)));
  });
  test("  release-idle tags it as one nothing accounts for, and files no unit", () => { assert.equal(`${chomp(readOr(X(".kind")))} ${fs.existsSync(X(".unit"))}`, "check false"); });
  let audit = "";
  test("  aside audit calls an older file store-newer", () => {
    audit = store(h, ["aside", "audit", set]).stdout;
    has(audit, "out/pad.bin\t4\tstore-newer");
  });
  test("  and a file the store lacks not-on-store", () => { has(audit, "out/gone.txt\t5\tnot-on-store"); });
  after(() => { store(h, ["aside", "drop", set]); });
});

// An unmerged set without its .units (a put-back cut short) can't say whose outputs it holds: it stays.
describe("an unmerged set without its .units", () => {
  const set = "f2-20020202-000000";
  test("an unmerged set without its .units isn't deleted by aside sort: nothing accounts for it, and no unit is filed", () => {
    write(h.at(`work/.store/aside/${set}/out/m.txt`), "mine\n");
    write(h.at(`work/.store/aside/${set}/.kind`), "unmerged\n");
    store(h, ["aside", "sort"]);
    assert.equal(asideLines(h, "f2", "out/m.txt", ".kind", ".unit"), "mine check");
  });
  after(() => { store(h, ["aside", "drop", set]); });
});

// A unit an older store.sh filed in the set's data group, to sort the set: aside sort drops it (no
// session sorts a set any more), unless its session is working it now, and the set stays.
describe("a sort unit filed in its data group", () => {
  const set = "f2-20030303-000000", old = "f2/aside-h-20030303-000000";
  test("a parked sort unit in the data group is dropped by aside sort", () => {
    write(h.at(`work/.store/aside/${set}/out/m.txt`), "mine\n");
    write(h.at(`work/.store/aside/${set}/.kind`), "check\n");
    add(old, "--host", "h", "--data", "none"); a.setup(["park", old, "--why", "test"]);
    write(h.at(`work/.store/aside/${set}/.unit`), `${old}\n`);
    store(h, ["aside", "sort"]);
    assert.equal(state(old), "dropped");
  });
  test("  saying why", () => { has(unitOf(a, old)?.record?.why ?? "", "No session sorts a set-aside copy any more"); });
  test("  none is filed in its place, and the set stops naming one", () => { assert.equal(`${asideLines(h, "f2", ".unit")}|${tr(a, ["show", "aside"]).code !== 0}`, "|true"); });
  test("  the set stays", () => { assert.equal(readOr(h.at(`work/.store/aside/${set}/out/m.txt`)), "mine\n"); });
  test("  one its session is sorting now is left alone", () => {
    const set2 = "f2-20030304-000000", old2 = "f2/aside-h-20030304-000000";
    write(h.at(`work/.store/aside/${set2}/out/m.txt`), "mine\n");
    write(h.at(`work/.store/aside/${set2}/.kind`), "check\n");
    add(old2, "--host", "h", "--data", "none"); a.setup(["claim", old2]);
    write(h.at(`work/.store/aside/${set2}/.unit`), `${old2}\n`);
    store(h, ["aside", "sort"]);
    assert.equal(`${state(old2)} ${chomp(readOr(h.at(`work/.store/aside/${set2}/.unit`)))}`, `doing ${old2}`);
  });
  after(() => {
    a.run("factory/tracker", ["drop", "f2/aside-h-20030304-000000", "--why", "test"]);
    for (const x of [set, "f2-20030304-000000"]) store(h, ["aside", "drop", x]);
  });
});

// A set whose group keeps no data on the store any more (or is gone) stays like any other, with no
// unit; its audit compares it with what the store still holds for that group.
describe("a set whose group lost its data", () => {
  const set = "gone-20040404-000000";
  test("a set of a group the tracker doesn't have stays, with no unit", () => {
    write(h.at(`work/.store/aside/${set}/out/lost.txt`), "lost\n");
    write(h.at(`work/.store/aside/${set}/.kind`), "check\n");
    store(h, ["aside", "sort"]);
    assert.equal(`${readOr(h.at(`work/.store/aside/${set}/out/lost.txt`))}${fs.existsSync(h.at(`work/.store/aside/${set}/.unit`))}`, "lost\nfalse");
  });
  test("  its audit lists the file the store lacks", () => { has(store(h, ["aside", "audit", set]).stdout, "out/lost.txt\t5\tnot-on-store"); });
  test("  and so does one of a group set to keep no data", () => {
    const s2 = "code-20040405-000000";
    write(h.at(`work/.store/aside/${s2}/out/x.txt`), "x\n");
    write(h.at(`work/.store/aside/${s2}/.kind`), "check\n");
    store(h, ["aside", "sort"]);
    assert.equal(`${readOr(h.at(`work/.store/aside/${s2}/out/x.txt`))}${fs.existsSync(h.at(`work/.store/aside/${s2}/.unit`))}`, "x\nfalse");
  });
  after(() => { for (const x of [set, "code-20040405-000000"]) store(h, ["aside", "drop", x]); });
});

// The rule is applied as a lane starts and as the lanes stop, not only at a lane's idle looks: a
// set whose unit is dropped (f2/n1) goes then.
describe("the rule as the lanes start and stop", () => {
  const s1 = "f2-20050505-000000", s2 = "f2-20050506-000000";
  const settled = (set: string) => {
    write(h.at(`work/.store/aside/${set}/out/m.txt`), "mine\n");
    write(h.at(`work/.store/aside/${set}/.kind`), "unmerged\n");
    write(h.at(`work/.store/aside/${set}/.units`), "f2/n1\n");
    write(h.at(`work/.store/aside/${set}/.from`), "f2/n1\ts\tc\th\n");
  };
  test("the lanes stopping (leave) remove a set whose unit is dropped", () => {
    settled(s1);
    ok(h, ["leave"]);
    assert.ok(!fs.existsSync(h.at(`work/.store/aside/${s1}`)));
  });
  test("a lane starting removes one, another lane still running (so no leave)", async () => {
    settled(s2);
    const other = await holdLock(path.join(h.envWith().FACTORY_LOCKS!, "lane-other.lock"));
    try { h.loop(["--max", "0", "--hours", "0.01"]); } finally { await other.release(); }
    assert.ok(!fs.existsSync(h.at(`work/.store/aside/${s2}`)));
  });
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
