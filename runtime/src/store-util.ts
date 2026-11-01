// The store's small helpers: files and folders, what the store's JSON says, its log.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// What the tracker's `data` says of a group (or of a unit's: its inputs).
export interface Data {
  remote: string;
  rebuilt?: string[];
  group?: string;
  title?: string;
  priority?: number;
  paths: { name: string; local: string }[];
  inputs?: { input: string; rel: string; local: string }[];
}
export type Json = Record<string, unknown>;

// The copy here and its marks (HELP).
export const L = "work/.store";

export const out = (s: string | null | undefined) => (s ?? "").replace(/\n+$/, "");   // as $(…) gives it
export const cat = (f: string) => { try { return out(fs.readFileSync(f, "utf8")); } catch { return null; } };
// A tab-separated mark's fields (its first line).
export const fields = (f: string) => cat(f)?.split("\n")[0].split("\t") ?? null;
export const stat = (f: string) => { try { return fs.statSync(f); } catch { return null; } };
export const isFile = (f: string) => !!stat(f)?.isFile();
export const isDir = (f: string) => !!stat(f)?.isDirectory();
export const nonEmpty = (f: string) => (stat(f)?.size ?? 0) > 0;
export const touch = (f: string) => { const t = new Date(); try { fs.utimesSync(f, t, t); } catch { fs.closeSync(fs.openSync(f, "a")); } };
export const rm = (...files: string[]) => { for (const f of files) fs.rmSync(f, { force: true }); };
export const rmrf = (p: string) => fs.rmSync(p, { recursive: true, force: true });
export const mkdirp = (d: string) => fs.mkdirSync(d, { recursive: true });
export const ls = (d: string) => { try { return fs.readdirSync(d).filter((n) => !n.startsWith(".")).sort(); } catch { return []; } };
export const json = (s: string | null): Json | null => { try { const j = JSON.parse(s ?? ""); return j && typeof j === "object" && !Array.isArray(j) ? j : null; } catch { return null; } };
// A value as jq prints it in a string ("\(.x)").
export const jqs = (v: unknown) => v === undefined || v === null ? "null" : typeof v === "string" ? v : JSON.stringify(v);
export const alt = (v: unknown, d: unknown) => v === undefined || v === null || v === false ? d : v;   // jq's //
// "<unit> from <host>": who wrote a stamp.
export const who = (rs: string) => { const j = json(rs); return j ? `${j.ci != null ? `${jqs(j.ci)}'s CI` : jqs(alt(j.unit, j.copying))} from ${jqs(j.host)}` : ""; };
export const p2 = (n: number) => String(n).padStart(2, "0");
export const log = (m: string) => { const d = new Date(); process.stderr.write(`${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())} store: ${m}\n`); };
export const timeName = (d = new Date()) => `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
export const MB = (n: number) => Math.floor(n / 1048576);
export const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), "store-"));

// Every entry under a folder, its path from there and its own stat (links not followed).
export function* walk(dir: string, rel = ""): Generator<{ rel: string; name: string; st: fs.BigIntStats }> {
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names.sort()) {
    const p = `${dir}/${name}`, r = rel ? `${rel}/${name}` : name;
    let st: fs.BigIntStats;
    try { st = fs.lstatSync(p, { bigint: true }); } catch { continue; }
    yield { rel: r, name, st };
    if (st.isDirectory()) yield* walk(p, r);
  }
}
export const count = (dir: string, keep: (e: { name: string; st: fs.BigIntStats }) => boolean) => { let n = 0; for (const e of walk(dir)) if (keep(e)) n++; return n; };
// `find -L <dir> -type f -printf '%P\t%s\t%T@\n'`, in Node (BSD find has no -printf): each file
// under a folder, links followed, as its path from there, its size and its modification time as
// find prints it (seconds, then ten digits), which the stamps' listings hold. A link back to a
// folder above isn't followed. With follow false, `find` without -L: links aren't followed.
export function filesFollowed(dir: string, follow = true): string[] {
  const out: string[] = [], above = new Set<string>();
  const t = (st: fs.BigIntStats) => `${st.mtimeNs / 1_000_000_000n}.${String(st.mtimeNs % 1_000_000_000n).padStart(9, "0")}0`;
  const go = (p: string, rel: string) => {
    let st: fs.BigIntStats;
    try { st = (follow ? fs.statSync : fs.lstatSync)(p, { bigint: true }); } catch { return; }
    if (st.isFile()) { out.push(`${rel}\t${st.size}\t${t(st)}`); return; }
    if (!st.isDirectory()) return;
    const id = `${st.dev}:${st.ino}`;
    if (above.has(id)) return;
    above.add(id);
    let names: string[] = [];
    try { names = fs.readdirSync(p); } catch {}
    for (const n of names) go(`${p}/${n}`, rel ? `${rel}/${n}` : n);
    above.delete(id);
  };
  go(dir, "");
  return out;
}
// `du -sbL`, in Node (BSD du has no -b): the bytes under a path, links followed, each file and
// file once (its own size, not the disk it takes; a folder counts nothing, as in coreutils 9's du).
export function bytesFollowed(p: string, seen = new Set<string>()): number {
  let st: fs.BigIntStats;
  try { st = fs.statSync(p, { bigint: true }); } catch { return 0; }
  const id = `${st.dev}:${st.ino}`;
  if (seen.has(id)) return 0;
  seen.add(id);
  let n = st.isDirectory() ? 0 : Number(st.size);
  if (st.isDirectory()) { try { for (const x of fs.readdirSync(p)) n += bytesFollowed(`${p}/${x}`, seen); } catch {} }
  return n;
}
// Is there a file under p (a plain one; with plain false, anything but a folder), links followed?
export function anyFile(p: string, plain: boolean, seen = new Set<string>()): boolean {
  let st: fs.Stats;
  try { st = fs.statSync(p); } catch { try { fs.lstatSync(p); return !plain; } catch { return false; } }   // a dangling link
  if (!st.isDirectory()) return plain ? st.isFile() : true;
  const id = `${st.dev}:${st.ino}`;
  if (seen.has(id)) return false;
  seen.add(id);
  let names: string[];
  try { names = fs.readdirSync(p); } catch { return false; }
  return names.some((n) => anyFile(`${p}/${n}`, plain, seen));
}
// Delete the empty folders in a folder, bottom up, itself too (`find -depth -type d -empty -delete`).
export function dropEmpty(dir: string) {
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const n of names) { try { if (fs.lstatSync(`${dir}/${n}`).isDirectory()) dropEmpty(`${dir}/${n}`); } catch {} }
  try { if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch {}
}
// `cmp -s`: the same bytes.
export function sameBytes(a: string, b: string): boolean {
  let fa: number | undefined, fb: number | undefined;
  try {
    fa = fs.openSync(a, "r"); fb = fs.openSync(b, "r");
    if (fs.fstatSync(fa).size !== fs.fstatSync(fb).size) return false;
    const ba = Buffer.alloc(1 << 16), bb = Buffer.alloc(1 << 16);
    for (;;) {
      const na = fs.readSync(fa, ba), nb = fs.readSync(fb, bb);
      if (na !== nb || !ba.subarray(0, na).equals(bb.subarray(0, nb))) return false;
      if (na === 0) return true;
    }
  } catch { return false; } finally { if (fa !== undefined) fs.closeSync(fa); if (fb !== undefined) fs.closeSync(fb); }
}
// A store.rebuilt glob as bash's [[ f == glob ]] reads it: `*` crosses folders.
export function globRe(g: string) {
  const esc = (c: string) => c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  let s = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") s += "[\\s\\S]*";
    else if (c === "?") s += "[\\s\\S]";
    else if (c === "[" && g.indexOf("]", i + 2) > 0) {
      const j = g.indexOf("]", i + 2);
      let cls = g.slice(i + 1, j).replace(/\\/g, "\\\\");
      if (cls[0] === "!") cls = "^" + cls.slice(1);
      s += `[${cls}]`; i = j;
    } else if (c === "\\" && i + 1 < g.length) s += esc(g[++i]);
    else s += esc(c);
  }
  return new RegExp(`^${s}$`);
}
export const rebuilt = (f: string, globs: string[]) => globs.some((x) => globRe(x).test(f));
