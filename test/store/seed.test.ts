// store.sh seed: a group whose data starts outside groups/ (a shared pool) is moved and stamped on
// the store, and copied down where its lease is held; the next copy back leaves it in place. Its
// refusals, runs cut short and run again, a data path that's a link, and a seed over ssh.
// Run: node --test test/store/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { has, readOr, chomp } from "../lib/index.ts";
import { storeFactory } from "./factory.ts";

const f = storeFactory(["a", "b"]);
const { add, store, stamp, st, write, group } = f;
const [a, b] = f.lanes;
const A = (p: string) => a.at(p), B = (p: string) => b.at(p);
const cat = (file: string) => chomp(readOr(file));
const yes = (file: string) => (fs.existsSync(file) ? "yes" : "");
const yesNo = (file: string) => (fs.existsSync(file) ? "yes" : "no");
const ok = (l: typeof a, args: string[]) => { const r = store(l, args); assert.equal(r.code, 0, `store.sh ${args.join(" ")}: ${r.stderr}`); };
for (const g of ["sd1", "sd2", "sd3", "sd4", "sd5", "sd6", "sd7", "sd8", "sd9", "sd10"]) group(g);
const pool = (g: string) => {
  write(st(`pool/${g}/out/seed.txt`), `pool ${g}\n`); write(st(`pool/${g}/mod/m.txt`), `pool mod ${g}\n`); write(st(`pool/${g}/README`), "note\n");
};
for (const g of ["sd1", "sd2", "sd2-again", "sd3", "sd4", "sd5", "s d'6", "sd7", "sd9"]) pool(g);
// store.sh seed in a lane, stdout and stderr merged (as `2>&1`): its exit code and output.
let rc = 0, out = "";
const seed = (l: typeof a, args: string[], env: NodeJS.ProcessEnv = {}) => { const r = l.run("factory/store.sh", ["seed", ...args], env); rc = r.code; out = r.stdout; };

describe("seed, leased by nobody", () => {
  // Over an empty copy's stamp from an older store.sh (bytes 0): moved and stamped only.
  test("seed, leased by nobody: done", () => {
    write(st("stamps/sd1.json"), '{"unit":"sd1/old","commit":"c","host":"a","at":"2026-10-14T00:00:00Z","bytes":0}\n');
    seed(b, ["sd1", "--from", "pool/sd1"]);
    assert.equal(rc, 0, out);
  });
  test("  the pool's folders are the group's on the store", () => { assert.equal(`${cat(st("groups/sd1/out/seed.txt"))}|${cat(st("groups/sd1/mod/m.txt"))}`, "pool sd1|pool mod sd1"); });
  test("  moved, and what isn't a path of the group is left in the pool", () => {
    assert.ok(!fs.existsSync(st("pool/sd1/out")), "pool/sd1/out still there");
    assert.ok(fs.existsSync(st("pool/sd1/README")), "pool/sd1/README gone");
  });
  test("  and says so", () => { has(out, "left in pool/sd1 (not the group's paths): README"); });
  test("  stamped as a seed, with its size", () => { const s = JSON.parse(readOr(st("stamps/sd1.json")) || "{}"); assert.equal(`${s.unit} ${s.bytes > 0}`, "sd1/seed true"); });
  test("  nothing copied down where it isn't leased", () => { assert.ok(!fs.existsSync(B("work/out/sd1"))); });
  test("  the event says so", () => { has(b.events(), "store-seeded\tsd1's data moved on the store from pool/sd1"); });
  test("  seeded already: refused", () => { seed(b, ["sd1", "--from", "pool/sd1"]); assert.equal(rc, 1, out); });
  // The next claim's copy down brings it, and the copy back after its unit leaves it in place.
  test("  the next claim copies it down", () => {
    a.setup(["lease", "take", "sd1"]);
    ok(a, ["take", "sd1", "--new"]);
    assert.equal(cat(A("work/out/sd1/seed.txt")), "pool sd1");
  });
  test("  the copy back after its unit leaves the seeded data in place, with the unit's", () => {
    add("sd1/s1"); a.setup(["done", "sd1/s1", "--evidence", "test"]);
    write(A("work/out/sd1/s1.txt"), "s1's work\n");
    ok(a, ["end", "sd1", "sd1/s1", "c"]);
    assert.equal(`${cat(st("groups/sd1/out/seed.txt"))}|${cat(st("groups/sd1/out/s1.txt"))}|${stamp("sd1")}`, "pool sd1|s1's work|sd1/s1");
  });
  after(() => { a.setup(["lease", "release", "sd1"]); });
});

