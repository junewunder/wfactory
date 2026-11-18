// fleet summary ends with the scorecard's lines (runtime/src/scorecard.ts), from this machine's
// records since the run started, so the morning report quotes figures that add up: sessions the tracker recorded (claimed by tags of
// their own, one given back unstarted, one handed back with its work kept, one done), rows for them
// in the checkout's run index, and a usage pause in its events. No lane runs.
// Run: node --test test/loop/fleet/
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { has } from "../../lib/index.ts";
import { fleetFactory } from "./helpers.ts";

const f = fleetFactory("fscore");
const { F, w, fleet } = f;
const as = (tag: string, args: string[]) => w.setup(args, F, { FACTORY_TAG: tag, FACTORY_ACTOR: "loop" });
const p2 = (n: number) => String(n).padStart(2, "0");
const local = (t: Date, sep = "") => `${t.getFullYear()}${sep}${p2(t.getMonth() + 1)}${sep}${p2(t.getDate())}`;
const started = (t: Date) => `${local(t)}-${p2(t.getHours())}${p2(t.getMinutes())}${p2(t.getSeconds())}`;
const hm = (t: Date) => `${local(t, "-")} ${p2(t.getHours())}:${p2(t.getMinutes())}`;

describe("fleet summary: the scorecard last", () => {
  let sum = "", card = "";
  test("fleet summary ends with the scorecard's lines for the run", () => {
    for (const [id, title] of [["g/a", "Unit a"], ["g/b", "Unit b"], ["g/c", "Unit c"]]) w.setup(["add-unit", id, "--title", title], F);
    as("t1", ["claim", "g/a"]); as("t1", ["unclaim", "g/a", "--unstarted"]);
    as("t2", ["claim", "g/b"]); fs.writeFileSync(path.join(F, "b.txt"), "work\n"); as("t2", ["unclaim", "g/b"]);
    as("t3", ["claim", "g/c"]); as("t3", ["done", "g/c", "--evidence", "c.txt has the result and its test passes"]);
    const t0 = new Date(Date.now() - 50 * 60_000), at = (m: number) => new Date(t0.getTime() + m * 60_000);
    fs.mkdirSync(path.join(F, "runs"), { recursive: true });
    fs.writeFileSync(path.join(F, "runs/index.tsv"), ["started\ttag\tloop\tunit\tresult\tturns\tcost_usd\tminutes",
      `${started(at(0))}\tt1\t\tUnit a (g/a)\tGave it back.\t2\t0.50\t1`,
      `${started(at(2))}\tt2\t\tUnit b (g/b)\tHanded it back.\t20\t3.00\t10`,
      `${started(at(13))}\tt3\t\tUnit c (g/c)\tDone.\t30\t6.50\t20`, ""].join("\n"));
    fs.appendFileSync(path.join(F, "runs/events.log"), `${hm(at(34))}\ttesthost\t1\tusage-pause\tunder 8% of the 5-hour window left\n${hm(at(44))}\ttesthost\t1\tusage-resume\tthe 5-hour window reset\n`);
    const since = hm(new Date(t0.getTime() - 5 * 60_000));
    const r = fleet(["summary", "--since", since]);
    assert.equal(r.code, 0, r.stdout);
    sum = r.stdout;
    card = w.just(["scorecard", "--since", since], F).stdout;
    // Every line of the card but those on what isn't recorded, after its header.
    const c = card.replace(/\n+$/, "").split("\n"), lines = c.slice(1).filter((l) => !l.includes(": not recorded ("));
    assert.deepEqual(sum.replace(/\n+$/, "").split("\n").slice(-(lines.length + 1)), [
      `Scorecard (\`just scorecard --since "${since}"\`): ${c[0]}`,
      ...lines.map((l) => `  ${l}`),
    ]);
  });
  // The report's figures, which add up without a sum: sessions, what each finished or became of.
  test("  first the sessions and what became of each, and the units done", () => {
    has(sum, "  Sessions: 3, $10.00: 1 finished their unit (1 done), 2 finished none: 1 left their work for a later session to carry on, 1 gave their unit back unstarted\n");
    has(sum, "  Units done: 1 in the tracker's log (every machine, each once), 1 of them by this machine's sessions\n");
  });
  test("  no waste: no session lost its work", () => { has(sum, "  0% of cost        Waste: sessions that lost their work: 0 of 3 (0%), $0.00\n"); });
  test("  and the usage pause, by its share of lane time", () => { has(sum, "  24% of lane time  Waiting in the usage pause: 10 min"); });
});
