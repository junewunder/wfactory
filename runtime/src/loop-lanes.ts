// A day count and a night count (--lanes "2, 4 at night", which fleet start passes on from
// docs/machines.md's Lanes): between units, a lane whose number is past its machine's count for
// the time of day takes no new unit; it waits until the count takes it in again (nightfall, or
// the morning), then works on. So a lane is never stopped mid-unit by the time of day, and one
// waiting keeps its clone, its records and its daemon record: it's still running. When night is:
// the profile's "night" (night.ts), on the lane's own machine, read at each look so a changed
// setting counts. One count ("2", or none given) never waits.
import { log } from "./session.ts";
import { epoch } from "./sys.ts";
import { exists, hmAt } from "./loop-util.ts";
import { laneMax, showLanes } from "./machines.ts";
import { countAt, isNight, nextAt, nightOf, worksFrom } from "./night.ts";
import type { Loop } from "./loop.ts";

// How often a waiting lane looks again (seconds): the profile's night may have changed.
const LOOK_S = 60;

// Waits while the lane is past the count for the time of day. True if it waited (the loop then
// starts its turn again: a stop, a pause or last call may have come meanwhile).
export async function lanesRest(l: Loop): Promise<boolean> {
  const c = l.o.lanes, n = Number(l.lane);
  // (In last call it takes no new units anyway, and runs CI that's due.)
  if (!c || c.day === c.night || l.clock.inLc || laneMax(c) < n) return false;
  let night = nightOf(process.env);
  let back = worksFrom(n, c, epoch(), night);
  if (back === null || back <= epoch()) return false;
  const what = isNight(epoch(), night) ? "day" : "night";
  const say = () => log(`waiting for ${what}: lane ${n} works ${what === "night" ? "at night" : "by day"} only (${l.host} runs ${showLanes(c)}; night is ${night.text}); back at ${hmAt(back!)}`);
  say();
  for (;;) {
    const left = back - epoch();
    if (left <= 0) break;
    if (!(await l.nap(Math.min(left, LOOK_S), true))) return true;
    if (exists("runs/.last-call") || l.clock.inLastCall()) return true;
    night = nightOf(process.env);
    const b = worksFrom(n, c, epoch(), night);
    if (b === null || b <= epoch()) break;
    if (b !== back) { back = b; say(); }
  }
  const now = epoch(), was = isNight(now, night);
  log(`${was ? "night" : "day"}: lane ${n} is back at work (${l.host} runs ${countAt(c, now, night)} until ${hmAt(nextAt(now, was ? night.to : night.from))})`);
  return true;
}
