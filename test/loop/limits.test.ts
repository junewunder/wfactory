// A usage limit: the session ends on one, the lane sleeps --limit-wait (30 minutes) and tries
// again, and the try doesn't count against --max. Only what the CLI itself reports counts, never
// the session's text. The loop runs in this process with its clock mocked (inproc.ts): the retry comes
// exactly 30 minutes after the limit. Run: node --test test/loop/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { has, hasnt } from "../lib/index.ts";
import { hmsAt, type Run } from "./inproc.ts";
import { loopFactory } from "./factory.ts";

const f = loopFactory("limits");
const { a, setup, state, claude, loop } = f;
const count = (out: string, s: string) => out.split("\n").filter((l) => l.includes(s)).length;

// The first session of each kind (FACTORY_FAKE_LIMIT) hits a limit; the next works the unit.
const LIMIT = `#!/usr/bin/env bash
k=\${FACTORY_FAKE_LIMIT:-result}
[ ! -e "$FACTORY_LOCKS/limit.$k" ] || exec claude-ok "$@"
touch "$FACTORY_LOCKS/limit.$k"
echo '{"type":"system","subtype":"init"}'
case $k in
  result) echo '{"type":"result","is_error":true,"result":"Claude AI usage limit reached|1760000000","num_turns":1}' ;;
  api) echo '{"type":"assistant","isApiErrorMessage":true,"message":{"content":[{"type":"text","text":"API Error: Request rejected (429)"}]}}'
       echo '{"type":"result","is_error":true,"result":"","num_turns":1}' ;;
  retry) echo '{"type":"system","subtype":"api_retry","attempt":10,"error_status":429}' ;;
  stderr) echo "Error: You've hit your limit · resets 5am" >&2 ;;
  # Not a limit: the session's own words about one, and a failure for another reason.
  text) echo '{"type":"assistant","message":{"content":[{"type":"text","text":"The server answers 429 under a rate limit; adding a retry"}]}}'
        echo '{"type":"result","is_error":true,"result":"the build failed","num_turns":3}' ;;
esac
exit 1
`;

describe("a usage limit: the session ends on one, the lane sleeps --limit-wait and tries again", () => {
  test("(the sessions hit a limit first)", () => {
    claude(LIMIT);
    for (const x of fs.readdirSync(a.locks)) if (x.startsWith("limit.")) fs.rmSync(path.join(a.locks, x));
  });
  for (const k of ["result", "api", "retry", "stderr"]) {
    let r: Run, before = "";
    const it = `iteration 1: Limit ${k} (g/lim-${k})`;
    test(`a session that hits a usage limit (${k}): the lane sleeps --limit-wait and retries`, async () => {
      setup("add-unit", `g/lim-${k}`, "--title", `Limit ${k}`);
      r = loop(["--max", "1", "--no-wait", "--hours", "1"], { FACTORY_FAKE_LIMIT: k });
      await r.until("usage limit; sleeping 30 min, then retrying");
      await r.at(1799);
      before = r.out();
      await r.at(1800);
      await r.end();
      has(r.out(), "usage limit; sleeping 30 min, then retrying");
    });
    test("  30 minutes after, not a second before", () => {
      assert.equal(count(before, it), 1);
      has(r.out(), `${hmsAt(r.t0, 1800)} loop: ${it}`);
    });
    test("  the retry isn't counted against --max", () => { assert.equal(count(r.out(), it), 2); });
    test("  and works the unit", () => { assert.equal(state(`g/lim-${k}`), "done"); });
  }
  let out = "";
  test("a session that only talks about rate limits and fails isn't a usage limit", async () => {
    setup("add-unit", "g/lim-text", "--title", "Limit text");
    out = (await loop(["--max", "1", "--no-wait", "--limit-wait", "0.02", "--hours", "0.05"], { FACTORY_FAKE_LIMIT: "text" }).end()).out;
    hasnt(out, "usage limit; sleeping");
  });
  test("  it's a failed session: the lane stops", () => {
    has(out, "failed (exit 1). Stopping");
    claude(); setup("drop", "g/lim-text", "--why", "test");
  });
});
