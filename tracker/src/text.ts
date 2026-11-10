// Small helpers for text, arguments and errors, with no knowledge of the tracker's state.
import fs from "node:fs";
import path from "node:path";

// A usage or data error: the command stops, prints the message, and exits 2.
export class UsageError extends Error {}
// Origin unreachable for a write that must be pushed (a claim).
export class NetError extends UsageError {}
// The tracker's lock stayed held by another command past the wait: nothing is wrong with the
// data, so the command exits 75 ("couldn't run now", as `just capped` uses it), and a caller
// that can wait tries again.
export class LockBusy extends UsageError {}
export const BUSY = 75;
export const die = (msg: string): never => { throw new UsageError(msg); };

export const now = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
// Today's date here, as YYYY-MM-DD (a prediction's date is a local one: commands/expect.ts).
export const today = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export const slugify = (s: string, max = 40) => {
  let out = s.toLowerCase().normalize("NFKD").replace(/[^\w\s.-]/g, " ").replace(/[_\s]+/g, "-")
    .replace(/-+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  if (out.length > max) out = out.slice(0, max).replace(/-[^-]*$/, "");
  return out || "x";
};
export const STOP = new Set("the and for with that this should does from into what which when will would have has are was were can not use one two any all our its it's".split(" "));
export const words = (s: string | undefined) => new Set((s || "").toLowerCase().match(/[a-z0-9]{3,}/g)?.filter((w) => !STOP.has(w)) || []);
export const overlap = (a: string, b: string) => { const A = words(a), B = words(b); if (!A.size || !B.size) return 0; let n = 0; for (const w of A) if (B.has(w)) n++; return n / Math.min(A.size, B.size); };
export const list = (s: unknown): string[] => (Array.isArray(s) ? s : String(s ?? "").split(",")).map((x) => String(x).trim()).filter(Boolean);
export const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;
export const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
export const reEsc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const keySlug = (s: string) => slugify([...(s.toLowerCase().match(/[a-z0-9]+/g) || [])].filter((w) => !STOP.has(w) && !/^(do|we|i|you|is|be|of|to|in|on|or|an|a|it|as|at|by|so|if|how|why|who|keep|get)$/.test(w)).slice(0, 5).join(" ") || s, 48);

// A title from longer text: up to the first break, at most 60 characters, on a word boundary.
export function shortTitle(s: string) {
  let t = s.replace(/`([^`]*)`/g, "$1").replace(/\*\*/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").trim();
  const cut = t.split(/(?::\s|\s[—–-]\s|\.\s|;\s|\s\()/)[0];
  if (cut.split(/\s+/).length >= 2) t = cut;
  if (t.length > 60) t = t.slice(0, 60).replace(/\s+\S*$/, "");
  return t;
}

// argv → { _: positional, flags (repeatable flags collect into arrays) }. A flag with no
// value is true.
export type Flag = string | true | string[] | undefined;
export interface Args {
  _: string[];
  [flag: string]: Flag | string[];
}
export function parseArgs(argv: string[], repeatable: string[] = []): Args {
  const out: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      let k: string, v: string | true;
      if (eq > 0) { k = a.slice(2, eq); v = a.slice(eq + 1); }
      else { k = a.slice(2); v = i + 1 < argv.length && !argv[i + 1].startsWith("--") ? argv[++i] : true; }
      if (repeatable.includes(k)) ((out[k] ||= []) as (string | true)[]).push(v); else out[k] = v;
    } else if (a === "-n") out.n = argv[++i];
    else out._.push(a);
  }
  return out;
}
// A flag's value when it was given one, else undefined (a bare flag is true).
export const str = (v: Flag | string[]): string | undefined => (typeof v === "string" ? v : undefined);
// A repeatable flag's values.
export const strs = (v: Flag | string[]): (string | true)[] => (Array.isArray(v) ? v : []);

export function writeAtomic(f: string, text: string) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, f);
}
