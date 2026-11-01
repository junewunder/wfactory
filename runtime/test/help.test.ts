// A subcommand given -h or --help prints the help and does nothing else: overseers ran
// `just fleet start --help`, which started lanes (October 2026). Run: node --test runtime/test/
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { asksHelp } from "../src/sys.ts";

const main = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "main.ts");

test("asksHelp: -h or --help before a --, not after it", () => {
  assert.equal(asksHelp(["start", "--help"]), true);
  assert.equal(asksHelp(["start", "wren", "-h"]), true);
  assert.equal(asksHelp(["start", "x", "--", "tool", "--help"]), false);
  assert.equal(asksHelp(["tell", "lane 1", "run it with --help first"]), false);
  assert.equal(asksHelp(["start"]), false);
  // Free text from textAt on: past its first word, --help is part of it.
  assert.equal(asksHelp(["note", "checked", "loop.sh", "--help", "output"], 2), false);
  assert.equal(asksHelp(["note", "--help"], 2), true);
});

// Each from a folder that isn't a factory: a command that went on past its help would fail there.
const cases = [["fleet", "start", "--help"], ["fleet", "stop", "-h"], ["fleet", "--loop", "a", "pause", "--help"], ["oversee", "start", "--help"],
  ["long", "start", "--help"], ["store", "end", "--help"], ["lane", "dir", "--help"], ["daemon", "start", "--help"],
  ["inbox", "open", "--help"], ["machines", "rows", "--help"], ["usage", "show", "--help"], ["profile", "get", "--help"], ["profile", "new", "--help"], ["fleet", "note", "--help"], ["fleet", "tell", "wren", "--help"]];
for (const argv of cases) {
  test(`${argv.join(" ")} prints the help`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-help-"));
    try {
      const r = spawnSync(process.execPath, [main, ...argv], { cwd: dir, encoding: "utf8", env: { ...process.env, HOME: dir } });
      assert.equal(r.status, 0, `${argv.join(" ")}: exit ${r.status}\n${r.stdout}${r.stderr}`);
      assert.match(r.stdout, new RegExp(`${argv[0]}`), "the help names the command");
      assert.deepEqual(fs.readdirSync(dir), [], "and nothing is written");
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}

test("fleet note: --help past the text's first word is part of the note, not a request for help", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-help-"));
  try {
    const r = spawnSync(process.execPath, [main, "fleet", "note", "checked", "loop.sh", "--help", "output"], { cwd: dir, encoding: "utf8", env: { ...process.env, HOME: dir } });
    assert.notEqual(r.status, 0, "outside a factory the note is refused, not answered with the help");
    assert.doesNotMatch(r.stdout, /fleet\.sh —|usage/i);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
