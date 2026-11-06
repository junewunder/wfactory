// One claimed unit, worked: its branch and data, its session, and what's recorded after it.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { openInbox, put } from "./inbox.ts";
import { git } from "./landing.ts";
import { machineSection, mdSection, mdSections } from "./machines.ts";
import { limitHit, linkedDirs, log, runSession } from "./session.ts";
import { epoch, pwd } from "./sys.ts";
import { platform } from "./os.ts";
import { trOut, trWait } from "./tr.ts";
import { ciUnrun, ciUses } from "./loop-ci.ts";
import { openQuestions, type Claimed } from "./loop-claim.ts";
import { setting } from "./loop-start.ts";
import { oomSession, sessionOom } from "./loop-oom.ts";
import { both, exe, exists, hmAt, json, mins, minsText, read, resTitles, rm, str, ymdhms, type Json } from "./loop-util.ts";
import type { Loop } from "./loop.ts";

// What every session would read first, read for it from the unit's checkout: the spec's loop
// section and any section headed "(every session)", and this machine's section of
// docs/machines.md. Whole, the two files cost ~12k tokens a session on every turn
// (2026-10-18), mostly rules and machines the unit never touches. Where a section is missing,
// the session is told to read the file.
export function startReading(spec: string, host: string) {
  const text = read(spec) ?? "";
  const loop = mdSections(text, (h) => h.toLowerCase() === "the loop" || /\(every session\)$/i.test(h)), me = machineSection(host);
  return (mdSection(text, "The loop")
    ? `\n\nFrom ${spec}, its loop and the sections every session follows:\n\n${loop.join("\n\n")}`
    : `\n\n${spec} has no "## The loop" section: read it whole before you start.`)
    + (me ? `\n\nThis machine's section of docs/machines.md:\n\n${me}`
      : `\n\ndocs/machines.md has no section for ${host}: read it for what this machine can do.`) + "\n";
}

// The session's appended system prompt and its prompt, written to its inbox (system.md and
// prompt.md) so neither goes on its command line; null if they couldn't be.
export function promptFiles(inbox: string, system: string, prompt: string) {
  try {
    fs.mkdirSync(inbox, { recursive: true });
    const f = { system: path.join(inbox, "system.md"), prompt: path.join(inbox, "prompt.md") };
    fs.writeFileSync(f.system, system); fs.writeFileSync(f.prompt, `${prompt}\n`);
    return f;
  } catch { return null; }
}

// The display the session would inherit: lanes run as user services, whose environment has the
// owner's. 24 Oct, a lane testing a fullscreen toggle opened its window on the owner's screen,
// and a stray F11 then Ctrl+Q closed the owner's editor. DISPLAY and XAUTHORITY go; with no
// WAYLAND_DISPLAY a Wayland app falls back to $XDG_RUNTIME_DIR/wayland-0, the owner's
// compositor, so that one names a socket that can't exist. A window then opens only where the
// session sets up a display of its own (`cu session`, a headless compositor, a container). A long
// job gets the session's display, not the user manager's (long.ts), and so does most of what the
// loop runs of the project's own (sessionAdd). What a session starts through D-Bus (xdg-open and the
// like) still gets the owner's: the spec template's rule keeps sessions from it (#130).
export const NO_DISPLAY = { drop: ["DISPLAY", "XAUTHORITY"], WAYLAND_DISPLAY: "/dev/null/no-display" };

// tracker/project.json's "session_env": variables a project adds to its sessions' environment
// (its own app's config kept away from the owner's, a private display of its own), {clone} and
// {lane} filled in. A name that isn't one, or a value that isn't a string (or holds a NUL, which
// no environment can), is left out.
export function sessionEnv(proj: Json | null, clone: string, lane: string): Record<string, string> {
  const e = proj?.session_env, out: Record<string, string> = {};
  if (!e || typeof e !== "object" || Array.isArray(e)) return out;
  for (const [k, v] of Object.entries(e as Record<string, unknown>))
    if (/^[A-Za-z_]\w*$/.test(k) && typeof v === "string" && !v.includes("\0")) out[k] = v.replaceAll("{clone}", clone).replaceAll("{lane}", lane);
  return out;
}

