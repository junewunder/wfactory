// A lane's branches and landing: each unit is worked on its own branch, unit/<id>, made from
// origin's main in the lane's clone; a finished one is merged into main here and deleted, an
// unfinished one is pushed for whoever takes the unit next. A finished one that couldn't land
// is pushed too, and any lane on this machine (where its outputs in work/ are) may land it once
// the lane that worked it is gone: one at a time, by the tracker's landing claim. The claim and
// every tracker write go straight to origin's main (the tracker pushes them), so a branch never
// carries tracker/ changes. Kept apart from the loop, where
// leases, pauses and CI meet: the bugs clustered where all of them were interleaved.
import crypto from "node:crypto";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { netGit, reachesRemote } from "../../tracker/src/net.ts";
import type { TrOut } from "./tr.ts";
import type { ReviewInput, Verdict } from "./review.ts";

export interface LaneCtx {
  MAIN: string;
  HOST: string;
  LANE: string;
  TDIR: string;   // the tracker's state (origin's main, .tracker/main/tracker)
  log(s: string): void;
  event(kind: string, msg: string): void;
  // `just check` with these busy groups (FACTORY_BUSY_GROUPS), its output to <log>, stopped by
  // a signal to the loop: true if it passed.
  check(log: string, busy: string): Promise<boolean>;
  // After a signal: what was running is stopped, and the loop goes no further (it never resolves).
  halt(): Promise<void>;
  // The tracker (tr.ts's tr: in the loop's process), with these variables added.
  tr(args: string[], add?: Record<string, string>): TrOut;
  // The review of a finished branch before it lands (review.ts's runReview).
  review(r: ReviewInput): Promise<Verdict>;
  // The project's check before a unit lands (ci.land): its command (bash -c) under a time limit in
  // minutes, with these variables, its output to <log>, stopped by a signal: its exit status (124
  // past the limit).
  landCheck(cmd: string, minutes: number, log: string, add: Record<string, string>): Promise<number>;
  // The ci.affected hook, once main has moved (loop-affected.ts).
  affected(): Promise<unknown>;
  // The ci.affected hook over old..new, for the review: its lines ("<group>\t<why>"), or "" when
  // the project has none or it failed.
  affectedBy(old: string, nw: string): Promise<string>;
}

// FACTORY_PID: the loop's own process, which a landing claim lives with.
const LOOP = { FACTORY_ACTOR: "loop", FACTORY_PID: String(process.pid) };
const read = (f: string) => { try { return fs.readFileSync(f, "utf8"); } catch { return null; } };
const cat = (f: string) => read(f)?.replace(/\n+$/, "") ?? null;

// A check before landing that keeps exiting 79 is told again this often while it holds landings.
export const UNRUN_RETELL_MS = 2 * 3600_000;
// runs/.land-unrun-told: since when landings have been held and when the overseer was last told. A file
// from before it held times (one line, the reason) counts from its own time.
function unrunHeld(f: string, now: number): { since: number; told: number } | null {
  const text = cat(f);
  if (text === null) return null;
  try {
    const j = JSON.parse(text);
    if (typeof j.since === "number" && typeof j.told === "number") return { since: j.since, told: j.told };
  } catch {}
  let at = now;
  try { at = fs.statSync(f).mtimeMs; } catch {}
  return { since: at, told: at };
}
const duration = (ms: number) => {
  const m = Math.round(ms / 60_000), h = Math.floor(m / 60);
  return h ? `${h} h${m % 60 ? ` ${m % 60} min` : ""}` : `${m} min`;
};
const sha1 = (s: string) => crypto.createHash("sha1").update(s).digest("hex");

// This lane's merge units (the merges it couldn't do, which only it takes), first in line first:
// runs/.merge-unit, one per line. A lane takes other work while one waits, so a second can be
// filed meanwhile (#135).
const MERGE_UNITS = "runs/.merge-unit";
export function mergeUnits(): string[] { return (read(MERGE_UNITS) ?? "").split("\n").map((l) => l.trim()).filter(Boolean); }
function setMergeUnits(l: string[]) {
  if (!l.length) { fs.rmSync(MERGE_UNITS, { force: true }); return; }
  const t = `${MERGE_UNITS}.${process.pid}`;
  fs.writeFileSync(t, l.map((x) => `${x}\n`).join("")); fs.renameSync(t, MERGE_UNITS);
}
export function addMergeUnit(id: string) { const l = mergeUnits(); if (!l.includes(id)) setMergeUnits([...l, id]); }
export function dropMergeUnits(drop: (id: string) => boolean) { const l = mergeUnits(); if (l.some(drop)) setMergeUnits(l.filter((x) => !drop(x))); }

// git, quietly: its output (as `$(…)` gives it), or null if it failed.
// One that reaches origin is bounded (tracker/src/net.ts): a dead connection would hang the lane.
export function git(...a: string[]): string | null {
  const o = { encoding: "utf8" as const, stdio: ["ignore", "pipe", "ignore"] as ["ignore", "pipe", "ignore"], maxBuffer: 256 << 20 };
  const r = reachesRemote(a) ? netGit(a, o, 900) : spawnSync("git", a, o);
  return r.status === 0 ? (r.stdout ?? "").replace(/\n+$/, "") : null;
}
// git without failing the loop: did it succeed? (The loop's own git work is logged quietly.)
export const g = (...a: string[]) => git(...a) !== null;
const raw = (...a: string[]) => spawnSync("git", a, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 256 << 20 }).stdout ?? "";
const isRef = (r: string) => spawnSync("git", ["show-ref", "-q", "--verify", r], { stdio: "ignore" }).status === 0;
const isAncestor = (a: string, b: string) => spawnSync("git", ["merge-base", "--is-ancestor", a, b], { stdio: "ignore" }).status === 0;

export class Landing {
  c: LaneCtx;
  why = "";     // why land() couldn't land a branch
  findings = ""; // what its review asked to fix, when land() returned 4
  // (why, when land() returned 5: the check before landing's last line)
  unreviewed = ""; // why its review gave no verdict, told once it has landed
  busy = "";    // the groups busy here at the last look (busyNow)
  red = "";     // main itself fails the check: why, until something lands. The loop takes no new units.
  constructor(c: LaneCtx) { this.c = c; }
  get om() { return `origin/${this.c.MAIN}`; }

