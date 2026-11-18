// The usage pause: between units, a lane pauses near the 5-hour limit until the window resets
// (usage.ts has the check, and the machine's one reading, which every factory's lanes here act
// on). The week's figure is never acted on.
// A paused lane needs no new reading to resume: its time is the window's reset. It looks at the
// reading again each minute all the same, since another factory's lanes may have read a newer
// one, or the owner changed a setting: no longer due to pause, it resumes then; due back at
// another time, it stays paused and says so, with no resume in between.
import { log } from "./session.ts";
import { epoch } from "./sys.ts";
import { hmAt } from "./loop-util.ts";
import { factoryRoot, readUsage, usageCheck, type Pause } from "./usage.ts";
import type { Loop } from "./loop.ts";

// How often a paused lane looks at the reading again (seconds).
const LOOK_S = 60;

// Pauses the lane while usage says to. True if it paused (the loop then starts its turn again:
// time has passed, and a stop or a pause may have been asked for meanwhile).
export async function usagePause(l: Loop): Promise<boolean> {
  const env = process.env, root = factoryRoot(env.FACTORY_ROOT!);
  const check = () => usageCheck(readUsage(root, env), env).pause;
  let p = check();
  if (!p) return false;
  // The reset is waited out a little longer: the plan's clock isn't this machine's.
  const slack = Number(env.FACTORY_USAGE_SLACK || 60);
  const say = (q: Pause) => { log(`usage pause: ${q.why}; resuming at ${hmAt(q.until)}`); l.event("usage-pause", `${q.why}; lanes resume at ${hmAt(q.until)}`); };
  say(p);
  for (;;) {
    const left = p.until + slack - epoch();
    if (left <= 0) break;
    if (!(await l.nap(Math.min(left, LOOK_S)))) return true;
    const q = check();
    if (!q) {
      // Before its time, so not by the clock: a newer reading, or a setting changed.
      if (epoch() < p.until) {
        const why = "the 5-hour window is no longer nearly used (a newer reading, or a changed setting)";
        log(`usage resume: ${why}`); l.event("usage-resume", why);
        return true;
      }
      continue;   // its window reset: the slack is still waited out
    }
    if (q.until !== p.until) { p = q; say(p); }
  }
  log("usage resume: the 5-hour window reset"); l.event("usage-resume", `the 5-hour window reset at ${hmAt(p.until)}`);
  return true;
}
