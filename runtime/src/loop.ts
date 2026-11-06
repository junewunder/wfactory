// The loop: run the factory unattended, one fresh headless session per unit (factory/loop.sh,
// `loop.sh --help`). This is the run, from start to its exit steps; its parts are its own modules:
// how it starts (loop-start.ts), its clock (loop-clock.ts), what it takes next (loop-claim.ts), a
// unit's session (loop-unit.ts), the review before a branch lands (review.ts), group CI (loop-ci.ts), out-of-memory kills (loop-oom.ts), its
// locks (loop-locks.ts), its heartbeat (loop-beat.ts), the ci.affected hook (loop-affected.ts) and restarting on a newer copy (loop-restart.ts). Branches and landing are
// landing.ts's; one session is session.ts's; the tracker runs in this process (tr.ts).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess, type StdioOptions } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { event as ev } from "./events.ts";
import { Landing, g, git, type LaneCtx } from "./landing.ts";
import { log, type Running } from "./session.ts";
import { enterRoot, epoch, host, pwd, status, tryLock, unlock } from "./sys.ts";
import { memoryTurn, type MemTurn } from "./heavy.ts";
import { measured } from "./capped.ts";
import { platform } from "./os.ts";
import { dropRecord } from "./daemon.ts";
import { tr, trOut, trWait } from "./tr.ts";
import { readUsage, usageCheck } from "./usage.ts";
import { HELP } from "./loop-help.ts";
import { Clock } from "./loop-clock.ts";
import { look, type Waiting } from "./loop-claim.ts";
import { ciUnclaim, ciUnrun } from "./loop-ci.ts";
import { Locks } from "./loop-locks.ts";
import { beat, startBeat } from "./loop-beat.ts";
import { adoptHolders, endHolder, linkSkill, restart, restarted, restartedRunning, type Restarted } from "./loop-restart.ts";
import { configure, dryRun, options, runClock, sessionPrompt, takeCheckout, type Config, type Opts } from "./loop-start.ts";
import { sessionAdd, sessionBase, workUnit } from "./loop-unit.ts";
import { affectedLines, ciAffected } from "./loop-affected.ts";
import { runReview } from "./review.ts";
import { exe, exists, hmAt, isInt, killTree, probeCmd, rm } from "./loop-util.ts";

export { HELP };
const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));   // the skill's runtime/, as deployed
// A turn of the event loop's check phase. Two in a row have a poll phase between them, where a
// signal that came is read. (Not a timer: the tests that mock the clock would never fire it.)
const immediate = () => new Promise<void>((r) => setImmediate(r));

export async function loopCli(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (args.includes("-h") || args.includes("--help")) { console.log(HELP); return 0; }
  // A restarted runner checks that this copy loads at all, before it's started in place of one.
  if (args[0] === "--check") return 0;
  if (args[0] === "beat") return beat(Number(args[1]));
  if (!enterRoot("loop.sh", env)) return 1;
  const o = options(args, env);
  if (typeof o === "number") return o;
  const l = new Loop(args, o, env);
  try { return await l.main(); } catch (e) {
    process.stderr.write(`${(e as Error)?.stack ?? e}\n`);
    return l.early(1);
  }
}

