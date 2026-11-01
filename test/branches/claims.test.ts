// Lanes on four laptops racing to claim: exactly one wins a unit, and four units go one to each.
// Each lane is a clone of a local bare origin with its own locks and host, so they meet only on
// origin; the claims are real `factory/tracker next --claim` processes started together.
// Run: node --test test/branches/
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { start } from "../lib/index.ts";
import { branchFactory } from "./factory.ts";

const { lanes, add, drop } = branchFactory(["a", "b", "c", "d"]);

// Every lane claims at once; the IDs the winners got, sorted.
async function race(tag: string) {
  const rs = await Promise.all(lanes.map((l) => start("factory/tracker", ["next", "--claim", "--json"], { cwd: l.dir, env: l.envWith({ FACTORY_TAG: `${l.n}${tag}` }) })));
  const won = rs.flatMap((r) => r.stdout.split("\n").filter((x) => x.trim()).map((x) => JSON.parse(x))).filter((j) => j.code === 0).map((j) => j.id).sort();
  return { won, out: rs.map((r) => r.stdout).join("") };
}

describe("claims race", () => {
  for (const round of [1, 2, 3]) {
    test(`four lanes race for one unit: exactly one wins (round ${round})`, async () => {
      add(`solo${round}`);
      const { won, out } = await race(String(round));
      drop(`g/solo${round}`);
      assert.deepEqual(won, [`g/solo${round}`], out);
    });
  }
  test("four lanes race for four units: each gets a different one", async () => {
    for (const x of ["p", "q", "r", "s"]) add(x);
    const { won, out } = await race("x");
    for (const x of ["p", "q", "r", "s"]) drop(`g/${x}`);
    assert.deepEqual(won, ["g/p", "g/q", "g/r", "g/s"], out);
  });
});
