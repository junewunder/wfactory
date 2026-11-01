// The machines file (docs/machines.md): its Lanes table, one row per machine.
import fs from "node:fs";
import { expandHome, asksHelp } from "./sys.ts";

export const HELP = `machines: read the Lanes table in docs/machines.md ($MACHINES_FILE).

  machines rows                  one line per machine: name, ssh, lanes, takes, checkout, can, cache, heavy,
                                 reserve, gpu (tab-separated)
  machines get <name> <column>   one machine's value in a column, by its header (Machine, ssh, Lanes, Takes,
                                 Checkout, Can, Cache, Heavy, Reserve, GPU; any case)
  machines get <name> <n>        deprecated: the same by number (1 name, 2 ssh, 3 lanes, 4 takes, 5 checkout,
                                 6 can, 7 cache, 8 heavy, 9 reserve, 10 gpu), whatever order the table's
                                 columns are in
  machines expand-home <path>    ~/x → $HOME/x (the checkout column is written with ~)

The table (the first with a Machine column, under "## Lanes" if there is one) is read by its
headers, so its columns can be in any order; each header must be the column's name above (any
case). A column it lacks reads as empty, which every script takes as that column's default, and
is warned about once per command.
No machines file means one machine (this one) with one lane that takes any unit.
Bash scripts that source factory/machines.sh get these as machine_rows, machine_get and
expand_home.`;

export const FIELDS = ["name", "ssh", "lanes", "takes", "checkout", "can", "cache", "heavy", "reserve", "gpu"] as const;

// A markdown table cell as the scripts read it: no backticks, no space around.
export const cell = (s: string | undefined) => (s ?? "").replace(/`/g, "").replace(/^[ \t]+|[ \t]+$/g, "");

export type Field = typeof FIELDS[number];
// Each field's column header in the table, as the template writes it.
export const HEADERS: Record<Field, string> = {
  name: "Machine", ssh: "ssh", lanes: "Lanes", takes: "Takes", checkout: "Checkout", can: "Can",
  cache: "Cache", heavy: "Heavy", reserve: "Reserve", gpu: "GPU",
};

// What each column comes to when the table lacks it, as the scripts that read it take it.
const DEFAULTS: Record<Field, string> = {
  name: "", ssh: "the machine's name", lanes: "1", takes: "any", checkout: "this checkout", can: "none",
  cache: "no limit", heavy: "1", reserve: "3G", gpu: "0",
};

// A column already warned about, per file: once a process, however often the table is read.
const warned = new Set<string>();

// The first table with a "Machine" column, under "## Lanes" if the file has that section: each
// row's cells in FIELDS' order, found by the header's names (any case, any order), "" for a
// column the table lacks.
export function machineRows(file = process.env.MACHINES_FILE || "docs/machines.md"): string[][] {
  let text: string;
  try { text = fs.readFileSync(file, "utf8"); } catch { return []; }
  const lanes = mdSection(text, "Lanes");
  if (lanes !== null) text = lanes;
  const rows: string[][] = [];
  let at: number[] | null = null;
  for (const line of text.split("\n")) {
    if (!/^[ \t]*\|/.test(line)) { if (at) break; continue; }
    const f = line.split("|").slice(1).map(cell);
    if (!at) {
      const head = f.map((c) => c.toLowerCase());
      if (!head.includes("machine")) continue;
      at = FIELDS.map((k) => head.indexOf(HEADERS[k].toLowerCase()));
      for (const [i, k] of FIELDS.entries()) {
        if (at[i] >= 0 || warned.has(`${file}\0${k}`)) continue;
        warned.add(`${file}\0${k}`);
        console.error(`machines: ${file}'s table has no ${HEADERS[k]} column; every machine gets its default (${DEFAULTS[k]})`);
      }
      continue;
    }
    if (f.every((c) => /^:?-*:?$/.test(c))) continue;
    rows.push(at.map((i) => i >= 0 ? f[i] ?? "" : ""));
  }
  if (!at && lanes !== null && /^[ \t]*\|/m.test(lanes) && !warned.has(`${file}\0name`)) {
    warned.add(`${file}\0name`);
    console.error(`machines: ${file}'s Lanes table has no Machine column; read as no machines file (this machine, one lane)`);
  }
  return rows;
}

// One machine's value in a column: undefined if there's no such row, "" if the table has no
// such column.
export function machineGet(name: string, k: Field, file?: string) {
  return machineRows(file).find((r) => r[0] === name)?.[FIELDS.indexOf(k)];
}

// What \`machines get\` was asked for: a column's header (any case), or, deprecated, its number
// in FIELDS (1-based; 0 is the whole row). Its index in a row, -1 for the whole row, undefined
// if there's no such column.
function columnAsked(col: string): number | undefined {
  if (/^[0-9]+$/.test(col)) return Number(col) - 1;
  const i = FIELDS.findIndex((k) => HEADERS[k].toLowerCase() === col.toLowerCase() || k === col.toLowerCase());
  return i >= 0 ? i : undefined;
}

// A markdown file's "## <title>" section, heading and all, up to the next heading of its level
// or above (a fenced block's lines are text): null if there's no such section.
export function mdSection(text: string, title: string): string | null {
  return mdSections(text, (h) => h.toLowerCase() === title.toLowerCase())[0] ?? null;
}

// Every "## " section whose heading (without the "## ") passes, in the file's order.
export function mdSections(text: string, want: (heading: string) => boolean): string[] {
  const lines = text.split("\n"), out: string[] = [];
  let start = -1, fence = false;
  const end = (i: number) => { if (start >= 0) out.push(lines.slice(start, i).join("\n").replace(/\s+$/, "")); start = -1; };
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) fence = !fence;
    if (fence || !/^#{1,2} /.test(lines[i])) continue;
    end(i);
    if (/^## /.test(lines[i]) && want(lines[i].slice(3).trim())) start = i;
  }
  end(lines.length);
  return out;
}

// The named machine's own section of the machines file ("## <name>"), for its sessions.
export function machineSection(name: string, file = process.env.MACHINES_FILE || "docs/machines.md") {
  try { return mdSection(fs.readFileSync(file, "utf8"), name); } catch { return null; }
}

export function machinesCli(args: string[]): number {
  const [cmd, ...a] = args;
  if (cmd === undefined || asksHelp(args)) { console.log(HELP); return 0; }
  if (cmd === "rows") { for (const r of machineRows()) console.log(r.join("\t")); return 0; }
  if (cmd === "get" && a.length >= 2) {
    const i = columnAsked(a[1]);
    if (i === undefined) { console.error(`machines: no column ${a[1]} (${Object.values(HEADERS).join(", ")})`); return 2; }
    const r = machineRows().find((r) => r[0] === a[0]);
    if (r) console.log(i === -1 ? r.join("\t") : r[i] ?? "");
    return 0;
  }
  if (cmd === "expand-home" && a.length >= 1) { console.log(expandHome(a[0])); return 0; }
  console.error(`machines: unknown command ${cmd} (rows | get <name> <column> | expand-home <path>)`);
  return 2;
}
