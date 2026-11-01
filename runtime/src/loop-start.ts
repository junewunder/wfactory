// How the loop starts: its options, the checks before an unattended run, what every session of
// the run gets, and taking the checkout for itself.
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { g, git } from "./landing.ts";
import { machineGet } from "./machines.ts";
import { profileFile, profileGet, profileUnfilled } from "./profile.ts";
import { linkedDirs, log } from "./session.ts";
import { epoch, tryLock } from "./sys.ts";
import { platform } from "./os.ts";
import { openingOpen, tr, trOut, trWait, type TrOut } from "./tr.ts";
import { Clock, SAME_STOP_S } from "./loop-clock.ts";
import { cat, exists, isInt, json, read, rm, which } from "./loop-util.ts";
import type { Restarted } from "./loop-restart.ts";

// ---------------------------------------------------------------- the options

export interface Opts {
  max: number; hours: string; model: string; effort: string; mem: string; limitWait: string;
  idleWait: string; wait: boolean; awake: boolean; dry: boolean; loop: string; lastCall: string;
}
export function options(args: string[], env: NodeJS.ProcessEnv): Opts | number {
  const o: Opts = { max: 50, hours: "8", model: env.FACTORY_MODEL || "", effort: env.FACTORY_EFFORT || "", mem: env.FACTORY_MEM || "10G",
    limitWait: "30", idleWait: env.FACTORY_IDLE_WAIT || "4", wait: true, awake: true, dry: false, loop: "", lastCall: "" };
  for (let k = 0; k < args.length; k++) {
    const a = args[k], v = () => args[++k] ?? "";
    switch (a) {
      case "--max": o.max = Number(v()) || 0; break;
      case "--hours": o.hours = v(); break;
      case "--model": o.model = v(); break;
      case "--effort": o.effort = v(); break;
      case "--mem": o.mem = v(); break;
      case "--limit-wait": o.limitWait = v(); break;
      case "--idle-wait": o.idleWait = v(); break;
      case "--last-call": o.lastCall = v(); break;
      case "--no-wait": o.wait = false; break;
      case "--no-awake": o.awake = false; break;
      case "--dry-run": o.dry = true; break;
      default:
        if (a.startsWith("-")) { console.error(`loop: unknown option ${a}`); return 2; }
        if (o.loop) { console.error(`loop: unexpected arg ${a}`); return 2; }
        o.loop = a;
    }
  }
  return o;
}

// tracker/project.json's whole-number setting, else its default.
export function setting(k: string, dflt: number): number {
  const p = json(read("tracker/project.json"));
  const v = p?.[k];
  const s = v === undefined || v === null || v === false ? String(dflt) : String(v);
  return isInt(s) ? Number(s) : dflt;
}

// ---------------------------------------------------------------- what the run is

// The CLI tools a lane session gets: subagents (Task) and their messages, the web, and ToolSearch
// for the ones the CLI loads on demand.
export const SESSION_TOOLS = ["Bash", "Read", "Edit", "Write", "Grep", "Glob", "Task", "SendMessage", "TaskStop", "WebFetch", "WebSearch", "ToolSearch"];

// What the loop settles before its first unit, fixed for the run.
export interface Config {
  spec: string;         // the loop's spec (docs/factory.md, or the named loop's)
  store: boolean;       // groups' data on a store: claims take leases, and the loop copies
  branches: boolean;    // an origin: units on branches, the state on origin's main
  main: string;         // the main branch
  tdir: string;         // the tracker's state: origin's main (.tracker/main) when there's an origin
  agent: string;        // the agent CLI
  args: string[];       // its arguments for every session
  scope: string;        // what each session's scope is named after: factory-<checkout>[-<loop>]
  cap: boolean;         // sessions run memory-capped
}

