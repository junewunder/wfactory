// Leases on a group's data: the store's folders made, four laptops racing for one group, units that
// need no lease, a stale lease taken over, lanes preferring groups their laptop leases at equal priority, and a
// probe on group data run only where the group is leased. Run: node --test test/store/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { start, has } from "../lib/index.ts";
import { storeFactory } from "./factory.ts";

const f = storeFactory(["a", "b", "c", "d"]);
const { lanes, add, drop, tr, leases } = f;
const [a, b] = lanes;

test("store.sh init makes the store's stamps/ folder", () => { assert.ok(f.initMadeStamps); });

describe("a lease race: two laptops want the same group; one gets it, the other takes nothing of it", () => {
  add("f1/r1"); add("f1/r2");
  for (const round of [1, 2, 3]) {
    let claims: { n: string; id: string; tag: string }[] = [];
    test(`four laptops race for one group's units: one laptop gets the lease and only it claims them (round ${round})`, async () => {
      const rs = await Promise.all(lanes.map((l) => start("factory/tracker", ["next", "--claim", "--json"], { cwd: l.dir, env: l.envWith({ FACTORY_LEASES: "1", FACTORY_TAG: `${l.n}${round}` }) })));
      claims = rs.flatMap((r, i) => r.stdout.split("\n").filter((x) => x.trim()).map((x) => JSON.parse(x)).filter((j) => j.code === 0).map((j) => ({ n: lanes[i].n, id: j.id, tag: `${lanes[i].n}${round}` })));
      const winners = [...new Set(claims.map((c) => c.n))];
      assert.equal(winners.length, 1, `winners: ${winners.join(" ")}`);
      assert.equal(leases(), `f1=${winners[0]}`);
    });
    test(`  giving the claims back releases the lease (round ${round})`, () => {
      for (const c of claims) lanes.find((l) => l.n === c.n)!.ok(["unclaim", c.id], { FACTORY_TAG: c.tag });
      assert.equal(leases(), "");
    });
  }
  after(() => { drop("f1/r1"); drop("f1/r2"); });
});

describe("a code-only unit needs no lease; a group's unit can't be claimed by hand without the loop", () => {
  test("a code-only unit is claimed without a lease", () => {
    add("code/c1");
    has(tr(a, ["next", "--claim", "--json"]).stdout, '"id":"code/c1"');
  });
  test("  and takes none", () => { assert.equal(leases(), ""); });
  test("outside the loop, a group's unit isn't offered without its lease", () => {
    drop("code/c1");
    add("f2/h1");
    has(tr(a, ["next", "--json"]).stdout, "isn't leased here");
  });
  after(() => { drop("f2/h1"); });
});

// The bash suite waited 3 s with FACTORY_LEASE_STALE=2; here the lease is made an hour older on
// origin's main, past the default limit (30 minutes).
describe("a stale lease is taken over", () => {
  test("a fresh lease keeps the other laptop out", () => {
    a.setup(["lease", "take", "f2"]);
    add("f2/s1");
    has(tr(b, ["next", "--json"], { FACTORY_LEASES: "1" }).stdout, "leased by a");
  });
  test("a lease with no heartbeat past the limit is taken over", () => {
    f.anHourLater();
    has(tr(b, ["next", "--claim", "--json"], { FACTORY_LEASES: "1", FACTORY_TAG: "bs" }).stdout, '"id":"f2/s1"');
  });
  test("  the lease is the new laptop's", () => { assert.equal(leases(), "f2=b"); });
  test("  and the log says whose it was", () => { has(tr(a, ["log", "-n", "5"]).stdout, "taken over from a"); });
  after(() => { b.setup(["unclaim", "f2/s1"], { FACTORY_TAG: "bs" }); drop("f2/s1"); });
});

describe("at equal priority, lanes prefer groups their laptop already leases", () => {
  test("a lane prefers a group its laptop already leases over earlier groups", () => {
    add("f3/p1"); add("f3/p2"); add("f4/p1");
    a.setup(["lease", "take", "f4"], { FACTORY_LEASES: "1", FACTORY_TAG: "pp" });
    has(tr(a, ["next", "--json"], { FACTORY_LEASES: "1" }).stdout, '"id":"f4/p1"');
  });
  test("  but a unit of higher priority goes first wherever its data is", () => {
    a.setup(["edit", "f3/p2", "--priority", "1"]);
    has(tr(a, ["next", "--json"], { FACTORY_LEASES: "1" }).stdout, '"id":"f3/p2"');
  });
  after(() => { a.setup(["lease", "release", "f4"]); for (const x of ["f3/p1", "f3/p2", "f4/p1"]) drop(x); });
});

describe("refresh runs a probe on group data only where the group is leased", () => {
  test("refresh doesn't run a group-data probe on a machine without its lease", () => {
    add("f5/pr", "--check", "computed", "--probe-cmd", "true");
    assert.equal(tr(a, ["refresh", "--all"]).code, 0);
    assert.equal(f.state("f5/pr"), "ready");
  });
  test("  and runs it where the group is leased", () => {
    a.setup(["lease", "take", "f5"]);
    assert.equal(tr(a, ["refresh", "--all"]).code, 0);
    assert.equal(f.state("f5/pr"), "done");
  });
  after(() => { a.setup(["lease", "release", "f5"]); drop("f5/pr"); });
});

f.notBroken();
