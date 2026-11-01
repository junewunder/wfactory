// The copy here (work/.store/): its stamp and file list, its marks, the group's lock, and
// whether it may be deleted.
import fs from "node:fs";
import { lock, tryLock, unlock } from "./sys.ts";
import { here } from "./store-here.ts";
import { platform } from "./os.ts";
import { code, remoteStamp, rsync, run } from "./store-remote.ts";
import { alt, anyFile, bytesFollowed, cat, filesFollowed, fields, isFile, json, L, nonEmpty, out, rm, touch, type Data } from "./store-util.ts";
import { data } from "./store-tracker.ts";

export const gf = (g: string, ext: string) => `${L}/groups/${g}.${ext}`;
// A group's marks of one kind (dirty, unmerged), as paths.
export function marks(g: string, kind: string) {
  const pre = `${g}.${kind}.`;
  try { return fs.readdirSync(`${L}/groups`).filter((n) => n.startsWith(pre)).sort().map((n) => `${L}/groups/${n}`); } catch { return []; }
}
// The groups with a copy here (a stamp).
export const groupsHere = () => { try { return fs.readdirSync(`${L}/groups`).filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5)).sort(); } catch { return []; } };
export const localStamp = (g: string) => cat(gf(g, "json")) ?? "";
export const used = (g: string) => touch(gf(g, "used"));
export const ready = (g: string) => isFile(gf(g, "ready"));
export const workedOn = (g: string) => marks(g, "dirty").length > 0 || marks(g, "unmerged").length > 0 || isFile(gf(g, "unsent"));
export const glock = (g: string) => lock(`${L}/lock-${g}`);

// A process's start time: with its pid, it names that one process.
export const pstart = (pid: string) => /^[0-9]+$/.test(pid) ? platform.processStart(Number(pid)) : "";
// Is the session that made this mark still running? Its loop's pid and start time say. A mark
// without them (an older store.sh, or by hand): whether its lane's loop holds the lane lock.
export function markLive(f: string): boolean {
  const [, pid = "", st = ""] = fields(f) ?? [];
  if (pid && /^[0-9]+$/.test(st)) return pstart(pid) === st;
  // (A start time that isn't a number is ps's, from an older store.sh still running in a lane.)
  if (pid && st) return out(run("ps", ["-o", "lstart=", "-p", pid], { err: "ignore" }).stdout) === st;
  if (pid) return false;
  const lk = `${here.locks}/lane-${f.slice(f.lastIndexOf(".dirty.") + 7)}.lock`;
  if (!fs.existsSync(lk)) return false;
  const fd = tryLock(lk);
  if (fd === null) return true;
  unlock(fd);
  return false;
}
// A session in this lane (its loop's pid) is about to work on the group (unit "ci": a CI run).
export const dirty = (g: string, unit = "", pid = "") => fs.writeFileSync(gf(g, `dirty.${here.lid}`), `${unit}\t${pid}\t${pid ? pstart(pid) : ""}\n`);
// by and built: the session and the commit its outputs were built from, as the lane it ended in
// knew them (end); "" from a mark whose loop is gone.
export const unmerged = (g: string, u: string, c: string, by = "", built = "") => fs.writeFileSync(gf(g, `unmerged.${(u || "unknown").replace(/\//g, "+")}`), `${u}\t${c}${by || built ? `\t${by}\t${built}` : ""}\n`);
// A copy back is due (.unsent); .retry keeps the unit and commit to stamp it with, its failed
// tries and when the last one was (each "" where the mark has none).
export interface Retry { unit: string; commit: string; tries: string; at: string }
export function retryOf(g: string): Retry {
  const [unit = "", commit = "", tries = "", at = ""] = fields(gf(g, "retry")) ?? [];
  return { unit, commit, tries, at };
}
export const setRetry = (g: string, r: Retry) => fs.writeFileSync(gf(g, "retry"), `${r.unit}\t${r.commit}\t${r.tries}\t${r.at}\n`);
// A copy back's unit "ci" is a CI run's (as in a session mark): its stamp says the group's CI.
export const after = (g: string, u: string) => u === "ci" ? `${g}'s CI run` : u;
// The copy back owed is a CI run's alone: what it holds is main's, rebuilt from git (ciMade).
export const ciOwed = (g: string) => isFile(gf(g, "unsent")) && retryOf(g).unit === "ci";
export function due(g: string, u: string, c: string) {
  let a = "0", t = "0";
  if (nonEmpty(gf(g, "retry"))) { const r = retryOf(g); a = r.tries || "0"; t = r.at || "0"; }
  touch(gf(g, "unsent"));
  setRetry(g, { unit: u, commit: c, tries: a, at: t });
}
// Seconds to wait after the <n>th failed try: 2, 4, 8, 16, then 30 minutes (FACTORY_STORE_RETRY: the first).
export const backoff = (n: number) => Math.min(Number(process.env.FACTORY_STORE_RETRY || 2) * 60 * (1 << (n < 5 ? n - 1 : 4)), 1800);

