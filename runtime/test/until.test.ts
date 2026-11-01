// just until: how a session waits for an app to settle or a file to appear, since the CLI refuses
// a Bash call that starts with sleep (recipes.ts). Run: node --test runtime/test/
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const main = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "main.ts");
const env = { ...process.env, FACTORY_UNTIL_POLL: "0.1" };
const run = (args: string[]) => spawnSync(process.execPath, [main, "until", ...args], { encoding: "utf8", env });

test("until: passes once the check does, with its output", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-until-"));
  try {
    const f = path.join(dir, "out.txt");
    const p = spawn(process.execPath, [main, "until", "10", "--", `test -s ${f} && cat ${f}`], { env });
    let out = ""; p.stdout.on("data", (d) => { out += d; });
    setTimeout(() => fs.writeFileSync(f, "made it\n"), 500);
    const code = await new Promise((r) => p.on("close", r));
    assert.equal(code, 0);
    assert.equal(out, "made it\n");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("until: 124 at the limit, saying what still fails", () => {
  const r = run(["1", "--", "echo not yet; false"]);
  assert.equal(r.status, 124);
  assert.match(r.stdout, /not yet/);
  assert.match(r.stderr, /still failing after 1 s \(exit 1\): echo not yet; false/);
});

test("until: several words after -- run as they are", () => {
  assert.equal(run(["1", "--", "test", "-d", os.tmpdir()]).status, 0);
});

test("until: with no check, waits that long", () => {
  const t = Date.now();
  assert.equal(run(["1"]).status, 0);
  assert.ok(Date.now() - t >= 1000);
});

test("until: refuses past a Bash call's limit, and a check without --", () => {
  const r = run(["600", "--", "true"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /just long start/);
  assert.equal(run(["5", "true"]).status, 2);
});

test("until: a check that prints a lot still passes, with its output's end", () => {
  const r = run(["5", "--", "head -c 2000000 /dev/zero | tr '\\0' a; echo; echo the end"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /the end\n$/);
  assert.ok(r.stdout.length <= 64 * 1024);
});

test("until: at the limit the check's whole group goes, and it says so", () => {
  const t = Date.now();
  const r = run(["2", "--", "sleep 30 & sleep 30; false"]);
  assert.equal(r.status, 124);
  assert.ok(Date.now() - t < 10_000, `took ${Date.now() - t} ms`);
  assert.match(r.stderr, /cut off at the limit/);
});

test("until: a poll setting that isn't a number falls back to 2 s", () => {
  const t = Date.now();
  const r = spawnSync(process.execPath, [main, "until", "1", "--", "false"], { encoding: "utf8", env: { ...process.env, FACTORY_UNTIL_POLL: "soon" } });
  assert.equal(r.status, 124);
  assert.ok(Date.now() - t < 10_000);
});