// Leased here, a session working on it (the unit that runs seed), its take having found nothing on
// the store: moved, stamped and copied down, its mark kept.
describe("seed with the lease held here", () => {
  test("seed with the lease held here: done", () => {
    a.setup(["lease", "take", "sd2"]);
    ok(a, ["take", "sd2", "--new"]);
    ok(a, ["dirty", "sd2", "sd2/s1", String(process.pid)]);
    seed(a, ["sd2", "--from", "pool/sd2"]);
    assert.equal(rc, 0, out);
  });
  test("  copied down too", () => { assert.equal(`${cat(A("work/out/sd2/seed.txt"))}|${cat(A("mods/m-sd2/m.txt"))}`, "pool sd2|pool mod sd2"); });
  test("  stamped current here", () => { assert.equal(cat(A("work/.store/groups/sd2.json")), cat(st("stamps/sd2.json"))); });
  test("  the session's mark stays", () => { assert.ok(fs.existsSync(A("work/.store/groups/sd2.dirty.a-lane1"))); });
  test("  the copy back after the unit leaves the seeded data in place, with the unit's", () => {
    add("sd2/s1"); a.setup(["done", "sd2/s1", "--evidence", "test"]);
    write(A("work/out/sd2/s1.txt"), "s1's work\n");
    ok(a, ["end", "sd2", "sd2/s1", "c"]);
    assert.equal(`${cat(st("groups/sd2/out/seed.txt"))}|${cat(st("groups/sd2/mod/m.txt"))}|${cat(st("groups/sd2/out/s1.txt"))}|${stamp("sd2")}`, "pool sd2|pool mod sd2|s1's work|sd2/s1");
  });
  test("  seeded already, the copy here emptied: copied down again, nothing moved", () => {
    fs.rmSync(A("work/out/sd2"), { recursive: true, force: true }); fs.rmSync(A("mods/m-sd2"), { recursive: true, force: true });
    seed(a, ["sd2", "--from", "pool/sd2-again"]);
    assert.equal(`${rc} ${yes(st("pool/sd2-again/out/seed.txt"))} ${cat(A("work/out/sd2/s1.txt"))}`, "0 yes s1's work", out);
  });
  test("  seeded already, a file here the store doesn't have: refused, nothing moved", () => {
    write(A("work/out/sd2/new.txt"), "not on the store\n");
    seed(a, ["sd2", "--from", "pool/sd2-again"]);
    assert.equal(`${rc} ${yes(st("pool/sd2-again/out/seed.txt"))}`, "1 yes", out);
  });
  after(() => { a.setup(["lease", "release", "sd2"]); });
});

