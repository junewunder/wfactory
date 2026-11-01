// Releasing leases: once a group's data here is all on the store, and as the last lane stops.
import fs from "node:fs";
import { event } from "./events.ts";
import { lock, tryLock, unlock } from "./sys.ts";
import { aside, overnight } from "./store-aside.ts";
import { tend } from "./store-copy.ts";
import { here } from "./store-here.ts";
import { gf, glock, localStamp, marks, workedOn } from "./store-local.ts";
import { code, type Run } from "./store-remote.ts";
import { isFile, L, log, out, rm } from "./store-util.ts";
import { remoteOf } from "./store-local.ts";
import { tr } from "./store-tracker.ts";

// Is everything this machine wrote to the group on the store? (For releasing its lease.)
export function onStore(g: string, now = false): boolean {
  if (isFile(gf(g, "unsent"))) return false;
  if (!now && (marks(g, "dirty").length || marks(g, "unmerged").length)) return false;
  const rs = remoteOf(g);
  return rs !== null && rs === localStamp(g);
}
export function release(g: string, why: string) {
  if (code(tr(["lease", "release", g, "--why", why])) === 0) { rm(gf(g, "ready")); log(`${g}: lease released (${why})`); }
  else log(`${g}: couldn't release its lease; it goes stale in 30 minutes`);
}
export const words = (r: Run) => out(r.stdout).split(/\s+/).filter(Boolean);

export function releaseIdle(): number {
  // (Main as last fetched will do: the loop holds the claim lock meanwhile.)
  const fetch = process.env.FACTORY_FETCH_EVERY;
  process.env.FACTORY_FETCH_EVERY = "20";
  try { if (aside(["sort"], false) !== 0) log("aside sort failed"); } catch { log("aside sort failed"); }
  finally { if (fetch === undefined) delete process.env.FACTORY_FETCH_EVERY; else process.env.FACTORY_FETCH_EVERY = fetch; }
  // What each copy here owes the store (tend): a copy back that failed is tried again, at its next
  // try, whether or not the group has units left here. A group busy here waits for the next look.
  const gs = new Set<string>();
  for (const n of (() => { try { return fs.readdirSync(`${L}/groups`); } catch { return []; } })()) {
    if (n.endsWith(".unsent")) gs.add(n.slice(0, -7));
    else for (const k of [".unmerged.", ".dirty."]) { const i = n.lastIndexOf(k); if (i >= 0) { gs.add(n.slice(0, i)); break; } }
  }
  for (const g of [...gs].sort()) {
    const fd = tryLock(`${L}/lock-${g}`);
    if (fd === null) continue;
    try { tend(g); } catch { log(`${g}: settling it failed`); } finally { unlock(fd); }
  }
  for (const g of words(tr(["lease", "idle"], "ignore"))) {
    if (onStore(g)) release(g, `no more units for it on ${here.host}`);
    else log(`${g}: no more units here, but not all its data is on the store; keeping the lease`);
  }
  return 0;
}

// The last lane stopping: copy back and release (now, "stop now": release only what's already safe).
export function leave(now: boolean): number {
  // Kept sets a whole run outlasted become ones to sort, and sets aside get their units before the
  // lanes go, so they're on main for the next run anywhere. Only the first leave since a session ran
  // here (the loop touches ran as each one ends) ends a run: two lanes stopping together both
  // leave, and lanes started and stopped again with no session between (a redeploy) end none (#140).
  // The night lock is held while that leave walks the sets, so the other's marking (below) waits
  // for it: a set made in this run isn't marked and then sorted straight away, a run early.
  try {
    const fd = lock(`${L}/lock-night`);
    try { if (isFile(`${L}/ran`)) { rm(`${L}/ran`); overnight(false); } } finally { unlock(fd); }
  } catch { log("sorting the kept sets failed"); }
  const sort = () => { try { if (aside(["sort"], false) !== 0) log("aside sort failed"); } catch { log("aside sort failed"); } };
  sort();
  for (const g of words(tr(["lease", "mine", "--all"], "ignore"))) {
    // The lanes have stopped, so every session mark here is a session that ended without its loop.
    if (!now && workedOn(g)) {
      let fd: number | null = null, failed = true;
      try { fd = glock(g); failed = tend(g, true, true); } catch {} finally { if (fd !== null) unlock(fd); }
      if (failed) {
        log(`${g}: couldn't copy it back; keeping the lease`);
        event("lease-kept", `${g}'s data on ${here.host} couldn't be copied back as the lanes stopped; its lease stays until ${here.host}'s lanes start again or it goes stale`);
        continue;
      }
    }
    // Stop now: the last finished unit's data has to be on the store; a cut-short session's isn't copied.
    if (onStore(g, now)) release(g, `the lanes on ${here.host} stopped`);
    else {
      log(`${g}: not all its data is on the store; the lease stays until it's stale`);
      event("lease-kept", `${g}'s data on ${here.host} isn't all on the store; its lease stays until ${here.host}'s lanes start again or it goes stale`);
    }
  }
  // The sets the put-backs above made get their units now, not at the next lane start (#140).
  sort();
  // Every set still kept, those put back just now included, has the next run to be wanted.
  try { const fd = lock(`${L}/lock-night`); try { overnight(true); } finally { unlock(fd); } } catch { log("marking the kept sets failed"); }
  return 0;
}
