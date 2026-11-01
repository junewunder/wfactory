// factory-diff.sh and to-stubs.sh: whether a factory runs the deployed skill through the current
// stubs, and switching one that still carries copies of the loop's scripts over to them.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { pwd } from "./sys.ts";
import { platform } from "./os.ts";

export const DIFF_HELP = `factory-diff.sh — whether a factory runs the deployed skill through the
current stubs, or still carries copies of the loop's scripts. Read-only: it
changes nothing, here or there.

The loop's code lives in the skill (runtime/, tracker/) and each machine
runs a deployed copy (scripts/deploy.sh). A factory's factory/ holds only
stubs (template/factory/: factory/skill, the .sh stubs, factory/tracker,
factory.just, prompt.md, oversee.md), which rarely change. For each: same,
differs (with the factory's last commit to it) or missing. A factory from
before the stubs carries copies: scripts/to-stubs.sh converts it, once. Then
the project's own files (kept by any copy), whether it has a tracker
(tracker/), whether it has an origin, and whether its lanes
are running (never copy over a running loop).

Usage:
  scripts/factory-diff.sh <factory repo>              the summary
  scripts/factory-diff.sh <factory repo> --diff <f>   the diff for one file (e.g. loop.sh)`;

export const STUBS_HELP = `to-stubs.sh — switch a factory from carrying copies of the loop's scripts to
the stubs that run the deployed skill (factory/skill). Done once per factory;
after it, nothing is ever copied into it again.

Writes every file in the skill's template/factory/ over the factory's
factory/ (the stubs, factory/skill, factory/deploy), and removes copies of
skill files the stubs replace (factory/session.sh). The project's own files
in factory/ (prompt.local.md, oversee.local.md, tidy, lane-setup,
pre-session, auto-mode.json, …) aren't touched (the template's auto-mode.json
is copied only where there's none). Adds /.tracker/ to .gitignore if
missing. Stages the changes; never commits.

Refuses while a loop runs there or factory/ has uncommitted changes. A copy
with edits of its own (one that matches no version of the template) is
named first: compare it with \`scripts/factory-diff.sh <repo> --diff <file>\`
before converting, or its edits are lost.

Usage: scripts/to-stubs.sh <factory repo> [--force]   (--force: convert despite own edits)`;

const SKILL = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const T = path.join(SKILL, "template", "factory");
// The project's own files in factory/, which no stub replaces.
const OWN = ["prompt.local.md", "oversee.local.md", "tidy", "lane-setup", "pre-session", "auto-mode.json"];
const exists = (f: string) => fs.existsSync(f);
const isFile = (f: string) => { try { return fs.statSync(f).isFile(); } catch { return false; } };
const ls = (d: string) => { try { return fs.readdirSync(d).sort(); } catch { return []; } };
// A command's output without its trailing newline; null if it failed.
function cmd(argv: string[], cwd?: string): string | null {
  const r = spawnSync(argv[0], argv.slice(1), { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 << 20 });
  return r.status === 0 ? r.stdout.replace(/\n+$/, "") : null;
}
const git = (repo: string, ...a: string[]) => cmd(["git", "-C", repo, ...a]);

// The factory's folder, as the shell's `cd <dir> && pwd` names it; null (said why) if it has
// no factory/.
function factoryRoot(dir: string, script: string): string | null {
  const r = path.resolve(pwd(), dir);
  if (!fs.existsSync(r)) { console.error(`${script}: cd: ${dir}: No such file or directory`); return null; }
  if (!fs.existsSync(path.join(r, "factory"))) { console.error(`${script}: ${r} has no factory/ folder`); return null; }
  return r;
}

