// The loop's review of a finished branch, before it lands (landing.ts runs it once the landing
// check has passed, so a red main or a failing branch spends none). A fresh headless session gets
// the branch's diff outside tracker/, its unit's card and main's CODING_STANDARDS.md if the project
// has one, and returns a verdict as JSON: pass, or fix with findings. 24 Oct: one project's lanes
// landed 31 units and one was reviewed; its spec asked for a review in a section lanes don't get.
// Review is the cheap place for standards: the reviewer reads a diff, while the session that did
// the work is the one short of context. 29 Oct: two lanes recorded units done whose evidence said
// the card's check hadn't run (split off into a new unit, or not reproduced), and the review passed
// both: it now weighs the evidence against the card's check. And a grab change landed that changed
// five fighters' builds and rebuilt none, which broke their CI overnight: the review now hears which
// other groups' builds the branch changes (the ci.affected hook over the branch), as one line each.
// A review that can't give a verdict (the CLI fails, a usage limit, a verdict that won't parse, too
// long, killed over its memory cap) doesn't hold the branch: it lands unreviewed, and the overseer
// hears why. One stopped by a pause or the stop time waits for the next look instead.
import fs from "node:fs";
import path from "node:path";
import { limitHit, linkedDirs, log, runSession } from "./session.ts";
import { epoch } from "./sys.ts";
import { platform } from "./os.ts";
import { setting } from "./loop-start.ts";
import { NO_DISPLAY } from "./loop-unit.ts";
import { sessionOom } from "./loop-oom.ts";
import { json, read, str, ymdhms, type Json } from "./loop-util.ts";
import type { Loop } from "./loop.ts";

// affected: the ci.affected hook's lines for the branch ("<group>\t<why>"), the unit's own group
// left out; "" when there are none or the project has no hook.
export interface ReviewInput { unit: string; title: string; card: string; diff: string; standards: string; affected?: string }
// none: no verdict (why says why), and the branch lands; wait: stopped, and it's tried again later.
export type Verdict = { verdict: "pass" } | { verdict: "fix"; findings: string } | { verdict: "none" | "wait"; why: string };

export const SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["pass", "fix"] },
    findings: { type: "array", items: { type: "string" }, description: "One per problem: file:line, what's wrong, what to do. Empty for pass." },
  },
  required: ["verdict", "findings"],
};

// A diff longer than this goes in a file the reviewer reads in pieces, not in the prompt.
const INLINE = 100_000;

export const SYSTEM = `You are the factory's reviewer. A lane's session finished a unit of work on a branch, and its check passed; before the loop merges the branch into main, you review its diff. You have no shell and change nothing: read what you need (Read, Grep, Glob), then give your verdict as JSON.`;

export function reviewPrompt(r: ReviewInput, diffFile: string): string {
  const diff = r.diff.length <= INLINE
    ? `The branch's diff from main (outside tracker/, which the tracker writes itself):\n\n\`\`\`diff\n${r.diff}\n\`\`\``
    : `The branch's diff from main (outside tracker/) is ${r.diff.length} characters, too long to give here: it's in ${diffFile}. Read it in pieces.`;
  return [
    `Review this finished unit's branch before it lands on main: ${r.title} (${r.unit}).`,
    `Its card, as the session that worked it read it:\n\n${r.card.trim()}`,
    r.standards.trim() ? `The project's coding standards (CODING_STANDARDS.md on main), which the branch must follow:\n\n${r.standards.trim()}` : "",
    diff,
    r.affected?.trim() ? `Besides its own group's, this branch changes the build of these groups (the project's ci.affected hook over the branch, one per line: group, then why). Their CI rebuilds them after it lands, overnight, and a fault found then holds each one until a fix lands:\n\n${r.affected.trim()}\n\nIf the branch changes what those builds make (not only a test or a doc) and neither the card nor its Evidence shows the change was built or checked for at least one of them, that's a finding: name the group and the cheapest check of its affected step that would show the change doesn't break it.` : "",
    `The card's Evidence is what the session says it did. Hold it to the card's check (what the card says to check or show, and its Done when): if the Evidence says that check wasn't run, was run on less than the card asks, or was split off into another unit the card didn't ask for, that's a finding, whatever the diff looks like. Say which check is missing; if only the owner can run it (their hands, hardware, a permission the session was refused), say so, and the next session asks them.`,
    `Answer "pass" unless something should be fixed before this lands: a bug, a broken rule of the coding standards above (if there are any), something the card asks for that's missing or wrong, a check the card asks for that wasn't done, a stray file (build output, a secret, a scratch file), or a test weakened to pass. (An exception a check takes for one of the owner's departures from the reference, citing their decision and listed in docs/departures.md, isn't a weakened test.) Not matters of taste, and not what the check already proves.
For "fix", list each finding on its own: the file and line, what's wrong, and what to do about it, so the next session can fix it from your words alone (it gets them on the unit's card). For "pass", findings is empty.`,
  ].filter(Boolean).join("\n\n") + "\n";
}

