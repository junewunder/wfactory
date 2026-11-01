// The tracker CLI end to end: .tracker/lock held by another command past the wait
// (FACTORY_LOCK_WAIT seconds, default 30) exits 75, not 2, so a caller can tell a busy lock from
// broken data and try again. Run: node --test tracker/test/
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { trackerRepo, has } from "../../test/lib/index.ts";

const f = trackerRepo("repo");
const { t, setup } = f;
setup(["init", "--title", "Locked"]);

describe("a busy lock", () => {
  // The holder: a live process, as the tracker writes it (so the lock isn't stale).
  // (Unref'd and killed at exit too, so a run that skips these tests neither waits on it nor
  // leaves it behind.)
  const holder = spawn("sleep", ["600"], { stdio: "ignore" }); holder.unref();
  after(() => { holder.kill(); }); process.on("exit", () => { holder.kill(); });
  test("a write waits FACTORY_LOCK_WAIT, then exits 75", () => {
    fs.mkdirSync(f.at(".tracker/lock"), { recursive: true });
    fs.writeFileSync(f.at(".tracker/lock/pid"), `${holder.pid}`);
    const t0 = Date.now();
    const r = t(["add-group", "g", "--title", "Group"], { FACTORY_LOCK_WAIT: "0.5" });
    assert.equal(r.code, 75, r.stderr);
    has(r.stderr, "the tracker is locked by another command");
    assert.ok(Date.now() - t0 >= 500);
  });
  test("  and goes through once the lock is let go", () => {
    fs.rmSync(f.at(".tracker/lock"), { recursive: true, force: true });
    assert.equal(t(["add-group", "g", "--title", "Group"], { FACTORY_LOCK_WAIT: "0.5" }).code, 0);
  });
});
