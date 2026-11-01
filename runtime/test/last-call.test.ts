// The daemon bringing a lane back reads the same last-call time as the loop (#159): the loop's
// clock writes it to last-call in the machine's lock folder, and the daemon reads it there; with
// nothing written (a reboot empties the folder), it works it out as the loop does.
// Run: node --test runtime/test/
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Clock, lastCallFile } from "../src/loop-clock.ts";
import { lastCallAt, type LaneRecord } from "../src/daemon.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "last-call-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const locks = path.join(tmp, "locks"), dir = path.join(tmp, "lane");
fs.mkdirSync(locks); fs.mkdirSync(path.join(dir, "tracker"), { recursive: true });
fs.writeFileSync(path.join(dir, "tracker", "project.json"), JSON.stringify({ name: "lc", last_call: 30 }));
const before = process.env.FACTORY_LOCKS;
process.env.FACTORY_LOCKS = locks;
after(() => { if (before === undefined) delete process.env.FACTORY_LOCKS; else process.env.FACTORY_LOCKS = before; });

const now = Math.floor(Date.now() / 1000);
const record = (deadline: number, env: Record<string, string> = {}): LaneRecord => ({
  v: 1, unit: "lane-1", dir, loop: "", args: ["--hours", "6"], env: { FACTORY_LOCKS: locks, ...env },
  started: now - 3600, deadline, manager: "m", resumes: [], quick: 0,
});
const clock = (deadline: number, carried = 0) => Object.assign(new Clock(), { start: now - 3600, deadline, lastCall: 30, carried });

test("the daemon reads the last call the loop wrote", () => {
  const k = clock(now + 5 * 3600);
  k.publish();
  assert.equal(k.lcAt(), now + 5 * 3600 - 30 * 60);
  assert.equal(lastCallAt(record(k.deadline), k.deadline), k.lcAt());
});

test("a loop carrying an earlier run's last call on writes that, and the daemon reads it", () => {
  const deadline = now + 4 * 3600, k = clock(deadline, now + 3600);
  k.publish();
  assert.equal(k.lcAt(), now + 3600);
  assert.equal(lastCallAt(record(deadline), deadline), now + 3600);
});

test("with nothing written, the daemon works it out as the loop does", () => {
  fs.rmSync(lastCallFile(locks), { force: true });
  const deadline = now + 3 * 3600, k = clock(deadline);
  assert.equal(lastCallAt(record(deadline), deadline), k.lcAt());
});


test("a last call written for another stop time, or by a lane with another last_call, isn't this lane's", () => {
  const deadline = now + 3 * 3600;
  fs.writeFileSync(lastCallFile(locks), JSON.stringify({ at: now + 60, deadline: deadline + 3600, last_call: 30, written: now }) + "\n");
  assert.equal(lastCallAt(record(deadline), deadline), deadline - 30 * 60);
  fs.writeFileSync(lastCallFile(locks), JSON.stringify({ at: now + 60, deadline, last_call: 90, written: now }) + "\n");
  assert.equal(lastCallAt(record(deadline), deadline), deadline - 30 * 60);
  fs.writeFileSync(lastCallFile(locks), JSON.stringify({ at: now + 60, deadline, last_call: 30, written: now }) + "\n");
  assert.equal(lastCallAt(record(deadline), deadline), now + 60);
});
