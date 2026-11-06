// events.ts: an events.log line names the unit it happened in, so the morning summary can say what
// became of it. Run: node --test runtime/test/
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { event } from "../src/events.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-events-"));
process.chdir(dir);
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const last = () => fs.readFileSync("runs/events.log", "utf8").trimEnd().split("\n").at(-1)!.split("\t");
const env = { FACTORY_HOST: "box", PWD: dir };

test("a line from inside a session names the unit the session holds", () => {
  event("oom-kill", "just long start big (make big) was killed: out of memory at 6G", { ...env, FACTORY_SESSION_UNIT: "g/big" });
  assert.deepEqual(last().slice(1), ["box", "1", "oom-kill", "just long start big (make big) was killed: out of memory at 6G", "g/big"]);
});
test("one the loop writes names the unit it's given", () => {
  event("oom-kill", "session 1a2b on Big (g/big) was killed", env, "g/other");
  assert.equal(last()[5], "g/other");
});
test("and a line with no unit has the five fields it always had", () => {
  event("idle", "lane 1 on box has had nothing to do", env);
  assert.equal(last().length, 5);
});
