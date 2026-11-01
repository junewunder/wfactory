// when.ts: the times people write, read without GNU date (macOS). Run: node --test runtime/test/
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readTime } from "../src/when.ts";

const now = new Date(2026, 9, 27, 14, 20, 30);
const at = (...a: [number, number, number, number?, number?, number?]) => new Date(a[0], a[1], a[2], a[3] ?? 0, a[4] ?? 0, a[5] ?? 0).getTime() / 1000;
const t0 = now.getTime() / 1000;

test("times of day are today's", () => {
  assert.equal(readTime("09:00", now), at(2026, 9, 27, 9));
  assert.equal(readTime("9", now), at(2026, 9, 27, 9));
  assert.equal(readTime("9am", now), at(2026, 9, 27, 9));
  assert.equal(readTime("9:30 PM", now), at(2026, 9, 27, 21, 30));
  assert.equal(readTime("12am", now), at(2026, 9, 27, 0));
  assert.equal(readTime("12pm", now), at(2026, 9, 27, 12));
  assert.equal(readTime("21:15:30", now), at(2026, 9, 27, 21, 15, 30));
});
test("days and dates, alone or with a time", () => {
  assert.equal(readTime("tomorrow 9am", now), at(2026, 9, 28, 9));
  assert.equal(readTime("tomorrow", now), at(2026, 9, 28, 14, 20, 30));
  assert.equal(readTime("yesterday 23:00", now), at(2026, 9, 26, 23));
  assert.equal(readTime("2026-11-01", now), at(2026, 10, 1));
  assert.equal(readTime("2026-11-01 07:45", now), at(2026, 10, 1, 7, 45));
  assert.equal(readTime("2026-11-01T07:45", now), at(2026, 10, 1, 7, 45));
});
test("moves from now or from a time", () => {
  assert.equal(readTime("now", now), t0);
  assert.equal(readTime("-24 hours", now), t0 - 86400);
  assert.equal(readTime("+2 days", now), t0 + 2 * 86400);
  assert.equal(readTime("3 hours ago", now), t0 - 3 * 3600);
  assert.equal(readTime("in 90 minutes", now), t0 + 90 * 60);
  assert.equal(readTime("tomorrow 9am -1 hour", now), at(2026, 9, 28, 8));
});
test("a day on keeps the clock time across a daylight-saving change, as GNU date does", () => {
  const tz = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    const before = new Date(2026, 9, 31, 12, 0, 0);   // the day before clocks go back
    assert.equal(readTime("+1 day", before), new Date(2026, 10, 1, 12, 0, 0).getTime() / 1000);
    assert.equal(readTime("tomorrow 12:00 +1 week", before), new Date(2026, 10, 8, 12, 0, 0).getTime() / 1000);
    assert.equal(readTime("+24 hours", before), before.getTime() / 1000 + 86400);
  } finally { if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz; }
});
test("anything else isn't a time", () => {
  for (const s of ["", " ", "soon", "25:00", "13pm", "9:75", "2026-02-30", "-24 parsecs", "tomorrow at noon"]) assert.equal(readTime(s, now), null, s);
});
test("each agrees with GNU date where there is one", { skip: process.platform !== "linux" }, () => {
  const n = new Date();
  for (const s of ["09:00", "9am", "9:30 pm", "tomorrow 9am", "tomorrow", "-24 hours", "3 hours ago", "2026-11-01 07:45", "now"]) {
    const g = Number(spawnSync("date", ["-d", s, "+%s"], { encoding: "utf8" }).stdout.trim());
    assert.ok(Math.abs(readTime(s, n)! - g) <= 1, `${s}: ${readTime(s, n)} vs ${g}`);
  }
});