// Refused, nothing moved: another machine leases it (its empty copy there is marked current), a
// stamp with data but only empty folders on the store (with the lease here too), files here under
// the lease, a --from that isn't a folder of the store's own.
describe("seed refused", () => {
  const sd3moved = () => yes(st("pool/sd3/out/seed.txt"));
  test("leased by another machine: refused", () => {
    b.setup(["lease", "take", "sd3"]);
    seed(a, ["sd3", "--from", "pool/sd3"]);
    b.setup(["lease", "release", "sd3"]);
    assert.equal(`${rc} ${sd3moved()}`, "1 yes", out);
  });
  test("  and says where to run it", () => { has(out, "leased by b"); });
  test("a stamp with data and no files on the store: refused", () => {
    fs.mkdirSync(st("groups/sd3/out"), { recursive: true });
    write(st("stamps/sd3.json"), '{"unit":"sd3/x","commit":"c","host":"a","at":"2026-10-14T00:00:00Z","bytes":5}\n');
    seed(b, ["sd3", "--from", "pool/sd3"]);
    assert.equal(`${rc} ${sd3moved()}`, "1 yes", out);
  });
  test("  also with the lease here and nothing here", () => {
    a.setup(["lease", "take", "sd3"]);
    seed(a, ["sd3", "--from", "pool/sd3"]);
    assert.equal(`${rc} ${sd3moved()} ${yesNo(A("work/.store/groups/sd3.json"))}`, "1 yes no", out);
  });
  test("files here under the lease: refused", () => {
    fs.rmSync(st("stamps/sd3.json")); fs.rmSync(st("groups/sd3"), { recursive: true });
    write(A("work/out/sd3/x.txt"), "mine\n");
    seed(a, ["sd3", "--from", "pool/sd3"]);
    fs.rmSync(A("work/out/sd3"), { recursive: true }); a.setup(["lease", "release", "sd3"]);
    assert.equal(`${rc} ${sd3moved()}`, "1 yes", out);
  });
  for (const x of ["../pool/sd3", "/pool/sd3", ".", "groups/sd1", "inputs/rip", "-rf"]) {
    test(`--from ${x}: refused`, () => { seed(b, ["sd3", "--from", x]); assert.equal(rc, 2, out); });
  }
  test("--from a folder not on the store: refused", () => { seed(b, ["sd3", "--from", "pool/nothing"]); assert.equal(rc, 1, out); });
  test("  no stamp from any of those, nothing moved", () => {
    assert.ok(!fs.existsSync(st("stamps/sd3.json")), "stamped");
    assert.equal(sd3moved(), "yes");
  });
});

describe("a seed cut short, run again", () => {
  // Cut short after the move (the stamp couldn't be written): run again, it's stamped.
  test("the stamp not written after the move: failed", () => {
    fs.chmodSync(st("stamps"), 0o555);
    try { seed(b, ["sd4", "--from", "pool/sd4"]); } finally { fs.chmodSync(st("stamps"), 0o755); }
    assert.equal(`${rc} ${cat(st("groups/sd4/out/seed.txt"))}`, "2 pool sd4", out);
  });
  test("  run again: stamped", () => { seed(b, ["sd4", "--from", "pool/sd4"]); assert.equal(`${rc} ${stamp("sd4")}`, "0 sd4/seed", out); });
  test("  and says why", () => { has(out, "a seed cut short?"); });
  // A copy down cut short leaves the copy here empty; run again, it's copied down.
  test("the copy down failing after the move: failed", () => {
    a.setup(["lease", "take", "sd5"]);
    fs.chmodSync(st("pool/sd5/mod/m.txt"), 0o000);
    try { seed(a, ["sd5", "--from", "pool/sd5"]); } finally { fs.chmodSync(fs.existsSync(st("groups/sd5/mod/m.txt")) ? st("groups/sd5/mod/m.txt") : st("pool/sd5/mod/m.txt"), 0o644); }
    assert.equal(`${rc} ${stamp("sd5")}`, "2 sd5/seed", out);
  });
  test("  the copy here left without it, and unstamped", () => {
    assert.ok(!fs.existsSync(A("mods/m-sd5/m.txt")), "copied down");
    assert.ok(!fs.existsSync(A("work/.store/groups/sd5.json")), "stamped here");
  });
  test("  run again: copied down", () => {
    seed(a, ["sd5", "--from", "pool/sd5"]);
    assert.equal(`${rc} ${cat(A("work/out/sd5/seed.txt"))}|${cat(A("mods/m-sd5/m.txt"))}`, "0 pool sd5|pool mod sd5", out);
  });
  test("    and stamped current here", () => { assert.equal(cat(A("work/.store/groups/sd5.json")), cat(st("stamps/sd5.json"))); });
  // A move cut short partway (one path moved, the next not): run again, the rest is moved and it's stamped.
  test("a move cut short partway: failed", () => {
    a.setup(["lease", "release", "sd5"]);
    fs.chmodSync(st("pool/sd7/mod"), 0o555);   // a folder moved to another parent needs its own write permission
    try { seed(b, ["sd7", "--from", "pool/sd7"]); } finally { fs.chmodSync(st("pool/sd7/mod"), 0o755); }
    assert.equal(`${rc} ${cat(st("groups/sd7/out/seed.txt"))} ${yesNo(st("stamps/sd7.json"))}`, "2 pool sd7 no", out);
  });
  test("  run again: the rest moved, and stamped", () => {
    seed(b, ["sd7", "--from", "pool/sd7"]);
    assert.equal(`${rc} ${cat(st("groups/sd7/mod/m.txt"))} ${stamp("sd7")}`, "0 pool mod sd7 sd7/seed", out);
  });
});