// The session's display (NO_DISPLAY, then session_env) as variables to add, undefined for one to
// drop, as tr() takes them. These run with it too, not with the user manager's display:
// factory/pre-session, the unit's check (the settle's probe), refresh's probes, the landing checks
// (#130), group CI steps and the ci.affected hook (#174). A check that launched the app under test
// opened it on the owner's screen. (Not factory/tidy: the owner's own clean-up, Loop.tidy.) The
// tracker runs in these too: whoever runs
// one sets FACTORY_ACTOR after, as the session's own variables win over session_env's.
export function sessionAdd(tdir: string, lane: string): Record<string, string | undefined> {
  const add: Record<string, string | undefined> = { WAYLAND_DISPLAY: NO_DISPLAY.WAYLAND_DISPLAY };
  for (const k of NO_DISPLAY.drop) add[k] = undefined;
  return { ...add, ...sessionEnv(json(read(`${tdir}/project.json`)), pwd(), lane) };
}
// The same, as a whole environment over base.
export function sessionBase(tdir: string, lane: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...base };
  for (const [k, v] of Object.entries(sessionAdd(tdir, lane))) { if (v === undefined) delete e[k]; else e[k] = v; }
  return e;
}

// Did a session record anything? Its log lines other than the claim and settle, or a commit
// naming its unit (another lane's commits don't count).
function progress(tdir: string, tag: string, unit: string, head0: string) {
  const lines = (read(`${tdir}/log.jsonl`) ?? "").split("\n").filter((x) => x.includes(`"tag":"${tag}"`) && !/"cmd":"(claim|settle)"/.test(x));
  const commits = head0 ? (git("log", "--format=%s", `${head0}..HEAD`) ?? "").split("\n").filter((x) => x && x.includes(unit) && !x.startsWith("tracker: ")) : [];
  return [...lines, ...commits].join("\n");
}

