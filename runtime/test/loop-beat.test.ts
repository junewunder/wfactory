// loop-beat.ts on its own: the heartbeat beats at the rate it's told, on a mocked clock (Date and
// setTimeout), so load can't make it look slow. The loop suite's heartbeat test checks it beats
// while the loop waits on the claim lock. Run: node --test runtime/test/
import test, { after, mock, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { beat } from "../src/loop-beat.ts";
import { readOr } from "../../test/lib/index.ts";

// A factory whose tracker notes each `lease beat` it's asked for (FACTORY_TRACKER naming a file
// that isn't the tracker makes the heartbeat run factory/tracker as a command).
const d = fs.mkdtempSync(path.join(os.tmpdir(), "beat-"));
after(() => fs.rmSync(d, { recursive: true, force: true }));
const beats = path.join(d, "beats");
fs.mkdirSync(path.join(d, "factory"));
fs.writeFileSync(path.join(d, "factory/tracker"), `#!/bin/sh\n[ "$1 $2" = "lease beat" ] && echo beat >> ${JSON.stringify(beats)}\nexit 0\n`, { mode: 0o755 });
const count = () => (readOr(beats).match(/beat/g) ?? []).length;
// Lets the heartbeat act on a tick (the mocked setTimeout resolves; the loop beats, or not,
// and waits again): real setImmediate, which isn't mocked.
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

// The heartbeat with FACTORY_BEAT_EVERY=every, for the loop <pid> of a process that lives until
// stop(); tick(s) moves the clock s seconds, a second at a time. A failed check still stops it
// (in the test's after hook), or the test would hang on the loop's process.
async function heartbeat(t: TestContext, every: number) {
  fs.rmSync(beats, { force: true });
  const loop = spawn("sleep", ["600"], { stdio: "ignore" });
  const was = { cwd: process.cwd(), every: process.env.FACTORY_BEAT_EVERY, tracker: process.env.FACTORY_TRACKER };
  process.chdir(d);
  process.env.FACTORY_BEAT_EVERY = String(every);
  process.env.FACTORY_TRACKER = path.join(d, "factory/tracker");
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_760_000_000_000 });
  syncBuiltinESMExports();
  const ended = beat(loop.pid!);
  await settle();
  let stopped: Promise<number | string> | undefined;
  const h = {
    async tick(s: number) { for (let i = 0; i < s; i++) { mock.timers.tick(1000); await settle(); } },
    stop: () => stopped ??= (async () => {
      loop.kill("SIGKILL");
      await new Promise((r) => loop.on("exit", r));
      // The clock moves on until the heartbeat has ended (10 minutes at most: one that never
      // ends fails here, rather than hanging the file).
      let code: number | undefined;
      void ended.then((c) => { code = c; });
      for (let i = 0; i < 600 && code === undefined; i++) { mock.timers.tick(1000); await settle(); }
      mock.timers.reset(); syncBuiltinESMExports();
      process.chdir(was.cwd);
      for (const [k, v] of [["FACTORY_BEAT_EVERY", was.every], ["FACTORY_TRACKER", was.tracker]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v;
      return code ?? "still beating 10 minutes after its loop ended";
    })(),
  };
  t.after(() => h.stop());
  return h;
}

test("told to beat every second, it beats once a second", async (t) => {
  const h = await heartbeat(t, 1);
  assert.equal(count(), 0, "a beat before a second had gone by");
  await h.tick(1);
  assert.equal(count(), 1, "a second in");
  await h.tick(9);
  assert.equal(count(), 10, "ten seconds in");
  assert.equal(await h.stop(), 0);
});

test("told to beat every 5 minutes, it beats at 5 minutes and not before; it ends with its loop", async (t) => {
  const h = await heartbeat(t, 300);
  await h.tick(299);
  assert.equal(count(), 0, "a beat before 5 minutes");
  await h.tick(1);
  assert.equal(count(), 1, "at 5 minutes");
  await h.tick(300);
  assert.equal(count(), 2, "at 10 minutes");
  assert.equal(await h.stop(), 0);
});
