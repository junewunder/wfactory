// git's merge driver for tracker JSON (.gitattributes: tracker/**/*.json
// merge=tracker-json). Both sides' entries are kept: lists of things with an
// id merge by id, other lists keep both sides' additions, objects merge key by
// key. The same field changed two different ways is a real clash: it's named,
// ours is left in the file, and git reports a conflict.
import fs from "node:fs";
import { pretty } from "../store.ts";
import { die } from "../text.ts";
import { C } from "./registry.ts";

type Json = unknown;
type Obj = Record<string, Json>;
const same = (a: Json, b: Json) => JSON.stringify(a) === JSON.stringify(b);
const obj = (x: Json): x is Obj => !!x && typeof x === "object" && !Array.isArray(x);
function merge3(base: Json, ours: Json, theirs: Json, at: string, clashes: string[]): Json {
  if (same(ours, theirs)) return ours;
  if (same(base, ours)) return theirs;
  if (same(base, theirs)) return ours;
  if (Array.isArray(ours) && Array.isArray(theirs)) return mergeList(Array.isArray(base) ? base : [], ours, theirs, at, clashes);
  if (obj(ours) && obj(theirs)) {
    const b = obj(base) ? base : {}, out: Obj = {};
    for (const k of [...new Set([...Object.keys(ours), ...Object.keys(theirs)])]) {
      const v = merge3(b[k], ours[k], theirs[k], `${at}.${k}`, clashes);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  clashes.push(`${at || "(top)"}: ${JSON.stringify(ours)?.slice(0, 60)} here, ${JSON.stringify(theirs)?.slice(0, 60)} on the other side`);
  return ours;
}
function mergeList(base: Json[], ours: Json[], theirs: Json[], at: string, clashes: string[]) {
  const all = [...base, ...ours, ...theirs];
  const byId = all.length > 0 && all.every((x) => obj(x) && typeof x.id === "string");
  const key = byId ? (x: Json) => (x as Obj).id as string : (x: Json) => JSON.stringify(x);
  const B = new Map(base.map((x) => [key(x), x])), O = new Map(ours.map((x) => [key(x), x])), Th = new Map(theirs.map((x) => [key(x), x]));
  const out: Json[] = [];
  for (const x of ours) {
    const k = key(x);
    if (!Th.has(k) && B.has(k)) { if (byId && !same(B.get(k), x)) clashes.push(`${at}[${k}]: changed here, removed on the other side`); else continue; }
    out.push(byId && Th.has(k) ? merge3(B.get(k), x, Th.get(k), `${at}[${k}]`, clashes) : x);
  }
  // their new entries go after the entry that precedes them on their side
  theirs.forEach((x, i) => {
    const k = key(x);
    if (O.has(k)) return;
    if (B.has(k)) { if (byId && !same(B.get(k), x)) clashes.push(`${at}[${k}]: removed here, changed on the other side`); return; }
    let j = i - 1; while (j >= 0 && !out.some((y) => key(y) === key(theirs[j]))) j--;
    const pos = j < 0 ? (out.length && i === 0 ? 0 : out.length) : out.findIndex((y) => key(y) === key(theirs[j])) + 1;
    out.splice(pos, 0, x);
  });
  return out;
}
C["merge-json"] = (a) => {
  const [b, o, t, p_] = a;
  if (!t) die("usage: merge-json <base> <ours> <theirs> [<path>]  (git runs it; see .gitattributes)");
  const rd = (f: string): Json => { try { return JSON.parse(fs.readFileSync(f, "utf8") || "null"); } catch (e) { return e; } };
  const B = rd(b), O = rd(o), Th = rd(t);
  if ([B, O, Th].some((x) => x instanceof Error)) { console.error(`merge-json: ${p_ || o} isn't valid JSON on one side; merge it by hand`); return 1; }
  const clashes: string[] = [];
  const out = merge3(B, O, Th, "", clashes);
  if (clashes.length) { console.error(`merge-json: ${p_ || o}: the same thing changed both ways:\n  ${clashes.join("\n  ")}`); return 1; }
  fs.writeFileSync(o, pretty(out) + "\n");
  return 0;
};
