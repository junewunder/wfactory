// A copy down over a copy changed since its stamp keeps only what changed here: a file still as it
// was stamped (the store's older copy, replaced or deleted on the store since) isn't kept, and the
// files a CI run wrote go into the stamp's listing (clean --since), so they aren't kept either.
// Only a listing from a copy that mirrored the store vouches for single files, only an unworked copy
// drops them, and only a CI run that started on the copy as stamped takes its writes in.
// Run: node --test test/store/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { has, hasnt } from "../lib/index.ts";
import { storeFactory } from "./factory.ts";

const f = storeFactory(["a"]);
const { store, st, write, touch, asideRead } = f;
f.onStore("f2");
f.add("f2/n1"); f.drop("f2/n1");   // the unit the copies down are for, dropped since
type Lane = ReturnType<typeof f.lane>;
const OLD = Date.parse("2001-01-01T00:00:00");
const files = (d: string): string[] => (fs.existsSync(d) ? fs.readdirSync(d, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name).sort() : []);
const take = (l: Lane, ...more: string[]) => { const r = store(l, ["take", "f2", "--unit", "f2/n1", "--new", ...more]); assert.equal(r.code, 0, r.stdout + r.stderr); return r; };
// Another machine's copy back: pad.bin rebuilt, gone.bin no longer made, the stamp newer.
let n = 0;
const storeMovesOn = () => {
  n++;
  write(st("groups/f2/out/pad.bin"), `rebuilt ${n}\n`);
  fs.rmSync(st("groups/f2/out/gone.bin"), { force: true });
  fs.writeFileSync(st("stamps/f2.json"), JSON.stringify({ unit: `f2/other${n}`, commit: "y", host: "z", at: `2026-02-0${n}T00:00:00Z`, bytes: 10 }) + "\n");
};

describe("files still as the copy was stamped aren't kept; a file changed here is", () => {
  const l = f.lane("e");
  write(st("groups/f2/out/gone.bin"), "an output the pipeline stopped making\n");
  touch(st("groups/f2/out/gone.bin"), OLD);
  take(l);
  storeMovesOn();
  write(l.at("work/out/f2/hand.txt"), "written here outside a lane\n");
  take(l);
  test("the store's copy is here", () => { has(fs.readFileSync(l.at("work/out/f2/pad.bin"), "utf8"), "rebuilt 1"); assert.ok(!fs.existsSync(l.at("work/out/f2/gone.bin"))); });
  test("  the file changed here is kept, with a unit to sort it", () => { has(asideRead(l, "f2", "out/hand.txt"), "outside a lane"); has(l.events(), "\tstore-aside\t"); });
  test("  the replaced and the deleted, as stamped, aren't", () => { assert.deepEqual(f.asides(l, "f2").flatMap((x) => files(x)).filter((x) => !x.startsWith(".")), ["hand.txt"]); });
});

describe("a CI run's files go into the stamp's listing: a later copy down sets nothing aside", () => {
  const l = f.lane("g");
  take(l, "--mark", "ci", String(process.pid));
  const t0 = Math.floor(Date.now() / 1000);
  write(l.at("work/out/f2/published.uasset"), "what the publish step wrote\n");
  write(l.at("work/out/f2/pad.bin"), "rebuilt by CI\n");
  const c = store(l, ["clean", "f2", "--since", String(t0)]);
  test("clean --since says what it took in", () => { assert.equal(c.code, 0, c.stderr); has(c.stdout + c.stderr, "2 files the CI run wrote are main's"); });
  test("  and drops the run's mark", () => { assert.deepEqual(fs.readdirSync(l.at("work/.store/groups")).filter((x) => x.includes(".dirty.")), []); });
  storeMovesOn();
  take(l);
  test("a copy down over the CI run's files sets nothing aside", () => { assert.deepEqual(f.asides(l, "f2"), []); hasnt(l.events(), "store-aside"); });
  test("  and the store's copy is here", () => { has(fs.readFileSync(l.at("work/out/f2/pad.bin"), "utf8"), "rebuilt 2"); assert.ok(!fs.existsSync(l.at("work/out/f2/published.uasset"))); });
});

const listOf = (l: Lane) => fs.readFileSync(l.at("work/.store/groups/f2.list"), "utf8");
const kept = (l: Lane) => f.asides(l, "f2").flatMap((x) => files(x)).filter((x) => !x.startsWith(".")).sort();

