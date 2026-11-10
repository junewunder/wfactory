// just scorecard: the figures a hand-written factory's records give (test/scripts/scorecard/, every
// way a session can finish no unit, a unit claimed four times, a review sending a branch back twice,
// a wait, a failed CI step), plain and --json; a record it doesn't understand; a factory with no runs;
// the ledger of predictions on a mocked clock; one read of a 50,000-line log; and that printing it
// starts no agent and reaches no daemon. Run: node --test test/scripts/
// The fixture's times are UTC, as is this process's clock (the run index and events are local time).
process.env.TZ = "UTC";
import { describe, mock, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT, has, hasnt, tempDir, workspace } from "../lib/index.ts";
import { scorecardCli, summaryLines } from "../../runtime/src/scorecard.ts";
import { EVENT_KINDS, LOG_CMDS } from "../../runtime/src/scorecard-read.ts";
import { knownName } from "../../runtime/src/scorecard-names.ts";

const FIXTURE = path.join(ROOT, "test", "scripts", "scorecard");

// A copy of the fixture factory, named fx (the project its heavy-job history names).
function fixture() {
  const d = path.join(tempDir("scorecard-"), "fx");
  fs.cpSync(FIXTURE, d, { recursive: true });
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, TZ: "UTC", FACTORY_STATE: "local", FACTORY_HOST: "fxhost", FACTORY_JOBS_HOME: path.join(d, "jobs") };
  return { d, env };
}
// The scorecard in this process: its exit code and what it printed.
function run(args: string[], env: NodeJS.ProcessEnv, cwd: string) {
  let out = "", err = "";
  const ow = process.stdout.write, ew = process.stderr.write;
  process.stdout.write = ((s: string) => { out += s; return true; }) as typeof process.stdout.write;
  process.stderr.write = ((s: string) => { err += s; return true; }) as typeof process.stderr.write;
  let code: number;
  try { code = scorecardCli(args, env, cwd); } finally { process.stdout.write = ow; process.stderr.write = ew; }
  return { code, out, err };
}

