// The loop's small helpers: files, the tracker's JSON, times, and finding commands and processes.
import fs from "node:fs";
import path from "node:path";
import { hm } from "./sys.ts";
import { platform } from "./os.ts";

export const read = (f: string) => { try { return fs.readFileSync(f, "utf8"); } catch { return null; } };
// A file's contents as `$(cat f)` gives them: without the trailing newlines.
export const cat = (f: string) => read(f)?.replace(/\n+$/, "") ?? null;
export const exists = (f: string) => fs.existsSync(f);
export const rm = (...fs_: string[]) => { for (const f of fs_) fs.rmSync(f, { force: true }); };
export const touch = (f: string) => fs.closeSync(fs.openSync(f, "a"));
export const isInt = (s: string | null | undefined): s is string => /^[0-9]+$/.test(s ?? "");
export type Json = Record<string, unknown>;
export const json = (s: string | null | undefined): Json | null => {
  try { const v = JSON.parse(s ?? ""); return v && typeof v === "object" && !Array.isArray(v) ? v : null; } catch { return null; }
};
export const list = (v: unknown): string[] => Array.isArray(v) ? v.map(String) : [];
// A value as the bash's jq `// empty` gave it: "" for missing, null and false.
export const str = (v: unknown) => v === undefined || v === null || v === false ? "" : String(v);
export const uniq = (a: string[]) => [...new Set(a)].sort();
export const both = (a: string[], b: string[]) => { const s = new Set(b); return uniq(a.filter((x) => s.has(x))); };
// awk's int(x * 60): minutes as whole seconds.
export const mins = (m: string) => Math.trunc(Number(m) * 60) || 0;
export const minsText = (n: number) => n === 1 ? "1 minute" : `${n} minutes`;
export const exe = (f: string) => { try { fs.accessSync(f, fs.constants.X_OK); return fs.statSync(f).isFile(); } catch { return false; } };
// `command -v`: is it a command on PATH (or a path that runs)?
export function which(c: string) {
  if (c.includes("/")) return exe(c);
  return (process.env.PATH ?? "").split(":").some((d) => exe(path.join(d || ".", c)));
}
export const ymdhms = (d = new Date()) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};
export const hmAt = (t: number) => hm(new Date(t * 1000));
// The command a settle runs for this unit's probe (a computed unit's, never dropped), so the loop
// reserves memory for it first: [] for none.
export function probeCmd(tdir: string, unit: string): string[] {
  const u = ((json(read(`${tdir}/groups/${unit.split("/")[0]}.json`))?.units ?? []) as Json[]).find((x) => x.id === unit);
  const cmd = (u?.probe as Json | undefined)?.cmd;
  return u?.check === "computed" && typeof cmd === "string" && cmd && (u.record as Json | undefined)?.state !== "dropped" ? [cmd] : [];
}

// A process and everything under it, even what runs in its own scope: listed first, then killed
// together, so nothing in between starts the next step.
export function killTree(pid: number) {
  for (const p of platform.processTree(pid)) { try { process.kill(p, "SIGTERM"); } catch {} }
}

// "the editor and the desktop": resources by their titles in the tracker's project.json.
export function resTitles(tdir: string, rs: string[]) {
  const p = json(read(`${tdir}/project.json`));
  const res = (p?.resources ?? {}) as Record<string, { title?: unknown } | undefined>;
  const t = rs.map((r) => { const x = res[r]?.title; return x === undefined || x === null || x === false ? r : String(x); });
  return t.length ? t[0] + t.slice(1).map((x) => ` and ${x}`).join("") : "";
}