// The loops running in the factory, or in a lane's clone beside it, by their working folder:
// `just loop` and the lanes' services both start one through factory/loop.sh (a TypeScript loop
// keeps that in its process title).
export function runningIn(r: string): string[] {
  const run = new Set<string>();
  const re = new RegExp(`^${r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(-lane[0-9]+)?$`);
  for (const pid of platform.processesMatching("(factory|runtime)/loop\\.sh")) {
    const cwd = platform.processFolder(pid);
    if (cwd !== null && re.test(cwd)) run.add(path.basename(cwd));
  }
  return [...run].sort();
}

// How many lines of `diff a b` are changes.
function changed(a: string, b: string) {
  const r = spawnSync("diff", [a, b], { encoding: "utf8", maxBuffer: 64 << 20 });
  return (r.stdout ?? "").split("\n").filter((l) => /^[<>]/.test(l)).length;
}

export function factoryDiffCli(args: string[]): number {
  if (!args.length || args[0] === "-h" || args[0] === "--help") { console.log(DIFF_HELP); return 0; }
  const r = factoryRoot(args[0], "factory-diff");
  if (!r) return 2;
  const [, flag, f] = args;
  if (flag === "--diff") {
    if (!f) { console.error("factory-diff: which file? e.g. loop.sh"); return 2; }
    spawnSync("diff", ["-u", "--label", `${r}/factory/${f}`, "--label", `skill: template/factory/${f}`, `${r}/factory/${f}`, `${T}/${f}`], { stdio: "inherit" });
    return 0;
  }
  console.log(factoryDiff(r).join("\n"));
  return 0;
}

// factory-diff's summary of a factory, as lines.
export function factoryDiff(r: string): string[] {
  const say: string[] = [`== ${r}`];
  const same: string[] = [], differs: string[] = [], missing: string[] = [];
  for (const f of ls(T)) {
    if (f === "auto-mode.json") continue;   // the project's own once there (below)
    const p = path.join(r, "factory", f);
    if (!exists(p)) missing.push(f);
    else if (spawnSync("cmp", ["-s", path.join(T, f), p]).status === 0) same.push(f);
    else differs.push(f);
  }
  if (!exists(path.join(r, "factory", "skill"))) say.push(`factory/ carries copies of the loop's scripts, from before the stubs: convert it once with scripts/to-stubs.sh ${r}`);
  else say.push(`the stubs: ${same.length} same, ${differs.length} differ, ${missing.length} missing`);
  for (const f of differs) {
    const n = changed(path.join(r, "factory", f), path.join(T, f));
    const last = (git(r, "log", "-1", "--format=%cs %s", "--", `factory/${f}`) ?? "").slice(0, 70);
    say.push(`  differs  ${f.padEnd(14)} ${String(n).padStart(4)} lines   last commit there: ${last || "(uncommitted)"}`);
  }
  for (const f of missing) say.push(`  missing  ${f}`);

  const own = OWN.filter((f) => exists(path.join(r, "factory", f)));
  say.push(`the project's own (kept): ${own.join(" ") || "none"}`);
  const extra = ls(path.join(r, "factory")).filter((f) => !f.startsWith(".") && !exists(path.join(T, f)) && !own.includes(f));
  if (extra.length) say.push(`other files in factory/ (not stubs): ${extra.join(" ")}`);
  say.push(`deployed on this machine: ${cmd([path.join(SKILL, "scripts", "deploy.sh"), "--status"]) ?? ""}`);

  say.push(isFile(path.join(r, "tracker", "project.json")) ? "tracker: tracker/" : "tracker: none found");
  const o = git(r, "remote", "get-url", "origin");
  say.push(o ? `origin: ${o}` : "origin: none (the state is tracker/ in the checkout; no branches)");
  const dirty = (git(r, "status", "--porcelain", "--", "factory", "justfile") ?? "").split("\n").filter(Boolean).length;
  if (dirty) say.push(`uncommitted changes in factory/ or the justfile: ${dirty}`);
  say.push(`running here: ${runningIn(r).join(" ") || "nothing"}`);
  return say;
}

