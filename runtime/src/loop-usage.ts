// The usage pause: between units, a lane pauses near the 5-hour limit until the window resets,
// and ahead of the week's line until the line reaches what's used (usage.ts has both, and the
// machine's one reading, which every factory's lanes here act on).
// A paused lane needs no new reading to resume: its time is worked out when it pauses. It looks
// at the reading again each minute all the same, since another factory's lanes may have read a
// newer one, or the owner changed a setting: no longer due to pause, it resumes then; due back
// later, it stays paused and says so (to the overseer too, once the time has moved by half an
// hour or the window is another), with no resume in between.
import { log } from "./session.ts";
import { epoch } from "./sys.ts";
import { hmAt } from "./loop-util.ts";
import { dayHmAt, factoryRoot, readUsage, usageCheck, type Pause } from "./usage.ts";
import type { Loop } from "./loop.ts";

// How often a paused lane looks at the reading again, and how far its time must move for the
// overseer to hear of it again (seconds).
const LOOK_S = 60, TELL_S = 1800;

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
  const say = (q: Pause, tell: boolean) => {
    log(`usage pause: ${q.why}; resuming at ${when(q)}`);
    if (tell) l.event("usage-pause", `${q.why}; lanes resume at ${when(q)}`);
  };
  say(p, true);
  let told = p;
  for (;;) {
    const left = p.until + (p.reset ? slack : 0) - epoch();
    if (left <= 0) break;
    if (!(await l.nap(Math.min(left, LOOK_S)))) return true;
    const q = check();
    if (!q) {
      // Before its time, so not by the clock: a newer reading, or a setting changed.
      if (epoch() < p.until) { log("usage resume: no longer due to pause (a newer reading, or a changed setting)"); l.event("usage-resume", "no longer due to pause (a newer reading, or a changed setting)"); return true; }
      continue;   // its window reset: the slack is still waited out
    }
    if (q.window !== p.window || q.until !== p.until) {
      const tell = q.window !== told.window || Math.abs(q.until - told.until) >= TELL_S;
      say(q, tell);
      if (tell) told = q;
      p = q;
    }
  }
  log(`usage resume: ${p.back}`); l.event("usage-resume", `${p.back} at ${when(p)}`);
  return true;
}