  // main's code, not its commit: every tracker write is a commit on main.
  mainCode(): string {
    const t = git("ls-tree", this.om);
    if (t === null) return "";
    return sha1(t.split("\n").filter((l) => !/\ttracker$/.test(l)).map((l) => l + "\n").join(""));
  }
  // What a branch changes, outside tracker/: the same before and after main is merged into it.
  ownChange(): string {
    const base = git("merge-base", this.om, "HEAD") ?? "";
    return sha1(base ? raw("diff", base, "HEAD", "--", ".", ":(exclude)tracker") : "");
  }
  aheadOfMain(b: string) { return Number(git("rev-list", "--count", `${this.om}..${b}`) ?? 0) || 0; }
  // The tracker: its output as `$(…)` gives it ("" if it failed), or whether it succeeded.
  out(a: string[], add?: Record<string, string>) { const r = this.c.tr(a, add); return r.code === 0 ? r.out.replace(/\n+$/, "") : ""; }
  ok(a: string[], add?: Record<string, string>) { return this.c.tr(a, add).code === 0; }
  state(u: string) { const r = this.c.tr(["state", u]); return r.code === 0 ? r.out.replace(/\n+$/, "") : "unknown"; }

  // This lane's checkout back on origin's main, clean (between units).
  toMain() {
    if (!g("fetch", "-q", "--prune", "origin")) this.c.log("git: couldn't fetch origin; working from the last copy");
    g("merge", "--abort");
    if (!g("checkout", "-q", "-f", "-B", this.c.MAIN, this.om)) this.c.log(`git: couldn't check out ${this.c.MAIN}`);
  }

  // The unit's branch, checked out: this lane's own earlier attempt, else one pushed by whoever
  // worked it before (on either machine), else new from main.
  startBranch(b: string): boolean {
    const { log, event, HOST, LANE } = this.c;
    this.toMain();
    if (isRef(`refs/heads/${b}`)) {
      if (isRef(`refs/remotes/origin/${b}`) && isAncestor(b, `origin/${b}`)) g("branch", "-q", "-f", b, `origin/${b}`);
      g("checkout", "-q", b);
      // Both moved (this clone's attempt, and someone's carried on and pushed): take theirs in too.
      if (isRef(`refs/remotes/origin/${b}`) && !isAncestor(`origin/${b}`, b)) {
        if (g("merge", "-q", "--no-edit", "-m", `Merge origin's ${b} (carried on elsewhere)`, `origin/${b}`)) log(`git: merged origin's ${b} into this clone's`);
        else {
          g("merge", "--abort"); log(`git: this clone's ${b} and origin's have both moved and clash; working on this clone's`);
          event("stuck-branch", `${b} on ${HOST} lane ${LANE} and on origin have both moved and clash; the session works on this clone's, and origin's keeps its own`);
        }
      }
    } else if (isRef(`refs/remotes/origin/${b}`)) {
      g("checkout", "-q", "-b", b, `origin/${b}`); log(`git: carrying on from ${b} as pushed`);
    } else g("checkout", "-q", "-b", b, this.om);
    if (git("rev-parse", "--abbrev-ref", "HEAD") !== b) { log(`git: couldn't check out ${b}`); return false; }
    return true;
  }

