// The heartbeat keeps the leases fresh while the loop waits on something (here another lane's
// claim lock), since another machine takes a lease silent for 30 minutes. The heartbeat is a
// process of its own, in real time; the loop runs in this process (inproc.ts), and the other
// lane's claim lock is held until two beats have come, so nothing waits a fixed time. That it
// beats at the rate it's told is checked on a mocked clock (runtime/test/loop-beat.test.ts):
// timed here, in real time, load made two beats a second apart take 7 s.
// Run: node --test test/loop/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { has, until, lockHeld, readOr, ROOT } from "../lib/index.ts";
import { loopFactory } from "./factory.ts";
import { waitFor } from "./inproc.ts";

const f = loopFactory("beat");
const { a, w, setup, loop } = f;
const beats = w.at("beats"), released = w.at("released");
// The tracker, noting each `lease beat` it's asked for.
const wrapper = w.at("tracker-beats.mjs");
fs.writeFileSync(wrapper, `import fs from "node:fs";
if (process.argv[2] === "lease" && process.argv[3] === "beat") fs.appendFileSync(${JSON.stringify(beats)}, "beat\\n");
await import(${JSON.stringify(path.join(ROOT, "tracker/tracker.mjs"))});
`);

describe("the heartbeat keeps the leases fresh while the loop waits on something", () => {
  let out = "", held = -1;
  test("the heartbeat beats while the loop waits for the claim lock", async () => {
    setup("add-unit", "g/hb", "--title", "Heartbeat unit");
    // Another lane holds the claim lock until it has seen two beats (or 60 s have gone by).
    const claim = path.join(a.locks, "claim.lock");
    const h = spawn("flock", [claim, "bash", "-c", `for _ in $(seq 600); do n=$(grep -c beat ${beats} 2>/dev/null); [ "\${n:-0}" -lt 2 ] || { echo "$n" > ${released}; exit 0; }; sleep 0.1; done; exit 1`], { stdio: "ignore", detached: true });
    after(() => { try { process.kill(-h.pid!, "SIGKILL"); } catch { /* gone */ } });
    const ended = new Promise<number>((r) => h.on("exit", (c) => r(c ?? 1)));
    await until(() => lockHeld(claim), "the other lane holds the claim lock");
    // A beat a second: one that beats at its default (5 minutes) fails here too.
    const r = loop(["--max", "1", "--no-wait", "--hours", "0.05"], { FACTORY_TRACKER: wrapper, FACTORY_BEAT_EVERY: "1" });
    await waitFor(() => (readOr(beats).match(/beat/g) ?? []).length >= 2, "two beats while the loop waits for the claim lock", 30);
    out = (await r.end(90)).out;
    held = await ended;
    assert.equal(held, 0, "the claim lock was let go of without two beats");
    assert.ok(Number(readOr(released)) >= 2, `${readOr(released)} beats`);
  });
  test("  and the loop goes on once it has the lock", () => { has(out, "iteration 1: Heartbeat unit (g/hb)"); has(out, "ran its --max 1 sessions"); });
});
