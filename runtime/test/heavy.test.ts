// heavy.ts's pure parts: sizes, a job's share and cap from its history, time left (by the
// holder's own project), and how a job's end reads. Run: node --test runtime/test/
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "heavy-unit-"));
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));
fs.writeFileSync(path.join(tmp, "meminfo"), "MemTotal:       31457280 kB\nMemAvailable:   20971520 kB\n");
process.env.FACTORY_MEMINFO = path.join(tmp, "meminfo");
const { bytes, capOk, sizeArg, sizes, request, recordRun, left, reasonOf, endedText, nameOf } = await import("../src/heavy.ts");
const G = 1024 ** 3, M = 1024 ** 2;
// The project is the folder's name, less a lane clone's -lane<N>.
const env = (proj: string) => { const d = path.join(tmp, proj); fs.mkdirSync(d, { recursive: true }); return { FACTORY_JOBS_HOME: path.join(tmp, "jobs"), PWD: d } as NodeJS.ProcessEnv; };
const inDir = <T>(e: NodeJS.ProcessEnv, f: () => T) => { const was = process.cwd(); process.chdir(e.PWD!); try { return f(); } finally { process.chdir(was); } };

test("systemd sizes in bytes", () => {
  assert.equal(bytes("4G"), 4 * G); assert.equal(bytes("512M"), 512 * M); assert.equal(bytes("1.5G"), 1.5 * G); assert.equal(bytes("1024"), 1024);
  assert.equal(bytes("4g"), null, "systemd takes upper-case suffixes only");
  assert.equal(bytes("lots"), null);
});
test("caps systemd takes besides sizes", () => {
  assert.ok(capOk("50%")); assert.ok(capOk("12.5%")); assert.ok(capOk("infinity"));
  assert.ok(!capOk("4g")); assert.ok(!capOk("150%"), "over the machine"); assert.ok(!capOk("50.123%"), "systemd takes 2 decimals");
});
test("a size for systemd, whole MiB", () => { assert.equal(sizeArg(12 * G), "12G"); assert.equal(sizeArg(1.5 * G), "1536M"); assert.equal(sizeArg(10 * M + 1), "11M"); });
test("a share given is the share and the cap", () => { assert.deepEqual(inDir(env("a"), () => sizes("x", "12G", env("a"))), { reserve: 12 * G, cap: "12G" }); });
test("  as a share of the machine", () => { assert.equal(inDir(env("a"), () => sizes("x", "50%", env("a"))).reserve, 15 * G); });
test("never run: 4G, capped at 8G", () => { assert.deepEqual(inDir(env("a"), () => sizes("never", undefined, env("a"))), { reserve: 4 * G, cap: "8G" }); });
test("its last 3 peaks plus 20%, its cap at least 8G", () => {
  const e = env("b");
  inDir(e, () => { for (const p of [1, 10, 5, 2]) recordRun("job", { peak: p * G }, e); });
  // The last 3 are 10, 5 and 2: 10G plus 20%.
  assert.equal(inDir(e, () => request("job", e)), 12 * G);
  assert.deepEqual(inDir(e, () => sizes("job", undefined, e)), { reserve: 12 * G, cap: "12G" });
});
test("  a lane's clone shares its project's history", () => { assert.equal(inDir(env("b-lane2"), () => request("job", env("b-lane2"))), 12 * G); });
test("time left: by the holder's own project, null once past its time", () => {
  const e = env("c");
  inDir(e, () => recordRun("long", { secs: 1800 }, e));
  const now = Date.now(), since = now - 600 * 1000;
  // Asked from another project's checkout, about c's job.
  const other = env("d");
  assert.equal(inDir(other, () => left({ cmd: "long", since, project: "c" }, other, now)), 1200);
  assert.equal(inDir(other, () => left({ cmd: "long", since }, other, now)), null, "d has no such job");
  assert.equal(inDir(e, () => left({ cmd: "long", since: now - 2000 * 1000, project: "c" }, e, now)), null, "overdue: not known");
});
test("how a job ended", () => {
  assert.equal(reasonOf(0, false, false), "ok"); assert.equal(reasonOf(3, false, false), "exit"); assert.equal(reasonOf(139, false, false), "signal");
  assert.equal(reasonOf(137, true, true), "oom"); assert.equal(reasonOf(1, true, false), "machine");
});
test("  in words", () => {
  const e = { what: "w", cmd: "c", start: 0, end: 120000, cap: "8G", peak: 31457280 };
  assert.match(endedText("j", { ...e, reason: "signal", rc: 139 }), /^j: crashed, ended by SIGSEGV \(exit 139\)/);
  assert.match(endedText("j", { ...e, reason: "oom" }), /^j: killed at its memory cap \(8G, peak 30M\)/);
  assert.match(endedText("j", { ...e, reason: "machine" }), /^j: killed when the whole machine ran out of memory \(not at its cap of 8G/);
});
test("a capped run's name: its command's first word", () => { assert.equal(nameOf(["scripts/editor.sh", "x"]), "editor"); assert.equal(nameOf(["uv", "run"]), "uv"); });
