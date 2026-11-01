// A session that does some work and hands its unit back (`tracker unclaim`): the loop pushes its
// branch as for any unfinished unit, and its settle after the session leaves the unit as the
// session handed it back (ready here), not interrupted. The loop is the real factory/loop.sh, in
// the file's lane. Run: node --test test/loop/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { has, hasnt } from "../../lib/index.ts";
import { laneFactory } from "./helpers.ts";

const f = laneFactory("lane-handback");
const { a, setup, state, claude, onBranch } = f;
// Works a second past its claim (times are to the second), commits, and hands the unit back.
const HANDBACK = `#!/usr/bin/env bash
card=""; while [ $# -gt 0 ]; do [ "$1" = --append-system-prompt-file ] && card=$(cat "$2"); shift; done
id=$(grep -oE '^Next: .*\\(([a-z0-9-]+/[a-z0-9.-]+)\\)' <<<"$card" | head -1 | sed -E 's/.*\\(([^)]*)\\)$/\\1/')
sleep 1.1
mkdir -p out; echo "half the work on $id" > out/handback.txt
git add out/handback.txt && git commit -qm "$id: half" -- out/handback.txt >/dev/null 2>&1
factory/tracker unclaim "$id" > "$FACTORY_LOCKS/unclaim.seen" 2>&1
echo '{"type":"result","is_error":false,"result":"handed it back","num_turns":1,"total_cost_usd":0.01}'
`;

describe("a session hands its unit back after work: the loop keeps it so", () => {
  let out = "";
  test("the loop runs the session", () => {
    setup("add-unit", "g/hb", "--title", "Handed back unit");
    claude(HANDBACK);
    out = f.loopSh(["--hours", "0.05", "--max", "1", "--no-wait"]).stdout;
    claude();
    has(f.seen("unclaim.seen"), "handed back, its work kept (1 commit on its branch): ready");
  });
  test("  its branch is pushed for the next session", () => { assert.equal(onBranch("unit/g/hb", "out/handback.txt"), "half the work on g/hb"); });
  test("  the loop's settle leaves it ready, not interrupted", () => {
    assert.equal(state("g/hb"), "ready");
    hasnt(out, "it shows as interrupted");
  });
  test("  the log says it was handed back, and never that it ended mid-unit", () => {
    const log = a.run("factory/tracker", ["log", "g/hb"]).stdout;
    has(log, "handed back by its session, its work kept");
    hasnt(log, "session ended mid-unit");
  });
  test("  the next session is told what was left, and to carry on from it", () => {
    const card = a.run("factory/tracker", ["show", "g/hb"]).stdout;
    has(card, "Its work so far: branch unit/g/hb (the loop checks it out for you)");
    hasnt(card, "claude --resume");
    setup("drop", "g/hb", "--why", "test");
  });
});
