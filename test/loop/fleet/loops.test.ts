// --loop <name>: a project with several loops runs each lane's as its own service. The lane
// starts stopped mid-unit (oversee.sh stop), so its clone is still on that unit's branch, cut
// before the loop was added: the start still finds the loop (#23).
// Run: node --test test/loop/fleet/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { has, readOr, until, HOST, active } from "../../lib/index.ts";
import { fleetFactory } from "./helpers.ts";

const f = fleetFactory("floops");
const { F, P, w, fleet, oversee, setup, hold, lane, locks } = f;
const LANE = `factory-${P}-lane1`, L1 = lane(1);
const L = (args: string[]) => oversee(args);

describe("--loop <name>: a project with several loops runs each lane's as its own service", () => {
  test("fleet --loop: a lane stopped mid-unit is still on its unit's branch", async () => {
    const fr = hold("g/fr");
    setup(["add-unit", "g/fr", "--title", "Unit fr"]);
    fleet(["start", "--hours", "0.05", "--no-awake"]);
    await fr.held();
    L(["stop"]);
    setup(["drop", "g/fr", "--why", "test"]);
    // The project gets a loop, on origin's main.
    w.git(F, "fetch", "-q", "origin"); w.git(F, "checkout", "-q", "-B", "main", "origin/main");
    const pj = path.join(F, "tracker/project.json");
    fs.writeFileSync(pj, JSON.stringify({ ...JSON.parse(readOr(pj)), loops: { lp: { title: "Loop lp", spec: "docs/factory.md", groups: ["g"] } } }, null, 2) + "\n");
    w.git(F, "commit", "-qam", "a loop"); w.git(F, "push", "-q", "origin", "HEAD:main");
    assert.equal(w.git(L1, "rev-parse", "--abbrev-ref", "HEAD"), "unit/g/fr");
  });
  const fs_ = hold("g/fs");
  test("fleet --loop: start", async () => {
    setup(["add-unit", "g/fs", "--title", "Unit fs"]);
    has(fleet(["--loop", "lp", "start", "--hours", "0.05", "--no-awake"]).stdout, `=== ${HOST} lane 1`);
    await fs_.held();
  });
  test("  the lane runs as that loop's service", () => { assert.ok(active(`${LANE}-lp.service`)); });
  test("  the loop's sessions are told which loop", () => { has(readOr(path.join(locks, "card.seen")), "You are working the 'lp' loop"); });
  test("fleet --loop: beat counts that loop's lanes", () => { has(fleet(["--loop", "lp", "beat"]).stdout, "1 busy, 0 waiting, 0 stopped"); });
  test("  and without it, the unnamed one's", () => { has(fleet(["beat"]).stdout, "0 busy, 0 waiting, 1 stopped"); });
  test("fleet --loop: state", () => { has(fleet(["--loop", "lp", "state"]).stdout, `running: ${LANE}-lp`); });
  test("oversee.sh <loop> state", () => { has(L(["state", "lp"]).stdout, `running: ${LANE}-lp`); });
  test("  without the name, the unnamed one", () => { has(L(["state"]).stdout, `not running: ${LANE} (last result:`); });
  test("oversee.sh wait <loop> --minutes 0: exit 10", () => { assert.equal(L(["wait", "lp", "--minutes", "0"]).code, 10); });
  test("fleet --loop: pause-now", () => { has(fleet(["--loop", "lp", "pause-now"]).stdout, `ended ${LANE}-lp's running session`); });
  test("  that loop's lane stops", async () => { await until(() => !active(`${LANE}-lp.service`), "that loop's lane stops", 60); });
});
