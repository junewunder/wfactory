// The machines file's Lanes table, read by its header's names (machines.ts): its columns in any
// order, and a column it lacks read as empty (the scripts' default) with one warning. Run:
// node --test runtime/test/
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { machineGet, machineRows } from "../src/machines.ts";
import { budget } from "../src/heavy.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "machines-"));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const write = (name: string, text: string) => { const f = path.join(dir, name); fs.writeFileSync(f, text); return f; };

// The columns shuffled, and no Heavy column.
const shuffled = write("shuffled.md", `# Machines

## Lanes

| GPU | Can | machine | Cache | Lanes | ssh | Reserve | Checkout | Takes |
|:---|---|---|---|---|---|---|---|---:|
| 2G | gpu | wren | 100G | 3 | wren.lan | 5G | ~/f | pinned |
| 0 | — | tern | — | 1 | tern | 3G | ~/g | any |

## wren
`);

// console.error's lines while f runs.
function stderr(f: () => void) {
  const was = console.error, said: string[] = [];
  console.error = (...a: unknown[]) => { said.push(a.join(" ")); };
  try { f(); } finally { console.error = was; }
  return said;
}

test("a table with its columns in another order reads every value right, Heavy giving its default and one warning", () => {
  let rows: string[][] = [];
  const said = stderr(() => { rows = machineRows(shuffled); machineRows(shuffled); machineGet("wren", "heavy", shuffled); });
  assert.deepEqual(rows, [
    ["wren", "wren.lan", "3", "pinned", "~/f", "gpu", "100G", "", "5G", "2G"],
    ["tern", "tern", "1", "any", "~/g", "—", "—", "", "3G", "0"],
  ]);
  assert.equal(machineGet("wren", "takes", shuffled), "pinned");
  assert.equal(machineGet("wren", "can", shuffled), "gpu");
  assert.equal(machineGet("wren", "checkout", shuffled), "~/f");
  assert.equal(machineGet("wren", "heavy", shuffled), "");
  assert.equal(machineGet("nobody", "lanes", shuffled), undefined);
  assert.equal(said.length, 1, said.join("\n"));
  assert.match(said[0], /no Heavy column; every machine gets its default \(1\)/);
});

test("the heavy-job budget reads its columns by name", () => {
  process.env.MACHINES_FILE = shuffled;
  let b: ReturnType<typeof budget>;
  try { b = budget({ ...process.env, FACTORY_HOST: "wren" }); } finally { delete process.env.MACHINES_FILE; }
  assert.equal(b.desk, 5 * 1024 ** 3);
  assert.equal(b.gpu, 2 * 1024 ** 3);
});

// `machines get` (and the bash machine_get it backs), by a column's name or its old number.
const main = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "main.mjs");
const get = (...a: string[]) => spawnSync(process.execPath, [main, "machines", "get", ...a], { encoding: "utf8", env: { ...process.env, MACHINES_FILE: shuffled } });

test("machines get <name> <column> and, still, <name> <n>", () => {
  assert.equal(get("wren", "Heavy").stdout, "\n");
  assert.equal(get("wren", "Takes").stdout, "pinned\n");
  assert.equal(get("wren", "gpu").stdout, "2G\n");
  assert.equal(get("wren", "4").stdout, "pinned\n");
  assert.equal(get("wren", "2").stdout, "wren.lan\n");
  const bad = get("wren", "Colour");
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /no column Colour/);
});

test("a table above the Lanes table with a Machine column isn't read in its place", () => {
  const f = write("above.md", `# Machines

## Accounts

| Name | Machine |
|---|---|
| x | ghost |

## Lanes

| Machine | ssh | Lanes | Takes | Checkout | Can | Cache | Heavy | Reserve | GPU |
|---|---|---|---|---|---|---|---|---|---|
| wren | wren | 2 | any | ~/f | — | — | 1 | 3G | 0 |
`);
  let rows: string[][] = [];
  const said = stderr(() => { rows = machineRows(f); });
  assert.deepEqual(rows, [["wren", "wren", "2", "any", "~/f", "—", "—", "1", "3G", "0"]]);
  assert.deepEqual(said, []);
});

test("a Lanes table without a Machine column: no machines, and a warning", () => {
  const f = write("nameless.md", "## Lanes\n\n| Host | ssh | Lanes |\n|---|---|---|\n| wren | wren | 1 |\n");
  let rows: string[][] = [];
  const said = stderr(() => { rows = machineRows(f); });
  assert.deepEqual(rows, []);
  assert.equal(said.length, 1);
  assert.match(said[0], /no Machine column/);
});
