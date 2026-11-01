// A first copy down over a copy that differs from the store's: same bytes with older times set
// nothing aside; only older files (and files store.rebuilt matches) are deleted with an
// older-copies-only event; anything else here (a file the store lacks, a link, same time but other
// bytes, a rebuilt file a lane worked on) gets the full event. Run: node --test test/store/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { has, hasnt, cmd } from "../lib/index.ts";
import { storeFactory } from "./factory.ts";

const f = storeFactory(["a"]);
const { store, st, write, touch, asideRead } = f;
f.onStore("f2");
f.add("f2/n1"); f.drop("f2/n1");   // the unit the copies down are for, dropped since
const OLD = Date.parse("2001-01-01T00:00:00");
type Lane = ReturnType<typeof f.lane>;
// A laptop with a copy of f2 here from before: files set by fill(l), then a first copy down.
function copyDown(n: string, fill: (l: Lane) => void) {
  const l = f.lane(n);
  fs.mkdirSync(l.at("work/out/f2"), { recursive: true });
  fill(l);
  const r = store(l, ["take", "f2", "--unit", "f2/n1", "--new"]);
  return { l, r };
}
const oldBuild = (l: Lane) => { write(l.at("work/out/f2/pad.bin"), "an old build\n"); touch(l.at("work/out/f2/pad.bin"), OLD); };
const asideDir = (l: Lane) => (fs.existsSync(l.at("work/.store/aside")) ? fs.readdirSync(l.at("work/.store/aside")) : []);
// A file given another's time to the nanosecond (`touch -r`; utimes would round it to the microsecond).
const touchAs = (ref: string, file: string) => assert.equal(cmd("touch", ["-r", ref, file], { cwd: f.w.top, env: f.w.env }).code, 0);
// Every file under a folder (`find -type f`).
const files = (d: string): string[] => (fs.existsSync(d) ? fs.readdirSync(d, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name) : []);

describe("a first copy down over a copy that differs from the store's only in file times sets nothing aside", () => {
  const { l: e, r } = copyDown("e", (l) => { fs.copyFileSync(st("groups/f2/out/pad.bin"), l.at("work/out/f2/pad.bin")); touch(l.at("work/out/f2/pad.bin"), OLD); });
  test("a copy down over same bytes with older times", () => { assert.equal(r.code, 0, r.stdout + r.stderr); assert.ok(fs.existsSync(e.at("work/.store/groups/f2.json")), "the copy down stamped nothing here"); assert.ok(fs.readFileSync(e.at("work/out/f2/pad.bin")).equals(fs.readFileSync(st("groups/f2/out/pad.bin")))); });
  test("  sets nothing aside", () => { assert.deepEqual(files(e.at("work/.store/aside")), []); });
  test("  and raises nothing", () => { hasnt(e.events(), "store-aside"); });
});

describe("a first copy down that only replaces older files says so, and deletes them: older copies only", () => {
  const { l: g, r } = copyDown("g", oldBuild);
  test("a copy down that only replaces older files gives an older-copies-only event", () => { assert.equal(r.code, 0, r.stderr); has(g.events(), "store-aside-old"); });
  test("  saying it deleted them", () => { has(g.events(), "older copies only, deleted"); });
  test("  and not the full event", () => { hasnt(g.events(), "\tstore-aside\t"); });
  test("  nothing is left aside", () => { assert.deepEqual(asideDir(g), []); });
});

// store.rebuilt: files a pipeline step rebuilds aren't kept, unless the copy was worked on here.
describe("store.rebuilt", () => {
  const m = f.lane("m");
  const pf = m.at("tracker/project.json"), pj = JSON.parse(fs.readFileSync(pf, "utf8"));
  pj.store.rebuilt = ["out/*.gen"];
  fs.writeFileSync(pf, JSON.stringify(pj, null, 2) + "\n");
  m.git("commit", "-qam", "rebuilt"); m.git("push", "-q", "origin", "main");
  fs.mkdirSync(m.at("work/out/f2"), { recursive: true });
  oldBuild(m);
  write(m.at("work/out/f2/names.gen"), "regenerated\n");
  store(m, ["take", "f2", "--unit", "f2/n1", "--new"]);
  test("a file store.rebuilt matches isn't kept: the rest is older copies only", () => { has(m.events(), "older copies only, deleted"); });
  test("  nothing left aside", () => { assert.deepEqual(asideDir(m), []); });
  test("  but is when a lane worked on the copy", () => {
    const { l: n } = copyDown("n2", (l) => { write(l.at("work/out/f2/names.gen"), "hand work\n"); write(l.at("work/.store/groups/f2.dirty.n2-lane1"), ""); });
    has(asideRead(n, "f2", "out/names.gen"), "hand work");
  });
});

// Older files with a deletion, a link, or same-time different bytes alongside: still the owner's.
describe("older files with something else alongside", () => {
  const kinds: [string, string, (l: Lane) => void][] = [
    ["i", "extra", (l) => { write(l.at("work/out/f2/old notes.txt"), "only here\n"); touch(l.at("work/out/f2/old notes.txt"), OLD); }],
    ["j", "link", (l) => { fs.symlinkSync("pad.bin", l.at("work/out/f2/pad-link")); fs.lutimesSync(l.at("work/out/f2/pad-link"), OLD / 1000, OLD / 1000); }],
    ["k", "sametime", (l) => { write(l.at("work/out/f2/pad.bin"), "same time\n"); touchAs(st("groups/f2/out/pad.bin"), l.at("work/out/f2/pad.bin")); }],
  ];
  for (const [n, kind, more] of kinds) {
    const { l, r } = copyDown(n, (x) => { oldBuild(x); more(x); });
    test(`older files plus ${kind} give the full event`, () => { assert.equal(r.code, 0, r.stderr); has(l.events(), "\tstore-aside\t"); });
    test("  not the older-only one", () => { hasnt(l.events(), "store-aside-old"); });
  }
});

f.notBroken();