// What each session in the fixture did, and so the figures it gives (11 sessions, $20.00):
//   s01 Four tries   claimed, given back unstarted          $0.10    0 min
//   s02 Four tries   claimed, the loop's settle (mid-unit)   $1.00   10 min   interrupted
//   s03 Four tries   handed back with a commit               $2.00   20 min
//   s04 Four tries   a silent event as it ended              $1.00   30 min
//   s05 Sent back    done; the review sent it back           $3.00   40 min
//   s06 Sent back    done; sent back a second time (stuck)   $2.00   30 min
//   s07 Out of mem   an oom-kill event of its unit           $1.50   15 min
//   s08 Asks         asked the owner, blocked on the answer  $0.40    5 min   asked
//   s09 Stuck        blocked on a refused permission         $0.50   10 min
//   s10 Fine         done, landed                            $4.00   40 min   finished
//   s11 Landed unrev done, landed without the review         $4.50   50 min   finished
// Two CI runs (Alpha failed at test, Beta passed: 20 and 15 min), a usage pause of 30 min (12:00 to
// 12:30) and an idle event between s10's end (13:50) and s11's start (14:50): lane time
// 250 + 35 + 30 + 60 = 375 min.
const FIGURES = {
  "sessions.count": 11, "sessions.cost": 20, "lane.minutes": 375,
  "sessions.no_unit.count": 9, "sessions.no_unit.share": 0.8182, "sessions.no_unit.cost": 11.5, "sessions.no_unit.cost_share": 0.575,
  ...Object.fromEntries(([
    ["unstarted", 1, 0.1], ["handed_back", 1, 2], ["interrupted", 1, 1], ["blocked", 1, 0.5], ["asked", 1, 0.4],
    ["sent_back", 2, 5], ["oom", 1, 1.5], ["silent", 1, 1], ["unknown", 0, 0],
  ] as [string, number, number][]).flatMap(([k, n, c]) => [
    [`sessions.no_unit.${k}.count`, n], [`sessions.no_unit.${k}.share`, Math.round(n / 11 * 1e4) / 1e4],
    [`sessions.no_unit.${k}.cost`, c], [`sessions.no_unit.${k}.cost_share`, c / 20],
  ])),
  "units.reclaimed.count": 1, "units.claims.max": 4,
  "review.landed.count": 2, "review.reviewed.count": 3, "review.sent_back.count": 2, "review.sent_back.rate": 0.6667,
  "review.sent_back_twice.count": 1, "review.unreviewed.count": 1,
  "wait.usage.minutes": 30, "wait.usage.share": 0.08, "wait.nothing_workable.minutes": 60, "wait.nothing_workable.share": 0.16,
  "wait.resource.minutes": null, "wait.memory.minutes": null, "wait.in_flight.minutes": null,
  "ci.runs": 2, "ci.failed.count": 1, "ci.failed.rate": 0.5, "ci.minutes": 35, "ci.share": 0.0933,
  "ci.step.build.runs": 2, "ci.step.build.failed": 0, "ci.step.build.fail_rate": 0, "ci.step.build.secs": 115,
  "ci.step.test.runs": 2, "ci.step.test.failed": 1, "ci.step.test.fail_rate": 0.5, "ci.step.test.secs": 300,
  "unit_cost.count": 2, "unit_cost.median": 4.25, "unit_cost.total": 8.5, "unit_cost.flagged.count": 0,
  "unit_cost.group.alpha.count": 1, "unit_cost.group.alpha.median": 4.5, "unit_cost.group.alpha.total": 4.5,
  "unit_cost.group.beta.count": 1, "unit_cost.group.beta.median": 4, "unit_cost.group.beta.total": 4,
  "unknown.count": 0,
};
// The plain output: by share of cost or lane time, largest first; then the rest in their order.
const PLAIN = `This machine's lanes (fxhost: checkout), everything recorded: 11 sessions, $20.00, 375 min of lane time. Units, the review and CI read the tracker's log: every machine.
57% of cost       Sessions that finished no unit: 9 of 11 (82%), $11.50
25% of cost       Sessions that had their unit sent back by the review: 2 (18% of sessions), $5.00
21% of cost       Four tries (alpha/four): claimed 4 times since it was last done or added: 1 given back unstarted, 1 interrupted or cut off, 1 handed back with its work kept, 1 silent; $4.10 here
16% of lane time  Waiting with nothing workable: 1 h (what for isn't recorded: below)
10% of cost       Sessions that handed their unit back, work kept: 1 (9% of sessions), $2.00
9% of lane time   Group CI: 2 runs, 1 failed (50%); 35 min of this machine's lane time
8% of lane time   Waiting in the usage pause: 30 min
8% of cost        Sessions that were killed over memory: 1 (9% of sessions), $1.50
5% of cost        Sessions that were interrupted or cut off: 1 (9% of sessions), $1.00
5% of cost        Sessions that were ended for going silent: 1 (9% of sessions), $1.00
3% of cost        Sessions that left their unit stuck: 1 (9% of sessions), $0.50
2% of cost        Sessions that asked the owner: 1 (9% of sessions), $0.40
1% of cost        Sessions that gave their unit back unstarted: 1 (9% of sessions), $0.10
                  The review: 3 branches reviewed, 2 sent back for fixes (67%), 1 of them a second time; 2 landed, 1 without a review
                  Waiting for a resource: not recorded (the loop would have to record each wait as it ends: the resource, and the minutes)
                  Waiting for the memory budget: not recorded (the heavy-job queue would have to record each wait as it ends: the job, and the minutes)
                  Waiting for work in flight elsewhere: not recorded (the loop would have to record why it waited (the units in progress elsewhere), and the minutes)
                  CI step build: 2 runs, 0 failed (0%); takes about 2 min (the heavy-job history's last runs)
                  CI step test: 2 runs, 1 failed (50%); takes about 5 min (the heavy-job history's last runs)
                  Cost of a finished unit: median $4.25, $8.50 for 2 units
                  Alpha (alpha): median $4.50, $4.50 for 1
                  Beta (beta): median $4.00, $4.00 for 1
`;

