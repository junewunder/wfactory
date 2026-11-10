// The usage pause: between units, a lane pauses near the 5-hour limit until the window resets,
// and ahead of the week's line until the line reaches what's used (usage.ts has both, and the
// machine's one reading, which every factory's lanes here act on).
// A paused lane needs no new reading to resume: its time is worked out when it pauses. It looks
// at the reading again each minute all the same, since another factory's lanes may have read a
// newer one, or the owner changed a setting: no longer due to pause, it resumes then; due back
// at another time, it stays paused and says so, with no resume in between. (Readings come in
// whole percents, so the week's time moves by hours when it moves.)
import { log } from "./session.ts";
import { epoch } from "./sys.ts";
import { hmAt } from "./loop-util.ts";
import { dayHmAt, factoryRoot, readUsage, usageCheck, type Pause } from "./usage.ts";
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
  // A window's own reset is waited out a little longer: the plan's clock isn't this machine's.
  const slack = Number(env.FACTORY_USAGE_SLACK || 60);
  // A time within the day for the 5-hour window; the week's may be days off.
  const when = (q: Pause) => q.window === "week" ? dayHmAt(q.until) : hmAt(q.until);
  const say = (q: Pause) => { log(`usage pause: ${q.why}; resuming at ${when(q)}`); l.event("usage-pause", `${q.why}; lanes resume at ${when(q)}`); };
  say(p);
  for (;;) {
    const left = p.until + (p.reset ? slack : 0) - epoch();
    if (left <= 0) break;
    if (!(await l.nap(Math.min(left, LOOK_S)))) return true;
    const q = check();
    if (!q) {
      // Before its time, so not by the clock: a newer reading, or a setting changed.
      if (epoch() < p.until) {
        const why = `${p.window === "week" ? "the week is no longer ahead of its line" : "the 5-hour window is no longer nearly used"} (a newer reading, or a changed setting)`;
        log(`usage resume: ${why}`); l.event("usage-resume", why);
        return true;
      }
      continue;   // its window reset: the slack is still waited out
    }
    if (q.window !== p.window || q.until !== p.until) { p = q; say(p); }
  }
  log(`usage resume: ${p.back}`); l.event("usage-resume", `${p.back} at ${when(p)}`);
  return true;
}
