// Restart onto a runner that can't start: the lane says so and carries on with its own copy. The
// lane runs from a deploy of its own (versions/old, this checkout); the newest (versions/broken)
// has a loop.sh that doesn't parse. The loop is the real factory/loop.sh, in the file's lane.
// Run: node --test test/loop/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { has, hasnt, ROOT } from "../../lib/index.ts";
import { hold } from "../inproc.ts";
import { laneFactory } from "./helpers.ts";

// (Main is red while red is in its tree.)
const f = laneFactory("lane-restart", "lane-restart", { check: "test ! -e red" });
const { a, w, setup, events } = f;
const RF = w.at("rfdeploy");
fs.mkdirSync(path.join(RF, "versions/old"), { recursive: true });
fs.mkdirSync(path.join(RF, "versions/broken/wfactory/runtime"), { recursive: true });
fs.symlinkSync(ROOT, path.join(RF, "versions/old/wfactory"));
fs.symlinkSync("versions/old", path.join(RF, "current"));
fs.writeFileSync(path.join(RF, "versions/broken/wfactory/runtime/loop.sh"), "#!/usr/bin/env bash\nif then\n", { mode: 0o755 });

describe("restart onto a runner that can't start: the lane says so and carries on with its own", () => {
  let b: ReturnType<typeof f.loopBg>;
  test("a restart onto a runner that can't start: the lane carries on with its own", async () => {
    setup("add-unit", "g/rsf", "--title", "Pinned elsewhere again", "--host", "otherbox");
    b = f.loopBg(["--hours", "0.05"], { FACTORY_SKILL: undefined, FACTORY_DEPLOY: RF });
    await b.until("waiting:");
    fs.rmSync(path.join(RF, "current")); fs.symlinkSync("versions/broken", path.join(RF, "current"));
    fs.writeFileSync(a.at("runs/.restart"), "rsf-1 1\n");
    await b.until("restart: the newest runner can't start here");
  });
  test("  a restart-failed event names the copy it carries on with", () => {
    has(events(), `restart-failed\tlane 1 on ${a.n}: the newest runner can't start there (factory/skill, or its loop.sh doesn't parse); the lane carries on with old`);
  });
  test("  its recipes still the copy it runs", () => { assert.equal(fs.readlinkSync(a.at(".tracker/skill")), path.join(RF, "versions/old/wfactory")); });
  test("  the request is used up", () => { assert.ok(!fs.existsSync(a.at("runs/.restart"))); });
  test("  (it carries on, and stops at a pause)", async () => {
    f.oversee(["pause"]);
    await b.until("paused at a good point", 20);
    await b.end();
  });
});

// A restart asked while main is red here (outside last call): the lane stops for the red main, not
// restarted in place, since a restarted loop starts with red unknown and could take units on it
// until a landing failed again (#118).
describe("a restart asked while main is red: the lane stops, not restarted", () => {
  let out = "";
  test("main goes red while a unit works; a restart is asked before its landing fails", async () => {
    setup("drop", "g/rsf", "--why", "test");
    setup("add-unit", "g/rr", "--title", "Unit on a red main");
    setup("add-unit", "g/rr2", "--title", "Unit after the red main");
    const h = hold(a.locks, "g/rr");
    const b = f.loopBg(["--hours", "0.05"]);
    await h.held();
    // (From a clone of its own: the session is working in the lane's.)
    const red = w.at("red-edit");
    w.git(w.top, "clone", "-q", f.origin, red);
    fs.writeFileSync(path.join(red, "red"), "main fails its check\n");
    w.git(red, "add", "red"); w.git(red, "commit", "-qm", "red main"); w.git(red, "push", "-q", "origin", "HEAD:main");
    fs.writeFileSync(a.at("runs/.restart"), "rr-1 1\n");
    h.go();
    out = (await b.end()).stdout;
    has(out, "main itself fails `just check`");
  });
  test("  not restarted", () => { hasnt(out, "restarting on the newest runner"); });
  test("  it stops for the red main", () => { has(out, "main is red: "); });
  test("  taking no other unit", () => { hasnt(out, ": Unit after the red main (g/rr2) (session"); });
});
