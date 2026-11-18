// A lane's records outlive its clone: fleet start --lanes 3 runs a session in each lane; the stop's
// tidy and a start with one lane remove lanes 2 and 3 (past the machines file's count), and the
// scorecard still counts all three lanes' sessions, from the run index and events the removal
// moved to the checkout's runs/removed-clones/ (fleet-scripts.ts, DROP_CLONE). A factory whose
// card knew of fewer sessions than the tracker's log had claims, its smaller lanes showing nothing
// before the day they were last made, is why.
// Run: node --test test/loop/fleet/
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { has, until } from "../../lib/index.ts";
import { fleetFactory } from "./helpers.ts";

const f = fleetFactory("frecords");
const { F, w, fleet, setup, hold, lane } = f;
const out = (args: string[]) => fleet(args).stdout;
const units = ["g/r1", "g/r2", "g/r3"];
const holds = units.map((u) => hold(u));

describe("a lane's records outlive its clone", () => {
  let tidied = "";
  test("fleet start --lanes 3: a session in each lane", async () => {
    for (const u of units) setup(["add-unit", u, "--title", `Unit ${u.slice(2)}`]);
    has(out(["start", "--lanes", "3", "--hours", "0.1", "--no-awake"]), "lane 3");
    for (const h of holds) await h.held();
    for (const h of holds) h.go();
    await until(() => {
      w.git(F, "fetch", "-q", "origin");
      const l = w.git(F, "log", "--format=%s", "origin/main");
      return units.every((u) => l.includes(`(${u}): merged`));
    }, "the three units landed", 180);
    for (const n of [1, 2, 3]) await until(() => fs.existsSync(path.join(lane(n), "runs/index.tsv")) && fs.readFileSync(path.join(lane(n), "runs/index.tsv"), "utf8").split("\n").length > 2, `lane ${n}'s session is in its run index`, 60);
    tidied = out(["stop"]) + out(["start", "--lanes", "1", "--hours", "0.02", "--no-awake"]);
    out(["stop"]);
  });
  test("  restarting with one lane removes lanes 2 and 3", () => {
    has(tidied, `removed ${lane(2)}: an orphaned lane clone`);
    has(tidied, `removed ${lane(3)}: an orphaned lane clone`);
    assert.ok(!fs.existsSync(lane(2)) && !fs.existsSync(lane(3)));
  });
  test("  their run index and events are kept in the checkout", () => {
    const kept = fs.readdirSync(path.join(F, "runs/removed-clones")).sort();
    assert.deepEqual(kept.map((d) => d.replace(/-[0-9]{8}-[0-9]{6}$/, "")), [path.basename(lane(2)), path.basename(lane(3))]);
    for (const d of kept) has(fs.readFileSync(path.join(F, "runs/removed-clones", d, "index.tsv"), "utf8"), "Unit r");
  });
  test("  and the scorecard still counts all three lanes' sessions", () => {
    const r = w.just(["scorecard", "--json"], F);
    assert.equal(r.code, 0, r.stdout);
    const j = JSON.parse(r.stdout);
    assert.deepEqual(j.lanes.filter((l: string) => l !== "checkout"), ["lane1", "lane2", "lane3"]);
    assert.equal(j.figures["sessions.count"], 3);
    assert.equal(j.figures["sessions.finished.count"], 3);
    assert.equal(j.figures["sessions.unrecorded.count"], 0);
  });
});
