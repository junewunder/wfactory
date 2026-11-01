// One lane's loop, run detached for an overseeing session to watch (factory/oversee.sh): a
// systemd service per checkout and loop, which `just fleet` asks of every lane.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { NoInbox, put } from "./inbox.ts";
import { dayHm, enterRoot, epoch, pwd, tail, tryLock, unlock, ymdHms, asksHelp } from "./sys.ts";
import { platform } from "./os.ts";
import { ask, dropRecord, ensureDaemon, look, lookMachine, recordLane, records, watch, writeRecord, type LaneAsk, type LaneSeen, type MachineAsk, type MachineSeen } from "./daemon.ts";

export const HELP = `
oversee.sh — run the factory loop detached, for an overseeing session to watch.

\`start\` runs \`factory/loop.sh\` as a transient systemd user service, so the
loop outlives the session that started it (a crashed or closed overseer
leaves the loop running, and a new \`oversee\` session picks it up with
\`state\`). Output goes to runs/loop.log. \`wait\` blocks until the loop exits or
a timeout passes, so the overseer can run it as a background command and be
woken only when something happened.

Usage:
  factory/oversee.sh start [<loop>] [loop.sh options…]
  factory/oversee.sh wait  [<loop>] [--minutes M]
  factory/oversee.sh pause [<loop>] [--now]
  factory/oversee.sh restart [<loop>] [--id ID --of N]
  factory/oversee.sh last-call [<loop>]
  factory/oversee.sh stop-at [<loop>] --at <epoch seconds>
  factory/oversee.sh tell [<loop>] [--unit <id>] -- <text…>
  factory/oversee.sh state [<loop>]
  factory/oversee.sh stop  [<loop>]
  factory/oversee.sh tidy  [<loop>]
  factory/oversee.sh watch <request>     (for \`fleet wait\`)

Examples:
  just oversee start --hours 10
  just oversee wait              # in the background; wakes the overseer on exit
  just oversee start docs --hours 6 --model sonnet
  just pause                     # finish the current unit, then stop
  just oversee pause --now       # end the current session; its unit waits for the next one
  just oversee stop              # the loop, its current session and its long jobs, now

Commands:
  start   Start the loop (refuses if it's already running). Options after the
          loop name go to loop.sh (\`factory/loop.sh --help\`).
  wait    Block until the loop's unit is inactive, or --minutes pass
          (default 110, under the Bash tool's 2-hour background limit). Then
          print its state and the end of runs/loop.log. Exit 0 = the loop has
          exited, 10 = still running (just wait again).
  pause   Ask the loop to stop after the unit it's on (writes runs/.pause).
          The loop logs "paused at a good point" and exits; \`wait\` sees it.
          With --now ("pause asap"): end the running session now as well. The
          loop settles its unit (it shows as interrupted, and its uncommitted
          work goes to its branch, pushed for whoever takes it next) and
          exits. Its long jobs are stopped with it (a long job never
          outlives its session).
  restart Ask the loop to start again on the newest deployed copy of the skill
          (writes runs/.restart) as soon as the unit it's on ends, or at once if it's
          waiting for work. It carries on the same run: its stop time, its leases.
          \`just fleet restart\` deploys first and passes --id/--of, so the last of a
          machine's lanes to restart tells the morning summary (factory/loop.sh --help).
  last-call  Start the loop's last call now (writes runs/.last-call): it takes no new
          unit, lets the one in flight land (one that holds a resource CI needs is told
          to wrap up, and ended after "last_call_grace" minutes), runs CI for every group
          whose CI is stale, then stops (\`factory/loop.sh --help\`, "Last call").
  stop-at Set the loop's stop time (runs/.stop-at), if earlier than its --hours: last
          call comes before it, and the loop stops at it.
  tell    Queue a message for the session running now (its inbox, factory/inbox.sh):
          it reads it after its next tool call. With --unit, only if that session works
          that unit. Exit 3 if no session (or none on that unit) is running.
  state   Print running / not running and the end of runs/loop.log.
  stop    Stop the loop, the session it's running (its own scope) and its long
          jobs (factory/long.sh), now. Only what's committed or on disk survives;
          the loop's next start saves the unit's work to its branch. Leases
          whose last finished unit's data is on the store are released; the
          cut-short unit's data isn't copied back.
  tidy    With the loop stopped: stop any session scope or long job it left
          running, and say what was stopped. (\`just fleet tidy\` also runs the
          project's factory/tidy for the whole machine.)
  watch   What \`just fleet wait\` asks of this machine, as a line of JSON: its
          lanes now ({"op":"look","lanes":[{"unit","dir"}…]}), or once one
          stops or logs an event ({"op":"watch",…,"seen":[…],"until":<epoch>}).
          Answered by the machine's daemon (main.mjs daemon --help), which it
          starts if it isn't running.

A start writes the lane's record for the machine's daemon and starts the
daemon, which brings the lane back if the machine goes down while it runs.

The service gets this shell's PATH, HOME, display and session-bus variables
and any FACTORY_* settings, and nothing else, so the loop's claude sessions
start clean rather than inheriting the overseer's session.`;

