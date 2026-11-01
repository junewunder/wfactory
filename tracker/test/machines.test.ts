// The tracker's read of docs/machines.md (ctx.ts): what each machine can do and its heavy-job
// slots, by the table's header names, its columns in any order. Run: node --test tracker/test/
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeContext } from "../src/ctx.ts";

test("a machines table with its columns in another order: Can and Heavy read by name", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tracker-machines-"));
  try {
    fs.mkdirSync(path.join(dir, "docs"));
    fs.writeFileSync(path.join(dir, "docs/machines.md"), [
      "| Heavy | Can | machine | Lanes |", "|---|---|---|---|",
      "| 2 | gpu, steam | wren | 1 |", "| 1 | — | tern | 1 |", "",
    ].join("\n"));
    const c = makeContext({ FACTORY_HOST: "wren", FACTORY_STATE: "local" }, "next", dir);
    assert.deepEqual([...c.MCAPS.keys()], ["wren", "tern"]);
    assert.deepEqual([...c.MCAPS.get("wren")!], ["gpu", "steam"]);
    assert.deepEqual([...c.MCAPS.get("tern")!], []);
    assert.deepEqual([...c.MHEAVY], [["wren", 2], ["tern", 1]]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a table above the Lanes table with a Machine column isn't read in its place", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tracker-machines-"));
  try {
    fs.mkdirSync(path.join(dir, "docs"));
    fs.writeFileSync(path.join(dir, "docs/machines.md"), [
      "## Accounts", "", "| Name | Machine |", "|---|---|", "| x | ghost |", "",
      "## Lanes", "", "| Machine | Can | Heavy |", "|---|---|---|", "| wren | gpu | 2 |", "",
    ].join("\n"));
    const c = makeContext({ FACTORY_HOST: "wren", FACTORY_STATE: "local" }, "next", dir);
    assert.deepEqual([...c.MCAPS.keys()], ["wren"]);
    assert.deepEqual([...c.MHEAVY], [["wren", 2]]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
