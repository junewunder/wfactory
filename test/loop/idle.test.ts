// Two iterations in a row that record nothing and commit nothing: the lane stops instead of
// spinning. The loop runs in this process (inproc.ts). Run: node --test test/loop/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { has } from "../lib/index.ts";
import { loopFactory } from "./factory.ts";

const f = loopFactory("idle");
const { setup, claude, loop, events } = f;
// A session that looks around and records nothing.
const IDLE = `#!/usr/bin/env bash
echo '{"type":"system","subtype":"init"}'
echo '{"type":"result","is_error":false,"result":"looked around","num_turns":1,"total_cost_usd":0.01}'
`;

describe("two iterations in a row that record nothing and commit nothing: the lane stops", () => {
  let out = "";
  test("two iterations that record nothing: the lane stops instead of spinning", async () => {
    claude(IDLE);
    setup("add-unit", "g/idle", "--title", "Idle unit");
    out = (await loop(["--max", "5", "--hours", "0.05"]).end()).out;
    claude(); setup("drop", "g/idle", "--why", "test");
    has(out, "two iterations recorded nothing; stopping instead of spinning");
  });
  test("  after the second", () => { assert.equal(out.split("\n").filter((l) => /iteration [0-9]*: Idle unit/.test(l)).length, 2); });
  test("  as the lane's stop reason", () => { has(events(), "lane-stop\ttwo iterations recorded nothing"); });
});