describe("the fixture factory's figures", () => {
  const { d, env } = fixture();
  test("plain: every line, ranked", () => {
    const r = run([], env, d);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, PLAIN);
  });
  test("--json: every figure by its name", () => {
    const r = run(["--json"], env, d), j = JSON.parse(r.out);
    assert.deepEqual(j.figures, FIGURES);
  });
  test("  the lines in the same order, each with its share", () => {
    const j = JSON.parse(run(["--json"], env, d).out);
    assert.deepEqual(j.lines.slice(0, 3).map((l: { share: number; of: string }) => [l.share, l.of]), [[0.575, "session cost"], [0.25, "session cost"], [0.205, "session cost"]]);
    assert.equal(j.lines.length, PLAIN.split("\n").length - 2);
  });
  test("  the unit claimed four times, and how each claim ended", () => {
    const j = JSON.parse(run(["--json"], env, d).out);
    assert.deepEqual(j.units, [{ id: "alpha/four", title: "Four tries", claims: 4, endings: { unstarted: 1, interrupted: 1, handed_back: 1, silent: 1 }, cost: 4.1 }]);
  });
  test("  what isn't recorded says what would have to be", () => {
    const j = JSON.parse(run(["--json"], env, d).out);
    assert.deepEqual(Object.keys(j.not_recorded), ["wait.resource.minutes", "wait.memory.minutes", "wait.in_flight.minutes"]);
  });
  test("--since: only what happened since then", () => {
    const j = JSON.parse(run(["--json", "--since", "2026-11-01 13:00"], env, d).out);
    assert.equal(j.figures["sessions.count"], 2);
    assert.equal(j.figures["sessions.no_unit.count"], 0);
  });
  test("--since that isn't a time: refused", () => {
    const r = run(["--since", "whenever"], env, d);
    assert.equal(r.code, 2);
    has(r.err, "--since needs a time");
  });
  test("--names: a line each", () => {
    const r = run(["--names"], env, d);
    has(r.out, "sessions.no_unit.share");
    has(r.out, "review.sent_back.rate");
    has(r.out, "wait.resource.minutes");
  });
});

describe("a record it doesn't understand", () => {
  const { d, env } = fixture();
  fs.appendFileSync(path.join(d, "runs/events.log"), "2026-11-01 16:30\tfxhost\t1\tteleported\tthe lane went somewhere else\n");
  fs.appendFileSync(path.join(d, "tracker/log.jsonl"), '{"at":"2026-11-01T16:31:00Z","actor":"loop","tag":"zz","host":"fxhost","cmd":"teleport","text":"somewhere"}\nnot json at all\n');
  fs.appendFileSync(path.join(d, "runs/index.tsv"), "a row\twith too few fields\n");
  let r = { code: 1, out: "", err: "" };
  test("is counted under unknown, and named", () => {
    r = run([], env, d);
    assert.equal(r.code, 0, r.err);
    has(r.out, `Not understood (unknown): 4 records: the tracker's log: "teleport"; the tracker's log: a line that isn't a log entry; checkout's run index: a row that doesn't parse; checkout's events: "teleported"`);
  });
  test("  in --json too", () => {
    const j = JSON.parse(run(["--json"], env, d).out);
    assert.equal(j.figures["unknown.count"], 4);
    assert.deepEqual(j.unknown.map((u: { what: string }) => u.what).sort(), ['"teleport"', '"teleported"', "a line that isn't a log entry", "a row that doesn't parse"]);
  });
  test("  and the rest is as before", () => { assert.equal(JSON.parse(run(["--json"], env, d).out).figures["sessions.count"], 11); });
});

