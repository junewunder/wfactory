// landing.ts on its own: a lane's clone of a bare origin, a fake tracker and a fake check, so each
// case says what landing does with a branch without a loop around it. (test/branches/ drives
// the same through the loop, with lanes racing.) Run: node --test runtime/test/
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tempDir } from "../../test/lib/index.ts";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { CHECK_RETRY_MS, FIX_IDLE_MS, Landing, REVIEW_RETRY_MS, UNRUN_RETELL_MS, type LaneCtx } from "../src/landing.ts";
import type { TrOut } from "../src/tr.ts";
import type { ReviewInput, Verdict } from "../src/review.ts";

for (const [k, v] of Object.entries({ GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" })) process.env[k] = v;
const home = process.cwd();

function sh(dir: string, script: string) {
  const r = spawnSync("bash", ["-euo", "pipefail", "-c", script], { cwd: dir, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${script}: ${r.stderr}`);
  return r.stdout.trim();
}

// A lane's clone (the working directory from here on) of a fresh origin whose main has a shared
// file, a tracker/ folder and a script of the loop's; "elsewhere" is another machine's clone.
function lane() {
  const d = tempDir("landing-");
  sh(d, `git init -q --bare -b main origin.git && git init -q -b main lane && cd lane
    printf 'runs/\\n' > .gitignore; echo base > shared.txt; mkdir -p tracker factory runs; echo '{}' > tracker/state.json; echo '# the loop' > factory/loop.sh
    git add -A && git commit -qm init && git remote add origin ../origin.git && git push -q origin main && git fetch -q origin
    cd .. && git clone -q origin.git elsewhere`);
  process.chdir(path.join(d, "lane"));
  return { d, elsewhere: (s: string) => sh(path.join(d, "elsewhere"), s), here: (s: string) => sh(path.join(d, "lane"), s), origin: (s: string) => sh(path.join(d, "origin.git"), s) };
}
test.afterEach(() => process.chdir(home));

interface Fake { events: [string, string][]; logs: string[]; calls: string[][]; checks: string[]; states: Map<string, string>; reviews: ReviewInput[]; lands: { cmd: string; minutes: number; tree: string; add: Record<string, string> }[]; affected: number }
// What the tracker says to run before a unit lands (`ci-land --json`).
type CiLandCheck = { group: string; title: string; cmd: string; timeout: number; own: boolean };
type CiLand = { since: string; checks: CiLandCheck[]; skipped: { group: string; why: string }[]; why?: string };
const G: CiLandCheck = { group: "g", title: "Group g", cmd: "factory/ci g land", timeout: 15, own: true };
const LAND: CiLand = { since: "2026-10-26T01:00:00Z", checks: [G], skipped: [] };
// The loop's side: a check that fails where a fail-check file is (or exits with what rc gives, when
// that isn't 0), a tracker that knows the states it's given and accepts every write (a unit filed,
// reopened, blocked or dropped takes that state), and a review that passes unless told otherwise. The
// check before landing (ci.land) is none unless ciLand says (null: the tracker can't answer), and exits with what land() gives
// (writing its output's last line), seeing the tree as it is; the ci.affected hook is counted.
function landing(o: { fails?: () => boolean; rc?: (log: string) => number; review?: (r: ReviewInput) => Verdict; ciLand?: CiLand | null; land?: () => [number, string]; affectedBy?: string } = {}): [Landing, Fake] {
  const f: Fake = { events: [], logs: [], calls: [], checks: [], states: new Map(), reviews: [], lands: [], affected: 0 };
  const ok = (out = ""): TrOut => ({ code: 0, out, err: "" });
  const c: LaneCtx = {
    MAIN: "main", HOST: "Box", LANE: "2", TDIR: "/nonexistent",
    log: (s) => { f.logs.push(s); },
    event: (k, m) => { f.events.push([k, m]); },
    halt: async () => {},
    check: async (log) => {
      f.checks.push(log);
      const rc = o.rc?.(log) || ((o.fails ?? (() => fs.existsSync("fail-check")))() ? 1 : 0);
      fs.writeFileSync(log, rc === 0 ? "checked\n" : rc === 1 ? "1 check failed\n" : `stopped at ${rc}\n`);
      return rc;
    },
    tr: (a) => {
      f.calls.push(a);
      if (a[0] === "show") return ok(`${a[1]}: the card\n`);
      if (a[0] === "ci-land") return o.ciLand === null ? { code: 1, out: "", err: "tracker: origin unreachable\n" } : ok(JSON.stringify(o.ciLand ?? { since: "", checks: [], skipped: [], why: "no ci.land in tracker/project.json" }));
      if (a[0] === "land-fail") return ok(f.states.get("land-fail") ?? `${a[1]} → ready, on its branch (the check before landing failed)\n`);
      if (a[0] === "review-none") return ok(`${a[1]} → stuck (the loop's review gave no verdict 3 times)\n`);
      if (a[0] === "state" && a[2] === "--overruled") return ok(`${f.states.get(`${a[1]} overruled`) ?? ""}\n`);
      if (a[0] === "state" && a[2] === "--branch" && f.states.has(`${a[1]} branch`)) return ok(`${f.states.get(`${a[1]} branch`)}\n`);
      if (a[0] === "state") { const s = f.states.get(a[1]); return s === undefined ? { code: 1, out: "", err: `no unit "${a[1]}"\n` } : ok(`${s}\n`); }
      if (a[0] === "add-unit" || a[0] === "reopen") f.states.set(a[1], "ready");
      if (a[0] === "block") f.states.set(a[1], "stuck");
      if (a[0] === "drop") f.states.set(a[1], "dropped");
      return ok();
    },
    review: async (r) => { f.reviews.push(r); return o.review ? o.review(r) : { verdict: "pass" }; },
    landCheck: async (cmd, minutes, log, add) => {
      f.lands.push({ cmd, minutes, add, tree: fs.readdirSync(".").filter((x) => !x.startsWith(".")).sort().join(" ") });
      const [rc, out] = o.land ? o.land() : [0, "drill: matched"];
      fs.writeFileSync(log, `rows\n${out}\n`);
      return rc;
    },
    affected: async () => { f.affected++; },
    affectedBy: async () => o.affectedBy ?? "",
  };
  return [new Landing(c), f];
}
// The unit a lane files when main's own check fails in its clone (the fake lane is on host Box).
const FIX = "merge/box-main-check";
const unitBranch = (b: string, files: Record<string, string>) => {
  spawnSync("git", ["checkout", "-q", "-b", b, "origin/main"]);
  for (const [p, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, t); }
  sh(".", `git add -A && git commit -qm "${b}: work"`);
};
const onOrigin = (r: ReturnType<typeof lane>, p: string) => { try { return r.origin(`git show main:${p}`); } catch { return null; } };

test("a finished branch lands: merged into main with a commit naming it, pushed, deleted, and the tracker told", async () => {
  const r = lane(); const [l, f] = landing();
  unitBranch("unit/g/a", { "a.txt": "a\n" });
  assert.equal(await l.land("unit/g/a", "Unit a (g/a)"), 0);
  assert.equal(onOrigin(r, "a.txt"), "a");
  assert.equal(r.origin("git log -1 --format=%s main"), "Unit a (g/a): merged from Box lane 2");
  assert.equal(r.here("git branch --list unit/g/a"), "");
  assert.equal(r.here("git rev-parse --abbrev-ref HEAD"), "main");
  assert.deepEqual(f.calls.filter((c) => c[0] === "merged"), [["merged", "--branch", "unit/g/a"]]);
  assert.deepEqual(f.checks, ["runs/land-check.log"]);
});

test("a branch with nothing to merge lands as it is, with no check", async () => {
  lane(); const [l, f] = landing({ fails: () => true });
  spawnSync("git", ["checkout", "-q", "-b", "unit/g/empty", "origin/main"]);
  assert.equal(await l.land("unit/g/empty", "Unit empty (g/empty)"), 0);
  assert.deepEqual(f.checks, []);
  assert.ok(f.logs.some((s) => s.includes("unit/g/empty had nothing to merge")));
});

test("what the session left uncommitted is committed on its branch before it lands", async () => {
  const r = lane(); const [l] = landing();
  unitBranch("unit/g/left", { "done.txt": "x\n" });
  fs.writeFileSync("left.txt", "left behind\n");
  assert.equal(await l.land("unit/g/left", "Unit left (g/left)"), 0);
  assert.equal(onOrigin(r, "left.txt"), "left behind");
});

test("a branch's tracker/ edits are dropped, new files too, and the overseer hears", async () => {
  const r = lane(); const [l, f] = landing();
  unitBranch("unit/g/t", { "t.txt": "t\n", "tracker/state.json": '{"sneaky":1}\n', "tracker/new.json": "{}\n" });
  assert.equal(await l.land("unit/g/t", "Unit t (g/t)"), 0);
  assert.equal(onOrigin(r, "t.txt"), "t");
  assert.equal(onOrigin(r, "tracker/state.json"), "{}");
  assert.equal(onOrigin(r, "tracker/new.json"), null);
  assert.ok(f.events.some(([k, m]) => k === "tracker-edits" && m.startsWith("Unit t (g/t) changed tracker/")));
});

test("a branch's edits to the loop's scripts are dropped, and where they are is said", async () => {
  const r = lane(); const [l, f] = landing();
  unitBranch("unit/g/s", { "s.txt": "s\n", "factory/loop.sh": "# changed\n", "factory/extra.sh": "# new\n" });
  assert.equal(await l.land("unit/g/s", "Unit s (g/s)"), 0);
  assert.equal(onOrigin(r, "factory/loop.sh"), "# the loop");
  assert.equal(onOrigin(r, "factory/extra.sh"), null);
  assert.equal(onOrigin(r, "s.txt"), "s");
  const e = f.events.find(([k]) => k === "factory-edits");
  assert.match(e?.[1] ?? "", /`git diff [0-9a-f]{9} [0-9a-f]+ -- factory\/` has them/);
});

test("a branch that conflicts with main needs a merge unit, and says which files", async () => {
  const r = lane(); const [l] = landing();
  r.elsewhere("echo theirs > shared.txt && git commit -qam theirs && git push -q origin main");
  unitBranch("unit/g/c", { "shared.txt": "ours\n" });
  assert.equal(await l.land("unit/g/c", "Unit c (g/c)"), 1);
  assert.equal(l.why, "merging main conflicts in shared.txt");
  assert.equal(onOrigin(r, "shared.txt"), "theirs");
  assert.equal(r.here("git branch --list unit/g/c").replace(/^[* ]+/, ""), "unit/g/c");
});

test("a branch that fails the check, main passing alone: a merge unit; main failing alone too: the branch waits, and isn't checked again on that main while the unit that's to fix it is open", async () => {
  const r = lane(); const [l, f] = landing();
  unitBranch("unit/g/breaks", { "fail-check": "" });
  assert.equal(await l.land("unit/g/breaks", "Unit breaks (g/breaks)"), 1);
  assert.match(l.why, /^`just check` fails on the branch with main merged in \(1 check failed\)/);
  assert.deepEqual(f.checks, ["runs/land-check.log", "runs/main-check.log"]);
  assert.equal(onOrigin(r, "fail-check"), null);

  r.elsewhere("git pull -q origin main && touch fail-check && git add fail-check && git commit -qm 'break main' && git push -q origin main");
  spawnSync("git", ["checkout", "-q", "-f", "main"]);
  unitBranch("unit/g/waits", { "w.txt": "w\n" });
  f.checks.length = 0;
  assert.equal(await l.land("unit/g/waits", "Unit waits (g/waits)"), 3);
  assert.match(l.why, /^main itself fails `just check` \(1 check failed\)/);
  assert.equal(f.checks.length, 2);
  // (finishUnit files the unit that's to find what fails.)
  f.states.set(FIX, "ready");
  // The tracker writes to main again: main's code is the same, so the branch isn't checked again.
  r.elsewhere("git pull -q origin main && echo '{\"later\":1}' > tracker/state.json && git commit -qam 'tracker: a write' && git push -q origin main");
  f.checks.length = 0;
  assert.equal(await l.land("unit/g/waits", "Unit waits (g/waits)"), 3);
  assert.deepEqual(f.checks, []);
  assert.equal(l.why, "main itself fails `just check` (runs/main-check.log)");
  // That unit done: what it fixed may be nothing in main's code, so the branch is checked again.
  f.states.set(FIX, "done");
  assert.equal(await l.land("unit/g/waits", "Unit waits (g/waits)"), 3);
  assert.equal(f.checks.length, 2);
  // Main fixed: it lands.
  r.elsewhere("git pull -q origin main && git rm -q fail-check && git commit -qm fix && git push -q origin main");
  assert.equal(await l.land("unit/g/waits", "Unit waits (g/waits)"), 0);
  assert.equal(onOrigin(r, "w.txt"), "w");
});

test("main moving during the check (a tracker write) loses the push race: merged again, not checked again", async () => {
  const r = lane();
  let raced = false;
  const [l, f] = landing({ fails: () => {
    if (!raced) { raced = true; r.elsewhere("git pull -q origin main && echo '{\"mid\":1}' > tracker/state.json && git commit -qam 'tracker: mid-check' && git push -q origin main"); }
    return false;
  } });
  unitBranch("unit/g/race", { "race.txt": "r\n" });
  assert.equal(await l.land("unit/g/race", "Unit race (g/race)"), 0);
  assert.equal(f.checks.length, 1);
  assert.equal(onOrigin(r, "race.txt"), "r");
  assert.equal(onOrigin(r, "tracker/state.json"), '{"mid":1}');
});

test("an unfinished branch is pushed for whoever's next, but never over origin's copy that moved on", () => {
  const r = lane(); const [l, f] = landing();
  unitBranch("unit/g/p", { "p.txt": "mine\n" });
  assert.equal(l.pushBranch("g/p", "unit/g/p"), true);
  assert.equal(r.origin("git show unit/g/p:p.txt"), "mine");
  assert.ok(f.calls.some((c) => c.join(" ") === "settle g/p --pushed"));
  // Carried on elsewhere and pushed; this clone moved too.
  r.elsewhere("git fetch -q origin && git checkout -q -b unit/g/p origin/unit/g/p && echo theirs >> p.txt && git commit -qam theirs && git push -q origin unit/g/p");
  r.here("echo more >> p.txt && git commit -qam more && git fetch -q origin");
  assert.equal(l.pushBranch("g/p", "unit/g/p"), false);
  assert.equal(r.origin("git show unit/g/p:p.txt"), "mine\ntheirs");
  assert.ok(f.events.some(([k, m]) => k === "stuck-branch" && m === "unit/g/p on Box lane 2 and on origin have both moved; nothing was overwritten"));
});

test("a branch the lane takes up again takes in what was pushed since, or says they clash", () => {
  const r = lane(); const [l, f] = landing();
  unitBranch("unit/g/b", { "b.txt": "first\n" });
  l.pushBranch("g/b", "unit/g/b");
  r.elsewhere("git fetch -q origin && git checkout -q -b unit/g/b origin/unit/g/b && echo other > other.txt && git add other.txt && git commit -qm other && git push -q origin unit/g/b");
  spawnSync("git", ["checkout", "-q", "-f", "main"]);
  assert.equal(l.startBranch("unit/g/b"), true);
  assert.equal(fs.readFileSync("other.txt", "utf8"), "other\n");   // fast-forwarded to origin's
  // Both move, clashing.
  r.here("echo here > b.txt && git commit -qam here");
  r.elsewhere("echo there > b.txt && git commit -qam there && git push -q origin unit/g/b");
  spawnSync("git", ["checkout", "-q", "-f", "main"]);
  assert.equal(l.startBranch("unit/g/b"), true);
  assert.equal(fs.readFileSync("b.txt", "utf8"), "here\n");
  assert.ok(f.events.some(([k, m]) => k === "stuck-branch" && m.endsWith("have both moved and clash; the session works on this clone's, and origin's keeps its own")));
});

test("a merge the lane can't do: a merge unit for this lane, reopened, then stuck at the third failure", () => {
  lane(); const [l, f] = landing();
  const id = "merge/box-lane2-g-x";
  l.fileMergeUnit("g/x", "unit/g/x", "merging main conflicts in a.txt");
  const add = f.calls.find((c) => c[0] === "add-unit");
  assert.deepEqual(add?.slice(0, 4), ["add-unit", id, "--title", "Merge main on Box lane 2"]);
  assert.ok(add?.includes("--lane") && add.includes("Box/2") && add.includes("unit/g/x"));
  assert.equal(fs.readFileSync("runs/.merge-unit", "utf8"), `${id}\n`);
  f.states.set(id, "ready");
  l.fileMergeUnit("g/x", "unit/g/x", "still conflicts");
  assert.ok(f.calls.some((c) => c[0] === "reopen" && c[1] === id));
  assert.equal(f.events.length, 0);
  l.fileMergeUnit("g/x", "unit/g/x", "conflicts a third time");
  assert.ok(f.calls.some((c) => c[0] === "block" && c[1] === id));
  assert.deepEqual(f.events.map(([k]) => k), ["stuck-merge"]);
  assert.ok(!fs.existsSync("runs/.merge-unit"));
});

test("a merge unit's ID: the lane and the unit, in lowercase, dashes for the rest, at most 60 characters", () => {
  lane(); const [l] = landing();
  assert.equal(l.mergeSlug("g/Some_Unit.2"), "box-lane2-g-some-unit.2");
  assert.equal(l.mergeSlug(`g/${"x".repeat(80)}`).length, 60);
});

// Main's own check failing in the lane's clone. Fourteen times in two weeks one factory's lanes
// took that for a broken main and stopped; none of the fourteen came from main's code (the
// tracker's data, a check killed or out of time, a file left in the work/ the lanes share). So a
// session is sent to find what fails, and the lane goes on.
test("main's check fails here: a unit is filed to find what fails, for this lane to take next; the lane goes on, and nobody is told main is broken", async () => {
  const r = lane(); const [l, f] = landing();
  r.elsewhere("touch fail-check && git add fail-check && git commit -qm 'break main' && git push -q origin main");
  f.states.set("g/w1", "merging").set("g/w2", "merging");
  unitBranch("unit/g/w1", { "w1.txt": "1\n" });
  await l.finishUnit("g/w1", "unit/g/w1", "Unit w1 (g/w1)");
  const add = f.calls.find((c) => c[0] === "add-unit");
  assert.deepEqual(add?.slice(0, 4), ["add-unit", FIX, "--title", "Main's check fails on Box"]);
  assert.ok(add?.includes("--lane") && add.includes("Box/2"));
  assert.match(add![add!.indexOf("--detail") + 1], /^`just check` fails on origin\/main itself in Box lane 2's clone: main itself fails `just check` \(1 check failed\)\. .*Never weaken the check/);
  assert.equal(fs.readFileSync("runs/.merge-unit", "utf8"), `${FIX}\n`);
  assert.equal(l.red, "", "the lane takes units still");
  assert.equal(f.events.length, 0);
  // A second branch while that unit is open: nothing more is filed.
  spawnSync("git", ["checkout", "-q", "-f", "main"]);
  unitBranch("unit/g/w2", { "w2.txt": "2\n" });
  await l.finishUnit("g/w2", "unit/g/w2", "Unit w2 (g/w2)");
  assert.equal(f.calls.filter((c) => c[0] === "add-unit" || c[0] === "reopen").length, 1);
  assert.equal(l.red, "");
  assert.equal(f.events.length, 0);
  // Each waits, pushed for whoever's next, and the lane is back on main.
  assert.equal(r.origin("git show unit/g/w2:w2.txt"), "2");
  assert.equal(r.here("git rev-parse --abbrev-ref HEAD"), "main");
});

test("  another lane's such unit is open: this lane files none, doesn't take it, and goes on", async () => {
  const r = lane(); const [l, f] = landing();
  r.elsewhere("touch fail-check && git add fail-check && git commit -qm 'break main' && git push -q origin main");
  f.states.set("g/w1", "merging").set(FIX, "doing");
  unitBranch("unit/g/w1", { "w1.txt": "1\n" });
  await l.finishUnit("g/w1", "unit/g/w1", "Unit w1 (g/w1)");
  assert.equal(f.calls.filter((c) => ["add-unit", "reopen", "block"].includes(c[0])).length, 0);
  assert.ok(!fs.existsSync("runs/.merge-unit"));
  assert.equal(l.red, "");
  assert.ok(f.logs.some((x) => x.includes(`Main's check fails on Box (${FIX}) is to put it right; finished branches wait for it, and the lane goes on`)));
});

test("  that unit was filed by a lane here that isn't running any more, with nobody at it: this lane takes it, so the branches don't wait on a unit no lane works", async () => {
  const r = lane(); const [l, f] = landing();
  l.c.TDIR = path.join(r.d, "tdir");
  fs.mkdirSync(path.join(l.c.TDIR, "groups"), { recursive: true });
  fs.writeFileSync(path.join(l.c.TDIR, "groups/merge.json"), JSON.stringify({ units: [{ id: FIX, title: "Main's check fails on Box", lane: "Box/1" }] }));
  r.elsewhere("touch fail-check && git add fail-check && git commit -qm 'break main' && git push -q origin main");
  f.states.set("g/w1", "merging").set(FIX, "ready");
  unitBranch("unit/g/w1", { "w1.txt": "1\n" });
  // Lane 1 running: it's left to it.
  l.c.laneRunning = () => true;
  await l.finishUnit("g/w1", "unit/g/w1", "Unit w1 (g/w1)");
  assert.ok(!fs.existsSync("runs/.merge-unit"));
  l.c.laneRunning = () => false;
  await l.finishUnit("g/w1", "unit/g/w1", "Unit w1 (g/w1)");
  assert.deepEqual(f.calls.find((c) => c[0] === "edit"), ["edit", FIX, "--lane", "Box/2"]);
  assert.equal(fs.readFileSync("runs/.merge-unit", "utf8"), `${FIX}\n`);
  assert.equal(l.red, "");
});

// The tracker refuses text that names a unit by its bare ID, and a check's last line may name one.
test("  the check's last line is text the tracker refuses: the unit is filed without that line, not left unfiled", async () => {
  const r = lane(); const [l, f] = landing();
  const tr = l.c.tr;
  l.c.tr = (a, add) => a[0] === "add-unit" && a.join(" ").includes("1 check failed") ? (f.calls.push(a), { code: 2, out: "", err: "--detail names g/x by a bare ID\n" }) : tr(a, add);
  r.elsewhere("touch fail-check && git add fail-check && git commit -qm 'break main' && git push -q origin main");
  f.states.set("g/w1", "merging");
  unitBranch("unit/g/w1", { "w1.txt": "1\n" });
  await l.finishUnit("g/w1", "unit/g/w1", "Unit w1 (g/w1)");
  const adds = f.calls.filter((c) => c[0] === "add-unit");
  assert.equal(adds.length, 2);
  assert.match(adds[1].join(" "), /in Box lane 2's clone: main itself fails `just check`\. `runs\/main-check\.log` there has its output/);
  assert.equal(f.states.get(FIX), "ready");
  assert.equal(fs.readFileSync("runs/.merge-unit", "utf8"), `${FIX}\n`);
});

test("  what failed wasn't in git (a file left in work/): once that unit is done the waiting branch is checked again, and lands", async () => {
  const r = lane(); const [l, f] = landing({ fails: () => fs.existsSync("../stray") });
  fs.writeFileSync("../stray", "");
  f.states.set("g/w1", "merging");
  unitBranch("unit/g/w1", { "w1.txt": "1\n" });
  await l.finishUnit("g/w1", "unit/g/w1", "Unit w1 (g/w1)");
  assert.equal(f.states.get(FIX), "ready");
  // Its session removes the file and records it done, with nothing to commit.
  fs.rmSync("../stray"); f.states.set(FIX, "done");
  await l.finishUnit("g/w1", "unit/g/w1", "Unit w1 (g/w1)");
  assert.equal(onOrigin(r, "w1.txt"), "1");
  assert.equal(f.events.length, 0);
  assert.equal(l.red, "");
});

test("  still failing after two sessions looked: main is red, the lane takes no more units, and the overseer hears once", async () => {
  const r = lane(); const [l, f] = landing();
  r.elsewhere("touch fail-check && git add fail-check && git commit -qm 'break main' && git push -q origin main");
  f.states.set("g/w1", "merging").set("g/w2", "merging");
  unitBranch("unit/g/w1", { "w1.txt": "1\n" });
  await l.finishUnit("g/w1", "unit/g/w1", "Unit w1 (g/w1)");
  // The first session records it done; main still fails: the unit is reopened for a second.
  f.states.set(FIX, "done");
  await l.finishUnit("g/w1", "unit/g/w1", "Unit w1 (g/w1)");
  assert.equal(f.calls.filter((c) => c[0] === "reopen" && c[1] === FIX).length, 1);
  assert.match(f.calls.find((c) => c[0] === "reopen")![3], /^`just check` still fails on Box: main itself fails/);
  assert.equal(l.red, ""); assert.equal(f.events.length, 0);
  // The second too: it's stuck, and main is red.
  f.states.set(FIX, "done");
  await l.finishUnit("g/w1", "unit/g/w1", "Unit w1 (g/w1)");
  assert.ok(f.calls.some((c) => c[0] === "block" && c[1] === FIX && /still fails on Box after 2 sessions/.test(c[3])));
  assert.ok(!fs.existsSync("runs/.merge-unit"));
  assert.match(l.red, /^main itself fails `just check`/);
  assert.deepEqual(f.events.map(([k]) => k), ["main-broken"]);
  assert.match(f.events[0][1], /^main itself fails `just check` \(1 check failed\); the unit filed to put it right \(merge\/box-main-check\) didn't put it right \(`just show merge\/box-main-check`\); Box lane 2 stops taking units, its finished branch pushed\. Stop the lanes, fix main, and start them again once main passes$/);
  // Once per broken main, not at every branch and look.
  spawnSync("git", ["checkout", "-q", "-f", "main"]);
  unitBranch("unit/g/w2", { "w2.txt": "2\n" });
  await l.finishUnit("g/w2", "unit/g/w2", "Unit w2 (g/w2)");
  await l.finishUnit("g/w1", "unit/g/w1", "Unit w1 (g/w1)");
  assert.equal(f.events.length, 1);
  assert.equal(r.origin("git show unit/g/w2:w2.txt"), "2");
});

test("  that unit's own branch failing the same way counts as a session that didn't fix it", async () => {
  const r = lane(); const [l, f] = landing();
  r.elsewhere("touch fail-check && git add fail-check && git commit -qm 'break main' && git push -q origin main");
  const b = `unit/${FIX}`;
  fs.writeFileSync("runs/.merge-tries-merge_box-main-check", "1\n");
  f.states.set(FIX, "merging");
  unitBranch(b, { "tried.txt": "x\n" });
  await l.finishUnit(FIX, b, "Main's check fails on Box");
  assert.equal(f.calls.filter((c) => c[0] === "reopen" && c[1] === FIX).length, 1);
  assert.equal(l.red, "");
  f.states.set(FIX, "merging");
  await l.finishUnit(FIX, b, "Main's check fails on Box");
  assert.equal(f.states.get(FIX), "stuck");
  assert.notEqual(l.red, "");
});

test("  that unit waiting on the owner: the lanes can't fix it themselves, so main is red at once", async () => {
  const r = lane(); const [l, f] = landing();
  r.elsewhere("touch fail-check && git add fail-check && git commit -qm 'break main' && git push -q origin main");
  f.states.set("g/w1", "merging").set(FIX, "you");
  unitBranch("unit/g/w1", { "w1.txt": "1\n" });
  await l.finishUnit("g/w1", "unit/g/w1", "Unit w1 (g/w1)");
  assert.notEqual(l.red, "");
  assert.match(f.events[0][1], /\(merge\/box-main-check\) waits on the owner/);
});

// That unit open with no session at it (it doesn't fit before the stop, or its lane gave it back):
// the lanes would pile finished work up behind it with nobody told.
test("  that unit open an hour with no lane taking it: main is red, and the overseer hears that", async () => {
  const r = lane(); const [l, f] = landing();
  r.elsewhere("touch fail-check && git add fail-check && git commit -qm 'break main' && git push -q origin main");
  f.states.set("g/w1", "merging");
  unitBranch("unit/g/w1", { "w1.txt": "1\n" });
  await l.finishUnit("g/w1", "unit/g/w1", "Unit w1 (g/w1)");
  // Still ready at the next look, and at the one after: counted from the first.
  await l.finishUnit("g/w1", "unit/g/w1", "Unit w1 (g/w1)");
  const since = Number(fs.readFileSync("runs/.main-check-idle", "utf8"));
  await l.finishUnit("g/w1", "unit/g/w1", "Unit w1 (g/w1)");
  assert.equal(Number(fs.readFileSync("runs/.main-check-idle", "utf8")), since);
  assert.equal(l.red, "");
  // A session at it: not counted.
  f.states.set(FIX, "doing");
  await l.finishUnit("g/w1", "unit/g/w1", "Unit w1 (g/w1)");
  assert.ok(!fs.existsSync("runs/.main-check-idle"));
  // Given back, and an hour on nobody has taken it.
  f.states.set(FIX, "interrupted");
  await l.finishUnit("g/w1", "unit/g/w1", "Unit w1 (g/w1)");
  fs.writeFileSync("runs/.main-check-idle", `${Date.now() - FIX_IDLE_MS - 60_000}\n`);
  await l.finishUnit("g/w1", "unit/g/w1", "Unit w1 (g/w1)");
  assert.notEqual(l.red, "");
  assert.match(f.events[0][1], /\(merge\/box-main-check\) has waited 1 h 1 min with no lane taking it \(`just show merge\/box-main-check`\); Box lane 2 stops taking units/);
});

// With two lanes on a machine, another's unit is nearly always busy: it goes the same way, and once
// main is red the overseer hears those may be why.
test("main's check failing while units here are busy: the same, and the overseer hears they may be why", async () => {
  const r = lane(); const [l, f] = landing();
  const tr = l.c.tr;
  l.c.tr = (a) => a[0] === "busy" ? { code: 0, out: "w\n", err: "" } : tr(a);
  r.elsewhere("touch fail-check && git add fail-check && git commit -qm 'break main' && git push -q origin main");
  f.states.set("g/b1", "merging");
  unitBranch("unit/g/b1", { "b1.txt": "1\n" });
  await l.finishUnit("g/b1", "unit/g/b1", "Unit b1 (g/b1)");
  assert.equal(f.events.length, 0);
  assert.match(f.calls.find((c) => c[0] === "add-unit")!.join(" "), /while units of w have outputs in work\/ that aren't on main yet/);
  f.states.set(FIX, "stuck");
  await l.finishUnit("g/b1", "unit/g/b1", "Unit b1 (g/b1)");
  assert.deepEqual(f.events.map(([k]) => k), ["main-broken"]);
  assert.match(f.events[0][1], /doesn't skip FACTORY_BUSY_GROUPS.*; Box lane 2 stops taking units/);
  assert.match(l.red, /^main itself fails `just check`, while units of w have outputs/);
});

test("main red, then a branch that fixes it lands: main isn't red any more, and the stuck unit is dropped", async () => {
  const r = lane(); const [l, f] = landing();
  // (The tracker's files, where the loop looks for that unit before it asks its state.)
  l.c.TDIR = path.join(r.d, "tdir");
  fs.mkdirSync(path.join(l.c.TDIR, "groups"), { recursive: true });
  fs.writeFileSync(path.join(l.c.TDIR, "groups/merge.json"), JSON.stringify({ units: [{ id: FIX, title: "Main's check fails on Box", lane: "Box/2" }] }));
  r.elsewhere("touch fail-check && git add fail-check && git commit -qm 'break main' && git push -q origin main");
  f.states.set("g/w1", "merging").set("g/fix", "merging").set(FIX, "stuck");
  unitBranch("unit/g/w1", { "w1.txt": "1\n" });
  await l.finishUnit("g/w1", "unit/g/w1", "Unit w1 (g/w1)");
  assert.notEqual(l.red, "");
  assert.match(f.events[0][1], /; Main's check fails on Box \(merge\/box-main-check\) didn't put it right/);
  spawnSync("git", ["checkout", "-q", "-f", "main"]);
  spawnSync("git", ["checkout", "-q", "-b", "unit/g/fix", "origin/main"]);
  sh(".", "git rm -q fail-check && git commit -qm fix");
  await l.finishUnit("g/fix", "unit/g/fix", "Unit fix (g/fix)");
  assert.equal(onOrigin(r, "fail-check"), null);
  assert.equal(l.red, "");
  assert.deepEqual(f.calls.find((c) => c[0] === "drop")?.slice(0, 4), ["drop", FIX, "--why", "`just check` passes on Box again: {unit:g/fix} landed"]);
  // Main breaking again later (with the same code: a tool, say) is news again.
  assert.ok(!fs.existsSync("runs/.main-broken-told"));
});

// A check that never judged the tree says nothing of the branch, nor of main. (Five of that
// factory's fourteen: main's check out of time on a slow machine, or killed while it waited for
// memory an editor held.)
for (const [rc, how] of [[124, "it ran out of time"], [75, "a heavy job in it couldn't get its turn (exit 75)"], [79, "it couldn't check (exit 79)"], [143, "it was killed (signal 15)"]] as const) {
  test(`a check that gives no verdict (exit ${rc}): the branch waits, with no merge unit and no red main; the overseer hears once; it's checked again half an hour later`, async () => {
    const r = lane(); let now = rc as number; const [l, f] = landing({ rc: () => now });
    f.states.set("g/nv", "merging");
    unitBranch("unit/g/nv", { "nv.txt": "n\n" });
    await l.finishUnit("g/nv", "unit/g/nv", "Unit nv (g/nv)");
    assert.deepEqual(f.checks, ["runs/land-check.log"], "main isn't checked: the branch's check said nothing");
    assert.equal(f.calls.filter((c) => ["add-unit", "land-fail", "block"].includes(c[0])).length, 0);
    assert.equal(l.red, "");
    assert.equal(r.origin("git show unit/g/nv:nv.txt"), "n", "its branch is on origin");
    assert.equal(r.here("git rev-parse --abbrev-ref HEAD"), "main");
    assert.deepEqual(f.events.map(([k]) => k), ["check-unrun"]);
    assert.ok(f.events[0][1].startsWith(`Unit nv (g/nv): \`just check\` gave no verdict on it: ${how} (stopped at ${rc}). That says nothing of the branch or of main, so Box lane 2 keeps taking units`), f.events[0][1]);
    // The next look: not checked again yet, and nothing more told.
    await l.finishUnit("g/nv", "unit/g/nv", "Unit nv (g/nv)");
    assert.equal(f.checks.length, 1);
    assert.equal(f.events.length, 1);
    // Half an hour on it is; this time the check runs, and the branch lands.
    fs.writeFileSync("runs/.check-unrun", fs.readFileSync("runs/.check-unrun", "utf8").replace(/\t(\d+)/, (_, t) => `\t${Number(t) - CHECK_RETRY_MS}`));
    now = 0;
    await l.finishUnit("g/nv", "unit/g/nv", "Unit nv (g/nv)");
    assert.equal(onOrigin(r, "nv.txt"), "n");
    assert.ok(!fs.existsSync("runs/.check-unrun-told"));
  });
}

test("the branch's check fails and main's gives no verdict: whose fault it is can't be told, so it waits, and nothing is filed", async () => {
  lane(); const [l, f] = landing({ rc: (log) => log.includes("main-check") ? 143 : 1 });
  unitBranch("unit/g/half", { "h.txt": "h\n" });
  assert.equal(await l.land("unit/g/half", "Unit half (g/half)"), 2);
  assert.equal(l.why, "`just check` gave no verdict on main: it was killed (signal 15) (stopped at 143)");
  assert.deepEqual(f.checks, ["runs/land-check.log", "runs/main-check.log"]);
  assert.equal(f.calls.filter((c) => c[0] === "add-unit").length, 0);
});

test("held for want of a verdict: the overseer hears again two hours on, with how long", async () => {
  lane(); const [l, f] = landing({ rc: () => 124 });
  f.states.set("g/slow", "merging");
  unitBranch("unit/g/slow", { "s.txt": "s\n" });
  await l.finishUnit("g/slow", "unit/g/slow", "Unit slow (g/slow)");
  const told = JSON.parse(fs.readFileSync("runs/.check-unrun-told", "utf8"));
  fs.writeFileSync("runs/.check-unrun-told", JSON.stringify({ ...told, since: told.since - UNRUN_RETELL_MS - 60_000, told: told.told - UNRUN_RETELL_MS }));
  fs.rmSync("runs/.check-unrun");
  await l.finishUnit("g/slow", "unit/g/slow", "Unit slow (g/slow)");
  assert.deepEqual(f.events.map(([k]) => k), ["check-unrun", "check-unrun"]);
  assert.match(f.events[1][1], /landings have been held 2 h 1 min so far$/);
});

test("an unfinished unit that changed nothing: its branch is deleted, not pushed", async () => {
  const r = lane(); const [l] = landing();
  spawnSync("git", ["checkout", "-q", "-b", "unit/g/none", "origin/main"]);
  l.saveBranch("g/none", "unit/g/none", "Unit none (g/none)", "interrupted");
  assert.equal(r.here("git branch --list unit/g/none"), "");
  assert.equal(r.origin("git branch --list unit/g/none"), "");
  assert.equal(r.here("git rev-parse --abbrev-ref HEAD"), "main");
});

test("an index.lock a killed session left is removed, and its work committed", () => {
  const r = lane(); const [l, f] = landing();
  unitBranch("unit/g/il", { "a.txt": "a\n" });
  fs.writeFileSync("wip.txt", "half done\n");
  fs.writeFileSync(".git/index.lock", "");
  const old = new Date(Date.now() - 5 * 60_000); fs.utimesSync(".git/index.lock", old, old);
  l.commitLeft("Unit il (g/il): work in progress");
  assert.ok(f.logs.includes("git: removed the index.lock a killed session left"));
  assert.equal(r.here("git log -1 --format=%s"), "Unit il (g/il): work in progress");
  assert.equal(r.here("git status --porcelain"), "");
});

test("a finished branch is reviewed once its check passes: its diff outside tracker/, its card and main's coding standards", async () => {
  const r = lane(); const [l, f] = landing();
  r.elsewhere("echo 'Name things plainly.' > CODING_STANDARDS.md && git add -A && git commit -qm standards && git push -q origin main");
  r.here("git fetch -q origin");
  unitBranch("unit/g/rv", { "rv.txt": "reviewed\n", "tracker/state.json": "{\"sneaky\": 1}\n" });
  assert.equal(await l.land("unit/g/rv", "Unit rv (g/rv)"), 0);
  assert.equal(f.reviews.length, 1);
  const [rv] = f.reviews;
  assert.equal(rv.unit, "g/rv");
  assert.match(rv.diff, /\+reviewed/);
  assert.doesNotMatch(rv.diff, /tracker\//);
  assert.doesNotMatch(rv.diff, /CODING_STANDARDS/, "main's own changes aren't the branch's");
  assert.equal(rv.card, "g/rv: the card");
  assert.equal(rv.standards, "Name things plainly.");
  assert.deepEqual(f.checks, ["runs/land-check.log"], "checked before it was reviewed");
  assert.equal(onOrigin(r, "rv.txt"), "reviewed");
});

test("  the ci.affected hook's lines over the branch reach the review, its own group's left out", async () => {
  const r = lane(); const [l, f] = landing({ affectedBy: "g\tits own\nother\tchanged its build: fx\n" });
  unitBranch("unit/g/af", { "af.txt": "x\n" });
  assert.equal(await l.land("unit/g/af", "Unit af (g/af)"), 0);
  assert.equal(f.reviews[0].affected, "other\tchanged its build: fx");
  void r;
});

test("a review asking for fixes: not landed; the branch is pushed and its unit goes back with the findings", async () => {
  const r = lane(); const [l, f] = landing({ review: () => ({ verdict: "fix", findings: "- fx.txt:1: says nothing" }) });
  f.states.set("g/fx", "done");
  unitBranch("unit/g/fx", { "fx.txt": "x\n" });
  await l.finishUnit("g/fx", "unit/g/fx", "Unit fx (g/fx)");
  assert.equal(onOrigin(r, "fx.txt"), null, "not on main");
  assert.notEqual(r.origin("git rev-parse -q --verify refs/heads/unit/g/fx || true"), "", "its branch is on origin");
  assert.match(r.origin("git show unit/g/fx:fx.txt"), /x/);
  const fx = f.calls.filter((c) => c[0] === "review-fix");
  assert.equal(fx.length, 1);
  assert.deepEqual(fx[0].slice(0, 5), ["review-fix", "unit/g/fx", "--findings", "- fx.txt:1: says nothing", "--change"]);
  assert.match(fx[0][5], /^[0-9a-f]{40}$/, "the change the review saw, for an overrule");
  assert.equal(f.calls.filter((c) => c[0] === "merged").length, 0);
  assert.equal(r.here("git rev-parse --abbrev-ref HEAD"), "main");
});

// An overrule (tracker overrule) holds for the change the review sent back, and no other.
test("overruled: the change the review sent back lands unreviewed; any other is reviewed", async () => {
  const r = lane(); const [l, f] = landing({ review: () => ({ verdict: "fix", findings: "- ov.txt:1: wrong" }) });
  f.states.set("g/ov", "done");
  unitBranch("unit/g/ov", { "ov.txt": "x\n" });
  await l.finishUnit("g/ov", "unit/g/ov", "Unit ov (g/ov)");
  const change = f.calls.find((c) => c[0] === "review-fix")![5];
  f.states.set("g/ov overruled", `${change}\tthe finding is wrong`);
  r.here("git checkout -q unit/g/ov");
  const n = f.reviews.length;
  assert.equal(await l.land("unit/g/ov", "Unit ov (g/ov)"), 0);
  assert.equal(f.reviews.length, n, "not reviewed again");
  assert.match(onOrigin(r, "ov.txt") ?? "", /x/);
  f.states.set("g/ow overruled", `${change}\tthe finding is wrong`);
  unitBranch("unit/g/ow", { "ow.txt": "y\n" });
  assert.equal(await l.land("unit/g/ow", "Unit ow (g/ow)"), 4, "another change: reviewed");
  assert.equal(f.reviews.length, n + 1);
});

test("a branch that changes nothing outside tracker/ lands with no review", async () => {
  lane(); const [l, f] = landing();
  unitBranch("unit/g/tr", { "tracker/state.json": "{\"only\": 1}\n" });
  assert.equal(await l.land("unit/g/tr", "Unit tr (g/tr)"), 0);
  assert.equal(f.reviews.length, 0);
});

test("main's check failing: the branch waits, and no review is spent on it", async () => {
  lane(); const [l, f] = landing({ fails: () => true });
  f.states.set("g/red", "done");
  unitBranch("unit/g/red", { "red.txt": "r\n" });
  await l.finishUnit("g/red", "unit/g/red", "Unit red (g/red)");
  assert.equal(f.states.get(FIX), "ready");
  assert.equal(f.reviews.length, 0);
});

// (Before, such a branch landed unreviewed, with a note and a review-skipped event.)
test("a review with no verdict: not landed; the branch waits, pushed, and the overseer hears it's reviewed again later", async () => {
  const r = lane(); const [l, f] = landing({ review: () => ({ verdict: "none", why: "the review session failed (exit 3)" }) });
  f.states.set("g/nv", "done");
  unitBranch("unit/g/nv", { "nv.txt": "n\n" });
  await l.finishUnit("g/nv", "unit/g/nv", "Unit nv (g/nv)");
  assert.equal(onOrigin(r, "nv.txt"), null, "not on main");
  assert.equal(r.origin("git show unit/g/nv:nv.txt"), "n", "its branch is on origin");
  assert.equal(f.calls.filter((c) => c[0] === "merged" || c[0] === "note" || c[0] === "review-none").length, 0);
  assert.deepEqual(f.events.map(([k]) => k), ["review-unrun"]);
  assert.match(f.events[0][1], /^Unit nv \(g\/nv\): the loop's review gave no verdict on its branch \(the review session failed \(exit 3\)\), so it isn't landed: the branch waits, pushed, and is reviewed again after \d\d:\d\d, while Box lane 2 takes other units \(try 1 of 3; /);
  assert.equal(r.here("git rev-parse --abbrev-ref HEAD"), "main");
});

test("  not reviewed again, nor checked, until REVIEW_RETRY_MS has passed; then a pass lands it", async () => {
  const r = lane();
  let v: Verdict = { verdict: "none", why: "its review went silent" };
  const [l, f] = landing({ review: () => v });
  unitBranch("unit/g/rr", { "rr.txt": "r\n" });
  assert.equal(await l.land("unit/g/rr", "Unit rr (g/rr)"), 2);
  assert.equal(await l.land("unit/g/rr", "Unit rr (g/rr)"), 2);
  assert.match(l.why, /^the loop's review gave no verdict on it at \d\d:\d\d; it's reviewed again after \d\d:\d\d$/);
  assert.equal(f.reviews.length, 1);
  assert.deepEqual(f.checks, ["runs/land-check.log"]);
  fs.writeFileSync("runs/.review-unrun", fs.readFileSync("runs/.review-unrun", "utf8").replace(/\t(\d+)\t/, (_, t) => `\t${Number(t) - REVIEW_RETRY_MS}\t`));
  v = { verdict: "pass" };
  assert.equal(await l.land("unit/g/rr", "Unit rr (g/rr)"), 0);
  assert.equal(f.reviews.length, 2);
  assert.equal(onOrigin(r, "rr.txt"), "r");
  assert.ok(!fs.existsSync("runs/.review-unrun"), "nothing left waiting");
});

test("  $FACTORY_REVIEW_RETRY, in seconds, in its place", async () => {
  lane(); const [l, f] = landing({ review: () => ({ verdict: "none", why: "x" }) });
  unitBranch("unit/g/re", { "re.txt": "r\n" });
  process.env.FACTORY_REVIEW_RETRY = "0";
  try {
    await l.land("unit/g/re", "Unit re (g/re)");
    await l.land("unit/g/re", "Unit re (g/re)");
  } finally { delete process.env.FACTORY_REVIEW_RETRY; }
  assert.equal(f.reviews.length, 2);
});

test("  the third with no verdict for the same change: the unit is stuck for the overseer (review-none), never landed", async () => {
  const r = lane();
  let n = 0;
  const [l, f] = landing({ review: () => ({ verdict: "none", why: `the review session failed (exit ${++n})` }) });
  f.states.set("g/n3", "done");
  unitBranch("unit/g/n3", { "n3.txt": "3\n" });
  process.env.FACTORY_REVIEW_RETRY = "0";
  try { for (let i = 0; i < 3; i++) await l.finishUnit("g/n3", "unit/g/n3", "Unit n3 (g/n3)"); } finally { delete process.env.FACTORY_REVIEW_RETRY; }
  assert.equal(f.reviews.length, 3);
  assert.equal(onOrigin(r, "n3.txt"), null, "not on main");
  assert.equal(r.origin("git show unit/g/n3:n3.txt"), "3", "its branch is on origin");
  assert.deepEqual(f.calls.filter((c) => c[0] === "review-none"), [["review-none", "unit/g/n3", "--why", "the review session failed (exit 3)"]]);
  assert.deepEqual(f.events.map(([k]) => k), ["review-unrun", "review-unrun", "stuck"]);
  assert.match(f.events[1][1], /try 2 of 3/);
  assert.equal(f.events[2][1], "g/n3: the loop's review gave no verdict 3 times, so it waits for the overseer (`just show g/n3` says why)");
  assert.ok(!fs.existsSync("runs/.review-unrun"), "a reopen starts its tries afresh");
});

test("  a usage limit (a wait) isn't a try: three in a row leave it waiting, not stuck", async () => {
  lane(); const [l, f] = landing({ review: () => ({ verdict: "wait", why: "the reviewer hit a usage limit" }) });
  f.states.set("g/ul", "done");
  unitBranch("unit/g/ul", { "ul.txt": "u\n" });
  for (let i = 0; i < 4; i++) await l.finishUnit("g/ul", "unit/g/ul", "Unit ul (g/ul)");
  assert.equal(f.reviews.length, 4, "reviewed again at each look");
  assert.equal(f.calls.filter((c) => c[0] === "review-none").length, 0);
  assert.deepEqual(f.events, []);
});

test("a review stopped by a pause: the branch waits for the next look, not landed", async () => {
  const r = lane(); const [l] = landing({ review: () => ({ verdict: "wait", why: "a pause stopped its review" }) });
  unitBranch("unit/g/wt", { "wt.txt": "w\n" });
  assert.equal(await l.land("unit/g/wt", "Unit wt (g/wt)"), 2);
  assert.equal(onOrigin(r, "wt.txt"), null);
  assert.equal(r.here("git rev-parse --abbrev-ref HEAD"), "unit/g/wt");
});

test("main moving during the review: merged again and pushed, not reviewed again", async () => {
  const r = lane();
  let n = 0;
  const [l, f] = landing({ review: () => { if (n++ === 0) r.elsewhere("git pull -q && echo m > m.txt && git add -A && git commit -qm moved && git push -q origin main"); return { verdict: "pass" }; } });
  unitBranch("unit/g/mv", { "mv.txt": "v\n" });
  assert.equal(await l.land("unit/g/mv", "Unit mv (g/mv)"), 0);
  assert.equal(f.reviews.length, 1);
  assert.equal(onOrigin(r, "mv.txt"), "v");
  assert.equal(onOrigin(r, "m.txt"), "m");
});

// A review whose landing then fails: origin goes away while it runs (the push and the fetch after fail).
const goneDuring = (r: ReturnType<typeof lane>, v: Verdict) => {
  let n = 0;
  return () => { if (n++ === 0) fs.renameSync(path.join(r.d, "origin.git"), path.join(r.d, "origin.away")); return v; };
};
const back = (r: ReturnType<typeof lane>) => fs.renameSync(path.join(r.d, "origin.away"), path.join(r.d, "origin.git"));

test("a review that passed isn't run again when the landing failed after it, the branch as it was", async () => {
  const r = lane(); const [l, f] = landing({ review: goneDuring(r, { verdict: "pass" }) });
  unitBranch("unit/g/pa", { "pa.txt": "p\n" });
  assert.equal(await l.land("unit/g/pa", "Unit pa (g/pa)"), 2);
  back(r);
  assert.equal(await l.land("unit/g/pa", "Unit pa (g/pa)"), 0);
  assert.equal(f.reviews.length, 1);
  assert.equal(onOrigin(r, "pa.txt"), "p");
});

// The check before landing (ci.land): what the project runs on the tree as it would land.
test("the check before landing passes: it ran on the merged tree, with the unit and its claim time, and the branch lands", async () => {
  const r = lane(); const [l, f] = landing({ ciLand: LAND });
  r.elsewhere("echo m > m.txt && git add m.txt && git commit -qm 'main moved' && git push -q origin main");
  unitBranch("unit/g/lc", { "lc.txt": "l\n" });
  assert.equal(await l.land("unit/g/lc", "Unit lc (g/lc)"), 0);
  assert.equal(f.lands.length, 1);
  assert.deepEqual({ cmd: f.lands[0].cmd, minutes: f.lands[0].minutes, add: f.lands[0].add }, { cmd: "factory/ci g land", minutes: 15, add: { FACTORY_UNIT: "g/lc", FACTORY_UNIT_SINCE: LAND.since } });
  assert.match(f.lands[0].tree, /lc\.txt.*m\.txt/, "main merged in");
  assert.deepEqual(f.checks, ["runs/land-check.log"]);
  assert.equal(onOrigin(r, "lc.txt"), "l");
  assert.equal(f.affected, 1, "the ci.affected hook looked once it landed");
});

test("the check before landing fails: not landed, the branch pushed, the unit back with its last line", async () => {
  const r = lane(); const [l, f] = landing({ ciLand: LAND, land: () => [1, "drill: work/g/out.json isn't what HEAD builds"] });
  f.states.set("g/lf", "done");
  unitBranch("unit/g/lf", { "lf.txt": "f\n" });
  await l.finishUnit("g/lf", "unit/g/lf", "Unit lf (g/lf)");
  assert.equal(onOrigin(r, "lf.txt"), null, "not on main");
  assert.equal(r.origin("git show unit/g/lf:lf.txt"), "f", "its branch is on origin");
  assert.deepEqual(f.calls.filter((c) => c[0] === "land-fail"), [["land-fail", "unit/g/lf", "--evidence", "drill: work/g/out.json isn't what HEAD builds"]]);
  assert.equal(f.calls.filter((c) => c[0] === "merged").length, 0);
  assert.equal(f.reviews.length, 0, "no review spent on it");
  assert.equal(f.affected, 0);
  assert.equal(r.here("git rev-parse --abbrev-ref HEAD"), "main");
  assert.equal(f.events.length, 0);
});

test("  the third time in a row (the tracker makes it stuck): the overseer hears", async () => {
  lane(); const [l, f] = landing({ ciLand: LAND, land: () => [1, "drill: differs"] });
  f.states.set("g/l3", "done").set("land-fail", "Unit l3 (g/l3) → stuck (the check before landing failed 3 times in a row)\n");
  unitBranch("unit/g/l3", { "l3.txt": "3\n" });
  await l.finishUnit("g/l3", "unit/g/l3", "Unit l3 (g/l3)");
  assert.deepEqual(f.events.map(([k]) => k), ["stuck"]);
  assert.match(f.events[0][1], /^g\/l3: the check before landing failed three times in a row, so it waits for the overseer \(`just show g\/l3` has the last failure\)$/);
});

test("the check before landing out of time: it lands anyway, and the overseer hears", async () => {
  const r = lane(); const [l, f] = landing({ ciLand: { ...LAND, checks: [{ ...G, timeout: 2 }] }, land: () => [124, "capped: waiting for a slot"] });
  unitBranch("unit/g/lt", { "lt.txt": "t\n" });
  assert.equal(await l.land("unit/g/lt", "Unit lt (g/lt)"), 0);
  assert.equal(f.lands[0].minutes, 2);
  assert.equal(onOrigin(r, "lt.txt"), "t");
  assert.deepEqual(f.events.map(([k]) => k), ["land-check-timeout"]);
  assert.match(f.events[0][1], /^Unit lt \(g\/lt\): the check before landing \(factory\/ci g land\) ran out of time after 2 min/);
});

test("the check before landing couldn't check (exit 79: a crash, something missing): not landed, not sent back, tried again at the next look; the overseer hears once, and again every two hours while it's held", async () => {
  const r = lane(); let rc = 79; const [l, f] = landing({ ciLand: LAND, land: () => [rc, rc === 79 ? "FACTORY_UNIT_SINCE isn't set" : "drill: matched"] });
  f.states.set("g/lu", "merging");
  unitBranch("unit/g/lu", { "lu.txt": "u\n" });
  await l.finishUnit("g/lu", "unit/g/lu", "Unit lu (g/lu)");
  assert.equal(onOrigin(r, "lu.txt"), null, "not on main");
  assert.equal(r.origin("git show unit/g/lu:lu.txt"), "u", "its branch is on origin");
  assert.equal(f.calls.filter((c) => c[0] === "land-fail" || c[0] === "merged").length, 0, "not sent back, nothing counted against it");
  assert.equal(f.reviews.length, 0);
  assert.ok(f.logs.some((x) => x.includes("couldn't check (FACTORY_UNIT_SINCE isn't set); it waits for the next look, not sent back")));
  assert.deepEqual(f.events.map(([k]) => k), ["land-check-unrun"]);
  assert.match(f.events[0][1], /^Unit lu \(g\/lu\): the check before landing \(factory\/ci g land\) couldn't check \(exit 79: FACTORY_UNIT_SINCE isn't set\)/);
  // The next look: still 79, nothing more told; then it runs, and the branch lands.
  await l.finishUnit("g/lu", "unit/g/lu", "Unit lu (g/lu)");
  assert.equal(f.events.length, 1, "told once");
  // Still held two hours after it was told (a check that can never run): told again, with how long it's been held.
  const told = JSON.parse(fs.readFileSync("runs/.land-unrun-told", "utf8"));
  const ago = 3 * 3600_000 + 10 * 60_000;
  fs.writeFileSync("runs/.land-unrun-told", JSON.stringify({ ...told, since: told.since - ago, told: told.told - UNRUN_RETELL_MS }));
  await l.finishUnit("g/lu", "unit/g/lu", "Unit lu (g/lu)");
  assert.deepEqual(f.events.map(([k]) => k), ["land-check-unrun", "land-check-unrun"]);
  assert.match(f.events[1][1], /landings have been held 3 h 10 min so far$/);
  await l.finishUnit("g/lu", "unit/g/lu", "Unit lu (g/lu)");
  assert.equal(f.events.length, 2, "not again until two more hours");
  rc = 0;
  await l.finishUnit("g/lu", "unit/g/lu", "Unit lu (g/lu)");
  assert.equal(onOrigin(r, "lu.txt"), "u");
  assert.equal(f.lands.length, 5);
  assert.equal(f.calls.filter((c) => c[0] === "land-fail").length, 0);
});

test("the tracker can't say what check to run before landing: the branch waits for the next look, as when it can't say a unit's state", async () => {
  const r = lane(); const [l, f] = landing({ ciLand: null });
  f.states.set("g/lo", "merging");
  unitBranch("unit/g/lo", { "lo.txt": "o\n" });
  await l.finishUnit("g/lo", "unit/g/lo", "Unit lo (g/lo)");
  assert.equal(onOrigin(r, "lo.txt"), null, "not landed unchecked");
  assert.equal(r.origin("git show unit/g/lo:lo.txt"), "o", "its branch is on origin");
  assert.equal(f.calls.filter((c) => c[0] === "land-fail" || c[0] === "merged").length, 0);
  assert.ok(f.logs.some((x) => x.includes("the tracker couldn't say what check to run before it lands (tracker: origin unreachable); Unit lo (g/lo) waits for the next look")));
});

test("a unit that committed nothing, left waiting on main (its check couldn't run): the next look checks it before it lands", async () => {
  lane(); let rc = 79; const [l, f] = landing({ ciLand: LAND, land: () => [rc, rc === 79 ? "no work/ here" : "drill: a hand fix in work/g"] });
  f.states.set("g/lw", "merging").set("g/lw branch", "unit/g/lw");
  spawnSync("git", ["checkout", "-q", "-b", "unit/g/lw", "origin/main"]);
  await l.finishUnit("g/lw", "unit/g/lw", "Unit lw (g/lw)");
  assert.equal(f.calls.filter((c) => c[0] === "merged").length, 0);
  rc = 1;
  await l.pending();
  assert.equal(f.lands.length, 2, "checked again at the next look");
  assert.equal(f.calls.filter((c) => c[0] === "merged").length, 0, "not landed past its check");
  assert.deepEqual(f.calls.filter((c) => c[0] === "land-fail").map((c) => c[3]), ["drill: a hand fix in work/g"]);
});

test("no check before landing for a group whose CI is broken (the tracker says none): it lands as before", async () => {
  const r = lane(); const [l, f] = landing({ ciLand: { ...LAND, checks: [], skipped: [{ group: "g", why: "Group g's CI is broken" }] }, land: () => [1, "would fail"] });
  unitBranch("unit/g/lb", { "lb.txt": "b\n" });
  assert.equal(await l.land("unit/g/lb", "Unit lb (g/lb)"), 0);
  assert.equal(f.lands.length, 0);
  assert.equal(onOrigin(r, "lb.txt"), "b");
  assert.ok(f.logs.includes("land check: none for Unit lb (g/lb): Group g's CI is broken"));
});

test("a unit that committed nothing gets the check too, on main: failing, it isn't landed", async () => {
  const r = lane(); const [l, f] = landing({ ciLand: LAND, land: () => [1, "drill: a hand fix in work/g"] });
  f.states.set("g/ln", "done");
  spawnSync("git", ["checkout", "-q", "-b", "unit/g/ln", "origin/main"]);
  await l.finishUnit("g/ln", "unit/g/ln", "Unit ln (g/ln)");
  assert.equal(f.lands.length, 1);
  assert.deepEqual(f.calls.filter((c) => c[0] === "land-fail").map((c) => c[3]), ["drill: a hand fix in work/g"]);
  assert.equal(f.calls.filter((c) => c[0] === "merged").length, 0);
  assert.equal(r.here("git rev-parse --abbrev-ref HEAD"), "main");
});

test("  passing, it lands as it is, and the ci.affected hook looks", async () => {
  lane(); const [l, f] = landing({ ciLand: LAND });
  spawnSync("git", ["checkout", "-q", "-b", "unit/g/lp", "origin/main"]);
  assert.equal(await l.land("unit/g/lp", "Unit lp (g/lp)"), 0);
  assert.equal(f.lands.length, 1);
  assert.deepEqual(f.calls.filter((c) => c[0] === "merged"), [["merged", "--branch", "unit/g/lp"]]);
  assert.equal(f.affected, 1);
});

// A unit that wrote other groups' data here gets their checks too (#149), in order, after its own.
const H: CiLandCheck = { group: "h", title: "Group h", cmd: "factory/ci h land", timeout: 5, own: false }, K: CiLandCheck = { group: "k", title: "Group k", cmd: "factory/ci k land", timeout: 5, own: false };
const MANY: CiLand = { ...LAND, checks: [G, H, K], skipped: [{ group: "m", why: "Group m has no CI" }] };

test("checks before landing for several groups: each runs, in order, and the skipped are named", async () => {
  const r = lane(); const [l, f] = landing({ ciLand: MANY });
  unitBranch("unit/g/lm", { "lm.txt": "m\n" });
  assert.equal(await l.land("unit/g/lm", "Unit lm (g/lm)"), 0);
  assert.deepEqual(f.lands.map((x) => [x.cmd, x.minutes, x.add.FACTORY_UNIT_SINCE]), [["factory/ci g land", 15, LAND.since], ["factory/ci h land", 5, LAND.since], ["factory/ci k land", 5, LAND.since]]);
  assert.equal(onOrigin(r, "lm.txt"), "m");
  assert.ok(f.logs.includes("land check: Unit lm (g/lm): not checked: Group m has no CI"), f.logs.join("\n"));
  assert.ok(f.logs.includes("land check: Unit lm (g/lm) passed"));
});

test("  the first that fails stops them: not landed, and its group named in the note", async () => {
  const r = lane(); let n = 0;
  const [l, f] = landing({ ciLand: MANY, land: () => (++n === 2 ? [1, "drift: out/h.txt isn't what HEAD builds"] : [0, "drift: none"]) });
  f.states.set("g/lf2", "done");
  unitBranch("unit/g/lf2", { "lf2.txt": "f\n" });
  await l.finishUnit("g/lf2", "unit/g/lf2", "Unit lf2 (g/lf2)");
  assert.deepEqual(f.lands.map((x) => x.cmd), ["factory/ci g land", "factory/ci h land"], "k's never ran");
  assert.equal(onOrigin(r, "lf2.txt"), null, "not on main");
  assert.deepEqual(f.calls.filter((c) => c[0] === "land-fail").map((c) => c[3]), ["Group h's check: drift: out/h.txt isn't what HEAD builds"]);
  assert.equal(f.calls.filter((c) => c[0] === "merged").length, 0);
});

test("  one that couldn't check holds the branch, as for its own group's", async () => {
  const r = lane(); let n = 0;
  const [l, f] = landing({ ciLand: MANY, land: () => (++n === 3 ? [79, "no work/k here"] : [0, "drift: none"]) });
  f.states.set("g/lu2", "merging");
  unitBranch("unit/g/lu2", { "lu2.txt": "u\n" });
  await l.finishUnit("g/lu2", "unit/g/lu2", "Unit lu2 (g/lu2)");
  assert.equal(onOrigin(r, "lu2.txt"), null);
  assert.equal(f.calls.filter((c) => c[0] === "land-fail" || c[0] === "merged").length, 0);
  assert.deepEqual(f.events.map(([k]) => k), ["land-check-unrun"]);
  assert.match(f.events[0][1], /\(factory\/ci k land\) couldn't check \(exit 79: no work\/k here\)/);
});

test("  its own group skipped (no CI), another's fails: the note names whose check it was", async () => {
  lane(); const [l, f] = landing({ ciLand: { ...LAND, checks: [H], skipped: [{ group: "g", why: "Group g has no CI" }] }, land: () => [1, "drift: out/h.txt differs"] });
  f.states.set("g/lo2", "done");
  unitBranch("unit/g/lo2", { "lo2.txt": "o\n" });
  await l.finishUnit("g/lo2", "unit/g/lo2", "Unit lo2 (g/lo2)");
  assert.deepEqual(f.calls.filter((c) => c[0] === "land-fail").map((c) => c[3]), ["Group h's check: drift: out/h.txt differs"]);
  assert.ok(f.logs.includes("land check: Unit lo2 (g/lo2): not checked: Group g has no CI"));
});

test("  one out of time counts as passed, and the next still runs", async () => {
  const r = lane(); let n = 0;
  const [l, f] = landing({ ciLand: MANY, land: () => (++n === 1 ? [124, "capped: waiting"] : n === 3 ? [1, "drift: out/k.txt differs"] : [0, "drift: none"]) });
  f.states.set("g/lt2", "done");
  unitBranch("unit/g/lt2", { "lt2.txt": "t\n" });
  await l.finishUnit("g/lt2", "unit/g/lt2", "Unit lt2 (g/lt2)");
  assert.equal(f.lands.length, 3);
  assert.deepEqual(f.events.map(([k]) => k), ["land-check-timeout"]);
  assert.equal(onOrigin(r, "lt2.txt"), null);
  assert.deepEqual(f.calls.filter((c) => c[0] === "land-fail").map((c) => c[3]), ["Group k's check: drift: out/k.txt differs"]);
});
