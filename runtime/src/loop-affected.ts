// The ci.affected hook (tracker/project.json ci.affected, `tracker ci-affected --help`): work landing
// outside a group can change what its build makes (shared code, a tool), so whenever main's code has
// moved past the last commit the hook covered, the loop runs it over that range and touches the
// groups it names (their CI goes stale, as for a unit of their own finishing). It runs after a lane
// lands a unit (landing.ts) and before a lane picks work (loop-claim.ts), so merges made outside the
// lanes (the owner's) are seen too. One lane at a time on a machine, by a lock in the lock folder;
// two machines running it over the same range only touch a group twice. A run that fails or times
// out records nothing, and is tried again next time; the overseer hears once until one passes.
import fs from "node:fs";
import path from "node:path";
import { git } from "./landing.ts";
import { tryLock, unlock } from "./sys.ts";
import type { TrOut } from "./tr.ts";

export interface AffectedCtx {
  ref: string;           // main as this clone has it (origin/<main>, fetched; or <main> with no origin)
  locks?: string;        // the machine's lock folder (FACTORY_LOCKS), if there is one
  tr(args: string[], add?: Record<string, string>): TrOut;
  log(s: string): void;
  event(kind: string, msg: string): void;
  // The hook's command (bash -c) under a time limit in seconds, its stdout to out and stderr to
  // err (descriptors): its exit status, 124 past the limit.
  run(cmd: string, secs: number, out: number, err: number): Promise<number>;
}
// What a look did: nothing to do (no hook, main's code not moved, another lane at it), recorded the
// first commit only, ran it and recorded what it said, or failed (nothing recorded).
export type Affected = "none" | "busy" | "recorded" | "ran" | "failed";

const OUT = "runs/ci-affected.out", ERR = "runs/ci-affected.log", TOLD = "runs/.ci-affected-told";
const LOOP = { FACTORY_ACTOR: "loop", FACTORY_CI_EVIDENCE: "loop" };
const short = (c: string) => c.slice(0, 8);
const lastLine = (f: string) => { try { return (fs.readFileSync(f, "utf8").replace(/\n+$/, "").split("\n").pop() ?? "").slice(0, 200); } catch { return ""; } };
const isAncestor = (a: string, b: string) => git("merge-base", "--is-ancestor", a, b) !== null;

export async function ciAffected(c: AffectedCtx): Promise<Affected> {
  const said = () => { try { return JSON.parse(c.tr(["ci-affected", "--json"]).out) as { cmd?: string | null; at?: string | null }; } catch { return null; } };
  let j = said();
  if (!j?.cmd) return "none";
  // main's code: the newest commit outside tracker/ (every tracker write is a commit on main too).
  const head = git("log", "-1", "--format=%H", c.ref, "--", ".", ":(exclude)tracker") ?? "";
  if (!head || j.at === head) return "none";
  const fd = c.locks ? tryLock(path.join(c.locks, "ci-affected.lock")) : null;
  if (c.locks && fd === null) return "busy";
  try {
    j = said();   // another lane here may have just covered it
    if (!j?.cmd || j.at === head) return "none";
    const old = j.at ?? "";
    // The first run, or a commit this clone doesn't have (main's history rewritten): nothing to
    // compare with, so it only records where main's code is.
    if (!old || git("cat-file", "-e", `${old}^{commit}`) === null) {
      const r = c.tr(["ci-affected", head], LOOP);
      if (r.code !== 0) { c.log(`ci.affected: couldn't record main's code at ${short(head)} (${(r.out + r.err).trim()}); again next time`); return "failed"; }
      c.log(old ? `ci.affected: ${short(old)} isn't in main's history any more; covering from ${short(head)}, nothing touched` : `ci.affected: the first run; covering from main's code at ${short(head)}, nothing touched`);
      return "recorded";
    }
    // This clone is behind what's covered (another machine got further): nothing to do yet.
    if (isAncestor(head, old)) return "none";
    const cmd = j.cmd.replaceAll("{old}", old).replaceAll("{new}", head);
    const secs = Number(process.env.FACTORY_CI_AFFECTED_TIMEOUT || 120);
    const out = fs.openSync(OUT, "w"), err = fs.openSync(ERR, "w");
    let rc: number;
    try { rc = await c.run(cmd, secs, out, err); } finally { fs.closeSync(out); fs.closeSync(err); }
    if (rc !== 0) {
      const why = `${rc === 124 ? `out of time after ${secs}s` : `exit ${rc}`}${lastLine(ERR) ? `: ${lastLine(ERR)}` : ""}`;
      c.log(`ci.affected: ${cmd} failed (${why}); nothing touched, tried again next time (${ERR})`);
      if (!fs.existsSync(TOLD)) {
        c.event("ci-affected-failed", `the ci.affected hook failed over ${short(old)}..${short(head)} (${why}); no group's CI is made due by work outside it until it passes. It's tried again at every look (${ERR} on this lane)`);
        fs.writeFileSync(TOLD, `${old} ${head}\n`);
      }
      return "failed";
    }
    fs.rmSync(TOLD, { force: true });
    const r = c.tr(["ci-affected", head, "--touches", path.resolve(OUT)], LOOP);
    if (r.code !== 0) { c.log(`ci.affected: couldn't record ${short(old)}..${short(head)} (${(r.out + r.err).trim()}); again next time`); return "failed"; }
    c.log(`ci.affected: ${short(old)}..${short(head)}: ${r.out.trim()}`);
    return "ran";
  } finally { if (fd !== null) unlock(fd); }
}

// The hook over old..nw for a branch's review (landing.ts), recording nothing: its lines
// ("<group>\t<why>"), or "" when the project has no hook or it fails (logged; the review goes on).
// old and nw may be any commit names; the hook gets them as full commits.
export async function affectedLines(tr: AffectedCtx["tr"], run: AffectedCtx["run"], old: string, nw: string, log: (s: string) => void): Promise<string> {
  let cmd: string | null | undefined;
  try { cmd = (JSON.parse(tr(["ci-affected", "--json"]).out) as { cmd?: string | null }).cmd; } catch { return ""; }
  const a = git("rev-parse", old), b = git("rev-parse", nw);
  if (!cmd || !a || !b || a === b) return "";
  const outF = "runs/ci-affected-branch.out", errF = "runs/ci-affected-branch.log";
  const out = fs.openSync(outF, "w"), err = fs.openSync(errF, "w");
  let rc: number;
  try { rc = await run(cmd.replaceAll("{old}", a).replaceAll("{new}", b), Number(process.env.FACTORY_CI_AFFECTED_TIMEOUT || 120), out, err); } finally { fs.closeSync(out); fs.closeSync(err); }
  if (rc !== 0) { log(`ci.affected over the branch failed (${rc === 124 ? "out of time" : `exit ${rc}`}${lastLine(errF) ? `: ${lastLine(errF)}` : ""}); the review goes on without it`); return ""; }
  try { return fs.readFileSync(outF, "utf8").trim(); } catch { return ""; }
}
