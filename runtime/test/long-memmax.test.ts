// long start's refusal of MemoryMax= set as an environment variable (long.ts, setsMemoryMaxVar):
// where a shell reads an assignment it's refused, anywhere else it's left alone.
// Run: node --test runtime/test/
import test from "node:test";
import assert from "node:assert/strict";
import { setsMemoryMaxVar } from "../src/long.ts";

const refused = [
  ["env", "MemoryMax=16G", "target/release/lift", "rom.gba"],
  ["MemoryMax=16G", "lift"],
  ["env", "-i", "PATH=/bin", "MemoryMax=16G", "lift"],
  ["bash", "-c", "env MemoryMax=16G lift rom.gba"],
  ["bash", "-c", "cargo build && MemoryMax=16G lift"],
  ["bash", "-c", "cd x; env MemoryMax=8G lift"],
  ["/usr/bin/time", "-v", "bash", "-eu", "-c", "MemoryMax=8G lift"],
];
const allowed = [
  ["grep", "-rn", "MemoryMax=", "."],
  ["grep", "MemoryMax=16G", "notes.txt"],
  ["systemd-run", "--user", "--scope", "-p", "MemoryMax=3G", "bin"],
  ["bash", "-c", "systemd-run --user --scope -p MemoryMax=3G bin"],
  ["bash", "-c", "systemctl --user show -p MemoryMax x | grep MemoryMax="],
  ["git", "commit", "-m", "drop env MemoryMax=16G"],
];
for (const a of refused) test(`refused: ${a.join(" ")}`, () => { assert.equal(setsMemoryMaxVar(a), true); });
for (const a of allowed) test(`allowed: ${a.join(" ")}`, () => { assert.equal(setsMemoryMaxVar(a), false); });