describe("seed: empty pools, links, ssh", () => {
  test("a pool with only empty folders: refused, no stamp", () => {
    fs.mkdirSync(st("pool/sd8/out"), { recursive: true }); fs.mkdirSync(st("pool/sd8/mod"), { recursive: true });
    seed(b, ["sd8", "--from", "pool/sd8"]);
    assert.equal(`${rc} ${yesNo(st("stamps/sd8.json"))}`, "1 no", out);
  });
  // A data path that's a link: the copy down goes through it, as copy_down's does.
  test("a data path that's a link: copied down through it", () => {
    a.setup(["lease", "take", "sd9"]);
    const elsewhere = f.w.at("elsewhere-sd9");
    fs.mkdirSync(A("mods"), { recursive: true }); fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, A("mods/m-sd9"));
    seed(a, ["sd9", "--from", "pool/sd9"]);
    a.setup(["lease", "release", "sd9"]);
    assert.equal(`${rc} ${cat(path.join(elsewhere, "m.txt"))} ${fs.lstatSync(A("mods/m-sd9")).isSymbolicLink() ? "link" : ""}`, "0 pool mod sd9 link", out);
  });
  // A file in the pool that's a link: its size is what it points to, as du -sbL's (a store whose
  // du has no -b, a Mac's, counts it by stat).
  test("a file that's a link: the stamp's size counts what it points to", () => {
    pool("sd10");
    write(f.w.at("big-sd10"), "x".repeat(5000));
    fs.symlinkSync(f.w.at("big-sd10"), st("pool/sd10/out/big.bin"));
    seed(b, ["sd10", "--from", "pool/sd10"]);
    assert.equal(`${rc} ${JSON.parse(readOr(st("stamps/sd10.json")) || "{}").bytes}`, `0 ${"pool sd10\n".length + "pool mod sd10\n".length + 5000}`, out);
  });
  // Over ssh (a host:path remote): the move runs as one script there. A fake ssh runs it locally.
  test("seed over ssh, a --from with a space and a quote: moved, stamped and copied down", () => {
    fs.writeFileSync(f.w.at("bin/fakessh"), '#!/usr/bin/env bash\nwhile [ "${1#-}" != "$1" ]; do [ "$1" = -o ] && shift; shift; done\nshift; cd && exec sh -c "$*"\n', { mode: 0o755 });
    b.setup(["lease", "take", "sd6"]);
    seed(b, ["sd6", "--from", "pool/s d'6"], { HOME: f.w.top, RSYNC_RSH: "fakessh", FACTORY_STORE: "localhost:store" });
    assert.equal(`${rc} ${cat(B("work/out/sd6/seed.txt"))}|${JSON.parse(readOr(st("stamps/sd6.json")) || "{}").from}`, "0 pool s d'6|pool/s d'6", out);
  });
  test("  stamped current there", () => { assert.equal(cat(B("work/.store/groups/sd6.json")), cat(st("stamps/sd6.json"))); });
  after(() => { b.setup(["lease", "release", "sd6"]); });
});

f.notBroken();
