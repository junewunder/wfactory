// What a session leaves that reaches the overseer as an event at once: a new question, a unit left
// stuck (with the reason), and a landed unit the tracker won't record as merged. The loop is the
// real factory/loop.sh, in the file's lane. Run: node --test test/loop/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { has } from "../../lib/index.ts";
import { laneFactory } from "./helpers.ts";
import { refusingTracker } from "../factory.ts";

const f = laneFactory("lane-events");
const { w, setup, state, claude, events } = f;
// A session that does one thing to its unit with `just`, and ends.
const session = (what: string) => `#!/usr/bin/env bash
card=""; while [ $# -gt 0 ]; do [ "$1" = --append-system-prompt-file ] && card=$(cat "$2"); shift; done
id=$(grep -oE '^Next: .*\\(([a-z0-9-]+/[a-z0-9.-]+)\\)' <<<"$card" | head -1 | sed -E 's/.*\\(([^)]*)\\)$/\\1/')
${what} >/dev/null 2>&1
echo '{"type":"result","is_error":false,"result":"did it","num_turns":1,"total_cost_usd":0.01}'
`;

describe("a new question reaches the overseer as an event", () => {
  test("a new question becomes an event", () => {
    setup("add-unit", "g/asking", "--title", "Asking unit");
    claude(session(`just ask --title "Should the asking unit go left?" --context x --option "a|Left|x" --option "b|Right|y" --default a --blocks "$id"`));
    f.loopSh(["--hours", "0.05"]);
    claude();
    setup("drop", "g/asking", "--why", "test");
    has(events(), "question\tShould the asking unit go left?");
  });
});

describe("a session that leaves its unit stuck: the overseer hears now, with the reason", () => {
  test("a unit a session leaves stuck becomes a stuck event, with its reason", () => {
    setup("add-unit", "g/refused", "--title", "Refused unit");
    claude(session(`just block "$id" --why "the permission to write the mod folder was refused"`));
    f.loopSh(["--hours", "0.05", "--max", "1", "--no-wait"]);
    claude();
    setup("drop", "g/refused", "--why", "test");
    has(events(), "stuck\tRefused unit (g/refused): stuck: the permission to write the mod folder was refused");
  });
});

describe("a landed unit the tracker won't record as merged (tried five times): the overseer hears", () => {
  test("a branch on main the tracker won't record as merged: a stuck-merging event", () => {
    setup("add-unit", "g/sm", "--title", "Unit sm");
    f.loopSh(["--max", "1", "--no-wait", "--hours", "0.05"], { FACTORY_TRACKER: refusingTracker(w.at("tracker-nomerged.mjs"), "merged"), FACTORY_RETRY_WAIT: "0" });
    has(events(), "stuck-merging\tUnit sm (g/sm) is on main but the tracker still says merging: `just tracker merged --branch unit/g/sm`");
  });
  test("  it still says merging", () => { assert.equal(state("g/sm"), "merging"); });
});
