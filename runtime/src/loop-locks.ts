// The lane's locks, in the machine's lock folder (FACTORY_LOCKS): its unit's and the unit's
// resources', and CI's, held from the claim to the session's end; the claim lock; and the lane
// lock each running lane holds, which the last lane looks for.
import fs from "node:fs";
import { lockWithin, tryLock, unlock } from "./sys.ts";

const dir = () => process.env.FACTORY_LOCKS!;

export class Locks {
  private held = new Set<number>();
  add(fd: number) { this.held.add(fd); }
  // The unit's lock and its resources'. -w 2: the tracker's own check takes a lock for an
  // instant; only a lane holds one for longer.
  take(unit: string, res: string[]) {
    for (const f of [`unit-${unit.replace(/\//g, "__")}.lock`, ...res.map((r) => `res-${r}.lock`)]) {
      const fd = lockWithin(`${dir()}/${f}`, 2);
      if (fd === null) return false;
      this.held.add(fd);
    }
    return true;
  }
  unlock(fd: number) { if (this.held.delete(fd)) unlock(fd); }
  dropAll() { for (const fd of [...this.held]) this.unlock(fd); }
  // One lane on this machine claims at a time.
  claimLock() { return lockWithin(`${dir()}/claim.lock`, 86400 * 365) ?? (() => { throw new Error("couldn't take the claim lock"); })(); }
  // Is this the last lane running here (no other lane lock held)? The last lane to stop runs
  // factory/tidy: whatever the lanes started (an editor, a headless desktop) shouldn't outlive them.
  static lastLane(checkout: string) {
    const L = dir(), mine = `lane-${checkout}.lock`;
    for (const f of fs.readdirSync(L).filter((n) => n.startsWith("lane-") && n.endsWith(".lock") && n !== mine)) {
      const fd = tryLock(`${L}/${f}`);
      if (fd === null) return false;
      unlock(fd);
    }
    return true;
  }
}