describe("a stamped file changed here is kept; nothing is dropped from a copy a lane worked on or one not stamped by a mirror", () => {
  const l = f.lane("i");
  take(l);
  write(l.at("work/out/f2/pad.bin"), "hand edit of a file the stamp lists\n");
  // An hour before the store's newer copy: older, but changed here all the same.
  const hourAgo = Date.now() / 1000 - 3600;
  fs.utimesSync(l.at("work/out/f2/pad.bin"), hourAgo, hourAgo);
  storeMovesOn();
  take(l);
  test("a file in the listing but changed here is kept", () => { has(asideRead(l, "f2", "out/pad.bin"), "hand edit"); });
  const w = f.lane("j");
  take(w);
  write(w.at("work/.store/groups/f2.dirty.j-lane9"), "f2/n1\t\t\n");
  write(w.at("work/out/f2/extra.txt"), "a session's\n");
  storeMovesOn();
  take(w);
  test("worked on here: even the stamped pad.bin is kept", () => { assert.deepEqual(kept(w), ["extra.txt", "pad.bin"]); });
  const m = f.lane("k");
  take(m);
  fs.rmSync(m.at("work/.store/groups/f2.mirror"));   // as a seed's copy down leaves it
  write(m.at("work/out/f2/extra.txt"), "here\n");
  storeMovesOn();
  take(m);
  test("a listing not from a mirror: the stamped pad.bin is kept", () => { assert.deepEqual(kept(m), ["extra.txt", "pad.bin"]); });
});

describe("what CI writes is taken in only from a clean start, with no other work, and only with --since", () => {
  const h = f.lane("h");
  take(h);
  write(h.at("work/out/f2/hand.txt"), "edited before the run\n");
  take(h, "--mark", "ci", String(process.pid));
  const t0 = Math.floor(Date.now() / 1000) - 5;
  write(h.at("work/out/f2/hand.txt"), "the run re-saved the hand edit\n");
  store(h, ["clean", "f2", "--since", String(t0)]);
  test("a copy changed before the run: nothing taken in", () => { hasnt(listOf(h), "hand.txt"); });
  storeMovesOn();
  take(h);
  test("  and the next copy down keeps it", () => { has(asideRead(h, "f2", "out/hand.txt"), "re-saved"); });

  const u = f.lane("u2");
  take(u, "--mark", "ci", String(process.pid));
  write(u.at("work/out/f2/x.txt"), "ci\n");
  write(u.at("work/.store/groups/f2.unmerged.f2+n9"), "f2/n9\tc\n");
  store(u, ["clean", "f2", "--since", String(Math.floor(Date.now() / 1000) - 5)]);
  test("unmerged outputs here: nothing taken in", () => { hasnt(listOf(u), "x.txt"); });

  const p = f.lane("p");
  take(p, "--mark", "ci", String(process.pid));
  write(p.at("work/out/f2/x.txt"), "ci\n");
  const plain = store(p, ["clean", "f2"]);
  test("plain clean takes nothing in", () => { assert.equal(plain.code, 0, plain.stderr); hasnt(listOf(p), "x.txt"); });
  test("  and drops the run's marks", () => { assert.deepEqual(fs.readdirSync(p.at("work/.store/groups")).filter((x) => x.includes(".dirty.") || x.includes(".cistart.")), []); });
});

f.notBroken();

// A mirror's listing with nothing in it (the store had no files for the group yet) vouches all the
// same: a file made here since, however old, was made here.
describe("an empty mirror's listing: a file made here since is kept, however old", () => {
  f.add("f3/n1"); f.drop("f3/n1");
  fs.mkdirSync(st("groups/f3/out"), { recursive: true });
  write(st("inputs/rip/fighters/f3/part.txt"), "f3's part\n");
  write(st("stamps/f3.json"), JSON.stringify({ unit: "f3/empty", commit: "x", host: "c", at: "2026-01-01T00:00:00Z", bytes: 0 }) + "\n");
  const l = f.lane("m");
  const take3 = () => { const r = store(l, ["take", "f3", "--unit", "f3/n1", "--new"]); assert.equal(r.code, 0, r.stdout + r.stderr); };
  take3();
  const mirror = fs.existsSync(l.at("work/.store/groups/f3.mirror")), list = fs.readFileSync(l.at("work/.store/groups/f3.list"), "utf8");
  test("the copy here is stamped as a mirror, listing nothing", () => { assert.ok(mirror); assert.equal(list, ""); });
  write(l.at("work/out/f3/pad.bin"), "unpacked here from an old archive\n");
  const dayAgo = Date.now() / 1000 - 86400;
  fs.utimesSync(l.at("work/out/f3/pad.bin"), dayAgo, dayAgo);
  write(st("groups/f3/out/pad.bin"), "made by another machine\n");
  write(st("stamps/f3.json"), JSON.stringify({ unit: "f3/other", commit: "y", host: "z", at: "2026-02-01T00:00:00Z", bytes: 24 }) + "\n");
  take3();
  test("a copy down over it keeps the file made here", () => { has(f.asideRead(l, "f3", "out/pad.bin"), "unpacked here"); hasnt(l.events(), "store-aside-old"); });
});