const LOG = "runs/loop.log";
// What the loop's service is given of this environment, besides every FACTORY_ variable.
const PASSED = ["PATH", "HOME", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"];
const WAIT_EVERY = 5;   // seconds between looks in `wait`

// tracker/project.json, as far as it can be read.
export function project(): Record<string, unknown> {
  try { const p = JSON.parse(fs.readFileSync("tracker/project.json", "utf8")); return p && typeof p === "object" ? p : {}; } catch { return {}; }
}

// The project's loops as the tracker has them: tracker/project.json on origin's main as last
// fetched (`fleet start` fetches it just before), not on whatever branch the checkout is on. A lane
// stopped mid-unit is left on that unit's branch, which may be from before a loop was added.
// With no origin's main (one machine, or a project not pushed yet), the checkout's.
function loops(env: NodeJS.ProcessEnv): Record<string, unknown> {
  let p = project();
  if (env.FACTORY_STATE !== "local") {
    const r = spawnSync("git", ["show", `refs/remotes/origin/${env.FACTORY_MAIN || "main"}:tracker/project.json`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    if (r.status === 0) { try { const o = JSON.parse(r.stdout); if (o && typeof o === "object") p = o; } catch {} }
  }
  const l = p.loops;
  return l && typeof l === "object" ? l as Record<string, unknown> : {};
}

const mkRuns = () => fs.mkdirSync("runs", { recursive: true });
const touch = (f: string) => { mkRuns(); fs.closeSync(fs.openSync(f, "a")); };
const read = (f: string) => { try { return fs.readFileSync(f, "utf8"); } catch { return null; } };
const resolve = (f: string) => { try { return fs.realpathSync(f); } catch { return ""; } };

export async function overseeCli(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const [cmd = "", ...rest] = args;
  if (cmd === "" || asksHelp(args)) { console.log(HELP); return 0; }
  // A machine-wide question, not one lane's: no checkout needed, and no loop name.
  if (cmd === "watch") {
    let req: Req;
    try { req = JSON.parse(rest[0] ?? ""); } catch { console.error("usage: oversee.sh watch <request as JSON>"); return 2; }
    console.log(JSON.stringify(await answer(req, env)));
    return 0;
  }
  if (!enterRoot("oversee.sh", env)) return 1;

  // A loop's name comes first, when the project has loops.
  let a = rest, loop = "";
  if (Object.keys(loops(env)).length > 0 && a.length > 0 && !a[0].startsWith("-")) { loop = a[0]; a = a.slice(1); }
  const base = `factory-${path.basename(pwd(env))}`;
  const UNIT = `${base}${loop ? `-${loop}` : ""}`;
  // Each iteration's session runs capped on its own, outside the lane's job. Tags are 8
  // characters, so this leaves other loops' sessions alone.
  const sessions = `${UNIT}-????????`;
  const longs = `${base}-long-*`;

  const active = () => platform.jobRunning(UNIT);
  // A stop the overseer asks for outranks a restart waiting for the lane to stop (one on a copy
  // from before restarts): the daemon no longer starts it again.
  const keepStopped = () => {
    const r = records(env).find((x) => x.unit === UNIT);
    if (r?.then) { const { then: _, restart: __, ...rest } = r; writeRecord(rest, env); }
  };
  const report = () => {
    if (active()) console.log(`running: ${UNIT}`);
    else console.log(`not running: ${UNIT} (last result: ${platform.jobResult(UNIT) || "none"})`);
    console.log(`--- ${LOG}`);
    // This run's lines only: what an earlier run said before its stop isn't this one's.
    const t = tail(LOG, 400);
    if (t === null) { console.log(`(no ${LOG} yet)`); return; }
    const h = t.findLastIndex((l) => l.startsWith("==== "));
    const run = h >= 0 ? t.slice(h) : t;
    if (run.length) console.log(run.slice(-15).join("\n"));
  };

  switch (cmd) {
    case "start": {
      if (active()) { console.error(`${UNIT} is already running; \`just oversee wait\` to watch it`); return 2; }
      platform.forgetJob(UNIT);
      mkRuns();
      fs.appendFileSync(LOG, `\n==== ${ymdHms()} start ${loop ? `${loop} ` : ""}${a.join(" ")}\n`);
      const vars: Record<string, string> = {};
      // (Not the history a resume hands its record: the loop has no use for it.)
      for (const v of [...PASSED, ...Object.keys(env).filter((k) => k.startsWith("FACTORY_") && k !== "FACTORY_RESUMED").sort()]) if (env[v]) vars[v] = env[v];
      const log = path.join(pwd(env), LOG);
      // Stopping waits for the loop's exit: copying data back and releasing leases.
      const rc = platform.startJob(UNIT, vars, ["factory/loop.sh", ...(loop ? [loop] : []), ...a], { log, stopTimeout: 300, keepResult: true });
      // systemd refused it (a user bus ssh can't reach, the last run's unit still stopping):
      // `fleet start` says the lane didn't start.
      if (rc !== 0) return rc;
      // The daemon's record of it, which brings it back after the machine went down.
      recordLane(UNIT, pwd(env), loop, a, vars, env);
      const d = await ensureDaemon(env);
      await sleep(3000);
      report();
      if (d.said) console.log(`(${d.said})`);
      const blocked = platform.bootBlocked(pwd(env));
      if (blocked) console.log(`(${blocked})`);
      return 0;
    }
    case "wait": {
      let mins = 110;
      if (a[0] === "--minutes") {
        if (!/^[0-9]+$/.test(a[1] ?? "")) { console.error(`oversee: --minutes needs a whole number (got '${a[1] ?? ""}')`); return 2; }
        mins = Number(a[1]);
      }
      const end = epoch() + mins * 60;
      while (active() && epoch() < end) await sleep(WAIT_EVERY * 1000);
      report();
      return active() ? 10 : 0;
    }
    case "pause": {
      // Works for a `just loop` in a terminal too: the loop checks for the file between units.
      touch("runs/.pause");
      keepStopped();
      if (a[0] === "--now") {
        touch("runs/.pause-now");
        platform.stopCapped(sessions);
        console.log(`ended ${UNIT}'s running session; the loop settles its unit and stops (a minute or two)`);
      } else if (active()) console.log(`asked ${UNIT} to stop after the unit it's on`);
      else console.log(`asked any running \`just loop\` here to stop after its unit (${UNIT} isn't running)`);
      return 0;
    }
    case "restart": {
      const usage = () => { console.error("usage: oversee.sh restart [<loop>] [--id ID --of N]"); return 2; };
      let id = "", of = "1";
      for (let i = 0; i < a.length; i += 2) {
        if (a[i] === "--id") id = a[i + 1] ?? "";
        else if (a[i] === "--of") of = a[i + 1] ?? "";
        else return usage();
      }
      if (!/^[A-Za-z0-9._-]*$/.test(id) || !/^[1-9][0-9]*$/.test(of)) return usage();
      if (!active()) { console.log(`${UNIT} isn't running: nothing to restart (\`just fleet start\` starts it on the newest runner)`); return 3; }
      // A loop from before restarts never looks for the request: say so rather than leave it unread.
      const pid = platform.jobPid(UNIT);
      const given = (pid > 0 && platform.processEnv(pid)) || {};
      const runs = given.FACTORY_SKILL ?? "";
      // (The bash loop had restart_lane; the TypeScript one is src/loop.ts.) Such a loop pauses
      // after its unit instead, and the daemon starts it again on the newest copy once it stops.
      if (runs && !(read(`${runs}/runtime/loop.sh`) ?? "").includes("restart_lane") && !fs.existsSync(`${runs}/runtime/src/loop.ts`)) {
        const run = lastStart(loop);
        if (!run) {
          console.log(`${UNIT} runs a copy of the skill from before restarts (${runs}), and ${LOG} doesn't say how it was started: pause it and start it (\`just fleet pause\`, then \`just fleet start\` once it stops)`);
          return 4;
        }
        const vars = Object.fromEntries(Object.entries(given)
          .filter(([k]) => PASSED.includes(k) || (k.startsWith("FACTORY_") && k !== "FACTORY_RESUMED")));
        // It starts again on the copy running this: the deployed current, picked again then, or
        // the copy chosen by hand.
        delete vars.FACTORY_SKILL; delete vars.FACTORY_SKILL_FROM;
        if (env.FACTORY_SKILL && env.FACTORY_SKILL_FROM !== "deploy") vars.FACTORY_SKILL = env.FACTORY_SKILL;
        recordLane(UNIT, pwd(env), loop, run.args, vars, env);
        const rec = records(env).find((r) => r.unit === UNIT);
        if (rec) writeRecord({ ...rec, started: run.at, deadline: run.at + Math.trunc(run.hours * 3600), then: "start", ...(id ? { restart: { id, of } } : {}) }, env);
        touch("runs/.pause");
        const d = await ensureDaemon(env);
        if (!d.ok) { console.log(`${UNIT} runs a copy of the skill from before restarts, and ${d.said}: pause it and start it (\`just fleet pause\`, then \`just fleet start\` once it stops)`); return 4; }
        console.log(`${UNIT} runs a copy of the skill from before restarts (${runs}), which can't restart itself: asked it to pause after the unit it's on, and the machine's daemon starts it again on the newest runner once it stops`);
        return 0;
      }
      mkRuns();
      fs.writeFileSync("runs/.restart", `${id || `${epoch()}-${process.pid}`} ${of}\n`);
      console.log(`asked ${UNIT} to restart on the newest runner when the unit it's on ends (at once if it's waiting)`);
      return 0;
    }
    case "last-call": {
      touch("runs/.last-call");
      keepStopped();
      if (active()) console.log(`last call for ${UNIT}: no new units; CI runs for every group whose CI is stale, then it stops`);
      else console.log(`${UNIT} isn't running (a \`just loop\` here takes last call too)`);
      return 0;
    }
    case "stop-at": {
      if (a[0] !== "--at" || !/^[0-9]+$/.test(a[1] ?? "")) { console.error("usage: oversee.sh stop-at [<loop>] --at <epoch seconds>"); return 2; }
      mkRuns();
      fs.writeFileSync("runs/.stop-at", `${a[1]}\n`);
      console.log(`${UNIT} stops at ${dayHm(new Date(Number(a[1]) * 1000))} (or at its --hours, if sooner), after last call${active() ? "" : "; it isn't running now"}`);
      return 0;
    }
    case "tell": {
      const usage = () => { console.error("usage: oversee.sh tell [<loop>] [--unit <id>] -- <text…>"); return 2; };
      let want = "";
      if (a[0] === "--unit") { if (a.length < 2) return usage(); want = a[1]; a = a.slice(2); }
      if (a[0] === "--") a = a.slice(1);
      if (a.length === 0) return usage();
      // Resolved once: the next session's inbox may replace it meanwhile, and a message meant for
      // this one mustn't reach that one. A link a killed loop left (its lock is free) is no session.
      const c = resolve("runs/inbox/current");
      let dead = !c || !isDir(`${c}/new`);
      if (!dead) {
        let fd: number | null = null;
        try { fd = tryLock("runs/.loop.lock"); } catch {}
        if (fd !== null) { unlock(fd); dead = true; }
      }
      if (dead) { console.log("no session is running here: nothing told (a note on a unit, or a decision scoped to it, reaches the next session that takes it)"); return 3; }
      const u = (read(`${c}/unit`) ?? "").replace(/\n+$/, "");
      if (want && u !== want) { console.log(`the session here works ${u} now, not ${want}: nothing told`); return 3; }
      try { put(c, "the overseer", a.join(" ")); } catch (e) {
        console.error(e instanceof NoInbox ? e.message : `inbox: ${(e as Error).message}`);
        return 2;
      }
      const tag = (read(`${c}/tag`) ?? "").replace(/\n+$/, "");
      // The session may have ended between the look and the put: then nothing reads it.
      if (resolve("runs/inbox/current") !== c) {
        console.log(`session ${tag} on ${u} ended just as the message was queued: it may not be read (a note on the unit reaches the next session)`);
        return 3;
      }
      console.log(`told session ${tag} on ${u}: it reads it after its next tool call`);
      return 0;
    }
    case "state": report(); return 0;
    case "stop": {
      // The loop's exit releases only leases whose last finished unit is on the store.
      mkRuns();
      if (active()) touch("runs/.stop-now");
      // Stopped on purpose: the daemon doesn't bring it back after the machine goes down.
      dropRecord(UNIT, env);
      platform.stopJobs(UNIT);
      platform.stopCapped(sessions);
      platform.stopJobs(longs);
      report();
      return 0;
    }
    case "tidy": {
      if (active()) { console.log(`${UNIT} is running; stop it first`); return 2; }
      const left = [...platform.knownCapped(sessions), ...platform.knownJobs(longs)];
      if (left.length) { platform.stop(...left); console.log(`stopped: ${left.join(" ")}`); }
      else console.log(`nothing left running from ${UNIT}`);
      return 0;
    }
    default:
      console.error(`oversee: unknown command ${cmd} (start | wait | pause | restart | last-call | stop-at | tell | state | stop | tidy)`);
      return 2;
  }
}

// What `fleet wait` asks of this machine: the daemon answers it; without one (it couldn't be
// started) it's answered here, the same way.
type Req = { op: "look"; lanes: LaneAsk[]; machine?: MachineAsk } | { op: "watch"; lanes: LaneAsk[]; seen: LaneSeen[]; until: number; machine?: MachineAsk };
export type Answer = { lanes: LaneSeen[]; machine?: MachineSeen };
export async function answer(req: Req, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<Answer> {
  for (let i = 0; i < 2 && !signal?.aborted; i++) {
    const r = await ask(req, env, signal) as Answer | null;
    if (r?.lanes) return r;
    // Not running, or restarted mid-answer (a deploy): start it, and ask again.
    if (!signal?.aborted && !(await ensureDaemon(env)).ok) break;
  }
  if (req.op === "look") return { lanes: look(req.lanes, env), ...(req.machine ? { machine: lookMachine(req.machine) } : {}) };
  return watch(req, 1, signal, env);
}

// How the lane's loop was last started, from the header \`start\` writes in runs/loop.log: when,
// its options, and its --hours (loop.sh's default, 8, without one). null if there's none.
function lastStart(loop: string): { at: number; args: string[]; hours: number } | null {
  const t = tail(LOG, 2000) ?? [];
  for (let i = t.length - 1; i >= 0; i--) {
    const m = /^==== (\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) start ?(.*)$/.exec(t[i]);
    if (!m) continue;
    const at = Math.floor(new Date(`${m[1]}T${m[2]}`).getTime() / 1000);
    let args = m[3].split(" ").filter(Boolean);
    if (loop && args[0] === loop) args = args.slice(1);
    const h = args.indexOf("--hours");
    const hours = h >= 0 && Number(args[h + 1]) > 0 ? Number(args[h + 1]) : 8;
    return Number.isFinite(at) ? { at, args, hours } : null;
  }
  return null;
}

const isDir = (d: string) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } };
