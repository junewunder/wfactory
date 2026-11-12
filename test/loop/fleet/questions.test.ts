// One question, several lanes: the questions file is main's, shared by every lane, so each lane
// logs a `question` event for it when its own unit ends. The overseer hears it once: fleet wait
// wakes for the first lane's line and not for the others', within one wait or across waits, an
// overseer that attaches has its waits drop the ones the logs already have, and the summary
// counts it once (a night of four lanes woke the overseer four times for each of two questions).
// Run: node --test test/loop/fleet/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { has, hasnt, readOr, HOST } from "../../lib/index.ts";
import { fleetFactory, readNext } from "./helpers.ts";

const f = fleetFactory("fquest", { lanes: 3 });
const { F, fleet, setup, hold, lane, bg } = f;
const out = (args: string[]) => fleet(args).stdout;
// A `question` line in lane n's runs/events.log, as the loop logs one (loop-unit.ts).
const asked = (n: number, title: string, id: string) => {
  const d = new Date(), p2 = (x: number) => String(x).padStart(2, "0");
  const at = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
  fs.mkdirSync(path.join(lane(n), "runs"), { recursive: true });
  fs.appendFileSync(path.join(lane(n), "runs/events.log"), `${at}\t${HOST}\t${n}\tquestion\t${title} (${id})\n`);
};
// fleet wait in the background, once its first look has read lane n's events.
async function waitFor(minutes: string, n: number) {
  const read = readNext(path.join(lane(n), "runs/events.log"));
  const b = bg(path.join(F, "factory/fleet.sh"), ["wait", "--minutes", minutes], { add: { FACTORY_WAIT_EVERY: "1" } });
  await read();
  return b;
}
const owner = (o: string) => o.split("\n").filter((l) => l.includes(" · question · "));

const held = [1, 2, 3].map((n) => hold(`g/q${n}`));
describe("one question, three lanes: the overseer hears it once", () => {
  test("three lanes on the machine, each in a unit", async () => {
    for (const n of [1, 2, 3]) setup(["add-unit", `g/q${n}`, "--title", `Unit q${n}`]);
    has(out(["start", "--hours", "0.1", "--no-awake"]), `=== ${HOST} lane 3`);
    for (const h of held) await h.held();
  });
  let o = "";
  test("the first lane to log it wakes the wait", async () => {
    const b = await waitFor("1", 2);
    asked(2, "Raise the bar to 59?", "q/raise-bar");
    o = (await b.end()).stdout;
    has(o, "woke: news: question\n");
  });
  test("  with it for the owner once", () => { assert.equal(owner(o).length, 1); has(owner(o)[0], "Raise the bar to 59? (q/raise-bar)"); });
  test("the other lanes logging it as their units end: no wake", async () => {
    const b = await waitFor("0.1", 3);
    asked(1, "Raise the bar to 59?", "q/raise-bar");
    asked(3, "Raise the bar to 59?", "q/raise-bar");
    o = (await b.end()).stdout;
    has(o, "woke: time");
  });
  test("  and nothing for the owner", () => { hasnt(o, "--- for the owner"); });
  test("  each lane's line is still in its log", () => {
    for (const n of [1, 2, 3]) has(readOr(path.join(lane(n), "runs/events.log")), "(q/raise-bar)");
  });
  test("two lanes logging a new one in the same wait: one wake, one line", async () => {
    const b = await waitFor("1", 1);
    asked(1, "Land the step without the fall?", "q/land-step");
    asked(2, "Land the step without the fall?", "q/land-step");
    o = (await b.end()).stdout;
    has(o, "woke: news: question\n");
    assert.equal(owner(o).length, 1);
  });
  test("  (the lane whose line came second is told it at the next wait, and doesn't wake it)", async () => {
    const b = await waitFor("0.1", 3);
    asked(3, "Land the step without the fall?", "q/land-step");
    has((await b.end()).stdout, "woke: time");
  });
  test("a new overseer here, with no record of what was told: attach lists each question once", () => {
    fs.rmSync(path.join(F, "runs/.fleet-questions"), { force: true });
    o = out(["attach", "--as", "ovQ"]);
    assert.equal(owner(o).length, 2, o);
  });
  test("  and its waits don't wake for a lane logging one again", async () => {
    const b = await waitFor("0.1", 2);
    asked(2, "Raise the bar to 59?", "q/raise-bar");
    has((await b.end()).stdout, "woke: time");
  });
  test("the summary counts each question once", () => {
    const pj = path.join(F, "tracker/project.json"), was = readOr(pj);
    // (A question is a wake-now event, which the summary leaves to what waits on the owner; a
    // project that moves it to the summary sees it there.)
    fs.writeFileSync(pj, JSON.stringify({ ...JSON.parse(was), events: { summary: ["question"] } }, null, 2) + "\n");
    const s = out(["summary"]);
    fs.writeFileSync(pj, was);
    has(s, "  question (2):\n");
    assert.equal(s.split("(q/raise-bar)").length - 1, 1, s);
  });
  test("a question in a lane's log isn't another question's repeat", async () => {
    const b = await waitFor("1", 3);
    asked(3, "Raise the bar to 61?", "q/raise-bar-2");
    has((await b.end()).stdout, "woke: news: question\n");
  });
});
