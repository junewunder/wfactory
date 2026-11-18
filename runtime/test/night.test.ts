// A machine's lanes by the time of day: the Lanes cell's one count or its day and night counts
// (machines.ts, laneCount), the profile's night (night.ts), and `fleet lanes` writing the cell
// (machines.ts, setCell). Run: node --test runtime/test/
import test from "node:test";
import assert from "node:assert/strict";
import { laneCount, setCell, showLanes } from "../src/machines.ts";
import { countAt, isNight, parseNight, worksFrom } from "../src/night.ts";

test("one number is one count, day and night, as the Lanes cell always read", () => {
  assert.deepEqual(laneCount("2"), { day: 2, night: 2 });
  assert.deepEqual(laneCount(" 0 "), { day: 0, night: 0 });
});

test("a day count and a night count, in the form the docs give and its short forms", () => {
  for (const c of ["2, 4 at night", "2,4", "2 / 4", "2 by day, 4 at night", "2 day, 4 night"]) assert.deepEqual(laneCount(c), { day: 2, night: 4 }, c);
});

test("anything else isn't a count", () => {
  for (const c of ["", "two", "2, 4 at noon", "2.5", "-1"]) assert.equal(laneCount(c), null, c);
});

test("said back in plain words", () => {
  assert.equal(showLanes({ day: 1, night: 1 }), "1 lane");
  assert.equal(showLanes({ day: 2, night: 4 }), "2 lanes by day and 4 at night");
});

// (Local time: a moment built from the hour and minute, as the machine's clock reads them.)
const at = (h: number, m = 0) => new Date(2026, 10, 18, h, m).getTime() / 1000;
const NIGHT = parseNight("22:00-07:00")!;

test("night spans midnight: 22:00 to 07:00", () => {
  assert.equal(isNight(at(21, 59), NIGHT), false);
  assert.equal(isNight(at(22), NIGHT), true);
  assert.equal(isNight(at(3), NIGHT), true);
  assert.equal(isNight(at(7), NIGHT), false);
});

test("or doesn't: 01:30 to 05:00", () => {
  const n = parseNight("1:30-5")!;
  assert.equal(isNight(at(1, 29), n), false);
  assert.equal(isNight(at(1, 30), n), true);
  assert.equal(isNight(at(5), n), false);
});

test("a night setting that isn't one", () => {
  for (const s of ["", "late", "22:00", "25:00-07:00", "22:00-22:00"]) assert.equal(parseNight(s), null, s);
});

test("the count for the time of day", () => {
  const c = { day: 2, night: 4 };
  assert.equal(countAt(c, at(12), NIGHT), 2);
  assert.equal(countAt(c, at(23), NIGHT), 4);
});

test("when a lane works next: now, at nightfall, in the morning, or never", () => {
  const c = { day: 2, night: 4 };
  assert.equal(worksFrom(2, c, at(12), NIGHT), at(12));
  assert.equal(worksFrom(3, c, at(12), NIGHT), at(22));
  assert.equal(worksFrom(3, c, at(23), NIGHT), at(23));
  assert.equal(worksFrom(5, c, at(12), NIGHT), null);
  // More lanes by day than at night: the morning.
  assert.equal(worksFrom(3, { day: 3, night: 1 }, at(23), NIGHT), at(7) + 86400);
});

const TABLE = `# Machines

| Machine | Lanes |
|---|---|
| decoy | 9 |

## Lanes

| Machine | ssh | Lanes | Heavy |
|---|---|---|---|
| wren | wren.lan | 2 | 1 |
| tern | tern | 1 | 1 |

## wren
`;

test("setCell writes one machine's cell in the Lanes table, and nothing else", () => {
  const out = setCell(TABLE, "tern", "lanes", "2, 4 at night");
  assert.equal(out, TABLE.replace("| tern | tern | 1 | 1 |", "| tern | tern | 2, 4 at night | 1 |"));
});

test("setCell: a machine not in the table, or a table without the column", () => {
  assert.equal(setCell(TABLE, "heron", "lanes", "2"), null);
  assert.equal(setCell(TABLE, "wren", "cache", "2"), null);
});