describe("the ledger of predictions", () => {
  const { d, env } = fixture();
  const at = (iso: string) => mock.timers.enable({ apis: ["Date"], now: new Date(iso) });
  test("expect refuses a name that isn't a figure", () => {
    at("2026-11-02T09:00:00Z");
    try {
      const r = run(["expect", "sessions.no_unit.bogus.count", "< 0.1", "--by", "2026-11-10", "--why", "a change"], env, d);
      assert.equal(r.code, 2);
      has(r.err, `"sessions.no_unit.bogus.count" isn't one of the scorecard's figures`);
    } finally { mock.timers.reset(); }
  });
  test("  and a date in the past", () => {
    at("2026-11-02T09:00:00Z");
    try {
      const r = run(["expect", "sessions.no_unit.share", "< 0.1", "--by", "2026-11-01", "--why", "a change"], env, d);
      assert.equal(r.code, 2);
      has(r.err, "--by 2026-11-01 is in the past (today is 2026-11-02)");
    } finally { mock.timers.reset(); }
  });
  test("  and records one that is, through the tracker", () => {
    at("2026-11-02T09:00:00Z");
    try {
      const a = run(["expect", "sessions.no_unit.share", "< 0.1", "--by", "2026-11-10", "--why", "units are passed over when they can't fit"], env, d);
      assert.equal(a.code, 0, a.err);
      has(a.out, "p1: sessions.no_unit.share < 0.1 by 2026-11-10");
      const b = run(["expect", "review.sent_back.rate", "> 0.5", "--by", "2026-11-10", "--why", "the review is strict"], env, d);
      has(b.out, "p2: review.sent_back.rate > 0.5 by 2026-11-10");
      has(fs.readFileSync(path.join(d, "tracker/log.jsonl"), "utf8"), '"cmd":"expect"');
    } finally { mock.timers.reset(); }
  });
  test("open before its date, with the figure now", () => {
    at("2026-11-10T20:00:00Z");
    try {
      const r = run([], env, d);
      has(r.out, "Predictions:\n  p1: sessions.no_unit.share < 0.1 by 2026-11-10: open; now 0.8182 (units are passed over when they can't fit)\n  p2: review.sent_back.rate > 0.5 by 2026-11-10: open; now 0.6667");
      assert.deepEqual(summaryLines(env, d, "2026-11-01").filter((l) => l.includes("prediction")), []);
    } finally { mock.timers.reset(); }
  });
  test("held or missed once its date has passed", () => {
    at("2026-11-11T08:00:00Z");
    try {
      const r = run([], env, d);
      has(r.out, "p1: sessions.no_unit.share < 0.1 by 2026-11-10: MISSED (0.8182)");
      has(r.out, "p2: review.sent_back.rate > 0.5 by 2026-11-10: HELD (0.6667)");
      assert.deepEqual(JSON.parse(run(["--json"], env, d).out).predictions.map((p: { state: string }) => p.state), ["missed", "held"]);
    } finally { mock.timers.reset(); }
  });
  test("  and so in fleet summary's lines", () => {
    at("2026-11-11T08:00:00Z");
    try { has(summaryLines(env, d, "2026-11-01").join("\n"), "  prediction p1: sessions.no_unit.share < 0.1 by 2026-11-10: MISSED (0.8182)"); } finally { mock.timers.reset(); }
  });
  test("  and still, a week on", () => {
    at("2026-11-18T08:00:00Z");
    try { has(run([], env, d).out, "p1: sessions.no_unit.share < 0.1 by 2026-11-10: MISSED"); } finally { mock.timers.reset(); }
  });
  test("until settled", () => {
    at("2026-11-18T08:00:00Z");
    try {
      const s = run(["settle", "p1", "--note", "missed: the share stayed high"], env, d);
      assert.equal(s.code, 0, s.err);
      const r = run([], env, d);
      hasnt(r.out, "p1:");
      has(r.out, "p2: review.sent_back.rate > 0.5");
    } finally { mock.timers.reset(); }
  });
  test("a figure's name with a part: a step or a group, any; an ending, only one of them", () => {
    assert.ok(knownName("ci.step.build.fail_rate"));
    assert.ok(knownName("unit_cost.group.alpha.median"));
    assert.ok(knownName("sessions.no_unit.silent.count"));
    assert.ok(!knownName("sessions.no_unit.bogus.count"));
    assert.ok(!knownName("ci.step.build"));
  });
});

