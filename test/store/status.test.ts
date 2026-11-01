// store.sh status (each group here, its size, whether it's current, worked on, unmerged, leased
// here), leave and leave --now (stop now) with copies back done or still owed, and the loop when it
// can't copy a unit's data down (store-down). Run: node --test test/store/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import { has, hasnt } from "../lib/index.ts";
import { storeFactory, NOPE } from "./factory.ts";

const f = storeFactory(["a"]);
const { add, store, stamp, leases, state, write, group } = f;
const [a] = f.lanes;
const ok = (args: string[], env: NodeJS.ProcessEnv = {}) => { const r = store(a, args, env); assert.equal(r.code, 0, `store.sh ${args.join(" ")}: ${r.stderr}`); return r; };
const G = (x: string) => a.at(`work/.store/groups/${x}`);
const status = (env: NodeJS.ProcessEnv = {}) => store(a, ["status"], env).stdout;

describe("status: each group here, its size, whether it's current, worked on, unmerged, leased here", () => {
  test("status: a current copy leased here, with its size", () => {
    group("s1");
    a.setup(["lease", "take", "s1"]);
    write(a.at("work/out/s1/big.bin"), crypto.randomBytes(2200000));
    ok(["up", "s1", "s1/seed", "x"]);
    has(status(), "s1\t2 MB\tcurrent, leased here");
  });
  test("  worked on, with a unit's outputs not on main", () => {
    ok(["dirty", "s1", "s1/w", String(process.pid)]); write(G("s1.unmerged.s1+u"), "s1/u\tc\n");
    has(status(), "s1\t2 MB\tcurrent, worked on since its last copy back (unmerged: s1/u), leased here");
  });
  test("  the store out of reach: not current", () => {
    fs.rmSync(G("s1.unmerged.s1+u"));
    has(status({ FACTORY_STORE: NOPE }), "s1\t2 MB\tnot current, worked on since its last copy back, leased here");
  });
  test("  not leased here", () => {
    a.setup(["lease", "release", "s1"]);
    has(status().split("\n").filter((l) => l.startsWith("s1\t")).join("\n"), "s1\t2 MB\tcurrent, worked on since its last copy back");
  });
  test("    (says so)", () => { hasnt(status(), "s1\t2 MB\tcurrent, worked on since its last copy back, leased here"); });
});

// leave --now ("stop now"): releases what's on the store already, cut-short sessions or not; keeps
// the lease of a copy back still owed. leave (no --now) tries that copy back first.
describe("leave --now and leave", () => {
  let r = { code: 0, stdout: "", stderr: "" };
  test("leave --now releases a lease whose last copy back is on the store, a session cut short or not", () => {
    a.setup(["lease", "take", "s1"]);
    r = store(a, ["leave", "--now"]);
    assert.equal(r.code, 0, r.stderr);
    hasnt(leases(), "s1=");
  });
  test("  and says so", () => { has(r.stderr, "s1: lease released (the lanes on a stopped)"); });
  test("  the cut-short session's mark stays", () => { assert.ok(fs.existsSync(G("s1.dirty.a-lane1"))); });
  // A unit done, its copy back failing (the store out of reach): store-up, then the lanes stopping keep the lease.
  test("a copy back that fails at the end of a unit: exit 2", () => {
    fs.rmSync(G("s1.dirty.a-lane1"));
    a.setup(["lease", "take", "s1"]);
    add("s1/d1"); a.setup(["done", "s1/d1", "--evidence", "test"]);
    write(a.at("work/out/s1/d1.txt"), "d1's work\n");
    assert.equal(store(a, ["end", "s1", "s1/d1", "c"], { FACTORY_STORE: NOPE }).code, 2);
  });
  test("  the event says so", () => { has(a.events(), "store-up\tcouldn't copy s1's data back from a after s1/d1; it's kept here"); });
  test("  leave --now keeps the lease of a copy back still owed", () => {
    ok(["leave", "--now"], { FACTORY_STORE: NOPE });
    has(leases(), "s1=a");
  });
  test("    and says so", () => { has(a.events(), "lease-kept\ts1's data on a isn't all on the store; its lease stays"); });
  test("  leave tries the copy back, and keeps the lease when it fails", () => {
    ok(["leave"], { FACTORY_STORE: NOPE });
    has(leases(), "s1=a");
  });
  test("    and says so", () => { has(a.events(), "lease-kept\ts1's data on a couldn't be copied back as the lanes stopped"); });
  test("  with the store back, leave copies back", () => {
    ok(["leave"]);
    assert.equal(stamp("s1"), "s1/d1");
  });
  test("    and releases the lease", () => { hasnt(leases(), "s1="); });
});

describe("store-down: the loop can't copy a unit's data down; it gives the unit back and waits", () => {
  test("a copy down that fails in the loop raises store-down", () => {
    group("s2");
    add("s2/w1", "--reads", "none"); a.setup(["edit", "s2/w1", "--priority", "100"]);
    a.loop(["--max", "1", "--hours", "0.004"], { FACTORY_STORE: NOPE });
    has(a.events(), "store-down\tcouldn't copy s2's data down to a for Unit w1 of s2 (s2/w1)");
  });
  test("  the unit is given back", () => { assert.equal(state("s2/w1"), "ready"); });
  after(() => { f.drop("s2/w1"); a.run("factory/tracker", ["lease", "release", "s2"]); });
});

f.notBroken();