export function toStubsCli(args: string[]): number {
  if (!args.length || args[0] === "-h" || args[0] === "--help") { console.log(STUBS_HELP); return 0; }
  const r = factoryRoot(args[0], "to-stubs");
  if (!r) return 2;
  const force = args[1] === "--force";
  if (git(r, "status", "--porcelain", "--", "factory") !== "") { console.error(`to-stubs: factory/ in ${r} has uncommitted changes; commit them first`); return 2; }
  if (runningIn(r).length) { console.error(`to-stubs: a loop is running in ${r} (or a lane beside it); stop it first`); return 2; }
  // …and on every machine in its machines file (its own fleet.sh, copy or stub, can ask them).
  const fleet = path.join(r, "factory", "fleet.sh");
  let fx = false;
  try { fx = (fs.statSync(fleet).mode & 0o111) !== 0; } catch {}
  if (fx && !force) {
    const b = spawnSync("factory/fleet.sh", ["beat"], { cwd: r, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const beat = ((b.stdout ?? "") + (b.stderr ?? "")).replace(/\n+$/, "");
    if (!beat.includes(" 0 busy, 0 waiting") || beat.includes("unreachable")) {
      console.error(`to-stubs: lanes may be running on another machine (${beat}); stop them first, or --force if a machine is just switched off`);
      return 2;
    }
  }

  // Copies with edits of their own: a file that matches no committed version of the skill's copy.
  const own: string[] = [];
  for (const n of ls(path.join(r, "factory"))) {
    if (!isFile(path.join(SKILL, "runtime", n)) && n !== "tracker") continue;
    const h = cmd(["git", "hash-object", path.join(r, "factory", n)]);
    // Not a file git can hash (a folder, from some older layout): nothing to compare, so stop.
    if (h === null) { console.error(`to-stubs: can't compare ${r}/factory/${n} with the skill's (git hash-object failed); move it aside first`); return 2; }
    const commits = (git(SKILL, "log", "--all", "--format=%H", "--", `template/factory/${n}`, `runtime/${n}`) ?? "").split("\n").filter(Boolean);
    const match = commits.some((c) => [`template/factory/${n}`, `runtime/${n}`].some((p) => git(SKILL, "rev-parse", "-q", "--verify", `${c}:./${p}`) === h));
    if (!match) own.push(n);
  }
  if (own.length && !force) {
    console.error(`to-stubs: these copies in ${r}/factory have edits of their own (they match no version of the skill's): ${own.join(" ")}`);
    console.error(`Compare each (scripts/factory-diff.sh ${r} --diff <file>), move what's worth keeping into the skill, then run again with --force.`);
    return 1;
  }

  // auto-mode.json is the project's own once it's there: the template's is only a start.
  for (const n of ls(T)) {
    const to = path.join(r, "factory", n);
    if (n === "auto-mode.json" && exists(to)) continue;
    fs.copyFileSync(path.join(T, n), to);
    const st = fs.statSync(path.join(T, n));
    fs.chmodSync(to, st.mode & 0o7777);
    fs.utimesSync(to, st.atime, st.mtime);
  }
  for (const n of ["session.sh"]) if (exists(path.join(r, "factory", n))) spawnSync("git", ["-C", r, "rm", "-q", "--", `factory/${n}`], { stdio: "inherit" });
  const gi = path.join(r, ".gitignore");
  let lines: string[] = [];
  try { lines = fs.readFileSync(gi, "utf8").split("\n"); } catch {}
  if (!lines.includes("/.tracker/")) fs.appendFileSync(gi, "/.tracker/\n");
  if (spawnSync("git", ["-C", r, "add", "--", "factory", ".gitignore"], { stdio: "inherit" }).status !== 0) {
    console.error(`to-stubs: the stubs are in ${r}/factory, but git couldn't stage them`);
    return 1;
  }
  console.log(`${r}: factory/ now holds stubs that run the deployed skill (staged; commit it).`);
  console.log("Run `factory/tracker status` there once, so `just` finds the skill's recipes.");
  return 0;
}