describe("one read of the tracker's log", () => {
  const { d, env } = fixture();
  // 50,000 lines: units added, claimed, given back, noted and done by sessions of their own.
  const L: string[] = [];
  for (let i = 0; L.length < 50_000; i++) {
    const id = `alpha/gen-${i}`, tag = `g${i}`, at = new Date(Date.UTC(2026, 10, 2) + i * 60_000).toISOString().replace(/\.\d+Z$/, "Z");
    for (const [cmd, more] of [["add-unit", ""], ["claim", ""], ["unclaim", ',"unstarted":true'], ["claim", ""], ["note", ""], ["done", ""]])
      L.push(`{"at":"${at}","actor":"loop","tag":"${cmd === "add-unit" ? "setup" : tag}","host":"fxhost","cmd":"${cmd}","id":"${id}","text":"Gen ${i}: ${cmd}"${more}}`);
  }
  fs.appendFileSync(path.join(d, "tracker/log.jsonl"), L.slice(0, 50_000).join("\n") + "\n");
  test("a log of 50,000 more lines is read once", () => {
    const reads: string[] = [];
    const real = fs.readFileSync;
    const m = mock.method(fs, "readFileSync", function (this: unknown, ...a: Parameters<typeof fs.readFileSync>) {
      if (String(a[0]).endsWith("log.jsonl")) reads.push(String(a[0]));
      return real.apply(this, a);
    } as typeof fs.readFileSync);
    let r;
    try { r = run(["--json"], env, d); } finally { m.mock.restore(); }
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(reads, [path.join(d, "tracker", "log.jsonl")]);
    assert.equal(JSON.parse(r.out).figures["units.reclaimed.count"], 1);
  });
});

describe("the lists of what it understands are whole", () => {
  const src = (dir: string) => fs.readdirSync(path.join(ROOT, dir), { recursive: true }).map(String).filter((f) => f.endsWith(".ts")).map((f) => fs.readFileSync(path.join(ROOT, dir, f), "utf8")).join("\n");
  test("every command the tracker writes to its log", () => {
    const cmds = new Set([...src("tracker/src").matchAll(/\blog\(T, "([a-z-]+)"/g)].map((m) => m[1]));
    assert.ok(cmds.size > 30);
    assert.deepEqual([...cmds].filter((c) => !LOG_CMDS.has(c)), []);
  });
  test("every kind of event the runtime writes", () => {
    const kinds = new Set([...src("runtime/src").matchAll(/\bevent\("([a-z-]+)"/g)].map((m) => m[1]));
    assert.ok(kinds.size > 30);
    assert.deepEqual([...kinds].filter((k) => !EVENT_KINDS.has(k)), []);
  });
  test("the tracker still writes the words the scorecard reads", () => {
    const t = src("tracker/src");
    for (const w of ["back to ready: the loop's review asked for fixes`", "stuck: the loop's review asked for fixes a second time`", "now done (its check passes)`", "given back unstarted`"]) has(t, w);
  });
});

// Through the recipe, as the owner runs it: a fake claude first on PATH and an empty daemon home.
describe("just scorecard", () => {
  const w = workspace();
  w.profile();
  const F = w.init("fresh");
  const ran = w.at("claude-ran"), dhome = w.at("daemon-home");
  fs.writeFileSync(w.at("bin/claude"), `#!/bin/sh\necho "$@" >> "${ran}"\n`, { mode: 0o755 });
  fs.mkdirSync(dhome);
  const add = { FACTORY_DAEMON_HOME: dhome };
  test("a factory with no runs yet: nothing recorded yet, exit 0", () => {
    const r = w.just(["scorecard"], F, add);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.stdout, "nothing recorded yet\n");
  });
  test("with runs: the card", () => {
    fs.cpSync(path.join(FIXTURE, "runs"), path.join(F, "runs"), { recursive: true });
    fs.appendFileSync(path.join(F, "tracker/log.jsonl"), fs.readFileSync(path.join(FIXTURE, "tracker/log.jsonl"), "utf8"));
    const r = w.just(["scorecard"], F, { ...add, TZ: "UTC" });
    assert.equal(r.code, 0, r.stdout);
    has(r.stdout, "Sessions that finished no unit: 9 of 11 (82%), $11.50");
  });
  test("  --help", () => { has(w.just(["scorecard", "--help"], F, add).stdout, "just scorecard [--since <when>] [--json]"); });
  test("and neither printing it started claude", () => { assert.ok(!fs.existsSync(ran), fs.existsSync(ran) ? fs.readFileSync(ran, "utf8") : ""); });
  test("  nor touched the daemon's home", () => { assert.deepEqual(fs.readdirSync(dhome), []); });
});