export class Loop {
  readonly args: string[]; readonly o: Opts; readonly env: NodeJS.ProcessEnv;
  readonly here = HERE;
  readonly host: string; readonly lane: string; readonly checkout: string;
  // A restart brings the run it carries on, and what holds the locks the loop it replaced held.
  readonly rs: Restarted | null;
  private readonly carried: number;   // the sessions FACTORY_RESTARTED says the run had
  cfg!: Config;
  prompt = "";                        // factory/prompt.md, as every session gets it
  clock = new Clock();
  land!: Landing;
  locks = new Locks();                // its unit's and resources' locks, and CI's
  loopFd: number | null = null;       // runs/.loop.lock
  laneFd: number | null = null;       // the lane lock, which the last lane looks for
  loopHolder: number | null = null; laneHolder: number | null = null;
  awakePid = 0;
  beatPid = 0;
  running: Running | null = null;     // the session, while it runs
  fg: ChildProcess | null = null;     // a check, a copy, a CI step, while it runs
  started = false;                    // past its checks and running
  stopping = false;
  turns = new Set<MemTurn>();         // its turns in the machine's memory budget, while it holds them
  signalled = false;
  whyStop = "";
  i = 0;                              // sessions so far
  idle = 0;                           // sessions in a row that recorded nothing
  waiting: Waiting = { since: 0, why: "", told: false };
  gaveBack = new Set<string>();       // units this lane's sessions gave back unstarted: not taken again this run
  mergeTold = "";                     // what the log last said about this lane's merge that can't move
  // Units held back as too long for the time before last call (loop-claim.ts): how many at the
  // last look, and what the log last said of them ("" once the morning summary has it).
  lcHeld = { n: 0, why: "" };
  tag = ""; uuid = "";                // this look's: its session's, or its CI run's
  ciNow: { group: string; step: string } | null = null;   // the CI run in progress
  ciBackoff = 0;                      // no CI claimed before this (one given back for want of memory)

  constructor(args: string[], o: Opts, env: NodeJS.ProcessEnv) {
    this.args = args; this.o = o; this.env = env;
    this.host = host(env);
    this.checkout = path.basename(pwd(env));
    this.lane = /-lane([0-9]*)$/.exec(this.checkout)?.[1] || "1";
    const r = restarted(env);
    this.rs = r?.id ? r : null; this.carried = r?.i ?? 0;
    // How `pgrep -f` and `ps` see the lane: as the script it was, with its options.
    try { process.title = `${HERE}/loop.sh ${args.join(" ")}`.trimEnd(); } catch {}
  }

  // No room for a new lease's data: every lane on this machine takes only units needing none until then.
  get noroom() { return `${process.env.FACTORY_LOCKS}/noroom-until`; }

  // For the overseer: one line per thing the owner may need to hear about.
  event(kind: string, msg: string, unit?: string) { ev(kind, msg, this.env, unit); }

  // A restarted copy that exits before it's running (a broken deploy, the tracker's data broken)
  // says so; the full exit steps replace this once it is. Its leases go stale in 30 minutes.
  early(code: number) {
    if (this.rs && !this.started) {
      log("stopping: the restarted loop stopped before it was running (above)");
      this.event("lane-stop", "the restarted loop stopped before it was running: a stop, or the new runner failing as it started (runs/loop.log); its leases go stale in 30 minutes");
    }
    return code;
  }
  // After a signal: the loop goes no further than where it is (this never resolves then).
  halt = (): Promise<void> => this.stopping ? new Promise<void>(() => {}) : Promise.resolve();
  // A signal that has come but isn't handled yet is handled here (it waits for the event loop,
  // and the loop's own work after a session can run to its exit without one: #74). Before the loop
  // decides a session failed, and before it decides it stopped by itself.
  async heedSignals() { await immediate(); await immediate(); }
  async pause(secs: number) { if (secs > 0) await sleep(secs * 1000); await this.halt(); }
  stop(why: string) { this.whyStop = why; log(why); }
  // One of the loop's own heavy commands (the landing check, the tracker's probes), run in a turn in
  // the machine's memory budget (heavy.ts, memoryTurn). A stop gives the turn back (stopChildren);
  // one that came while it waited starts nothing.
  async memory<T>(what: string, cmds: string[], run: (held: Record<string, string>) => Promise<T>): Promise<T> {
    const t = await memoryTurn(what, cmds);
    if (t) this.turns.add(t);
    try {
      if (this.stopping) { t?.give(); await this.halt(); }
      return await run(t?.env ?? {});
    } finally { t?.give(); if (t) this.turns.delete(t); }
  }

