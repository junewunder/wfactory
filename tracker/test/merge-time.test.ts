// How long a unit's session usually takes, when sessions were cut off, and for a lane's merge unit
// (a lane's merge, filed 17 minutes before the stop, was claimed seven times in 18 minutes: each
// session cut off after a minute or two dragged its estimate down, and with nothing to go by it
// had none). A session cut off (the loop's settle) doesn't count: how long it ran says only that
// the unit takes longer. A merge unit goes by the other merge units' sessions, and with none, needs
// the project's min_unit_minutes (default 45): it always runs the project's check.
// Run: node --test tracker/test/
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { trackerRepo, ago, has } from "../../test/lib/index.ts";

const f = trackerRepo("repo", { FACTORY_TAG: "s1", FACTORY_EVIDENCE_MIN: "0" });
const { t, setup } = f;
setup(["init", "--title", "Merge time"]);
const logLine = (x: Record<string, unknown>) => fs.appendFileSync(f.at("tracker/log.jsonl"), JSON.stringify({ actor: "loop", host: "testhost", ...x }) + "\n");
const next = (args: string[]) => JSON.parse(t(["next", "--json", ...args]).stdout);
// A session of id from h0 to h1 hours ago, ending in a note, or cut off (the loop's settle).
const session = (tag: string, id: string, h0: number, h1: number, cut = false) => {
  logLine({ at: ago(h0), tag, cmd: "claim", id, text: `${id}: claimed` });
  logLine({ at: ago(h1), tag, cmd: cut ? "settle" : "note", id, text: cut ? `${id}: session ended mid-unit` : `${id}: note: worked` });
};

describe("a session cut off doesn't count toward a unit's usual session", () => {
  test("setup: one finished hour-long session, then three cut off after 2 minutes", () => {
    setup(["add-group", "g", "--title", "Group"]);
    setup(["add-unit", "g/x", "--title", "Hour unit"]);
    session("a1", "g/x", 10, 9);
    for (const [i, h] of [[2, 6], [3, 5], [4, 4]]) session(`a${i}`, "g/x", h, h - 2 / 60, true);
  });
  test("  with 30 min left, it's passed over: its usual session is the hour, not 2 minutes", () => {
    const j = next(["--time-left", "1800"]);
    assert.equal(j.code, 1, JSON.stringify(j));
    assert.equal(j.late, 1);
    has(j.why, "usual session (60 min)");
  });
});

describe("a lane's merge unit", () => {
  test("setup: a merge unit with no sessions, and nothing else", () => {
    setup(["drop", "g/x", "--why", "test"]);
    setup(["add-group", "merge", "--title", "Merges the loop couldn't do by itself", "--priority", "1000"]);
    setup(["add-unit", "merge/one", "--title", "Merge main on testhost lane 1", "--check", "recorded"]);
  });
  test("  with nothing to go by, needs min_unit_minutes (45 by default): not taken with 17 min left", () => {
    const j = next(["--group", "merge", "--time-left", String(17 * 60)]);
    assert.equal(j.code, 1, JSON.stringify(j));
    assert.equal(j.late, 1);
    has(j.why, "usual session (45 min) won't fit in the 17 min left");
  });
  test("  taken with an hour left", () => {
    assert.equal(next(["--group", "merge", "--time-left", "3600"]).id, "merge/one");
  });
  test("  sessions of it cut off at a minute or two don't make it look quick", () => {
    for (const [i, h] of [[1, 3], [2, 2.9], [3, 2.8]]) session(`m${i}`, "merge/one", h, h - 2 / 60, true);
    const j = next(["--group", "merge", "--time-left", String(17 * 60)]);
    assert.equal(j.late, 1, JSON.stringify(j));
    has(j.why, "usual session (45 min)");
  });
  test("  it goes by the other merge units' finished sessions", () => {
    setup(["add-unit", "merge/old", "--title", "Merge main on testhost lane 2", "--check", "recorded"]);
    session("o1", "merge/old", 20, 19.5);
    setup(["drop", "merge/old", "--why", "test"]);
    has(next(["--group", "merge", "--time-left", String(17 * 60)]).why, "usual session (30 min)");
    assert.equal(next(["--group", "merge", "--time-left", String(31 * 60)]).id, "merge/one");
  });
  test("  project.json min_unit_minutes sets its default", () => {
    // (Its own sessions and the other merge unit's taken out of the log.)
    const lines = f.read("tracker/log.jsonl").split("\n").filter((l) => l && !/"tag":"(m[0-9]|o1)"/.test(l));
    fs.writeFileSync(f.at("tracker/log.jsonl"), lines.map((l) => l + "\n").join(""));
    f.edit("tracker/project.json", (p) => { p.min_unit_minutes = 10; });
    assert.equal(next(["--group", "merge", "--time-left", String(17 * 60)]).id, "merge/one");
  });
});
