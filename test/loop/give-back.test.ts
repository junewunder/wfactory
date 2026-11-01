// Near the stop, a lane doesn't claim and give back the same unit every few seconds (#141): a
// unit its session gave back unstarted isn't offered to that lane again this run, and a unit whose
// usual session won't fit in the time left isn't started; with nothing that fits, the lane stops.
// The loop runs in this process (inproc.ts). Run: node --test test/loop/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { ago, has, hasnt } from "../lib/index.ts";
import { loopFactory } from "./factory.ts";

const f = loopFactory("giveback");
const { a, setup, state, claude, loop, events } = f;
// A session that reads the stop time, sees its unit won't fit, and gives it back unstarted.
const GIVE_BACK = `#!/usr/bin/env bash
card=""; while [ $# -gt 0 ]; do case $1 in --append-system-prompt-file) card=$(cat "$2") ;; --append-system-prompt) card=$2 ;; esac; shift; done
id=$(grep -oE '^Next: .*\\(([a-z0-9-]+/[a-z0-9.-]+)\\)' <<<"$card" | head -1 | sed -E 's/.*\\(([^)]*)\\)$/\\1/')
echo '{"type":"system","subtype":"init"}'
factory/tracker unclaim "$id" >/dev/null
echo '{"type":"result","is_error":false,"result":"gave '"$id"' back unstarted","num_turns":1,"total_cost_usd":0.01}'
`;
const iterations = (out: string, title: string) => out.split("\n").filter((l) => new RegExp(`iteration [0-9]*: ${title}`).test(l)).length;

describe("a unit its session gave back unstarted isn't offered to the lane again this run", () => {
  let out = "";
  test("the session gives it back unstarted: one claim, then the lane stops", async () => {
    claude(GIVE_BACK);
    setup("add-unit", "g/back", "--title", "Given back");
    out = (await loop(["--max", "4", "--hours", "1"]).end()).out;
    claude();
    assert.equal(iterations(out, "Given back"), 1, out);
  });
  test("  the log says why it isn't taken again", () => {
    has(out, "Given back (g/back) was given back unstarted: this lane doesn't take it again this run");
    has(out, "1 unit this lane's sessions gave back unstarted this run");
  });
  test("  a new run offers it again", async () => {
    const o = (await loop(["--max", "1", "--hours", "1"]).end()).out;
    assert.equal(iterations(o, "Given back"), 1, o);
  });
});

describe("a unit whose usual session won't fit in the time left isn't started", () => {
  let out = "";
  test("a two-hour desk unit, with an hour left: the lane stops without a session", async () => {
    setup("add-unit", "g/past", "--title", "Past desk unit", "--uses", "desk");
    setup("add-unit", "g/long", "--title", "Long desk unit", "--uses", "desk");
    setup("drop", "g/past", "--why", "test");
    // Its kind's past session: two hours, on the desk (in the log on origin's main, where the
    // tracker's state is).
    const st = a.at(".tracker/main");
    a.run("git", ["-C", st, "pull", "-q", "--ff-only", "origin", "main"]);
    fs.appendFileSync(`${st}/tracker/log.jsonl`, [
      { at: ago(3), actor: "loop", tag: "z1", host: "a", cmd: "claim", id: "g/past", text: "Past desk unit: claimed" },
      { at: ago(1), actor: "loop", tag: "z1", host: "a", cmd: "note", id: "g/past", text: "Past desk unit: note: took two hours" },
    ].map((x) => JSON.stringify(x) + "\n").join(""));
    a.run("git", ["-C", st, "commit", "-qam", "a two-hour desk session"]);
    const p = a.run("git", ["-C", st, "push", "-q", "origin", "HEAD:main"]);
    assert.equal(p.code, 0, p.stdout + p.stderr);
    out = (await loop(["--max", "2", "--hours", "1"]).end()).out;
    assert.equal(iterations(out, "Long desk unit"), 0, out);
  });
  test("  the stop says nothing fits, and why", () => {
    has(out, "nothing fits before the stop at");
    has(out, "1 unit whose usual session (120 min) won't fit in the");
    has(events(), "lane-stop\tnothing fits before the stop");
  });
  test("  with other work still moving (a unit in progress elsewhere), the lane waits instead", async () => {
    setup("add-unit", "g/busy", "--title", "Busy unit");
    a.setup(["claim", "g/busy"], { FACTORY_TAG: "o9", FACTORY_HOST: "b" });
    const r = loop(["--hours", "1"]);
    await r.until("loop: waiting: nothing workable");
    await r.at(3601);
    const o = (await r.end()).out;
    a.setup(["drop", "g/busy", "--why", "test"]);
    hasnt(o, "nothing fits");
    has(o, "1 unit whose usual session (120 min) won't fit in the");
    has(o, "out of time");
  });
  test("  with time for it, it's started", async () => {
    const o = (await loop(["--max", "1", "--hours", "3"]).end()).out;
    hasnt(o, "nothing fits");
    assert.equal(iterations(o, "Long desk unit"), 1, o);
  });
});