  // `tracker settle <unit>`: its probe (settle runs a computed unit's) waits for memory in the
  // machine's budget, as one of the loop's heavy commands (#117), and a busy lock is waited out
  // (#109). The probe gets the session's display, not the owner's (sessionAdd, #130). What the
  // tracker said.
  settle(unit: string, title: string, add: Record<string, string>) {
    return this.memory(`${title}'s check (${unit})`, probeCmd(this.cfg.tdir, unit), async (held) => trWait(["settle", unit], log, { ...sessionAdd(this.cfg.tdir, this.lane), ...add, ...held }));
  }

  // A long command (a check, a copy, probes) run so a signal to the loop stops it at once.
  // (free: one of the exit steps, which run once it's stopping.)
  // (err: stderr somewhere else than stdout.)
  async stoppable(cmd: string[], o: { out?: "inherit" | "ignore" | number; err?: "inherit" | "ignore" | number; input?: string; env?: NodeJS.ProcessEnv; free?: boolean } = {}): Promise<number> {
    const out = o.out ?? "inherit";
    const stdio: StdioOptions = [o.input !== undefined ? "pipe" : "inherit", out, o.err ?? out];
    const rc = await new Promise<number>((resolve) => {
      let c: ChildProcess;
      const start = (argv: string[]) => {
        try { c = spawn(argv[0], argv.slice(1), { stdio, env: o.env ?? process.env }); } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ENOEXEC" && argv === cmd) return start(["bash", ...cmd]);
          process.stderr.write(`${argv[0]}: ${(e as Error).message}\n`); resolve(126); return;
        }
        this.fg = c;
        c.on("error", (e: NodeJS.ErrnoException) => { process.stderr.write(`${argv[0]}: ${e.code === "ENOENT" ? "command not found" : e.message}\n`); resolve(e.code === "ENOENT" ? 127 : 126); });
        c.on("exit", (code, signal) => resolve(status({ code, signal })));
        if (o.input !== undefined) { c.stdin?.on("error", () => {}); c.stdin?.end(o.input); }
      };
      start(cmd);
    });
    this.fg = null;
    if (!o.free) await this.halt();
    return rc;
  }
  // A command run to its end, its output where the loop's goes (stderr for stdout too, with toErr).
  quick(cmd: string[], o: { toErr?: boolean; quiet?: boolean; env?: NodeJS.ProcessEnv } = {}) {
    const out = o.quiet ? "ignore" : o.toErr ? 2 : "inherit";
    return spawnSync(cmd[0], cmd.slice(1), { stdio: ["inherit", out, o.quiet ? "ignore" : "inherit"], env: o.env ?? process.env }).status ?? 1;
  }

  // Sleep up to <secs> seconds, waking early for a pause or the deadline: false if it should stop.
  // With restart, a lane waiting for work restarts at once (not one waiting out a usage limit or a CI retry).
  async nap(secs: number, restart = false): Promise<boolean> {
    const end = epoch() + secs;
    for (let left = end - epoch(); left > 0; left = end - epoch()) {
      if (exists("runs/.pause")) return false;
      if (restart && exists("runs/.restart")) return false;
      this.clock.refresh();
      if (epoch() >= this.clock.deadline) return false;
      await this.pause(Math.min(left, 1));
    }
    return true;
  }

  // Main itself is red (Landing.red): no new units, since none could land. True if the loop stops.
  // Not in last call, which runs to its end: its CI runs, and it takes no new units then (look).
  mainRed(): boolean {
    if (!this.land?.red || this.clock.inLc) return false;
    this.stop(`main is red: ${this.land.red}. This lane takes no new units; its work is pushed, and the lanes start again once main passes`);
    return true;
  }
  // stuckEvent <unit> <title>: a `stuck` event with the tracker's reason.
  stuckEvent(u: string, t: string) {
    const why = trWait(["status", u.split("/")[0]], log).out.split("\n").filter((x) => x.startsWith("  - ")).map((x) => x.slice(4)).find((x) => x.includes(`(${u}): `));
    this.event("stuck", why || `${t} (${u}): stuck`);
  }
  // Without an origin the loop commits tracker/ in this checkout (git allows one writer at a time;
  // a session may be mid-commit). With one, the CLI pushed it.
  async commitTracker(msg: string) {
    if (this.cfg.branches) return;
    for (let n = 1; n <= 6; n++) {
      if (!(git("status", "--porcelain", "--", "tracker/") ?? "")) return;
      if (g("add", "--", "tracker/") && g("commit", "-q", "-m", msg, "--", "tracker/")) return;
      await this.pause(n * 2);
    }
    log("couldn't commit tracker/");
  }
  // No room in this machine's cache: units needing a new lease wait (FACTORY_NOROOM_WAIT seconds).
  noRoom() {
    const f = this.noroom, tmp = `${f}.${process.pid}`;
    fs.writeFileSync(tmp, `${epoch() + Number(process.env.FACTORY_NOROOM_WAIT || 1800)}\n`); fs.renameSync(tmp, f);
  }
  // Releasing a lease takes the claim lock and a fresh look at main, so no lane here is claiming meanwhile.
  releaseIdle() {
    if (!this.cfg.store) return;
    const fd = this.locks.claimLock();
    this.quick(["factory/store.sh", "release-idle"], { toErr: true, env: { ...process.env, FACTORY_FETCH_EVERY: "0" } });
    unlock(fd);
  }
  stopBeat() { if (this.beatPid) { try { process.kill(this.beatPid, "SIGTERM"); } catch {} this.beatPid = 0; } }
  startAwake() { if (this.o.awake && platform.canStayAwake()) this.awakePid = platform.stayAwake(`factory loop: ${this.checkout} ${this.o.loop}`); }
  stopAwake() { if (this.awakePid) { try { process.kill(this.awakePid, "SIGTERM"); } catch {} this.awakePid = 0; } }

  laneCtx(): LaneCtx {
    return {
      MAIN: this.cfg.main, HOST: this.host, LANE: this.lane, TDIR: this.cfg.tdir,
      log, event: (k, m) => this.event(k, m), halt: this.halt,
      // A busy lock (another command held it past the tracker's wait) is waited out, never taken
      // for an answer: a merge unit read as gone, a merge unit not filed (#109).
      tr: (a, add) => trWait(a, log, add, () => this.stopping),
      review: (r) => runReview(this, r),
      landCheck: async (cmd, minutes, logf, add) => {
        const fd = fs.openSync(logf, "w");
        try { return await this.stoppable(["timeout", String(Math.round(minutes * 60)), "bash", "-c", cmd], { out: fd, env: { ...sessionBase(this.cfg.tdir, this.lane), ...add } }); } finally { fs.closeSync(fd); }
      },
      affected: () => this.affected(),
      affectedBy: (old, nw) => this.affectedBy(old, nw),
      check: async (logf, busy) => {
        const fd = fs.openSync(logf, "w");
        try {
          // A heavy command: it waits for memory in the machine's budget (heavy.ts), and its peak
          // is recorded for the next one's reservation (capped.ts, measured).
          return await this.memory(`the landing check (${this.checkout})`, ["just check"], async (held) =>
            (await measured("just check", ["timeout", process.env.FACTORY_CHECK_TIMEOUT || "1800", "just", "check"], { ...sessionBase(this.cfg.tdir, this.lane), FACTORY_BUSY_GROUPS: busy, ...held },
              // (Named as a session's scope is, so \`oversee.sh stop\` ends what it left running.)
              this.cfg.cap ? `${this.cfg.scope}-${crypto.randomBytes(4).toString("hex")}` : "", (argv, env) => this.stoppable(argv, { out: fd, env }))) === 0);
        } finally { fs.closeSync(fd); }
      },
    };
  }

  // The ci.affected hook, if main's code has moved past what it covered (loop-affected.ts). It's
  // the project's own code, so it gets the session's environment, not the owner's display (#174).
  affected() {
    return ciAffected({
      ref: this.cfg.branches ? `origin/${this.cfg.main}` : this.cfg.main, locks: process.env.FACTORY_LOCKS,
      tr: (a, add) => tr(a, add), log, event: (k, m) => this.event(k, m),
      run: (cmd, secs, out, err) => this.stoppable(["timeout", String(secs), "bash", "-c", cmd], { out, err, input: "", env: sessionBase(this.cfg.tdir, this.lane) }),
    });
  }

  // The ci.affected hook over old..nw, for a branch's review: its lines, or "" with no hook, or
  // when it fails (the review goes on without them).
  async affectedBy(old: string, nw: string): Promise<string> {
    return affectedLines((a) => tr(a), (cmd, secs, out, err) => this.stoppable(["timeout", String(secs), "bash", "-c", cmd], { out, err, input: "", env: sessionBase(this.cfg.tdir, this.lane) }), old, nw, log);
  }

  // ---------------------------------------------------------------- the run

  async main(): Promise<number> {
    const o = this.o, env = this.env, rs = this.rs;
    // The stop time counts from here, not from after the checks below (a busy tracker lock they
    // wait out would move it, last call with it).
    const t0 = epoch();
    process.env = env;
    if (rs) adoptHolders(this, rs);
    const cfg = configure(o, env, this.host, this.lane, this.checkout);
    if (typeof cfg === "number") return this.early(cfg);
    this.cfg = cfg;
    if (o.dry) return dryRun(cfg, o);
    const taken = takeCheckout(cfg, this.checkout, rs);
    if (typeof taken === "number") return this.early(taken);
    this.loopFd = taken.loopFd;

    // Sessions' `just` reads the recipes of the copy this loop runs, not whatever is deployed later.
    linkSkill(env.FACTORY_SKILL ?? "");
    this.prompt = sessionPrompt(HERE, cfg.spec, o.loop);

    // ---- stay awake while looping
    // A logind inhibitor (sleep, idle, and the lid switch) held while the loop runs: the holder
    // watches this loop and lets go when it ends, even if it's killed. Where logind refuses one
    // (polkit), the loop runs anyway, and the machine's own power settings apply.
    this.startAwake();

    if (!exists("runs/index.tsv")) fs.writeFileSync("runs/index.tsv", "started\ttag\tloop\tunit\tresult\tturns\tcost_usd\tminutes\n");
    // A restart carries on the run it restarted: its start, stop time and sessions so far.
    this.clock = runClock(o, env, rs, t0);
    this.land = new Landing(this.laneCtx());

    // The lane lock. A restart keeps the one the loop it replaced held (its holder), so no other
    // lane sees this one gone.
    if (!this.laneHolder) this.laneFd = tryLock(`${env.FACTORY_LOCKS}/lane-${this.checkout}.lock`);
    this.beatPid = startBeat(HERE);

    this.i = this.carried;
    // Main is checked again at a start: it may have been fixed outside its code (a tool, a service),
    // and the lane would otherwise stop on what it knew failed before.
    if (!rs) rm("runs/.main-broken");
    // The first lane to start here starts afresh (space may have been freed while the lanes were stopped).
    if (!rs && Locks.lastLane(this.checkout)) rm(this.noroom);

    this.started = true;
    // Noted first, even once it's stopping (its session died of the same signal, say, and the loop
    // went on to stop for that): finish() reads it, so the lane keeps its record (#74).
    const onSignal = () => { this.signalled = true; if (this.stopping) return; this.whyStop ||= "stopped (signal)"; void this.finish(143); };
    process.on("SIGTERM", onSignal);
    process.on("SIGINT", onSignal);
    if (rs) restartedRunning(this, rs);

    let code = 0;
    try {
      if (cfg.branches) await this.land.pending();
      // As each lane starts, what the copies here owe is settled and sets aside get their units, so a
      // machine whose lanes only run briefly (or never wait idle) still sorts its sets.
      this.releaseIdle();
      code = await this.iterations();
    } catch (e) {
      process.stderr.write(`${(e as Error)?.stack ?? e}\n`);
      code = 1;
    }
    if (code === 0) {
      if (this.i >= o.max && !this.whyStop) this.stop(`ran its --max ${o.max} sessions`);
      const r = tr(["status"]);   // $LOOP is set: this loop only
      process.stderr.write(r.out + r.err);
    }
    return this.finish(code);
  }

  // The loop's iterations; 0 once it stops as it should, 2 on a tracker error.
  async iterations(): Promise<number> {
    const o = this.o, env = process.env, k = this.clock;
    while (this.i < o.max) {
      k.refresh();
      if (epoch() >= k.deadline) { this.stop(`out of time (${k.stopAt ? `the stop time, ${k.stopAt}, not ` : ""}--hours ${o.hours})${ciUnrun(k.inLc)}`); break; }
      if (exists("runs/.pause")) { rm("runs/.pause", "runs/.pause-now"); this.stop("paused at a good point (just pause)"); break; }
      // Not while main is red outside last call: the lane stops below anyway, and a restarted one
      // would start with red unknown and take units until a landing failed again (#118). Its next
      // start is on the newest copy anyway.
      if (exists("runs/.restart") && !(this.land?.red && !k.inLc)) restart(this);
      // Last call: no new units of groups whose CI runs here; CI runs for every group whose CI is
      // stale. The time goes to the machine's last-call file, for its daemon (loop-clock.ts).
      if (!k.inLc && k.lastCall > 0) k.publish();
      if (!k.inLc && k.inLastCall()) {
        k.inLc = true; env.FACTORY_LAST_CALL = "1";
        this.heldBack();
        log(`last call${exists("runs/.last-call") ? " (just fleet last-call)" : `, stopping at ${hmAt(k.deadline)}`}: no new units${exists("runs/.last-call") ? "" : " that would make CI here run again"}; work in flight lands, then CI runs for every group whose CI is stale`);
      }
      if (this.mainRed()) break;

      // ---- usage: pause between units near the 5-hour limit
      const root = env.FACTORY_ROOT!, lm = [...root.matchAll(/-lane[0-9]/g)].pop();
      const uc = usageCheck(readUsage(lm ? root.slice(0, lm.index) : root), env);
      const slack = Number(env.FACTORY_USAGE_SLACK || 60);
      if (uc.code === 4 && isInt(uc.out)) {
        const at = hmAt(Number(uc.out));
        log(`usage pause: under ${env.FACTORY_USAGE_PAUSE_LEFT || 8}% of the 5-hour window left; resuming at ${at}`);
        this.event("usage-pause", `under ${env.FACTORY_USAGE_PAUSE_LEFT || 8}% of the 5-hour window left; lanes resume at ${at}`);
        if (!(await this.nap(Number(uc.out) - epoch() + slack))) continue;
        log("usage resume: the 5-hour window reset"); this.event("usage-resume", `the 5-hour window reset at ${at}`);
        continue;
      }

      const next = await look(this);
      if (next.kind === "again") continue;
      if (next.kind === "stop") break;
      if (next.kind === "error") return 2;
      if ((await workUnit(this, next.unit)) === "stop") break;
    }
    return 0;
  }

  // What was held back before last call as too long for the time left, for the morning summary:
  // once a run, as last call begins (or the lane stops before it).
  heldBack() {
    if (this.lcHeld.why) this.event("held-back", `lane ${this.lane} on ${this.host}: ${this.lcHeld.why}`);
    this.lcHeld.why = "";
  }

  // ---------------------------------------------------------------- stopping

  async tidy() {
    // Two lanes stopping together each see the other gone; tidying twice is harmless.
    if (this.laneFd !== null) { unlock(this.laneFd); this.laneFd = null; }
    endHolder(this.laneHolder); this.laneHolder = null;
    const now = exists("runs/.stop-now"); rm("runs/.stop-now");
    if (!Locks.lastLane(this.checkout)) return;
    let failed = "";
    // Leases don't outlive the lanes: copy back and release ("stop now": release only what's already safe).
    if (this.cfg.store) {
      const rc = await this.stoppable(now ? ["timeout", "120", "factory/store.sh", "leave", "--now"] : ["timeout", "1800", "factory/store.sh", "leave"], { out: 2, free: true });
      if (rc !== 0) { log("store: leave failed"); failed = "copying back and releasing its leases"; }
    }
    // factory/tidy keeps the loop's environment, the owner's display with it (#174): it's the
    // owner's own clean-up, and may need their desktop (to stop an editor, or a headless desktop
    // through systemctl --user), unlike what the loop runs of the project's own (sessionBase).
    if (exe("factory/tidy")) {
      log(`the last lane on ${this.host}: tidying up (factory/tidy)`);
      if ((await this.stoppable(["timeout", "300", "factory/tidy"], { out: 2, free: true })) !== 0) { log("factory/tidy failed"); failed = `${failed ? `${failed}, ` : ""}factory/tidy`; }
    }
    // On main before the machine may sleep (awake done, after this): the overseer reads it in
    // `just log` and needn't reach a machine that's asleep.
    const r = spawnSync("timeout", ["120", "factory/tracker", "lanes-stopped", ...(failed ? ["--failed", failed] : [])], { encoding: "utf8", env: { ...process.env, FACTORY_ACTOR: "loop" }, stdio: ["ignore", "pipe", "pipe"] });
    if (r.status !== 0) log("tracker: couldn't record that the lanes stopped");
    else if (`${r.stdout}${r.stderr}`.includes("not pushed yet")) log("tracker: the record that the lanes stopped isn't on main yet (offline)");
  }

  // A signal (not only `fleet stop`) ends the running session, check or copy and long jobs too.
  stopChildren() {
    const s = this.running;
    if (s) { if (s.scope) platform.stopCapped(s.scope); if (s.child.pid) killTree(s.child.pid); }
    if (this.fg?.pid) killTree(this.fg.pid);
    if (s) spawnSync("factory/long.sh", ["stop-all", "--tag", this.tag], { stdio: "ignore" });
    for (const t of this.turns) t.give();
  }
  // The exit steps, for any stop once the loop runs: a last call ends with the lane stopping at its
  // end; after a crash or a --max, a restart carries on with it. Its first line tells `fleet beat`
  // the lane is stopping (copying back, tidying), not busy.
  async exitSteps() {
    log("stopping: its exit steps (copying back, tidying)");
    if (/^(last call is over|out of time|paused)/.test(this.whyStop)) rm("runs/.last-call");
    this.heldBack();
    this.event("lane-stop", this.whyStop || "the loop exited");
    this.stopChildren();
    // A CI run cut off by the stop: on record as cut off, for the morning summary and the view.
    if (this.ciNow) { const c = this.ciNow; this.ciNow = null; ciUnclaim(this, c.group, ["--cut", `the lane was stopped (${this.whyStop || "the loop exited"})`, "--step", c.step]); }
    rm("runs/inbox/current");
    await this.tidy();
    // The heartbeat stops after tidy: copying back as the lanes stop can take a while, and the
    // lease must stay fresh meanwhile.
    this.stopBeat();
    this.stopAwake();
    endHolder(this.loopHolder);
  }
  async finish(code: number): Promise<never> {
    this.stopping = true;
    try { await this.exitSteps(); } catch (e) { process.stderr.write(`${(e as Error)?.stack ?? e}\n`); }
    // A signal that came as a failed session stopped the lane (the session died of it first): the
    // lane keeps its record. A stop the lane chose (a pause, a red main, nothing left) stands.
    if (!this.signalled) {
      await this.heedSignals();
      if (this.signalled && !/^session .* failed/.test(this.whyStop)) this.signalled = false;
      else if (this.signalled) log("a signal came as the lane stopped: stopped (signal), its record kept");
    }
    // The machine's daemon brings a lane back if the machine's going down cut it off (a logout or
    // a shutdown stops it with a signal). One that stopped by itself is done: its record goes.
    // (`oversee.sh stop` drops the record before it signals.)
    if (!this.signalled && this.cfg.scope) { try { dropRecord(this.cfg.scope, this.env); } catch {} }
    process.exit(code);
  }
}