// The verdict in a review's stream-json transcript: the result's structured output, else JSON in
// its text. null if there's none to be had.
export function verdictOf(out: string): Verdict | null {
  const res = json((read(out) ?? "").split("\n").filter((x) => x.includes('"type":"result"')).pop());
  if (!res || res.is_error === true) return null;
  let v = res.structured_output as Json | undefined;
  if (!v || typeof v !== "object") {
    const t = str(res.result), i = t.indexOf("{"), j = t.lastIndexOf("}");
    v = i >= 0 && j > i ? json(t.slice(i, j + 1)) ?? undefined : undefined;
  }
  if (!v) return null;
  const fs_ = (Array.isArray(v.findings) ? v.findings.map(str) : [str(v.findings)]).map((x) => x.trim()).filter(Boolean);
  if (v.verdict === "pass") return { verdict: "pass" };
  // A fix that names none is still a fix: the reviewer said it shouldn't land as it is.
  if (v.verdict === "fix") return { verdict: "fix", findings: fs_.length ? fs_.map((x) => `- ${x}`).join("\n") : "- The reviewer asked for fixes but named none: check the diff against the card and the coding standards before recording it again." };
  return null;
}

// tracker/project.json's "review_model", else the lane's model ("" for the CLI's default).
export function reviewModel(proj: Json | null, lane: string): string {
  const m = proj?.review_model;
  return typeof m === "string" && /^[\w.:\[\]-]+$/.test(m) ? m : lane;
}