// The group's size here (du -sbL's, following links).
export function bytes(d: Data) {
  let n = 0;
  for (const p of d.paths) n += bytesFollowed(p.local);
  return n;
}
export const gsize = (g: string) => { const d = data([g], true); return d ? bytes(d) : 0; };
// The group's files here, one line each: path name, file, size, modification time.
export function listing(d: Data) {
  const lines: string[] = [];
  for (const p of d.paths) {
    if (!fs.existsSync(p.local)) continue;
    lines.push(...filesFollowed(p.local).map((l) => `${p.name}\t${l}`));
  }
  return lines.sort();
}
export const hasFiles = (d: Data) => d.paths.some((p) => anyFile(p.local, true));
// The copy here equals the store's. mirror: every file the listing names was on the store (a copy
// with --delete both ways over every path here, or one checked identical); a seed's copy down, which
// keeps files here the store lacks, isn't. Only a mirror's listing vouches for single files (stamped).
export function stampHere(g: string, d: Data, st: string, mirror = false) {
  fs.writeFileSync(gf(g, "json"), `${st}\n`);
  if (mirror) touch(gf(g, "mirror")); else rm(gf(g, "mirror"));
  // In sort(1)'s order, as an older store.sh, still running in another lane here, compares it.
  const lines = listing(d).map((l) => `${l}\n`).join("");
  fs.writeFileSync(gf(g, "list"), lines && run("sort", [], { input: lines }).stdout);
}
// A CI run here on the group is starting (take --mark ci): whether the copy is as it was stamped,
// by a mirror, with no other work in it. Only then can what the run writes be told to be main's.
export const ciStart = (g: string, d: Data) => fs.writeFileSync(gf(g, `cistart.${here.lid}`),
  isFile(gf(g, "mirror")) && unchanged(g, d) && !workedOn(g) ? "clean\n" : "changed\n");
// A CI run here on the group is over (clean --since): the files it wrote (written since it started)
// go into the stamp's listing, as if the copy had been stamped with them. CI runs main's code over a
// copy that was the store's when it started (ciStart), so what it writes is rebuilt from git: a
// later copy down replaces them without keeping them, rather than taking the copy for one changed
// by hand. Not while other work here isn't on the store (a session's mark, unmerged outputs, a
// copy back owed): then the copy is one worked on anyway. The number of files it wrote, or null
// when the copy isn't the store's and the run's alone (then it isn't copied back either: ciOwed).
export function ciMade(g: string, d: Data, since: number): number | null {
  const start = cat(gf(g, `cistart.${here.lid}`)) ?? "";
  rm(gf(g, `cistart.${here.lid}`));
  if (start.trim() !== "clean" || !isFile(gf(g, "list")) || !isFile(gf(g, "json")) || !isFile(gf(g, "mirror"))) return null;
  if (marks(g, "dirty").some((f) => f !== gf(g, `dirty.${here.lid}`)) || marks(g, "unmerged").length || isFile(gf(g, "unsent"))) return null;
  const key = (l: string) => l.split("\t").slice(0, 2).join("\t");
  const made = listing(d).filter((l) => Number(l.split("\t")[3]) >= since);
  if (!made.length) return 0;
  const was = new Map((cat(gf(g, "list")) ?? "").split("\n").filter(Boolean).map((l) => [key(l), l]));
  for (const l of made) was.set(key(l), l);
  const lines = [...was.values()].map((l) => `${l}\n`).join("");
  fs.writeFileSync(gf(g, "list"), run("sort", [], { input: lines }).stdout);
  return made.length;
}
// The stamp's listing, by <name>\t<path>: <size>\t<time>.
export const stamped = (g: string) => !isFile(gf(g, "mirror")) ? new Map<string, string>() : new Map((cat(gf(g, "list")) ?? "").split("\n").filter(Boolean).map((l) => {
  const f = l.split("\t"); return [`${f[0]}\t${f[1]}`, `${f[2]}\t${f[3]}`] as const;
}));
// Its files as they were when it was stamped (by name, size and time; in any order, so a list an
// older store.sh sorted by the locale still matches).
export const unchanged = (g: string, d: Data) => isFile(gf(g, "list")) && listing(d).join("\n") === (cat(gf(g, "list")) ?? "").split("\n").filter(Boolean).sort().join("\n");
// The store holds a copy back of this machine's own that didn't finish (a suspend mid-copy, say,
// then the lease went stale and was taken again here): the copy here is the whole of it.
export const ownTorn = (g: string, rs: string) => { const j = json(rs); return isFile(gf(g, "unsent")) && !!j && j.copying != null && j.host === here.host; };

// The store's stamp for a group, by its data's remote (remoteStamp).
export const remoteOf = (g: string) => { const d = data([g]); return d ? remoteStamp(d.remote, g) : null; };

// May the copy here be deleted? See HELP.
export function safe(g: string): boolean {
  const d = data([g]);
  if (!d || workedOn(g)) return false;
  const ls = localStamp(g), rs = remoteStamp(d.remote, g);
  if (!rs || !ls) return false;
  if (ls !== rs) {
    // The store moved on: only forward (a finished copy back, newer than the copy here), never
    // a torn copy or an older one put back. Then the copy here is safe if it's as it was.
    const j = json(rs), l = json(ls);
    if (!j || !l || (j.unit ?? j.ci) == null || j.copying != null || !(String(alt(j.at, "")) > String(alt(l.at, "")))) return false;
    return unchanged(g, d);
  }
  for (const p of d.paths) {
    if (!fs.existsSync(p.local)) continue;
    const r = rsync(["-a", "--dry-run", "--delete", "-i", "--protect-args", `${p.local}/`, `${d.remote}/groups/${g}/${p.name}/`], { err: "pipe" });
    if (code(r) !== 0 || r.stdout + r.stderr !== "") return false;
  }
  return true;
}