// The session (tag) gave its unit back unstarted (the tracker marks that unclaim).
function gaveBackUnstarted(tdir: string, tag: string, unit: string) {
  return (read(`${tdir}/log.jsonl`) ?? "").split("\n").some((x) => x.includes(`"tag":"${tag}"`) && x.includes('"cmd":"unclaim"') && x.includes('"unstarted":true') && json(x)?.id === unit);
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// Last call's wrap-up, for a session whose unit uses resources CI needs (runSession calls tick at
// every poll): told through its inbox when last call begins, ended graceS seconds after that.
class Wrapup {
  private l: Loop; private u: Claimed; private inbox: string;
  told: "" | "none" | number = "";   // "": not yet; "none": CI needs none of them now; else when told
  res: string[];                     // the resources it holds that CI needs
  constructor(l: Loop, u: Claimed, inbox: string, res: string[]) { this.l = l; this.u = u; this.inbox = inbox; this.res = res; }
  tick = (): boolean => {
    const { l, u } = this, k = l.clock;
    if (this.told === "none") return true;
    if (this.told === "") {
      k.refresh();
      if (!k.inLastCall()) return true;
      // Still needed now? CI may have passed since the session started.
      this.res = both(this.res, ciUses());
      if (this.res.length === 0) { this.told = "none"; return true; }
      this.told = epoch();
      const what = resTitles(l.cfg.tdir, this.res), at = hmAt(this.told + k.graceS);
      try {
        put(this.inbox, "the loop", `Last call: CI needs ${what}. Within ${minsText(Math.trunc((k.graceS + 59) / 60))} commit what works${l.cfg.branches ? " on your branch (the loop pushes it)" : ""}, leave a note for the next attempt (\`just note ${u.id} "…"\`), and end the session. At ${at} the loop ends it.`);
      } catch {}
      log(`last call: told ${u.title} (${u.id}) to wrap up by ${at} (CI needs ${what})`);
      l.event("wrap-up", `last call: ${u.title} (${u.id}) holds ${what}, which CI needs; its session was told to wrap up, and is ended at ${at} if it hasn't`);
      return true;
    }
    return epoch() - this.told < k.graceS;
  };
}

// A session that passes twice its estimate is told once, through its inbox, to write what it
// learned and split the unit. Cards give no time, so a session's estimate is prompt.md's hour:
// FACTORY_SPLIT_AFTER seconds, default 7200 (15 Oct: a spike ran one 4-hour session).
function overlong(l: Loop, u: Claimed, inbox: string, tag: string, then?: () => boolean) {
  const splitAfter = Number(process.env.FACTORY_SPLIT_AFTER || 7200), s0 = epoch();
  let told = false;
  return () => {
    if (!told && splitAfter > 0 && epoch() - s0 >= splitAfter) {
      told = true;
      const h = splitAfter % 3600 ? minsText(Math.round(splitAfter / 60)) : splitAfter === 3600 ? "1 hour" : `${splitAfter / 3600} hours`;
      let sent = true;
      try {
        put(inbox, "the loop", `This session has run ${h}, twice what one should take: the unit is too big for a session. Stop the work where it is. Commit what works${l.cfg.branches ? " on your branch (the loop pushes it)" : ""}, write what you learned (\`just note ${u.id} "…"\`, and memory/ for what lasts), and split the unit: what's left as units of an hour or less (\`just tracker add-unit\`), the way \`${l.cfg.spec}\` splits work, or \`just ask\` how with your split as the default. Then record this unit and end the session.`);
      } catch { sent = false; }
      const did = sent ? "told it to write what it learned and split the unit" : "it has no inbox, so it wasn't told to split the unit";
      log(`${u.title} (${u.id}) has run ${h}: ${did}`);
      l.event("overlong", `${u.title} (${u.id}): session ${tag} has run ${h}, twice a session's hour; ${sent ? "it was told to write what it learned and split the unit" : "it has no inbox and wasn't told"}`);
    }
    return then ? then() : true;
  };
}

// Works the unit: "next" to go on to the next look, "stop" once the loop stops (its reason given).
export async function workUnit(l: Loop, u: Claimed): Promise<"next" | "stop"> {
  const o = l.o, c = l.cfg, env = process.env, { id: unit, title, card } = u;
  const looper = { FACTORY_TAG: l.tag, FACTORY_ACTOR: "loop" };

  // The unit's own branch (a merge unit works the branch it's merging).
  let branch = "", onbranch = "";
  if (c.branches) {
    branch = u.branch || `unit/${unit}`;
    if (!l.land.startBranch(branch)) {
      l.locks.dropAll(); await l.settle(unit, title, looper);
      l.stop(`couldn't check out ${branch} for ${title} (${unit})`); return "stop";
    }
    onbranch = `\nYou are on branch ${branch}, made for this unit${l.land.aheadOfMain(branch) === 0 ? "" : ", with the work an earlier session left on it"}. Commit your work on it. The last step before you record the unit: merge the latest main into it (factory/prompt.md says how)${u.slowCheck ? "; this unit's own check is slow, so run only `just check` at that step" : ""}.`;
  }

  l.i++;
  const started = ymdhms(), t0 = epoch(), tag = l.tag;
  const out = `runs/${started}-${tag}.jsonl`, errf = `${out.replace(/\.jsonl$/, "")}.err`;
  const head0 = git("rev-parse", "HEAD") ?? "";
  const before = progress(c.tdir, tag, unit, head0);
  log(`iteration ${l.i}: ${title} (${unit}) (session ${tag}${u.model ? `, ${u.model}` : ""})`);

  // The unit's data: room for a new lease, then a copy down unless the copy here is current.
  let dg = "";
  if (c.store) {
    dg = u.data;
    if (dg) {
      const rc = await l.stoppable(["factory/store.sh", "take", dg, "--unit", unit, "--mark", unit, String(process.pid), ...(u.newLease ? ["--new"] : [])]);
      if (rc !== 0) {
        // No room: the lease goes too, even one an earlier claim here took (the copy here wasn't
        // current, so nothing in it is unsent), or every lane here would take it again at once.
        l.locks.dropAll(); trWait(["unclaim", unit, "--unstarted", ...(rc === 1 ? ["--release-lease"] : [])], log, looper);
        if (c.branches) l.land.toMain();
        l.i--;
        if (rc === 1) {
          // Units needing a new lease wait half an hour here, not a claim and a give-back every look.
          log(`no room in this machine's cache for ${dg}'s data; gave ${title} (${unit}) back; every lane here takes only units needing no new lease for 30 min`);
          l.noRoom(); return "next";
        }
        log(`couldn't get ${dg}'s data ready; gave ${title} (${unit}) back; waiting`);
        l.event("store-down", `couldn't copy ${dg}'s data down to ${l.host} for ${title} (${unit}); the lane waits and tries again`);
        await l.nap(mins(o.idleWait), true); return "next";
      }
    }
  }

  // Its own outputs from its last, unfinished attempt, set aside when that ended, go back into
  // work/ if they were built from the commit its branch is on (store.sh restore); the session is
  // told either way.
  let restored = "";
  if (dg) {
    const r = spawnSync("factory/store.sh", ["restore", dg, unit], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
    restored = (r.stdout ?? "").trim();
    if (restored) log(`  ${restored}`);
  }

  // factory/pre-session, if the project has one, gets the unit and its card and returns at once (warm-ups etc.).
  // It gets the session's environment (sessionAdd).
  if (exe("factory/pre-session") && (await l.stoppable(["factory/pre-session", unit], { input: `${card}\n`, env: sessionBase(c.tdir, l.lane) })) !== 0) log("pre-session failed; carrying on");

  // "Pause asap" between the claim and the session: don't start it.
  if (exists("runs/.pause-now")) {
    l.locks.dropAll(); await l.settle(unit, title, looper);
    if (c.branches) await l.land.finishUnit(unit, branch, `${title} (${unit})`);
    await l.commitTracker(`tracker: ${title} (${unit}), paused before its session`);
    rm("runs/.pause", "runs/.pause-now");
    l.stop(`paused asap: ${title} (${unit}) was claimed but not started; the next session takes it`);
    return "stop";
  }

  const scope = c.cap ? `${c.scope}-${tag}` : "";
  // Its inbox: `just fleet tell` finds it through runs/inbox/current while the session runs.
  const inbox = `${pwd()}/runs/inbox/${tag}`;
  // A unit holding what CI needs gets last call's wrap-up.
  const wrap = new Wrapup(l, u, inbox, u.uses.length ? both(u.uses, ciUses()) : []);
  const tick = overlong(l, u, inbox, tag, wrap.res.length ? wrap.tick : undefined);
  let sargs: string[] = [];
  try {
    openInbox(inbox, unit, tag, u.claimedAt, "factory/auto-mode.json", `${card}\n`, u.decisions);
    sargs = ["--settings", `${inbox}/settings.json`];
    rm("runs/inbox/current"); fs.symlinkSync(tag, "runs/inbox/current");
  } catch {
    log(`inbox: couldn't make ${inbox}; this session gets no messages`);
    if (exists("factory/auto-mode.json")) sargs = ["--settings", "factory/auto-mode.json"];
  }
  // The real directories behind the clone's links (its work/), so the CLI lets it write there.
  const dirs = linkedDirs(".").flatMap((d) => ["--add-dir", d]);
  // No prompt text on the command line: the appended system prompt goes in a file and
  // factory/prompt.md comes on stdin (on the command line only if its inbox can't take them).
  // 24 Oct, a `pkill -A -f` for words a card mentioned killed every lane's session. What still
  // names a session there: --name and --session-id.
  // When what it holds goes to CI (last call), told next to the stop time, so it can split what won't fit.
  const toCi = wrap.res.length && l.clock.lastCall > 0 ? ` ${cap(resTitles(c.tdir, wrap.res))} ${wrap.res.length > 1 ? "go" : "goes"} to CI at about ${hmAt(l.clock.lcAt())} (last call): finish with it by then.` : "";
  const system = `Your factory session tag is ${tag}. You are lane ${l.lane} on ${l.host}. The lane stops at ${hmAt(l.clock.deadline)}.${toCi}${o.loop ? ` You are working the '${o.loop}' loop.` : ""}${onbranch}${restored ? `\n${restored}` : ""}${startReading(c.spec, l.host)}\nYou have claimed this unit:\n${card}`;
  const files = promptFiles(inbox, system, l.prompt);
  if (!files) log(`inbox: couldn't write this session's prompts in ${inbox}; they go on its command line`);
  const agent = [c.agent, ...c.args, ...dirs, ...(u.model ? ["--model", u.model] : []), ...sargs, "--session-id", l.uuid, "--name", `factory: ${title}`,
    ...(files ? ["--append-system-prompt-file", files.system] : ["--append-system-prompt", system, l.prompt])];
  // A session's Bash calls may run 10 minutes (the CLI's default is 2), which `just long wait` relies on.
  // They run in lane-bash.sh: plain bash, stdin from /dev/null, none of the owner's aliases.
  // No display (NO_DISPLAY), then the project's own variables (session_env), then the loop's.
  const senv: NodeJS.ProcessEnv = { ...sessionBase(c.tdir, l.lane, env), BASH_DEFAULT_TIMEOUT_MS: env.BASH_DEFAULT_TIMEOUT_MS || "600000", BASH_MAX_TIMEOUT_MS: env.BASH_MAX_TIMEOUT_MS || "600000",
    // No auto-memory: a factory keeps what sessions learn in its own files and the tracker.
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    CLAUDE_CODE_SHELL: path.join(l.here, "lane-bash.sh"), FACTORY_OWNER_SHELL: env.FACTORY_OWNER_SHELL || env.SHELL || "",
    FACTORY_INBOX: inbox, FACTORY_STOP_FILE: "runs/.pause-now", FACTORY_DEADLINE: String(l.clock.deadline), FACTORY_TAG: tag, FACTORY_SESSION: l.uuid, FACTORY_PID: String(process.pid), FACTORY_ACTOR: "loop",
    // The unit it holds, for the events its jobs log (an oom-kill: events.ts).
    FACTORY_SESSION_UNIT: unit };
  // A session silent this long with no tool call open is ended (runSession).
  const silent = setting("session_silence", 30);
  const s = await runSession({ out, err: errf, scope, cmd: scope ? platform.cappedCmd(scope, o.mem, agent) : agent, stdin: files?.prompt, env: senv, stopFile: "runs/.pause-now", deadline: l.clock.deadline, tick, silent: silent * 60 },
    (r) => { l.running = r; });
  // A session ran here: the next leave ends a run of the lanes, for the kept sets (store-leases.ts,
  // leave). Lanes started and stopped again before one ran don't end one (#140). (Before the halt:
  // one a stop cut short counts too.)
  if (c.store) { try { fs.mkdirSync("work/.store", { recursive: true }); fs.writeFileSync("work/.store/ran", ""); } catch {} }
  await l.halt();
  // A stop asked for (oversee.sh stop touches runs/.stop-now before it signals): the session may
  // have ended of that stop before the loop has handled its own signal. Its unit is the stop's to
  // settle, not settled here as a session that ended (#127, #125): the loop waits for the signal,
  // whose finish() settles it (pause() never returns once it's stopping). The wait is a timer, so
  // the process stays up for the signal; one that never comes (the stop failed after the touch)
  // leaves a stale file, which goes after a minute, and the unit is settled here as before.
  if (exists("runs/.stop-now")) {
    log(`stopping: ${title} (${unit})'s session ended as the lane is being stopped; the stop settles it`);
    for (let i = 0; i < 60; i++) await l.pause(1);
    rm("runs/.stop-now");
    log("  no signal came within a minute: the stop didn't happen, so the loop settles the unit itself");
  }
  const rc = s.rc;
  rm("runs/inbox/current");
  // A message that came after the session's last tool call never reached it: the overseer hears.
  let unread: string[] = []; try { unread = fs.readdirSync(`${inbox}/new`); } catch {}
  if (unread.length) l.event("inbox-unread", `${title} (${unit}): session ${tag} ended before reading ${unread.length} message(s) from the factory (${inbox}/new); a note on the unit reaches the next session`);
  l.locks.dropAll();
  // Long jobs belong to their session: none keeps writing while the lane switches branches.
  const left = (spawnSync("factory/long.sh", ["stop-all", "--tag", tag], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).stdout ?? "").replace(/\n+$/, "");
  if (left) log(left);
  const after = progress(c.tdir, tag, unit, head0);   // before the loop's own tracker commit below
  if (c.branches) l.land.presave(unit, branch, `${title} (${unit})`);

  // Its probe waits for memory in the machine's budget (heavy.ts). A busy lock is waited out, or the
  // unit would stay claimed by a session that's gone (#109).
  const settled = await l.settle(unit, title, looper);
  const st = (settled.out + settled.err).replace(/\n+$/, "");
  if (st) log(`  ${st}`);
  // The session left its unit stuck (blocked on something other than a question: a permission
  // refused, a credential missing): the overseer hears now, with the reason.
  { const r = trWait(["state", unit], log); if (r.code === 0 && r.out.trim() === "stuck") l.stuckEvent(unit, title); }
  // What the loop itself wrote (the claim, the settle, a check result) goes in its own commit.
  await l.commitTracker(`tracker: ${title} (${unit}), after session ${tag}`);
  // A finished unit's branch goes into main; an unfinished one is pushed for whoever's next.
  if (c.branches) await l.land.finishUnit(unit, branch, `${title} (${unit})`);
  // Its data back to the store once its work is on main; an unfinished unit's outputs don't go, and
  // the store's copy is put back here (store.sh end). Then leases with nothing left go, and a copy
  // back that failed earlier is tried again.
  if (dg) {
    const commit = git("rev-parse", "--short", `origin/${c.main}`) ?? git("rev-parse", "--short", "HEAD") ?? "";
    if ((await l.stoppable(["factory/store.sh", "end", dg, unit, commit])) !== 0) log(`couldn't copy ${dg}'s data back; it stays marked as unsent, so nothing deletes it, and it's tried again at each look`);
  }
  let marks: string[] = []; try { marks = fs.readdirSync("work/.store/groups"); } catch {}
  if (dg || marks.some((n) => n.endsWith(".unsent") || n.includes(".unmerged."))) l.releaseIdle();
  // A new question for the owner: the overseer posts it now, not at the end of the run.
  const qs = new Set(u.qsBefore);
  for (const q of openQuestions(c.tdir).filter((x) => !qs.has(x))) {
    const qj = json(read(`${c.tdir}/questions.json`));
    const x = (Array.isArray(qj?.questions) ? qj!.questions as Json[] : []).find((y) => y.id === q);
    if (x) l.event("question", `${x.title} (${x.id})`);
  }

  const res = json((read(out) ?? "").split("\n").filter((x) => x.includes('"type":"result"')).pop()) ?? {};
  const isErr = !("is_error" in res) || String(res.is_error) === "true";
  const text = str(res.result).replace(/\s+/g, " ").slice(0, 120);
  const turns = str(res.num_turns), cost = str(res.total_cost_usd).slice(0, 6);
  fs.appendFileSync("runs/index.tsv", [started, tag, o.loop, `${title} (${unit})`, text, turns, cost, Math.trunc((epoch() - t0) / 60)].join("\t") + "\n");

  // `just oversee pause --now` ended this session: its unit is left for the next one.
  if (exists("runs/.pause-now")) {
    rm("runs/.pause", "runs/.pause-now");
    l.stop(`paused asap: ${title} (${unit}) was cut short and shows as interrupted; ${c.branches ? "its work is on its branch, pushed for whoever takes it next" : "the next session carries on from what it left"}`);
    return "stop";
  }
  // Still running well past the stop time (runSession ended it): its unit is left for the next run.
  if (s.stopped === 3) {
    l.clock.refresh();
    l.stop(`out of time: ${title} (${unit}) was still running ${Math.trunc((Number(env.FACTORY_OVERRUN || 1200) + 59) / 60)} min after the stop time (${hmAt(l.clock.deadline)}), so it was ended; it shows as interrupted, ${c.branches ? "its work pushed to its branch" : "the next session carries on from what it left"}${ciUnrun(l.clock.inLc)}`);
    return "stop";
  }
  // Last call's wrap-up time ran out (Wrapup): CI gets the resource, and the lane goes on.
  if (s.stopped === 4) {
    log(`last call: ${title} (${unit}) was ended after its wrap-up time, so CI can have ${resTitles(c.tdir, wrap.res)}; it shows as interrupted${c.branches ? ", its work pushed to its branch" : ""}`);
    l.event("wrapped-up", `last call: ${title} (${unit}) didn't end within its wrap-up time and was ended, so CI can have ${resTitles(c.tdir, wrap.res)}; it shows as interrupted, ${c.branches ? "its work pushed to its branch" : "the next session carries on from what it left"}`);
    return "next";
  }
  // Its stream went silent with no tool call open (runSession ended it): the lane goes on.
  if (s.stopped === 5) {
    const why = `${title} (${unit}) wrote nothing for ${minsText(silent)} with no tool call open, so it was ended; it shows as interrupted, ${c.branches ? "its work pushed to its branch" : "the next session carries on from what it left"}`;
    log(`silent: ${why}`);
    l.event("silent", why);
    return "next";
  }
  // A session stopped after a clean result (runSession) succeeded, whatever its exit status.
  if (isErr || (rc !== 0 && s.stopped === 0)) {
    if (limitHit(out, errf)) {
      log(`usage limit; sleeping ${o.limitWait} min, then retrying`);
      l.i--;
      await l.nap(mins(o.limitWait));
      return "next";
    }
    // The memory cap isn't the unit's failure, nor the lane's: record what used it, go on.
    if (await sessionOom(l, scope, errf)) { await oomSession(l, unit, title, tag, out, s.end); return "next"; }
    // A signal to the lane (a logout, a shutdown) that killed the session too: the lane stopped
    // on the signal, not on a failed session (#74). (It never returns, then.)
    await l.heedSignals(); await l.halt();
    l.stop(`session ${tag} failed (exit ${rc}). Stopping; see ${out} and ${errf}`);
    return "stop";
  }
  log(`  → ${text}`);
  // Its session gave the unit back unstarted: this lane doesn't take it again this run.
  if (gaveBackUnstarted(c.tdir, tag, unit)) { l.gaveBack.add(unit); log(`  ${title} (${unit}) was given back unstarted: this lane doesn't take it again this run`); }

  if (after === before) {
    l.idle++;
    if (l.idle >= 2) { l.stop("two iterations recorded nothing; stopping instead of spinning"); return "stop"; }
  } else l.idle = 0;
  return "next";
}