  // A merge unit taken over from lane n, gone, whose clone (on this machine) may hold work on
  // branch b that never reached origin: that lane was killed in the session, and the save at its
  // next start never came (#172). Commits there that origin's copy lacks are fetched and merged
  // in, as startBranch takes in a copy carried on elsewhere, and pushed; the overseer hears of it
  // either way. If the fetch or the merge fails, the clone is left as it is, and this lane works
  // from origin's copy.
  takeGone(b: string, clone: string, n: string) {
    const { log, event, HOST, LANE } = this.c;
    // (Read only: --no-optional-locks, so not even its index is refreshed.)
    const there = (...a: string[]) => spawnSync("git", ["--no-optional-locks", "-C", clone, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).stdout?.trim() ?? "";
    const tip = there("rev-parse", "-q", "--verify", `refs/heads/${b}`);
    const dirty = there("status", "--porcelain", "--", ".", ":!tracker", ":!work", ":!.env")
      ? `; the clone also has changes never committed (on ${(there("rev-parse", "--abbrev-ref", "HEAD") || "HEAD").replace(/^HEAD$/, "a detached HEAD")}), left there` : "";
    // Nothing to bring in: the overseer hears only of changes never committed.
    const none = () => { if (dirty) event("gone-lane-left", `${b}: lane ${n}'s clone (${clone}) has no commits origin's copy lacks${dirty}`); };
    const onOrigin = isRef(`refs/remotes/origin/${b}`);
    if (!tip || (onOrigin && git("cat-file", "-e", `${tip}^{commit}`) !== null && isAncestor(tip, `origin/${b}`))) { none(); return; }
    const at = `refs/factory-gone/${n}/${b}`, short = tip.slice(0, 12);
    const fail = (what: string) => {
      log(`git: lane ${n}'s ${b} (${short}, in ${clone}) has commits origin's lacks, and ${what}; working from origin's`);
      event("gone-lane-left", `${b} in lane ${n}'s clone (${clone}) has commits origin's lacks, up to ${short}, and ${what}, at the takeover by ${HOST} lane ${LANE}; the clone is left as it is, and the merge unit works from origin's copy${dirty}`);
      g("update-ref", "-d", at);
    };
    if (!g("fetch", "-q", clone, `+refs/heads/${b}:${at}`)) { fail("they couldn't be fetched"); return; }
    if (onOrigin && isAncestor(at, `origin/${b}`)) { g("update-ref", "-d", at); none(); return; }
    const had = git("rev-parse", "-q", "--verify", `refs/heads/${b}`);
    let merged: boolean;
    if (!had && !onOrigin) merged = g("branch", "-q", b, at);
    else {
      merged = this.startBranch(b) && g("merge", "-q", "--no-edit", "-m", `Merge lane ${n}'s ${b}, left unpushed in its clone`, at);
      if (!merged) g("merge", "--abort");
      this.toMain();
      if (!merged) { if (had) g("branch", "-q", "-f", b, had); else g("branch", "-q", "-D", b); }
    }
    if (!merged) { fail("they clash with origin's copy"); return; }
    g("update-ref", "-d", at);
    const pushed = g("push", "-q", "origin", `${b}:refs/heads/${b}`);
    log(`git: merged lane ${n}'s ${b} (${short}, left unpushed in ${clone}) into this clone's${pushed ? ", and pushed it" : "; couldn't push it yet"}`);
    event(dirty ? "gone-lane-left" : "gone-lane-merged", `${b} in lane ${n}'s clone (${clone}) had commits origin's lacked, up to ${short}: merged into ${HOST} lane ${LANE}'s copy${pushed ? " and pushed" : ""}, which the merge unit works${dirty}`);
  }

  // Push a unit's branch for whoever takes the unit next, unless origin has a copy this one
  // doesn't contain (someone carried on elsewhere): never clobber that.
  pushBranch(u: string, b: string): boolean {
    const { log, event, HOST, LANE } = this.c;
    // Already there: nothing to push or settle again (a leftover branch is looked at every look),
    // but for a finished unit not yet marked pushed (origin's copy is the finished one: another
    // lane here may land it).
    if ((git("rev-parse", "-q", "--verify", `refs/remotes/origin/${b}`) ?? "") === (git("rev-parse", "-q", "--verify", b) ?? "")) {
      const r = unitRecord(`${this.c.TDIR}/groups/${u.split("/")[0]}.json`, u);
      if (r?.branch === b && !r.pushed && ["done", "review"].includes(r.state ?? "")) this.c.tr(["settle", u, "--pushed"], LOOP);
      return true;
    }
    if (isRef(`refs/remotes/origin/${b}`) && !isAncestor(`origin/${b}`, b)) {
      // Only behind: origin has all of it. Caught up if the unit is still this lane's, else
      // dropped here (another lane carried it on); nothing is lost either way.
      if (isAncestor(b, `origin/${b}`)) {
        const here = git("rev-parse", "--abbrev-ref", "HEAD") === b;
        if (this.mine(u)) { if (here) g("merge", "-q", "--ff-only", `origin/${b}`); else g("branch", "-q", "-f", b, `origin/${b}`); }
        else if (!here) { g("branch", "-q", "-D", b); log(`git: ${b} was carried on elsewhere; this clone's copy, all on origin, is dropped`); }
        return true;
      }
      log(`git: origin's ${b} has work this clone's doesn't; leaving it`);
      event("stuck-branch", `${b} on ${HOST} lane ${LANE} and on origin have both moved; nothing was overwritten`);
      return false;
    }
    if (g("push", "-q", "-f", "origin", `${b}:refs/heads/${b}`)) {
      this.c.tr(["settle", u, "--pushed"], LOOP);
      log(`git: ${b} pushed, for whoever takes it next`);
      return true;
    }
    log(`git: couldn't push ${b}; it stays in this lane's clone and is pushed at the next look`);
    return false;
  }

  // Is u still this lane's: its record's last claim was made by this loop, here?
  mine(u: string): boolean {
    const r = unitRecord(`${this.c.TDIR}/groups/${u.split("/")[0]}.json`, u);
    return r?.host === this.c.HOST && r?.pid === process.pid;
  }
  // The landing claim on a finished branch (the tracker's): true if it's this lane's to land now.
  claimLanding(b: string): boolean {
    const r = this.c.tr(["landing", "claim", b], LOOP);
    if (r.code !== 0) this.c.log(`git: not landing ${b}: ${r.out.trim() || "the tracker couldn't say whose landing it is"}`);
    return r.code === 0;
  }

  // Commit whatever the session left (never tracker/: the tracker lives on main). Never fails
  // the loop (a failure is logged).
  commitLeft(msg: string) {
    const { log } = this.c;
    const il = git("rev-parse", "--git-path", "index.lock") ?? ".git/index.lock";
    // The session is over, so an index.lock over a minute old is one it left when it was killed.
    try { if (Date.now() - fs.statSync(il).mtimeMs > 60_000) { fs.rmSync(il, { force: true }); log("git: removed the index.lock a killed session left"); } } catch {}
    g("merge", "--abort");
    if (!raw("status", "--porcelain", "--", ".", ":!tracker").trim()) return;
    if (!g("add", "-A", "--", ".", ":!tracker")) { log("git: couldn't stage what the session left"); return; }
    // Never the lane's links to the checkout's work/ and .env (lane.sh excludes them too).
    for (const x of ["work", ".env"]) { try { if (fs.lstatSync(x).isSymbolicLink()) g("reset", "-q", "--", x); } catch {} }
    if (spawnSync("git", ["diff", "--cached", "--quiet"], { stdio: "ignore" }).status !== 0 && !g("commit", "-q", "--no-verify", "-m", msg)) log("git: couldn't commit what the session left");
  }

  // Right after a session that didn't finish its unit, before its claim is settled: the branch
  // goes up first, so a lane that takes the unit the moment the claim ends (pause asap, say)
  // carries on from it instead of starting fresh from main beside it.
  presave(u: string, b: string, t: string) {
    if (["merging", "done", "review", "unknown"].includes(this.state(u))) return;
    this.commitLeft(`${t}: work in progress`);
    if (this.aheadOfMain(b) > 0) this.pushBranch(u, b);
  }

  // An unfinished unit: its work goes to its branch on origin, for whoever claims it next.
  saveBranch(u: string, b: string, t: string, why: string) {
    this.commitLeft(`${t}: work in progress (${why})`);
    if (this.aheadOfMain(b) > 0) this.pushBranch(u, b);
    else if (!isRef(`refs/remotes/origin/${b}`)) { g("checkout", "-q", "-f", this.c.MAIN); g("branch", "-q", "-D", b); }
    this.toMain();
  }

  // A finished branch that's on main: delete it here and on origin, and tell the tracker.
  async landed(b: string, t: string) {
    const { log, event } = this.c;
    g("branch", "-q", "-D", b);
    // origin's copy goes only if main has all of it (someone may have carried on since).
    if (isRef(`refs/remotes/origin/${b}`)) {
      g("fetch", "-q", "origin", b);
      if (isAncestor(`origin/${b}`, this.om)) g("push", "-q", "origin", "--delete", b);
      else {
        log(`git: origin's ${b} has commits main doesn't; left there`);
        event("stuck-branch", `${t} is merged, but origin's ${b} has commits that aren't on main (someone carried on); it was left there`);
      }
    }
    const wait = Number(process.env.FACTORY_RETRY_WAIT || 3);
    for (let k = 1; k <= 5; k++) {
      if (this.ok(["merged", "--branch", b], LOOP)) return;
      await pause(k * wait, this.c);
    }
    log(`tracker: couldn't record ${b} as merged`);
    event("stuck-merging", `${t} is on main but the tracker still says merging: \`just tracker merged --branch ${b}\``);
  }

  // The groups other units on this machine have outputs in work/ for that aren't on main yet
  // (lanes here share it): `just check` skips them.
  busyNow(except: string) { this.busy = this.out(["busy", "--except", except]); }
  busyWhy() { return this.busy ? `, while units of ${this.busy} have outputs in work/ that aren't on main yet` : ""; }

  // Merge a finished unit's branch into main and push. 0 = landed; 1 = it needs a merge unit
  // (why says why); 2 = origin unreachable, or its review was stopped (the branch waits here); 3 =
  // main itself fails the check (the branch waits for a fix, and the lane stops taking units; busy
  // set: perhaps for another unit's outputs in work/, so it's checked again when none is busy, or
  // at the next start); 4 = its review asks for fixes (findings says which); 5 = the project's check
  // before landing failed (why has its last line).
  async land(b: string, t: string): Promise<0 | 1 | 2 | 3 | 4 | 5> {
    const { log, event, MAIN, HOST, LANE, TDIR } = this.c;
    this.why = ""; this.findings = ""; this.unreviewed = "";
    if (!g("checkout", "-q", b)) { this.why = `couldn't check out ${b}`; return 1; }
    this.commitLeft(`${t}: what the session left uncommitted`);
    if (!g("fetch", "-q", "origin", MAIN)) return 2;
    const u = b.replace(/^unit\//, "");
    // A unit that committed nothing (its work is all in work/) has nothing to merge: its branch is
    // already on main. It lands as it is, with no \`just check\`, so a broken main doesn't hold it up;
    // the check before landing still looks at what it left in work/.
    if (isAncestor("HEAD", this.om)) {
      g("checkout", "-q", "-f", "-B", MAIN, this.om);
      const lc = await this.landCheck(u, t);
      if (lc !== 0) { g("checkout", "-q", "-f", b); return lc; }
      await this.landed(b, t); log(`git: ${b} had nothing to merge; it's on main`);
      await this.c.affected();
      return 0;
    }
    // This branch already failed on this main, and main failed alone: neither has changed, so
    // don't check again. A branch that changes (one that fixes main, say) is checked as usual.
    // The key is the branch's own change (its diff from main, outside tracker/), which merging
    // main in doesn't alter, plus main's code. And whether any group was busy: main may fail for
    // another unit's outputs in work/ (a check that doesn't skip FACTORY_BUSY_GROUPS), so once
    // none is, it's checked again.
    this.busyNow(u);
    let mc = this.mainCode();
    let key = `${this.ownChange()} ${mc} ${this.busy ? "busy" : ""}`;
    if (mc && (read("runs/.main-broken") ?? "").split("\n").includes(key)) {
      this.why = `main itself fails \`just check\`${this.busyWhy()} (runs/main-check.log)`; return 3;
    }
    // The tracker lives on main: tracker/ edits on a branch are dropped, never merged.
    const base = git("merge-base", this.om, "HEAD") ?? "";
    if (git("diff", "--name-only", base, "HEAD", "--", "tracker")) {
      if (g("checkout", "--no-overlay", base, "--", "tracker")) g("commit", "-q", "--no-verify", "-m", `${t}: drop its tracker/ edits (the tracker writes to main itself)`);
      log(`git: ${b} changed tracker/; those edits were dropped`);
      event("tracker-edits", `${t} changed tracker/ on its branch; the edits were dropped (the tracker writes to main itself)`);
    }
    // The loop's scripts come from the wfactory skill: a session's edits to them are
    // dropped too, unless the unit is tagged `factory`. A copy that drifts misses the skill's
    // fixes, and a session that breaks the loop stops every lane. The edits stay in the
    // branch's history, for the skill.
    const own = ["factory/tracker", "factory/skill", "factory/deploy", "factory/*.sh", "factory/prompt.md", "factory/oversee.md", "factory/factory.just"];
    const changed = (git("diff", "--no-renames", "--name-only", base, "HEAD", "--", ...own) ?? "").split("\n").filter(Boolean);
    if (changed.length > 0 && !tagged(`${TDIR}/groups/${u.split("/")[0]}.json`, u, "factory")) {
      const was = git("rev-parse", "--short", "HEAD") ?? "";
      for (const f of changed) {
        if (spawnSync("git", ["cat-file", "-e", `${base}:${f}`], { stdio: "ignore" }).status === 0) g("checkout", base, "--", f);
        else g("rm", "-q", "--", f);
      }
      g("commit", "-q", "--no-verify", "-m", `${t}: drop its edits to the loop's scripts (they come from the wfactory skill; \`git diff ${base.slice(0, 9)} ${was} -- factory/\` has them)`);
      log(`git: ${b} changed the loop's scripts; those edits were dropped`);
      event("factory-edits", `${t} changed the loop's scripts on its branch; the edits were dropped, and \`git diff ${base.slice(0, 9)} ${was} -- factory/\` has them, for the wfactory skill`);
    }
    // Checked once per main code: every tracker write moves main too, and a recheck for each
    // one would keep a slow check from ever landing.
    let checked = "", reviewed = false, landChecked = false;
    for (let n = 1; n <= 6; n++) {
      if (!isAncestor(this.om, "HEAD")) {
        if (!g("merge", "-q", "--no-edit", "-m", `Merge main into ${b}`, this.om)) {
          const files = raw("diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean).slice(0, 8).join(" ");
          g("merge", "--abort");
          this.why = `merging main conflicts in ${files || "some files"}`; return 1;
        }
        if (checked !== this.mainCode()) checked = "";
      }
      // main only gets what passes the oracle: checked here whatever the session did.
      if (!checked) {
        this.busyNow(u);
        if (!(await this.c.check("runs/land-check.log", this.busy))) {
          this.why = `\`just check\` fails on the branch with main merged in (${lastLine("runs/land-check.log")})`;
          // If main fails alone, the branch isn't to blame: no merge unit, wait for main to be fixed.
          // -f: a check that rewrote tracked files would otherwise keep us on the branch's tree.
          g("checkout", "-q", "-f", "--detach", this.om);
          if (!(await this.c.check("runs/main-check.log", this.busy))) {
            g("checkout", "-q", "-f", b); mc = this.mainCode(); key = `${this.ownChange()} ${mc} ${this.busy ? "busy" : ""}`;
            if (mc) {
              const keep = (read("runs/.main-broken") ?? "").split("\n").filter((l) => l.endsWith(` ${mc} `) || l.endsWith(` ${mc} busy`));
              try { fs.writeFileSync("runs/.main-broken.new", [...keep, key].map((l) => l + "\n").join("")); } catch {}
            }
            try { fs.renameSync("runs/.main-broken.new", "runs/.main-broken"); } catch {}
            this.why = `main itself fails \`just check\`${this.busyWhy()} (${lastLine("runs/main-check.log")})`; return 3;
          }
          g("checkout", "-q", "-f", b); return 1;
        }
        checked = this.mainCode() || "1";
      }
      // The project's check before landing, once, on the merged tree: cheaper than the review, so
      // a unit that left work/ ahead of git spends none.
      if (!landChecked) {
        landChecked = true;
        const lc = await this.landCheck(u, t);
        if (lc !== 0) { g("checkout", "-q", "-f", b); return lc; }
      }
      // Reviewed once it passes the check, so a red main or a failing branch spends no review,
      // and once only: main moving under it doesn't change the branch's own change.
      if (!reviewed) {
        reviewed = true;
        const v = await this.review(u, t);
        if (v === 4) return 4;
        if (v === 2) { g("checkout", "-q", "-f", b); return 2; }
      }
      if (fs.existsSync("memory/MEMORY.md") && !this.ok(["memory", "--check"])) {
        if (this.ok(["memory"]) && g("add", "memory/MEMORY.md")) g("commit", "-q", "--no-verify", "-m", "memory: rebuild the index");
      }
      g("checkout", "-q", "-f", "-B", MAIN, this.om);
      if (!g("merge", "-q", "--no-ff", "--no-edit", "-m", `${t}: merged from ${HOST} lane ${LANE}`, b)) { g("checkout", "-q", "-f", b); this.why = "merging into main failed"; return 1; }
      if (g("push", "-q", "origin", MAIN)) {
        for (const f of ["runs/.main-broken", "runs/.main-broken-told", `runs/.merge-tries-merge_${this.mergeSlug(u)}`]) fs.rmSync(f, { force: true });
        this.red = "";
        if (this.unreviewed) {
          event("review-skipped", `${t} landed without the loop's review: ${this.unreviewed}`);
          this.c.tr(["note", u, `Landed without the loop's review: ${this.unreviewed}`], LOOP);
        }
        await this.landed(b, t);
        log(`git: ${b} merged into main`);
        await this.c.affected();
        return 0;
      }
      // Someone pushed first: merge their main into the branch and try again.
      g("checkout", "-q", "-f", "-B", MAIN, this.om); g("checkout", "-q", "-f", b);
      if (!g("fetch", "-q", "origin", MAIN)) return 2;
    }
    this.why = "origin refused the push six times"; return 2;
  }

  // The project's checks before a unit lands (tracker/project.json ci.land, \`tracker ci-land --help\`):
  // its group's, then each other group's whose data it wrote here (#149), in order, on the tree as
  // it would land, in this lane's clone and on this machine (its copy in work/ is here): 0 = land
  // it, 5 = don't (the first that fails stops it; why has the output's last line), 2 = not yet (why
  // says why: it's tried again at the next look, and the unit isn't sent back). None for a group
  // without CI, or whose CI stands failed or has its ci-fix open, nor one other work here has at
  // work (the tracker says; the log line names them). One past its time limit counts as passed,
  // and the overseer hears. Not yet: the tracker couldn't say what to run (as when it can't say a
  // unit's state, the branch is kept for the next look), or a check exited 79, couldn't check
  // (a crash, something it needs missing), which isn't the unit's fault; the overseer hears once,
  // then every two hours while it holds landings, until a check runs again, since every landing
  // waits on it.
  async landCheck(u: string, t: string): Promise<0 | 2 | 5> {
    const { log, event } = this.c;
    const r = this.c.tr(["ci-land", u, "--json"]);
    type Check = { group?: string; title?: string; cmd?: string; timeout?: number; own?: boolean };
    let j: { why?: string; since?: string; checks?: Check[]; skipped?: { group?: string; why?: string }[] } = {};
    let parsed = true;
    try { j = JSON.parse(r.out); } catch { parsed = false; }
    if (r.code !== 0 || !parsed) {
      this.why = `the tracker couldn't say what check to run before it lands (${(r.out + r.err).trim().split("\n").pop() || `exit ${r.code}`})`;
      log(`land check: ${this.why}; ${t} waits for the next look`);
      return 2;
    }
    const checks = (j.checks ?? []).filter((c) => c.cmd), skips = (j.skipped ?? []).map((x) => x.why).filter(Boolean).join("; ");
    if (!checks.length) {
      const why = j.why ?? skips;
      if (why && !why.startsWith("no ci.land")) log(`land check: none for ${t}: ${why}`);
      return 0;
    }
    if (skips) log(`land check: ${t}: not checked: ${skips}`);
    const logf = "runs/land-ci.log", told = "runs/.land-unrun-told";
    for (const c of checks) {
      const cmd = c.cmd!, min = Number(c.timeout) || 15;
      // (Whose check, when it isn't the unit's own group's.)
      const whose = c.own === false ? `${c.title || c.group}'s check: ` : "";
      log(`land check: ${cmd}`);
      const rc = await this.c.landCheck(cmd, min, logf, { FACTORY_UNIT: u, FACTORY_UNIT_SINCE: j.since ?? "" });
      const last = lastLine(logf, 240);
      if (rc === 0) continue;
      if (rc === 124) {
        log(`land check: ${t}: ${whose}out of time after ${min} min; it counts as passed, and night CI checks it`);
        event("land-check-timeout", `${t}: the check before landing (${cmd}) ran out of time after ${min} min, so it passed unchecked; the group's CI checks it`);
        continue;
      }
      if (rc === 79) {
        const why = last || "it gave no reason";
        this.why = `its check before landing couldn't check (${whose}exit 79: ${why})`;
        log(`land check: ${t}: ${whose}couldn't check (${why}); it waits for the next look, not sent back`);
        // told once, then again every UNRUN_RETELL_MS while it stays held, saying for how long, so a check that
        // can never run (a deterministic crash) doesn't hold landings silently
        const now = Date.now(), held = unrunHeld(told, now);
        if (held === null || now - held.told >= UNRUN_RETELL_MS) {
          const since = held?.since ?? now;
          const long = now - since >= 60_000 ? `; landings have been held ${duration(now - since)} so far` : "";
          event("land-check-unrun", `${t}: the check before landing (${cmd}) couldn't check (exit 79: ${why}), so it waits and is tried again at every look; every landing ${c.own === false ? `that wrote ${c.title || c.group}'s data` : "in its group"} waits until the check can run${long}`);
          try { fs.writeFileSync(told, JSON.stringify({ since, told: now, why }) + "\n"); } catch {}
        }
        return 2;
      }
      fs.rmSync(told, { force: true });
      this.why = `${whose}${last || `${cmd} failed (exit ${rc})`}`;
      log(`land check: ${t} failed (exit ${rc}): ${this.why}`);
      return 5;
    }
    fs.rmSync(told, { force: true });
    log(`land check: ${t} passed`);
    return 0;
  }

  // A finished branch's review, on the branch with main merged in (land, once its check passed):
  // 0 = land it; 2 = stopped (a pause, the stop time), so it waits; 4 = fixes asked for
  // (this.findings). A branch that changes nothing outside tracker/ has nothing to review. One whose
  // review gave no verdict lands, and the overseer hears why: the check, the hard gate, has passed,
  // and a reviewer that can't run would otherwise hold every branch back. A branch whose own change
  // passed here before (its landing failed after: a conflict, a push refused) isn't reviewed again.
  async review(u: string, t: string): Promise<0 | 2 | 4> {
    const { log } = this.c;
    const base = git("merge-base", this.om, "HEAD") ?? "";
    const diff = base ? raw("diff", base, "HEAD", "--", ".", ":(exclude)tracker") : "";
    if (!diff.trim()) { log(`review: ${t} changes nothing outside tracker/; no review`); return 0; }
    const key = `${u} ${this.ownChange()}`, passed = (read("runs/.review-passed") ?? "").split("\n").filter(Boolean);
    if (passed.includes(key)) { log(`review: ${t} passed before, as it is; not reviewed again`); return 0; }
    const card = this.out(["show", u]);
    const standards = git("show", `${this.om}:CODING_STANDARDS.md`) ?? "";
    // The other groups whose build the branch changes (its own group's is its own work).
    const own = u.split("/")[0];
    const affected = (await this.c.affectedBy(base, "HEAD")).split("\n").filter((l) => l.trim() && l.split("\t")[0].trim() !== own).join("\n");
    const v = await this.c.review({ unit: u, title: t, card, diff, standards, affected });
    if (v.verdict === "pass") {
      log(`review: ${t} passed`);
      try { fs.writeFileSync("runs/.review-passed", [...passed.slice(-49), key].map((l) => l + "\n").join("")); } catch {}
      return 0;
    }
    if (v.verdict === "fix") { this.findings = v.findings; log(`review: ${t} needs fixes before it lands`); return 4; }
    if (v.verdict === "wait") { this.why = v.why; log(`review: ${v.why}; ${t} waits`); return 2; }
    log(`review: none for ${t} (${v.why}); it lands unreviewed`);
    this.unreviewed = v.why;
    return 0;
  }

  // The lane couldn't merge a branch: a unit only this lane takes, before anything else.
  mergeSlug(u: string) { return `${this.c.HOST}-lane${this.c.LANE}-${u.replace(/\//g, "-")}`.toLowerCase().replace(/[^a-z0-9.\n-]/g, "-").slice(0, 60); }
  fileMergeUnit(u: string, b: string, why: string) {
    const { log, event, HOST, LANE, MAIN } = this.c;
    const t = `Merge main on ${HOST} lane ${LANE}`, id = `merge/${this.mergeSlug(u)}`;
    const d = `Branch \`${b}\` holds {unit:${u}}, finished but not on main: ${why}. Merge origin/${MAIN} into that branch, settle the conflicts keeping both sides' intent, run \`just check\`, commit on the branch, then record this unit done. The loop merges the branch into main after you.`;
    this.c.tr(["add-group", "merge", "--title", "Merges the loop couldn't do by itself", "--priority", "1000"]);
    if (!this.out(["state", id])) {
      if (!this.ok(["add-unit", id, "--title", t, "--detail", d, "--branch", b, "--lane", `${HOST}/${LANE}`, "--check", "recorded"])) { log(`tracker: couldn't file the merge unit for ${u}`); return; }
    } else {
      // The third failure is beyond the lanes: stuck, for the overseer, and the lane goes on with other work.
      const tf = `runs/.merge-tries-${id.replace(/\//g, "_")}`;
      const tries = (Number(cat(tf) ?? 0) || 0) + 1;
      fs.writeFileSync(tf, `${tries}\n`);
      if (tries >= 2) {
        this.c.tr(["block", id, "--why", `Merging this branch failed three times: ${why}`]);
        event("stuck-merge", `${t}: merging branch ${b} into main failed three times (${why}); it waits, and the lane goes on with other work`);
        dropMergeUnits((x) => x === id);
        log(`git: ${b} failed to merge three times; ${id} is stuck, for the overseer`);
        return;
      }
      this.c.tr(["edit", id, "--detail", d, "--branch", b]);
      this.c.tr(["reopen", id, "--note", `Merging failed again: ${why}`]);
    }
    addMergeUnit(id);
    log(`git: ${b} couldn't be merged (${why}); filed ${t} (${id}), which this lane takes next`);
  }

  // After a session: land a finished unit, save an unfinished one.
  async finishUnit(u: string, b: string, t: string) {
    const { log, event, HOST, LANE } = this.c;
    let st = this.state(u);
    // In review with no branch on its record: a check given up without a verdict put it back
    // (the reviewer's session ended). Nothing of it is finished here: save, never land.
    if (st === "review" && !this.out(["state", u, "--branch"])) st = "back in review";
    if ((st === "merging" || st === "done" || st === "review") && !this.claimLanding(b)) { this.pushBranch(u, b); this.toMain(); }
    else if (st === "merging" || st === "done" || st === "review") {
      // Pushed first (marked pushed), so if this lane dies landing it, another lane here lands it
      // from origin instead of only this lane's restart (#135). What the session left goes too.
      if (git("rev-parse", "--abbrev-ref", "HEAD") === b) this.commitLeft(`${t}: what the session left uncommitted`);
      this.pushBranch(u, b);
      const rc = await this.land(b, t);
      // This lane's merge is over once its branch lands (the lane works other units while it waits).
      if (rc === 0) this.mergeOver(u, b);
      // A merge unit works the original unit's branch, so the branch names the unit to merge.
      else if (rc === 1) { this.fileMergeUnit(b.replace(/^unit\//, ""), b, this.why); this.saveBranch(u, b, t, "waiting for its merge"); }
      else if (rc === 2) { log(`git: couldn't merge ${b} yet (${this.why}); it waits in this clone and is tried again at the next look`); this.pushBranch(u, b); this.toMain(); }
      else if (rc === 4) {
        // Its review asks for fixes: its branch goes up first, then its unit goes back to ready on it
        // (stuck the second time), so the next claim carries it on.
        this.saveBranch(u, b, t, "its review asks for fixes");
        const r = this.c.tr(["review-fix", b, "--findings", this.findings], LOOP);
        if (r.code !== 0) log(`tracker: couldn't record ${b}'s review (${r.out.trim() || r.err.trim()}); it's reviewed again at the next look`);
        else this.sentBack(u, b, r.out, "the loop's review asked for fixes a second time, so it waits for the overseer (`just show <unit>` has the findings)");
      }
      else if (rc === 5) {
        // Its check before landing failed: as for a review's fixes, its branch goes up and its unit
        // goes back to ready on it with the check's last line (stuck the third time in a row).
        this.saveBranch(u, b, t, "its check before landing failed");
        const r = this.c.tr(["land-fail", b, "--evidence", this.why], LOOP);
        if (r.code !== 0) log(`tracker: couldn't record that ${b}'s check before landing failed (${r.out.trim() || r.err.trim()}); it's tried again at the next look`);
        else this.sentBack(u, b, r.out, "the check before landing failed three times in a row, so it waits for the overseer (`just show <unit>` has the last failure)");
      }
      else {
        log(`git: ${b} waits: ${this.why}`);
        // Main is red: every landing fails until it's fixed, so the lane stops taking units (the
        // overseer stops the rest, fixes main, and starts them again). Busy or not: with two lanes
        // here something nearly always is, and a check that doesn't skip the busy groups is the
        // project's to fix (the event says so).
        this.red = this.why;
        // Once per broken main, not once per branch and look; again if that was while units
        // here were busy (perhaps the cause) and it's still broken once none are.
        let told = cat("runs/.main-broken-told") ?? "";
        const mc = this.mainCode();
        if (told.split(" ")[0] !== mc || (!this.busy && told !== `${mc} `)) {
          told = `${mc} ${this.busy ? "busy" : ""}`;
          const stops = `${HOST} lane ${LANE} stops taking units, its finished branch pushed. Stop the lanes, fix main, and start them again once main passes`;
          if (!this.busy) event("main-broken", `${this.why}; ${stops}`);
          else event("main-broken", `${this.why}. If the check doesn't skip FACTORY_BUSY_GROUPS (docs/factory.md, the oracle), those may be what fails, and main passes on a clean checkout; ${stops}`);
          fs.writeFileSync("runs/.main-broken-told", `${told}\n`);
        }
        this.pushBranch(u, b); this.toMain();
      }
    } else if (st === "unknown") {
      // The tracker couldn't say: keep the branch (pushed), decide at the next look.
      log(`tracker: couldn't read ${u}'s state; ${b} is kept`); this.commitLeft(`${t}: work in progress`); this.pushBranch(u, b); this.toMain();
    } else this.saveBranch(u, b, t, st);
  }

  // The merge of branch b (by merge unit u, or one working b) is over: off this lane's list.
  mergeOver(u: string, b: string) { dropMergeUnits((x) => x === u || unitField(`${this.c.TDIR}/groups/merge.json`, x, "branch") === b); }

  // A finished branch's units went back to ready (review-fix, land-fail; out is what the tracker
  // said): a merge unit's merge is over (the unit whose work it is went back), and a unit made stuck
  // is the overseer's.
  sentBack(u: string, b: string, out: string, stuck: string) {
    const bu = b.replace(/^unit\//, "");
    this.mergeOver(u, b);
    fs.rmSync(`runs/.merge-tries-merge_${this.mergeSlug(bu)}`, { force: true });
    this.c.log(`git: ${b} isn't landed: ${out.trim()}`);
    const bt = unitField(`${this.c.TDIR}/groups/${bu.split("/")[0]}.json`, bu, "title");
    if (/→ stuck/.test(out)) this.c.event("stuck", `${bt ? `${bt} (${bu})` : bu}: ${stuck.replace("<unit>", bu)}`);
  }

  // Is this clone's copy of finished unit u's branch the finished one: this lane finished it, or took
  // its landing over? (A record naming no lane, from before lanes were recorded or a done by hand, is
  // taken as this machine's clone's, as it always was.)
  copyIsMine(u: string) {
    const { TDIR, HOST, LANE } = this.c, r = unitRecord(`${TDIR}/groups/${u.split("/")[0]}.json`, u);
    return r?.landing?.lane ? r.landing.lane === `${HOST}/${LANE}` : r?.host === HOST;
  }
  // Is u done, its work landed on main: the tracker logged it merged since its last claim or
  // reopen? Not one done by hand (or reopened and done again some other way), whose work may be
  // only on its branch.
  landedDone(u: string) {
    if (this.state(u) !== "done") return false;
    const id = `"id":${JSON.stringify(u)}`;
    const mine = (read(`${this.c.TDIR}/log.jsonl`) ?? "").split("\n").filter((l) => l.includes(id)).map((l) => { try { return JSON.parse(l) as { cmd?: string; id?: string }; } catch { return null; } }).filter((x) => x?.id === u);
    const last = mine.findLastIndex((x) => x!.cmd === "claim" || x!.cmd === "reopen");
    return mine.slice(last + 1).some((x) => x!.cmd === "merged");
  }
  // A clone's copy of a branch another lane carried on: dropped, its commit logged (git can bring
  // it back while its objects last).
  dropStale(b: string, why: string) {
    const sha = git("rev-parse", "--short", b) ?? "";
    if (g("branch", "-q", "-D", b)) this.c.log(`git: ${b}'s unit was ${why}; this clone's earlier copy (${sha}), with commits origin's doesn't have, is dropped`);
  }

  // What an earlier iteration or a stopped loop left behind, at the start and at each look. A
  // unit branch checked out with work on it (stop now) is saved. A finished branch that never
  // merged (origin was unreachable, main was red) is landed, but only if the unit's record still
  // names it; one already on main is deleted. Then any other lane's finished branch on origin
  // that lane can't land any more (it's gone): this lane takes its landing and lands it.
  async pending() {
    const { log, TDIR, HOST, LANE } = this.c;
    const cur = git("rev-parse", "--abbrev-ref", "HEAD") ?? "";
    const others = this.out(["landing"]).split("\n").filter(Boolean).map((l) => l.split("\t"));
    if (!others.length && !git("for-each-ref", "--format=x", "refs/heads/unit/") && !cur.startsWith("unit/")) return;
    g("fetch", "-q", "--prune", "origin");
    // Not a copy that isn't this clone's to push: its unit done, landed from elsewhere (an earlier
    // copy: dropped), or finished and its landing another lane's (left to the rule below, so a lane
    // that died landing it never pushes over the copy that lane is landing; what was left is
    // committed here first). A branch one of this lane's merge units works is this lane's to save.
    const merging = new Set(mergeUnits().map((mu) => unitField(`${TDIR}/groups/merge.json`, mu, "branch")).filter(Boolean));
    if (cur.startsWith("unit/") && this.landedDone(cur.slice(5))) { g("checkout", "-q", "-f", this.c.MAIN); this.dropStale(cur, "done elsewhere"); }
    else if (cur.startsWith("unit/") && !merging.has(cur) && this.state(cur.slice(5)) === "merging" && !this.copyIsMine(cur.slice(5))) {
      this.commitLeft(`${cur.slice(5)}: work in progress (the loop stopped)`); g("checkout", "-q", "-f", this.c.MAIN);
    }
    else if (cur.startsWith("unit/")) this.saveBranch(cur.slice(5), cur, cur.slice(5), "the loop stopped");
    // A branch one of this lane's merge units is settling waits for that unit.
    // (Once the merge unit is recorded finished, its branch waiting to merge, it lands as any other.)
    const mbs = new Set(mergeUnits().filter((mu) => this.state(mu) !== "merging").map((mu) => unitField(`${TDIR}/groups/merge.json`, mu, "branch")).filter(Boolean));
    for (const b of (git("for-each-ref", "--format=%(refname:short)", "refs/heads/unit/") ?? "").split("\n").filter(Boolean)) {
      const u = b.slice(5), st = this.state(u);
      // Already on main (a unit that committed nothing, say): the tracker hears it landed, if it's waiting for that.
      if (isAncestor(b, this.om)) {
        // Through land() all the same, so its check before landing runs (one that couldn't run, or
        // whose tracker couldn't say, left it waiting here).
        if (st === "merging" && this.out(["state", u, "--branch"]) === b) { log(`git: ${b}, left from before, is on main; landing it`); await this.finishUnit(u, b, u); }
        else g("branch", "-q", "-D", b);
        continue;
      }
      if (mbs.has(b)) continue;
      // Its merge unit (open, or stuck for the overseer) settles it, not another try every look.
      const ms = this.c.tr(["state", `merge/${this.mergeSlug(u)}`]);
      if (!(ms.code !== 0 || ["done", "dropped", "merging"].includes(ms.out.trim()))) continue;
      if (st === "merging" && this.out(["state", u, "--branch"]) === b) {
        // This clone's copy is the finished one only if this lane finished it (or took its landing
        // over). Else it's an earlier attempt's: origin's copy, once pushed, is landed below, and
        // this one goes if origin has all of it. (A record naming no lane, from before lanes were
        // recorded or a done by hand, is taken as this clone's, as it always was.)
        const r = unitRecord(`${TDIR}/groups/${u.split("/")[0]}.json`, u);
        if (!this.copyIsMine(u)) {
          // Gone if origin has all of it; and if it has commits origin doesn't (an earlier attempt's,
          // never pushed), once origin has the finished copy (pushed after it was finished): kept,
          // it would keep this lane from landing that copy (#135). Its commit is in the log.
          if (isRef(`refs/remotes/origin/${b}`) && isAncestor(b, `origin/${b}`)) g("branch", "-q", "-D", b);
          // (Gone: origin's copy lands below with the other lanes' finished branches, once it's
          // this lane's to land.)
          else if (isRef(`refs/remotes/origin/${b}`) && r?.pushed) this.dropStale(b, "finished elsewhere");
          continue;
        }
        if (this.claimLanding(b)) { log(`git: landing ${b}, left from before`); await this.finishUnit(u, b, u); }
      }
      // Done (landed, from elsewhere): this clone's copy is an earlier one, superseded, never to be
      // pushed as an orphan branch (#135).
      else if (st === "done" && this.landedDone(u)) this.dropStale(b, "done elsewhere");
      else if (st !== "unknown" && this.aheadOfMain(b) > 0) this.pushBranch(u, b);
    }
    // Finished branches on origin that this clone doesn't have, whose lane is gone. (The tracker's
    // list is as it was before this lane's own landed: one landed since isn't merging any more.)
    // Not while main is red here: this lane stops, and those wait for main to be fixed too.
    for (const [b, u, t] of this.red ? [] : others) {
      if (isRef(`refs/heads/${b}`) || !isRef(`refs/remotes/origin/${b}`) || this.state(u) !== "merging" || !this.claimLanding(b)) continue;
      if (!g("branch", "-q", b, `origin/${b}`)) continue;
      log(`git: landing ${b}, finished elsewhere`);
      await this.finishUnit(u, b, `${t} (${u})`);
    }
    this.toMain();
  }
}

// A wait the loop's signal handling can cut short (it never returns, then).
async function pause(s: number, c: LaneCtx) { if (s > 0) await sleep(s * 1000); await c.halt(); }
// The last line of a check's log, cut to 80 characters (or n), for a reason.
const lastLine = (f: string, n = 80) => ((read(f) ?? "").replace(/\n+$/, "").split("\n").pop() ?? "").trim().slice(0, n);

// A unit's field in a group's file, "" if there's none.
export function unitField(file: string, id: string, k: string): string {
  try {
    const u = (JSON.parse(fs.readFileSync(file, "utf8")).units ?? []).find((x: { id?: string }) => x.id === id);
    const v = u?.[k];
    return v === undefined || v === null ? "" : String(v);
  } catch { return ""; }
}
// A unit's record in a group's file, null if there's none.
function unitRecord(file: string, id: string): { host?: string; pid?: number; branch?: string; pushed?: boolean; state?: string; landing?: { lane?: string } } | null {
  try { return (JSON.parse(fs.readFileSync(file, "utf8")).units ?? []).find((x: { id?: string }) => x.id === id)?.record ?? null; } catch { return null; }
}
function tagged(file: string, id: string, tag: string): boolean {
  try {
    const u = (JSON.parse(fs.readFileSync(file, "utf8")).units ?? []).find((x: { id?: string }) => x.id === id);
    return Array.isArray(u?.tags) && u.tags.includes(tag);
  } catch { return false; }
}
