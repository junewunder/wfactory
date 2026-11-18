// A machine's lanes by the time of day: the Lanes cell's day and night counts (machines.ts,
// laneCount) and when night is: the profile's "night" setting, in the machine's local time.
import { profileGet } from "./profile.ts";
import type { LaneCount } from "./machines.ts";

export const NIGHT = "22:00-07:00";
// Night, as minutes after midnight: from (it starts), to (day starts); text as the log says it.
export interface Night { from: number; to: number; text: string }

const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
// "22:00-07:00" ("22-7", "1:30–5" too); null if it isn't a span of the day.
export function parseNight(s: string): Night | null {
  const m = /^\s*([0-9]{1,2})(?::([0-9]{2}))?\s*[-–]\s*([0-9]{1,2})(?::([0-9]{2}))?\s*$/.exec(s);
  if (!m) return null;
  const [h1, m1, h2, m2] = [m[1], m[2] ?? "0", m[3], m[4] ?? "0"].map(Number);
  if (h1 > 23 || h2 > 23 || m1 > 59 || m2 > 59) return null;
  const from = h1 * 60 + m1, to = h2 * 60 + m2;
  return from === to ? null : { from, to, text: `${hhmm(from)}–${hhmm(to)}` };
}
// The profile's night, else the default (one it can't read too).
export const nightOf = (env: NodeJS.ProcessEnv = process.env): Night => parseNight(profileGet("night", NIGHT, env)) ?? parseNight(NIGHT)!;

const minuteOf = (t: number) => { const d = new Date(t * 1000); return d.getHours() * 60 + d.getMinutes(); };
export function isNight(t: number, n: Night) {
  const m = minuteOf(t);
  return n.from < n.to ? m >= n.from && m < n.to : m >= n.from || m < n.to;
}
export const countAt = (c: LaneCount, t: number, n: Night) => isNight(t, n) ? c.night : c.day;
// The next moment after t (epoch seconds) the machine's clock reads that minute of the day.
export function nextAt(t: number, min: number) {
  const d = new Date(t * 1000);
  d.setHours(Math.floor(min / 60), min % 60, 0, 0);
  while (d.getTime() / 1000 <= t) d.setDate(d.getDate() + 1);
  return Math.floor(d.getTime() / 1000);
}
// When lane <lane> works next, from t: t if the count for now takes it in, else the next
// boundary (nightfall or morning); null if neither count does.
export function worksFrom(lane: number, c: LaneCount, t: number, n: Night): number | null {
  if (countAt(c, t, n) >= lane) return t;
  if (Math.max(c.day, c.night) < lane) return null;
  return nextAt(t, isNight(t, n) ? n.to : n.from);
}
