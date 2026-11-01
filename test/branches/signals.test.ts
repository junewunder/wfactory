// A plain signal to a lane (TERM): it stops, its session or running check goes with it, its exit
// steps run, and the next start carries the unit on. Run: node --test test/branches/
import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { until, alive, readOr, killPid } from "../lib/index.ts";
import { branchFactory, ONE } from "./factory.ts";

const f = branchFactory(["e"]);
const [e] = f.lanes;
const { add, drop } = f;
const lk = (x: string) => path.join(e.locks, x);
// Has the loop ended within s seconds?
function endsWithin(done: Promise<unknown>, s: number) {
  let t: NodeJS.Timeout | undefined;
  return Promise.race([done.then(() => true), new Promise<boolean>((r) => { t = setTimeout(() => r(false), s * 1000); })]).finally(() => clearTimeout(t));
}
// The exit steps' event, once per stop.
const stops = () => e.events().split("\n").filter((l) => l.split("\t")[3] === "lane-stop").length;

describe("a plain signal to a lane: its session is stopped, not left running", () => {
  let session = 0;
  test("a lane sent TERM stops", async () => {
    add("signalled");
    fs.writeFileSync(lk("hold.g-signalled"), "");
    const l = e.loopBg(["--hours", "0.05"]);
    await until(() => fs.existsSync(lk("held.g-signalled")), "the session is working");
    session = Number(readOr(lk("held.g-signalled")));
    process.kill(l.pid!, "SIGTERM");
    assert.ok(await endsWithin(l.done, 20), "still running 20 s after TERM");
  });
  test("  and its session goes with it", () => { assert.ok(session > 0 && !alive(session), `session ${session} still runs`); });
  test("  the next start carries the unit on", () => {
    fs.rmSync(lk("hold.g-signalled")); fs.writeFileSync(lk("go.g-signalled"), "");
    e.loop(ONE);
    assert.equal(e.ok(["state", "g/signalled"]), "done");
  });
});

describe("a plain signal while the loop runs a slow check: the check is killed and the exit steps run", () => {
  let check = 0, before = 0;
  test("a lane sent TERM mid-check stops at once, not when the check ends", async () => {
    add("slowcheck");
    fs.writeFileSync(lk("check-hook"), '#!/bin/sh\necho $$ > "$FACTORY_LOCKS/hook-started.new" && mv "$FACTORY_LOCKS/hook-started.new" "$FACTORY_LOCKS/hook-started"\nexec sleep 61\n', { mode: 0o755 });
    const l = e.loopBg(["--hours", "0.05"]);
    await until(() => fs.existsSync(lk("hook-started")), "the check has started", 30);
    check = Number(readOr(lk("hook-started")));
    before = stops();
    const t0 = Date.now();
    process.kill(l.pid!, "SIGTERM");
    assert.ok(await endsWithin(l.done, 30), "still running 30 s after TERM");
    const el = (Date.now() - t0) / 1000;
    assert.ok(el <= 10, `${el} s`);
  });
  test("  the check is killed", () => { assert.ok(check > 0 && !alive(check), `check ${check} still runs`); });
  test("  and the exit steps ran", () => { assert.equal(stops(), before + 1, e.events()); });
  after(() => {
    fs.rmSync(lk("check-hook"), { force: true });
    killPid(check, "SIGKILL");
    drop("g/slowcheck");
  });
});
