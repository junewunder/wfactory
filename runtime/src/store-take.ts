// take: a claimed unit's data here, with room made for it in this machine's cache.
import path from "node:path";
import { lock, unlock } from "./sys.ts";
import { copyDown, tend } from "./store-copy.ts";
import { ciStart, dirty, gf, glock, ready, used, workedOn } from "./store-local.ts";
import { copy } from "./store-remote.ts";
import { isFile, L, log, mkdirp, rm, touch } from "./store-util.ts";
import { room } from "./store-cache.ts";
import { data } from "./store-tracker.ts";

// take <group> --unit <id> [--new] [--mark <unit> <pid>]. The locks it takes are held until the
// command ends.
export function take(args: string[]): number {
  const g = args[0] ?? "";
  let unit = "", isNew = false, mark: [string, string] | null = null;
  for (let i = 1; i < args.length;) {
    if (args[i] === "--unit") { unit = args[i + 1] ?? ""; i += 2; }
    else if (args[i] === "--new") { isNew = true; i++; }
    else if (args[i] === "--mark") { mark = [args[i + 1] ?? "", args[i + 2] ?? ""]; i += 3; }
    else i++;
  }
  // A lease held here already: the copy here is the newest once a take under it finished.
  // Waiting on the group's lock waits for another lane's copy down still under way.
  if (!isNew) {
    const gl = glock(g);
    tend(g);
    if (ready(g)) log(`${g}: leased here already; the copy here is the newest`);
    // Worked on here (by a lane, or a copy back that didn't finish): newer than the store's.
    // (Also how a lease held from before .ready marks existed carries on.)
    else if (workedOn(g)) { touch(gf(g, "ready")); log(`${g}: leased here and worked on here; the copy here is the newest`); }
    else { unlock(gl); log(`${g}: leased here, but no copy down under this lease finished; copying down`); isNew = true; }
  }
  if (isNew) {
    // One copy down at a time on this machine, so two lanes can't both fill the last of the
    // cache. The cache lock comes before the group's, always.
    const cl = lock(`${L}/lock`);
    glock(g);
    tend(g);
    rm(gf(g, "ready"));
    const rc = room(g);
    if (rc !== 0) return rc;
    if (copyDown(g) !== 0) return 2;
    unlock(cl);
  }
  used(g);
  // Once all is here, the session's (or CI run's) mark, under the group's lock: no put-back can
  // start in between.
  // A CI run: whether the copy is the store's as it starts, for what it writes (clean --since).
  if (mark?.[0] === "ci") { const d = data([g]); if (!d) return 2; ciStart(g, d); }
  if (!unit) { if (mark) dirty(g, ...mark); return 0; }
  const d = data([g]), ui = d && data(["--unit", unit]);
  if (!d || !ui) return 2;
  for (const i of ui.inputs ?? []) {
    if (!i.input) continue;
    const mk = `${L}/inputs/${i.input}/${i.rel.replace(/\//g, "_")}.ok`;
    if (isFile(mk)) continue;
    const il = lock(`${L}/lock-input`);
    try {
      if (!isFile(mk)) {
        log(`input ${i.input}: copying down ${i.rel}`);
        if (!copy(`${d.remote}/inputs/${i.input}/${i.rel}/`, `${i.local}/`)) return 2;
        mkdirp(path.dirname(mk)); touch(mk);
      }
    } finally { unlock(il); }
  }
  if (mark) dirty(g, ...mark);
  return 0;
}
