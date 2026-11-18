// just scorecard: the figures a hand-written factory's records give (test/scripts/scorecard/, every
// way a session can finish no unit, a unit claimed four times, a review sending a branch back twice,
// a wait, a failed CI step), plain and --json; that only lost work is waste; a removed lane clone's
// records, and the claims whose records were lost; a record it doesn't understand; a factory with
// no runs; one read of a 50,000-line log; and that printing it starts no agent and reaches no
// daemon. Run: node --test test/scripts/
// The fixture's times are UTC, as is this process's clock (the run index and events are local time).
process.env.TZ = "UTC";
import { describe, mock, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT, has, hasnt, tempDir, workspace } from "../lib/index.ts";
import { scorecardCli, summaryLines } from "../../runtime/src/scorecard.ts";
import { EVENT_KINDS, LOG_CMDS } from "../../runtime/src/scorecard-read.ts";

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

// What each session in the fixture did, and so the figures it gives (11 sessions, $20.00; lost:
// the kill, the cut-off and the silent one, $3.50; carried on by a later session: the two sent
// back, $5.00, of which the second carried on the first, $2.00, and the one handed back, $2.00;
// waiting on the owner: the question and the stuck one, $0.90; given back unstarted, $0.10):
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
// Two CI runs (Alpha failed at test, Beta passed: 20 and 15 min); a usage pause of 30 min (12:00 to
// 12:30); an idle event between s09's end (11:20) and the first CI run (12:30), 70 min less the
// pause within it, and one between s10's end (13:50) and s11's start (14:50), 60 min: lane time
// 250 + 35 + 30 + 100 = 415 min. The heavy-job history has build's passing runs at 100 and 130 s
// (dated), and two older undated ones at 110 and 120; test's at 280.
const FIGURES = {
  "sessions.count": 11, "sessions.cost": 20, "lane.minutes": 415, "sessions.unknown.count": 0,
  "sessions.finished.count": 2, "units.done.count": 2, "sessions.unrecorded.count": 0,
  "sessions.no_unit.count": 9, "sessions.no_unit.share": 0.8182, "sessions.no_unit.cost": 11.5, "sessions.no_unit.cost_share": 0.575,
  "sessions.lost.count": 3, "sessions.lost.share": 0.2727, "sessions.lost.cost": 3.5, "sessions.lost.cost_share": 0.175,
  "sessions.no_unit.lost.count": 3, "sessions.no_unit.lost.cost": 3.5, "sessions.no_unit.carried_on.count": 3, "sessions.no_unit.carried_on.cost": 7,
  "sessions.no_unit.waiting.count": 2, "sessions.no_unit.waiting.cost": 0.9, "sessions.no_unit.sent_back.next_cost": 2,
  ...Object.fromEntries(([
    ["unstarted", 1, 0.1], ["handed_back", 1, 2], ["interrupted", 1, 1], ["blocked", 1, 0.5], ["asked", 1, 0.4],
    ["sent_back", 2, 5], ["oom", 1, 1.5], ["silent", 1, 1],
  ] as [string, number, number][]).flatMap(([k, n, c]) => [
    [`sessions.no_unit.${k}.count`, n], [`sessions.no_unit.${k}.share`, Math.round(n / 11 * 1e4) / 1e4],
    [`sessions.no_unit.${k}.cost`, c], [`sessions.no_unit.${k}.cost_share`, c / 20],
  ])),
  "units.reclaimed.count": 2, "units.claims.max": 4,
  "review.landed.count": 2, "review.reviewed.count": 3, "review.sent_back.count": 2, "review.sent_back.rate": 0.6667,
  "review.sent_back_twice.count": 1, "review.unreviewed.count": 1,
  "wait.usage.minutes": 30, "wait.usage.share": 0.0723, "wait.nothing_workable.minutes": 100, "wait.nothing_workable.share": 0.241,
  "wait.resource.minutes": null, "wait.memory.minutes": null, "wait.in_flight.minutes": null,
  "ci.runs": 2, "ci.failed.count": 1, "ci.failed.rate": 0.5, "ci.minutes": 35, "ci.share": 0.0843,
  "ci.step.build.runs": 2, "ci.step.build.failed": 0, "ci.step.build.fail_rate": 0, "ci.step.build.secs": 115,
  "ci.step.test.runs": 2, "ci.step.test.failed": 1, "ci.step.test.fail_rate": 0.5, "ci.step.test.secs": 280,
  "unit_cost.count": 2, "unit_cost.median": 4.25, "unit_cost.total": 8.5, "unit_cost.flagged.count": 0,
  "unit_cost.group.alpha.count": 1, "unit_cost.group.alpha.median": 4.5, "unit_cost.group.alpha.total": 4.5,
  "unit_cost.group.beta.count": 1, "unit_cost.group.beta.median": 4, "unit_cost.group.beta.total": 4,
  "unknown.count": 0,
};
// The plain output: the sessions and units done first, which add up as they stand; then by share
// of cost or lane time, largest first; then the rest in their order.
const PLAIN = `This machine's lanes (fxhost: checkout), everything recorded: 11 sessions, $20.00, 415 min of lane time. Units and CI read the tracker's log: every machine.
                  Sessions: 11, $20.00: 2 finished their unit (2 done), 9 finished none: 3 lost their work, 3 left their work for a later session to carry on, 2 ended waiting on the owner, 1 gave their unit back unstarted
                  Units done: 2 in the tracker's log (every machine, each once), 2 of them by this machine's sessions
24% of lane time  Waiting with nothing workable: 1 h 40 min (what for isn't recorded: below)
18% of cost       Waste: sessions that lost their work: 3 of 11 (27%), $3.50: 1 killed over memory ($1.50), 1 cut off ($1.00), 1 ended for going silent ($1.00)
8% of lane time   Group CI: 2 runs, 1 failed (50%); 35 min of this machine's lane time
7% of lane time   Waiting in the usage pause: 30 min
                  Sessions that finished no unit and left their work for a later session to carry on: 3, $7.00: 2 sent back by the review ($5.00; the 1 session that carried them on: $2.00), 1 handed back with their work kept ($2.00)
                  Sessions that finished no unit and ended waiting on the owner: 2, $0.90: 1 asked the owner ($0.40), 1 left their unit stuck ($0.50)
                  Sessions that finished no unit and gave their unit back unstarted: 1, $0.10
                  Four tries (alpha/four): claimed 4 times since it was last done or added: 1 given back unstarted, 1 interrupted or cut off, 1 handed back with its work kept, 1 silent; $4.10 here
                  Sent back (alpha/sent): claimed twice since it was last done or added: 2 sent back by the review; $5.00 here
                  The review, of this machine's landings: 3 branches reviewed, 2 sent back for fixes (67%), 1 of them a second time; 2 landed, 1 without a review
                  Waiting for a resource: not recorded (the loop would have to record each wait as it ends: the resource, and the minutes)
                  Waiting for the memory budget: not recorded (the heavy-job queue would have to record each wait as it ends: the job, and the minutes)
                  Waiting for work in flight elsewhere: not recorded (the loop would have to record why it waited (the units in progress elsewhere), and the minutes)
                  CI step build: 2 runs, 0 failed (0%); takes about 2 min (the median of 4 passing runs in the heavy-job history)
                  CI step test: 2 runs, 1 failed (50%); takes about 5 min (the median of 1 passing run in the heavy-job history)
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
    assert.deepEqual(j.lines.slice(0, 4).map((l: { share: number; of: string }) => [l.share, l.of]), [[null, null], [null, null], [0.241, "lane time"], [0.175, "session cost"]]);
    assert.equal(j.lines.length, PLAIN.split("\n").length - 2);
  });
  // (A done the review sent back doesn't count as done: the unit sent back twice was claimed twice.)
  test("  the unit claimed four times, and how each claim ended", () => {
    const j = JSON.parse(run(["--json"], env, d).out);
    assert.deepEqual(j.units, [
      { id: "alpha/four", title: "Four tries", claims: 4, endings: { unstarted: 1, interrupted: 1, handed_back: 1, silent: 1 }, cost: 4.1 },
      { id: "alpha/sent", title: "Sent back", claims: 2, endings: { sent_back: 2 }, cost: 5 },
    ]);
  });
  test("  what isn't recorded says what would have to be", () => {
    const j = JSON.parse(run(["--json"], env, d).out);
    assert.deepEqual(Object.keys(j.not_recorded), ["wait.resource.minutes", "wait.memory.minutes", "wait.in_flight.minutes"]);
  });
  test("--since: only what happened since then", () => {
    const j = JSON.parse(run(["--json", "--since", "2026-11-01 13:00"], env, d).out);
    assert.equal(j.figures["sessions.count"], 2);
    assert.equal(j.figures["sessions.no_unit.count"], 0);
    assert.equal(j.figures["units.done.count"], 2);
    // (CI step time by its runs' dates: none since then; the undated ones only for everything.)
    assert.equal(j.figures["ci.step.build.secs"], null);
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
  fs.appendFileSync(path.join(d, "runs/index.tsv"), "a row\twith too few fields\n20261101-170000\tzz9\t\tFour tries (alpha/four)\tDone, it says.\t5\t1.00\t5\n");
  let r = { code: 1, out: "", err: "" };
  test("is counted under unknown, and named", () => {
    r = run([], env, d);
    assert.equal(r.code, 0, r.err);
    has(r.out, `Not understood (unknown): 5 records: the tracker's log: "teleport"; the tracker's log: a line that isn't a log entry; checkout's run index: a row that doesn't parse; checkout's events: "teleported"; checkout's run index: session zz9, which the tracker's log has no line of`);
  });
  test("  in --json too", () => {
    const j = JSON.parse(run(["--json"], env, d).out);
    assert.equal(j.figures["unknown.count"], 5);
    assert.deepEqual(j.unknown.map((u: { what: string }) => u.what).sort(), ['"teleport"', '"teleported"', "a line that isn't a log entry", "a row that doesn't parse", "session zz9, which the tracker's log has no line of"]);
  });
  // A session whose claim isn't in the log (a copy of main's log fetched before it) is neither
  // finished nor not: the shares are of the sessions whose ending is known, as before.
  test("  a session the log has no claim of is counted, as unknown, and out of the shares", () => {
    const f = JSON.parse(run(["--json"], env, d).out).figures;
    assert.deepEqual([f["sessions.count"], f["sessions.unknown.count"], f["sessions.no_unit.count"], f["sessions.no_unit.share"], f["sessions.no_unit.cost_share"]], [12, 1, 9, 0.8182, 0.575]);
    has(run([], env, d).out, "Waste: sessions that lost their work: 3 of 11 (27%; 1 more not in the log, not counted), $3.50");
    has(run([], env, d).out, "Sessions: 12, $21.00: 2 finished their unit (2 done), 9 finished none: 3 lost their work, 3 left their work for a later session to carry on, 2 ended waiting on the owner, 1 gave their unit back unstarted; 1 more whose claim isn't in the tracker's log");
  });
});

describe("the review is this machine's; a step's runs count once", () => {
  const { d, env } = fixture();
  // Another machine landed a branch, and its review sent one back: its review-skipped events are on it.
  fs.appendFileSync(path.join(d, "tracker/log.jsonl"), [
    '{"at":"2026-11-01T15:50:00Z","actor":"loop","tag":"manual","host":"elsewhere","cmd":"merged","id":"beta/stuck","text":"Stuck: on main"}',
    `{"at":"2026-11-01T15:51:00Z","actor":"loop","tag":"manual","host":"elsewhere","cmd":"reopen","id":"beta/ask","text":"Asks: back to ready: the loop's review asked for fixes"}`, ""].join("\n"));
  test("another machine's landings and send-backs aren't in the review's figures", () => {
    const f = JSON.parse(run(["--json"], env, d).out).figures;
    assert.deepEqual([f["review.landed.count"], f["review.reviewed.count"], f["review.sent_back.count"]], [2, 3, 2]);
  });
  test("a step whose command names no group: each run counted once, not once per group", () => {
    const pj = path.join(d, "tracker/project.json"), p = JSON.parse(fs.readFileSync(pj, "utf8"));
    p.ci.steps.lint = { cmd: "make lint" };
    fs.writeFileSync(pj, JSON.stringify(p));
    const h = path.join(d, "jobs/history.json"), j = JSON.parse(fs.readFileSync(h, "utf8"));
    j["fx\tci-step runs/ci-20261101-123005-alpha-lint.log.secs timeout 600 bash -c make lint"] = { secs: [40] };
    j["fx\tci-step runs/ci-20261101-125205-beta-lint.log.secs timeout 600 bash -c make lint"] = { secs: [60] };
    fs.writeFileSync(h, JSON.stringify(j));
    const r = run([], env, d);
    assert.equal(JSON.parse(run(["--json"], env, d).out).figures["ci.step.lint.secs"], 50);
    has(r.out, "CI step lint: 0 runs, 0 failed (—); takes about 1 min (the median of 2 passing runs in the heavy-job history)");
  });
});

// Only a session whose work was lost is waste: a unit the review sent back keeps its branch and
// the next session carries on from it; a question waits on the owner. A factory with one of
// each, a kill over memory, and a unit done first time.
describe("only lost work is waste", () => {
  const d = path.join(tempDir("scorecard-"), "fx");
  fs.mkdirSync(path.join(d, "runs"), { recursive: true });
  fs.cpSync(path.join(FIXTURE, "tracker"), path.join(d, "tracker"), { recursive: true });
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, TZ: "UTC", FACTORY_STATE: "local", FACTORY_HOST: "fxhost", FACTORY_JOBS_HOME: path.join(d, "jobs") };
  const L = (at: string, tag: string, cmd: string, id: string | null, text: string, more = "") => `{"at":"2026-11-01T${at}:00Z","actor":"loop","tag":"${tag}","host":"fxhost","cmd":"${cmd}"${id ? `,"id":"${id}"` : ""},"text":"${text}"${more}}`;
  fs.writeFileSync(path.join(d, "tracker/log.jsonl"), [
    L("07:00", "setup", "add-unit", "alpha/sent", "Sent back: added"), L("07:00", "setup", "add-unit", "beta/oom", "Out of memory: added"),
    L("07:00", "setup", "add-unit", "beta/ask", "Asks: added"), L("07:00", "setup", "add-unit", "beta/fine", "Fine: added"),
    // Sent back by the review, then carried on and landed by the next session.
    L("08:00", "a1", "claim", "alpha/sent", "Sent back: claimed"), L("08:40", "a1", "done", "alpha/sent", "Sent back: done"),
    L("08:42", "manual", "reopen", "alpha/sent", "Sent back: back to ready: the loop's review asked for fixes"),
    L("08:45", "a2", "claim", "alpha/sent", "Sent back: claimed"), L("08:55", "a2", "done", "alpha/sent", "Sent back: done"),
    L("08:57", "manual", "merged", "alpha/sent", "Sent back: on main"),
    // Killed over memory.
    L("09:00", "a3", "claim", "beta/oom", "Out of memory: claimed"), L("09:20", "a3", "settle", "beta/oom", "Out of memory: session ended mid-unit"),
    // Asked the owner.
    L("09:30", "a4", "claim", "beta/ask", "Asks: claimed"), L("09:35", "a4", "ask", null, "asked the owner: Which way?", ',"q":"q/which-way"'),
    L("09:36", "a4", "block", "beta/ask", "Asks: waiting on the owner's answer to Which way?"),
    // Done first time.
    L("10:00", "a5", "claim", "beta/fine", "Fine: claimed"), L("10:30", "a5", "done", "beta/fine", "Fine: done"), L("10:32", "manual", "merged", "beta/fine", "Fine: on main"), ""].join("\n"));
  fs.writeFileSync(path.join(d, "runs/index.tsv"), ["started\ttag\tloop\tunit\tresult\tturns\tcost_usd\tminutes",
    "20261101-080000\ta1\t\tSent back (alpha/sent)\tDone.\t40\t3.00\t40", "20261101-084500\ta2\t\tSent back (alpha/sent)\tFixed.\t10\t0.80\t10",
    "20261101-090000\ta3\t\tOut of memory (beta/oom)\t\t10\t1.50\t20", "20261101-093000\ta4\t\tAsks (beta/ask)\tAsked.\t8\t0.40\t6",
    "20261101-100000\ta5\t\tFine (beta/fine)\tDone.\t30\t4.30\t30", ""].join("\n"));
  fs.writeFileSync(path.join(d, "runs/events.log"), "2026-11-01 09:20\tfxhost\t1\toom-kill\tsession a3 on Out of memory (beta/oom) was killed: out of memory at 8G\tbeta/oom\n");
  const out = () => run([], env, d).out;
  test("the waste line counts only the kill", () => {
    has(out(), "15% of cost       Waste: sessions that lost their work: 1 of 5 (20%), $1.50: 1 killed over memory ($1.50)");
    const f = JSON.parse(run(["--json"], env, d).out).figures;
    assert.deepEqual([f["sessions.lost.count"], f["sessions.lost.cost"], f["sessions.lost.cost_share"]], [1, 1.5, 0.15]);
  });
  test("  the sent-back session is carried on, with what the session after it cost", () => {
    has(out(), "Sessions that finished no unit and left their work for a later session to carry on: 1, $3.00: 1 sent back by the review ($3.00; the 1 session that carried it on: $0.80)");
    assert.equal(JSON.parse(run(["--json"], env, d).out).figures["sessions.no_unit.sent_back.next_cost"], 0.8);
  });
  test("  the question waits on the owner", () => { has(out(), "Sessions that finished no unit and ended waiting on the owner: 1, $0.40: 1 asked the owner ($0.40)"); });
  test("  and only the waste line carries a share of the cost", () => {
    const j = JSON.parse(run(["--json"], env, d).out);
    assert.deepEqual(j.lines.filter((l: { of: string | null }) => l.of === "session cost").map((l: { text: string }) => l.text.split(":")[0]), ["Waste"]);
  });
  test("sessions, what became of each, and the units done add up as they stand", () => {
    const o = out().split("\n");
    assert.equal(o[1].trim(), "Sessions: 5, $10.00: 2 finished their unit (2 done), 3 finished none: 1 lost their work, 1 left their work for a later session to carry on, 1 ended waiting on the owner");
    assert.equal(o[2].trim(), "Units done: 2 in the tracker's log (every machine, each once), 2 of them by this machine's sessions");
  });
});

// A lane clone the fleet removed (past --lanes) leaves its run index and events in the checkout's
// runs/removed-clones/<clone>-<when>/ (fleet-scripts.ts, DROP_CLONE): they count under its lane.
describe("a removed lane clone's records", () => {
  const { d, env } = fixture();
  const gone = path.join(d, "runs/removed-clones/fx-lane3-20261101-200000");
  fs.mkdirSync(gone, { recursive: true });
  fs.writeFileSync(path.join(gone, "index.tsv"), "started\ttag\tloop\tunit\tresult\tturns\tcost_usd\tminutes\n20261101-170000\tr1\t\tFine (beta/fine)\tLooked again.\t5\t2.00\t10\n");
  fs.writeFileSync(path.join(gone, "events.log"), "2026-11-01 17:30\tfxhost\t3\tlane-stop\tout of time\n");
  fs.appendFileSync(path.join(d, "tracker/log.jsonl"), [
    '{"at":"2026-11-01T17:00:00Z","actor":"loop","tag":"r1","host":"fxhost","cmd":"claim","id":"beta/fine","text":"Fine: claimed"}',
    '{"at":"2026-11-01T17:09:00Z","actor":"loop","tag":"r1","host":"fxhost","cmd":"unclaim","id":"beta/fine","text":"Fine: given back unstarted","unstarted":true}', ""].join("\n"));
  test("are counted under the lane it was", () => {
    const j = JSON.parse(run(["--json"], env, d).out);
    assert.deepEqual(j.lanes, ["checkout", "lane3"]);
    assert.equal(j.figures["sessions.count"], 12);
    assert.equal(j.figures["sessions.no_unit.unstarted.count"], 2);
  });
  // Claims here whose records went with a clone before removing one kept them: said, not guessed.
  test("a loop claim on this machine with no record anywhere here is said as lost records", () => {
    fs.appendFileSync(path.join(d, "tracker/log.jsonl"), [
      '{"at":"2026-11-01T18:00:00Z","actor":"loop","tag":"x1","host":"fxhost","cmd":"claim","id":"beta/fine","text":"Fine: claimed"}',
      '{"at":"2026-11-01T18:10:00Z","actor":"loop","tag":"x2","host":"fxhost","cmd":"claim","id":"alpha/ok","text":"Landed unreviewed: claimed"}',
      // (Another machine's, and an owner's session's, are no lane's here.)
      '{"at":"2026-11-01T18:20:00Z","actor":"loop","tag":"x3","host":"elsewhere","cmd":"claim","id":"beta/stuck","text":"Stuck: claimed"}',
      '{"at":"2026-11-01T18:30:00Z","actor":"session","tag":"x4","host":"fxhost","cmd":"claim","id":"beta/ask","text":"Asks: claimed"}', ""].join("\n"));
    // x2 is running now, in the checkout's lane: no row yet.
    fs.mkdirSync(path.join(d, "runs/inbox/current"), { recursive: true });
    fs.writeFileSync(path.join(d, "runs/inbox/current/tag"), "x2\n");
    has(run([], env, d).out, "Not counted: 1 session on this machine claimed a unit (the tracker's log) but no lane here has a record of it");
    assert.equal(JSON.parse(run(["--json"], env, d).out).figures["sessions.unrecorded.count"], 1);
  });
});

// The predictions (expect, settle) went unused in every factory: gone, with the tracker's commands.
test("just scorecard expect and settle are gone", () => {
  const { d, env } = fixture();
  for (const a of [["expect", "sessions.count", "< 1", "--by", "2026-12-01", "--why", "x"], ["settle", "p1", "--note", "x"]]) {
    const r = run(a, env, d);
    assert.equal(r.code, 2);
    has(r.err, `unknown argument '${a[0]}'`);
  }
  hasnt(run(["--help"], env, d).out, "expect");
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
    assert.equal(JSON.parse(r.out).figures["units.reclaimed.count"], 2);
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
    const kinds = new Set([...src("runtime/src").matchAll(/\b(?:event\(|laneEvent\([^,]+, )"([a-z-]+)"/g)].map((m) => m[1]));
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
    has(r.stdout, "Waste: sessions that lost their work: 3 of 11 (27%), $3.50");
  });
  test("  --help", () => { has(w.just(["scorecard", "--help"], F, add).stdout, "just scorecard [--since <when>] [--json]"); });
  test("and neither printing it started claude", () => { assert.ok(!fs.existsSync(ran), fs.existsSync(ran) ? fs.readFileSync(ran, "utf8") : ""); });
  test("  nor touched the daemon's home", () => { assert.deepEqual(fs.readdirSync(dhome), []); });
});
