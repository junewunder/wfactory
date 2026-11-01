// A time as people write it, read without GNU date (macOS's date has no -d): the forms the fleet's
// help names, in local time. "now"; a time of day ("09:00", "9", "9am", "9:30 pm", "21:15:30"),
// today's; "today", "tomorrow" or "yesterday", alone (this time that day) or before a time of day;
// a date ("2026-10-28"), alone (its midnight) or before a time of day (a "T" between allowed);
// and moves from any of those: "-24 hours", "+2 days", "3 hours ago", "in 90 minutes". Epoch
// seconds, null if it can't be read.
const UNITS: Record<string, number> = { s: 1, sec: 1, second: 1, min: 60, minute: 60, h: 3600, hour: 3600, day: 86400, week: 604800 };

function timeOfDay(s: string): [number, number, number] | null {
  const m = /^(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*(am|pm)?$/.exec(s);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0), sec = Number(m[3] ?? 0);
  if (m[4]) { if (h < 1 || h > 12) return null; h = h % 12 + (m[4] === "pm" ? 12 : 0); }
  return h < 24 && min < 60 && sec < 60 ? [h, min, sec] : null;
}

export function readTime(text: string, now = new Date()): number | null {
  let s = text.trim().toLowerCase().replace(/\s+/g, " ");
  if (!s) return null;
  // The moves, taken off the end one at a time: days and weeks on the calendar (the clock time
  // kept across a daylight-saving change, as GNU date keeps it), the rest in seconds.
  let move = 0, days = 0;
  for (;;) {
    const m = /(?:^| )(?:(in) )?([+-]?\d+) ?([a-z]+?)s?( ago)?$/.exec(s);
    if (!m || UNITS[m[3]] === undefined) break;
    const n = Number(m[2]) * (m[4] ? -1 : 1);
    if (UNITS[m[3]] >= 86400) days += n * UNITS[m[3]] / 86400; else move += n * UNITS[m[3]];
    s = s.slice(0, m.index).trim();
  }
  const d = new Date(now.getTime());
  d.setMilliseconds(0);
  const day = /^(today|tomorrow|yesterday)(?: (.*))?$/.exec(s);
  const date = /^(\d{4})-(\d{2})-(\d{2})(?:[ t](.*))?$/.exec(s);
  let rest: string | undefined = s;
  if (day) {
    d.setDate(d.getDate() + (day[1] === "tomorrow" ? 1 : day[1] === "yesterday" ? -1 : 0));
    rest = day[2];
  } else if (date) {
    const [y, mo, da] = [Number(date[1]), Number(date[2]), Number(date[3])];
    d.setFullYear(y, mo - 1, da);
    if (d.getMonth() !== mo - 1 || d.getDate() !== da) return null;
    d.setHours(0, 0, 0);
    rest = date[4];
  } else if (s === "now" || s === "") rest = undefined;
  if (rest !== undefined) {
    const t = timeOfDay(rest);
    if (!t) return null;
    d.setHours(...t);
  }
  d.setDate(d.getDate() + days);
  return Math.floor(d.getTime() / 1000) + move;
}