// Run the review, the way the loop runs a session: its prompt in a file on stdin and its system
// prompt in a file, not on the command line (#119); no display (NO_DISPLAY); in a capped scope where
// sessions have one; stopped by a pause, the stop time, a signal, its silence, or
// FACTORY_REVIEW_TIMEOUT seconds (1800). It reads what the lane's sessions can (the clone's linked
// folders, its work/, by --add-dir). Killed over its memory cap, it's an oom-kill event like a
// session's, with what used the memory. Not a turn in the machine's memory budget: the lane runs
// it in place of a session, never beside one, and sessions, which do far more, take none either.
export async function runReview(l: Loop, r: ReviewInput): Promise<Verdict> {
  const c = l.cfg, o = l.o;
  const dir = `runs/review/${ymdhms()}-${r.unit.replace(/[^A-Za-z0-9_.-]+/g, "-")}`;
  const f = { system: path.join(dir, "system.md"), prompt: path.join(dir, "prompt.md"), diff: path.join(dir, "diff.patch"), out: path.join(dir, "review.jsonl"), err: path.join(dir, "review.err") };
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(f.diff, r.diff);
    fs.writeFileSync(f.system, SYSTEM);
    fs.writeFileSync(f.prompt, reviewPrompt(r, path.resolve(f.diff)));
  } catch (e) { return { verdict: "none", why: `couldn't write its prompt in ${dir} (${(e as Error).message})` }; }
  const model = reviewModel(json(read(`${c.tdir}/project.json`)), o.model);
  // FACTORY_REVIEWER: another command for the review than the agent CLI (the tests' fake reviewer).
  const cmd = [process.env.FACTORY_REVIEWER || c.agent, "-p", "--output-format", "stream-json", "--verbose", "--tools", "Read,Grep,Glob", "--allowedTools", "Read", "Grep", "Glob",
    "--json-schema", JSON.stringify(SCHEMA), "--no-session-persistence", ...linkedDirs(".").flatMap((d) => ["--add-dir", d]), ...(model ? ["--model", model] : []), ...(o.effort ? ["--effort", o.effort] : []),
    "--name", `factory review: ${r.title}`, "--append-system-prompt-file", f.system];
  const env: NodeJS.ProcessEnv = { ...process.env, WAYLAND_DISPLAY: NO_DISPLAY.WAYLAND_DISPLAY, CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", FACTORY_ACTOR: "loop", FACTORY_REVIEW: r.unit };
  for (const k of NO_DISPLAY.drop) delete env[k];
  const scope = c.cap ? `${c.scope}-review` : "";
  const limit = Number(process.env.FACTORY_REVIEW_TIMEOUT) || 1800, t0 = epoch();
  log(`reviewing ${r.title}${model ? ` with ${model}` : ""}: ${dir}`);
  const s = await runSession({ out: f.out, err: f.err, scope, cmd: scope ? platform.cappedCmd(scope, o.mem, cmd) : cmd, stdin: f.prompt, env,
    stopFile: "runs/.pause-now", deadline: l.clock.deadline, tick: () => epoch() - t0 < limit, tickWhy: `the review has run over ${mins(limit)}: ending it`, silent: setting("session_silence", 30) * 60 }, (x) => { l.running = x; });
  await l.halt();
  if (s.stopped === 2 || s.stopped === 3) return { verdict: "wait", why: s.stopped === 2 ? "a pause stopped its review" : "its review ran past the stop time" };
  const v = verdictOf(f.out);
  if (v) return v;
  if (await sessionOom(l, scope, f.err)) {
    const big = oomSnapshot(f.out, f.err, o.mem, s.end);
    log(`the review of ${r.title} was OOM-killed inside its ${o.mem} scope; the branch lands unreviewed`);
    l.event("oom-kill", `the review of ${r.title} was killed: out of memory at ${o.mem}; biggest: ${big}. The branch lands unreviewed`, r.unit);
    return { verdict: "none", why: `its review was killed: out of memory at ${o.mem} (biggest: ${big})` };
  }
  if (limitHit(f.out, f.err)) return { verdict: "none", why: "the reviewer hit a usage limit" };
  if (s.stopped === 4) return { verdict: "none", why: `its review ran over ${mins(limit)}` };
  if (s.stopped === 5) return { verdict: "none", why: "its review went silent" };
  if (s.rc !== 0 && s.stopped === 0) return { verdict: "none", why: `the review session failed (exit ${s.rc}; ${f.err})` };
  return { verdict: "none", why: `the review gave no verdict that could be read (${f.out})` };
}

const mins = (s: number) => s % 60 === 0 ? `${s / 60} minutes` : `${s} s`;

// A review killed over its memory cap: the session's last snapshot of what used the memory
// (runSession's <out>.mem) goes to its .err, and the biggest process is named, or why none is.
// A snapshot from well before the kill (an earlier peak's, as loop-oom.ts judges a session's)
// names nothing.
function oomSnapshot(out: string, err: string, mem: string, end: number): string {
  const f = out.replace(/\.jsonl$/, ".mem"), snap = read(f) ?? "";
  let age = 0; if (snap) { try { age = end - Math.floor(fs.statSync(f).mtimeMs / 1000); } catch {} }
  const stale = !!snap && age > Math.trunc(3 * Number(process.env.FACTORY_POLL || 5)) + 10;
  const top = snap.replace(/\n$/, "").split("\n")[1]?.split("\t") ?? [];
  try {
    fs.appendFileSync(err, stale ? `\nloop: the review was killed: out of memory at ${mem}. The last snapshot is ${age}s older than the kill, from an earlier peak, so it doesn't say what used the memory then:\n${snap}`
      : snap ? `\nloop: the review was killed: out of memory at ${mem}. What used the memory at the last look before the kill:\n${snap}`
      : `loop: the review was killed: out of memory at ${mem}, with no snapshot: it never used a quarter of its cap at a look\n`);
  } catch {}
  if (stale) return "not caught: it went from under a quarter of the cap to over it between two looks";
  if (top.length < 3) return "not caught: no snapshot";
  let c = top.slice(2).join(" ").replace(/`/g, "").trim();
  if (c.length > 100) c = `${c.slice(0, 97)}...`;
  return `\`${c}\` (${top[1]})`;
}