// Which loop, the checks before any unattended run, and what the run is: a Config, or the
// exit code it refuses with. What sessions and the tracker need goes into env as it goes.
export function configure(o: Opts, env: NodeJS.ProcessEnv, host: string, lane: string, checkout: string): Config | number {
  const say = (r: TrOut) => { process.stdout.write(r.out); process.stderr.write(r.err); };
  // ---- which loop: its spec
  let spec = "docs/factory.md";
  const proj = json(read("tracker/project.json"));
  const loops = proj?.loops && typeof proj.loops === "object" ? proj.loops as Record<string, unknown> : {};
  if (Object.keys(loops).length > 0) {
    if (!o.loop) { log(`name a loop: ${Object.keys(loops).sort().join(" ")}`); return 2; }
    const r = trWait(["where", o.loop], log);
    if (r.code !== 0) { process.stderr.write(r.err); return 2; }
    spec = r.out.replace(/\n+$/, "");
  }
  env.LOOP = o.loop;

  // ---- preflight: no unattended runs until the factory is actually defined
  if (!exists("tracker/project.json")) { log("no tracker/ here; see the wfactory skill"); return 2; }
  // A busy tracker lock (exit 75) is waited out here, never taken for broken data.
  { const why = openingOpen((a) => trWait(a, log)); if (why) { log(why); return 2; } }
  for (const f of [spec, "docs/machines.md"]) {
    if (/<fill[:>]/.test(read(f) ?? "")) { log(`${f} still has <fill: …> placeholders. Fill it in first (the wfactory skill's design questions).`); return 2; }
  }
  const check = spawnSync("just", ["--show", "check"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  if (check.status !== 0 || (check.stdout ?? "").includes("TODO: wire the oracle")) { log("`just check` is missing or still the placeholder. Wire the oracle before looping."); return 2; }
  // Only broken data stops a loop; a slip in someone's note is a warning.
  { const r = trWait(["lint", "--broken"], log); if (r.code !== 0) { log("the tracker's data is broken; fix that first"); say(r); return 2; } }
  // The owner's profile: no unattended run while it has placeholders (a machine without one
  // runs on the defaults).
  if (profileUnfilled(env).length) { log(`the profile (${profileFile(env)}) still has <fill: …> placeholders. Fill it in first (install.md).`); return 2; }
  const agent = profileGet("agent", "claude", env);
  if (!which(agent)) { log(`the agent CLI (${agent}, the profile's \`agent\`) not found`); return 2; }

  // This machine's row in docs/machines.md: does it take any unit, or only units pinned to it?
  if (machineGet(host, "takes") === "pinned") env.FACTORY_HOST_ONLY = "1";
  // …and what it can do: a unit with caps goes only to a machine that has them all.
  const can = machineGet(host, "can") ?? "";
  env.FACTORY_CAPS = ["-", "—", "none", ""].includes(can) ? "" : can;
  // Groups' data on the store: claims take leases, and the loop copies. Only the loop's own
  // claims may take leases (not a session's: it can't copy data).
  const store = !!proj?.store;
  const project = typeof proj?.name === "string" && proj.name ? proj.name : checkout;
  env.FACTORY_LOCKS ||= `${env.XDG_RUNTIME_DIR || "/tmp"}/factory-${project}`;
  fs.mkdirSync(env.FACTORY_LOCKS, { recursive: true });
  const main = env.FACTORY_MAIN || "main";
  let branches = false;
  if (git("remote", "get-url", "origin") !== null && env.FACTORY_STATE !== "local") {
    branches = true; env.FACTORY_BRANCHES = "1"; env.FACTORY_LANE = `${host}/${lane}`;
  }
  const tdir = trOut(["dir"]);

  // Grep and Glob: a session that doesn't take the CLI's own search tools gets `grep` and `find`
  // in its Bash replaced by the CLI's ugrep and bfs, which take other flags.
  // The tools a session takes (--tools): the rest of the CLI's, and the owner's skills (the Skill
  // tool), are ~12k tokens in every turn that lanes almost never use (18-19 Oct: 2
  // skill calls in 300 sessions). tracker/project.json's "session_tools" adds more, e.g. ["Skill"].
  const extra = Array.isArray(proj?.session_tools) ? proj.session_tools.filter((t): t is string => typeof t === "string" && /^\w+$/.test(t)) : [];
  const tools = [...new Set([...SESSION_TOOLS, ...extra])].join(",");
  const args = ["-p", "--permission-mode", "auto", "--output-format", "stream-json", "--verbose", "--tools", tools, "--allowedTools", "Bash(just long:*)", "Bash(factory/long.sh:*)", "Grep", "Glob"];
  if (o.effort) args.push("--effort", o.effort);
  // Each session's scope is named factory-<checkout>[-<loop>]-<tag>, so `oversee.sh stop` can find it.
  const scope = `factory-${checkout}${o.loop ? `-${o.loop}` : ""}`;
  const cap = env.FACTORY_NOCAP !== "1" && platform.canCap();
  if (!cap) log("sessions run without a memory cap");
  return { spec, store, branches, main, tdir, agent, args, scope, cap };
}

// --dry-run: what would run next, and the session's command line.
export function dryRun(c: Config, o: Opts) {
  const a = tr(["ci-next"]); process.stdout.write(a.out);
  const n = tr(["next"]); process.stdout.write(n.out); process.stderr.write(n.err);
  const run = c.cap ? platform.cappedCmd(`${c.scope}-<tag>`, o.mem, []) : ["--unit", `${c.scope}-<tag>`, "--"];
  console.log(`${run.join(" ")} ${c.agent} ${c.args.join(" ")} ${linkedDirs(".").map((d) => `--add-dir ${d} `).join("")}${o.model ? `--model ${o.model} ` : ""}--settings runs/inbox/<tag>/settings.json --session-id <uuid> --name 'factory: <unit>' --append-system-prompt-file runs/inbox/<tag>/system.md < runs/inbox/<tag>/prompt.md`);
  console.log(`  system.md: the tag, the spec's loop section, this machine's section, the unit's card; prompt.md: factory/prompt.md for ${c.spec}`);
  return 0;
}

// runs/ and the checkout, taken for this loop: its lock (a restart keeps the one the loop it
// replaced held), what's left from an earlier run cleared, and with branches a checkout that
// isn't the owner's work. The loop lock's descriptor (null for a restart), or the exit code it
// refuses with.
export function takeCheckout(c: Config, checkout: string, rs: Restarted | null): { loopFd: number | null } | number {
  fs.mkdirSync("runs", { recursive: true });
  // A restart keeps the lock the loop it replaced held (its holder): taking it again would wait on that.
  let loopFd: number | null = null;
  if (!rs) {
    loopFd = tryLock("runs/.loop.lock");
    if (loopFd === null) { log("another loop is running in this checkout; one at a time (a second lane runs in its own clone: factory/lane.sh)"); return 2; }
  }
  // A restart keeps a pause or another restart asked for meanwhile; a fresh start forgets them.
  if (!rs) rm("runs/.pause", "runs/.pause-now", "runs/.restart", "runs/.stop-now");
  rm("runs/inbox/current");
  // Inboxes are kept a week, for a look at what a session was told.
  try { for (const e of fs.readdirSync("runs/inbox")) { const p = `runs/inbox/${e}`; try { const st = fs.lstatSync(p); if (st.isDirectory() && Date.now() - st.mtimeMs > 8 * 86400_000) fs.rmSync(p, { recursive: true, force: true }); } catch {} } } catch {}
  // A stop time the overseer set still holds for a lane restarted before it; one that's passed doesn't.
  if (!(Number(cat("runs/.stop-at") ?? 0) > epoch())) rm("runs/.stop-at");
  // So does a last call (`just fleet last-call`) the lane didn't finish: it ends when the lane stops
  // at its end (last call over, out of time, paused), and one over 12 hours old is from another run.
  try { if (Date.now() - fs.statSync("runs/.last-call").mtimeMs > 720 * 60_000) rm("runs/.last-call"); } catch {}

  // With branches the loop resets its checkout to origin's main between units, so a loop by hand
  // in the owner's checkout refuses to start over their work: changes, untracked files, unpushed
  // commits or another branch. A lane's clone (…-lane<N>) is the loop's own; it carries on.
  const M = c.main;
  if (c.branches && !/-lane[0-9]+$/.test(checkout)) {
    let cur = git("rev-parse", "--abbrev-ref", "HEAD") ?? "";
    if (!cur.startsWith("unit/")) {
      g("fetch", "-q", "origin", M);
      let mine = "";
      // Detached on a commit main has, clean: where a CI run that was stopped leaves the checkout.
      // (Not mid-bisect or mid-rebase, and with nothing on the local main origin lacks.)
      const gp = (p: string) => git("rev-parse", "--git-path", p) ?? p;
      if (cur === "HEAD" && spawnSync("git", ["merge-base", "--is-ancestor", "HEAD", `origin/${M}`], { stdio: "ignore" }).status === 0
        && !exists(gp("BISECT_LOG")) && !exists(gp("rebase-merge")) && !exists(gp("rebase-apply"))
        && (git("rev-list", "--count", `origin/${M}..${M}`) ?? "1") === "0") cur = M;
      if (cur !== M) mine = `it's on ${cur}, not ${M}`;
      if (!mine && (git("status", "--porcelain") ?? "")) mine = "it has changes or untracked files (git status)";
      if (!mine && (git("rev-list", "--count", `origin/${M}..HEAD`) ?? "0") !== "0") mine = `${M} has commits origin doesn't`;
      if (mine) { log(`not starting in this checkout: ${mine}, and the loop resets it to origin's ${M} between units. Commit and push (or stash) first, or run lanes in their own clones: just fleet start`); return 2; }
    }
  }
  return { loopFd };
}

// factory/prompt.md for this loop, with the factory's own additions (factory/prompt.local.md).
export function sessionPrompt(here: string, spec: string, loop: string) {
  const thisLoop = loop ? ` (the \`${loop}\` loop; work and report on it alone)` : "";
  let p = (read(`${here}/prompt.md`) ?? "").replaceAll("{{SPEC}}", spec).replaceAll("{{THIS_LOOP}}", thisLoop).replace(/\n+$/, "");
  const local = cat("factory/prompt.local.md");
  if (local !== null) p += `\n\n${local}`;
  return p;
}

// The run's clock: from the lane's start (t0, before any wait for a busy tracker lock: #109), or
// the run a restart carries on (its start and stop time).
export function runClock(o: Opts, env: NodeJS.ProcessEnv, rs: Restarted | null, t0 = epoch()) {
  const c = new Clock();
  c.start = t0;
  c.deadline = c.start + (Math.trunc(Number(o.hours) * 3600) || 0);
  if (rs) { c.start = rs.start; c.deadline = rs.deadline; }
  c.lastCall = isInt(o.lastCall) ? Number(o.lastCall) : setting("last_call", 30);
  const lcGrace = setting("last_call_grace", 15);
  c.graceS = isInt(env.FACTORY_LAST_CALL_GRACE) ? Number(env.FACTORY_LAST_CALL_GRACE) : lcGrace * 60;
  // A lane the daemon brought back carries on its run's last call: "<at> <stop time>", for that stop time.
  const [at, d] = (env.FACTORY_LAST_CALL_AT ?? "").split(" ");
  if (isInt(at) && isInt(d) && Math.abs(Number(d) - c.deadline) <= SAME_STOP_S) c.carried = Number(at);
  return c;
}
