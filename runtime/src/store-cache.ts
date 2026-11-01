// The cache: groups' data here stays under this machine's Cache in docs/machines.md, the least
// recently used safe groups deleted to make room.
import fs from "node:fs";
import { machineGet } from "./machines.ts";
import { here } from "./store-here.ts";
import { bytes, gf, groupsHere, gsize, localStamp, ownTorn, safe } from "./store-local.ts";
import { remoteStamp } from "./store-remote.ts";
import { data, heldHere } from "./store-tracker.ts";
import { L, MB, alt, isFile, json, log, rm, rmrf } from "./store-util.ts";

export function limitBytes(): number | null {
  const c = process.env.FACTORY_CACHE || (machineGet(here.host, "cache") ?? "");
  if (["", "none", "-", "—", "no limit"].includes(c)) return 0;
  const m = /^([0-9]+(?:\.[0-9]+)?)([KMGTPEZY]?)$/i.exec(c.replace(/B$/, ""));
  return m ? Math.ceil(Number(m[1]) * 1024 ** (m[2] ? "KMGTPEZY".indexOf(m[2].toUpperCase()) + 1 : 0)) : null;
}

// Room for a group's copy down; the cache lock is held. 0 = room, 1 = none, 2 = error.
export function room(g: string): number {
  const limit = limitBytes();
  if (limit === null) { log("Cache in docs/machines.md isn't a size (e.g. 100G)"); return 2; }
  if (limit <= 0) return 0;
  const d = data([g]);
  if (!d) return 2;
  const rs = remoteStamp(d.remote, g);
  if (rs === null) return 2;
  // Nothing will be copied down (nothing on the store, the copy here current, or this machine's own
  // copy back to finish): the cache doesn't grow.
  if (!rs || rs === localStamp(g) || ownTorn(g, rs)) return 0;
  const need = Number(alt(json(rs)?.bytes, 0)) || 0, have = bytes(d);
  let total = 0;
  for (const x of groupsHere()) if (x !== g) total += gsize(x);
  const want = total + Math.max(need, have);
  if (want <= limit) return 0;
  // Least recently used first; only what's safe and not leased here. Plan first: delete nothing
  // unless deleting is enough.
  const lru = (() => { try { return fs.readdirSync(`${L}/groups`).filter((n) => n.endsWith(".used")).map((n) => ({ g: n.slice(0, -5), t: fs.statSync(`${L}/groups/${n}`).mtimeMs })).sort((a, b) => a.t - b.t).map((x) => x.g); } catch { return []; } })();
  const plan: [string, number][] = [];
  let free = want;
  for (const cand of lru) {
    if (free <= limit) break;
    if (cand === g || !isFile(gf(cand, "json"))) continue;
    if (heldHere(cand) || !safe(cand)) continue;
    const x = gsize(cand);
    plan.push([cand, x]); free -= x;
  }
  if (free <= limit) {
    for (const [cand, x] of plan) {
      for (const p of data([cand])?.paths ?? []) rmrf(p.local);
      rm(gf(cand, "json"), gf(cand, "list"), gf(cand, "mirror"), gf(cand, "used"), gf(cand, "ready"));
      log(`${cand}: deleted here to make room (safe on the store; ${MB(x)} MB)`);
    }
    return 0;
  }
  log(`no room for ${g}: the cache would be ${Math.floor(want / 1073741824)} GB of ${Math.floor(limit / 1073741824)} GB, and nothing else here is safe to delete`);
  return 1;
}
