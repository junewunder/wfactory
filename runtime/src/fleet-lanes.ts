// The fleet's lanes and machines: starting, restarting, stopping and tidying lanes, telling them
// things, and each machine's usage reading and a command run there.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { epoch, ymdHm, ymdHms } from "./sys.ts";
import { platform, remote } from "./os.ts";
import { openingOpen, trWait } from "./tr.ts";
import { project } from "./oversee.ts";
import { CLONES, DROP_CLONE, PULL_CHECKOUT, PULL_LANE, TIDY_LANE, TIDY_MACHINE } from "./fleet-scripts.ts";
import { cat, chomp, chomp1, lines, say, timeAt } from "./fleet-util.ts";
import type { Fleet, Lane } from "./fleet-ctx.ts";

// Each lane's own state (oversee.sh state), and the leases with a store. With capture, returned.
export function state(f: Fleet, ms: string[], capture = false) {
  const { env, each } = f;
  let said = each(ms, ["state"], capture);
  const store = project().store;
  if (store !== undefined && store !== null && store !== false) {
    if (capture) said += "=== leases\n"; else say("=== leases");
    const r = spawnSync("factory/tracker", ["leases"], { env, encoding: "utf8", stdio: ["ignore", capture ? "pipe" : "inherit", "ignore"] });
    if (capture) said += r.stdout ?? "";
  }
  return said;
}

// Clones past <keep> on a machine (an old count, or a night's --lanes) that no loop runs in: each
// of the project's loops' units is asked, then the clone's own lock (DROP_CLONE).
function dropOrphans(f: Fleet, m: string, keep: number) {
  const { ME, hasOrigin, checkout, on, sh, LANES_FILE, loopNames } = f;
  if (!hasOrigin) return;
  // The clones are every loop's: none another loop's --lanes still counts.
  let fs_: string[] = []; try { fs_ = fs.readdirSync("runs"); } catch {}
  for (const f of fs_.filter((f) => f.startsWith(".fleet-lanes") && path.join("runs", f) !== LANES_FILE))
    for (const l of lines(cat(path.join("runs", f)))) { const [mm, n] = l.split(" "); if (mm === m && Number(n) > keep) keep = Number(n); }
  for (const c of lines(sh(m, checkout(m), CLONES, { out: "capture", err: "ignore" }).out)) {
    const n = Number(/-lane([0-9]+)$/.exec(c)?.[1] ?? 0);
    if (!(n > keep)) continue;
    const units = loopNames.map((l) => `factory-${path.basename(c)}${l ? `-${l}` : ""}`);
    const st = units.map((u) => m === ME ? (platform.jobState(u) === "stopped" ? "stopped" : "running")
      : (() => { const x = on(m, "~", remote.jobRunningCmd(u), { err: "ignore" }).status; return x === 255 ? "unreachable" : remote.jobStoppedStatus.includes(x) ? "stopped" : "running"; })());
    if (st.every((x) => x === "stopped")) sh(m, checkout(m), DROP_CLONE, {}, c, path.basename(c));
  }
}
export function tidy(f: Fleet, ms: string[]) {
  const { floop, checkout, lanes, sh, laneState, setOverride, allLanes } = f;
  for (const m of ms) {
    let busy = false, gone = false;
    for (const { d } of allLanes([m])) { const st = laneState(m, d); if (st === "running") busy = true; else if (st === "unreachable") gone = true; }
    if (gone) { say(`=== ${m}: unreachable; not tidied`); continue; }
    if (busy) { say(`=== ${m}: a lane is still running; it tidies up when the last one stops`); continue; }
    say(`=== ${m}`);
    for (const { d } of allLanes([m])) sh(m, checkout(m), TIDY_LANE, {}, d, floop);
    if (sh(m, checkout(m), TIDY_MACHINE).status !== 0) say(`(${m}: factory/tidy failed)`);
    dropOrphans(f, m, lanes(m));
    setOverride(m, null);
  }
}

// --until <time>: the stop time as a time of day ("09:00", "9am", "tomorrow 9am"; a time of
// day already past today is tomorrow's), so the owner's "until 9am" needs no sum. The options
// without it, and the time (epoch seconds); or what's wrong.
export function takeUntil(rest: string[], now: number): { rest: string[]; until: number | null } | string {
  const i = rest.indexOf("--until");
  if (i < 0) return { rest, until: null };
  if (rest.includes("--hours")) return "--until and --hours both give the stop time: pass one";
  const at = rest[i + 1] ?? "";
  const t = timeAt(at, now);
  if (t === null) return `--until needs a time, e.g. 09:00 (got '${at}')`;
  if (t === "past") return `--until ${at} is in the past`;
  return { rest: [...rest.slice(0, i), ...rest.slice(i + 2)], until: t };
}
// The --hours from now to it, worked out as each lane starts: a lane started after another
// machine's deploy still stops at the time asked for.
export const hoursTo = (until: number, now: number) => ["--hours", ((until - now) / 3600).toFixed(3)];

// fleet start [<machine>…] [--lanes N] [loop options]: deploy, then start each machine's lanes.
export function start(f: Fleet, args: string[]): number {
  const { ME, NAMES, checkout, lanes, loopArg, deployed, takeMachines, on, sh, updateSkill, laneState, LANES_FILE, MEM_FILE, setOverride, allLanes } = f;
  // A busy tracker lock is waited out: it isn't the opening over (#109).
  { const why = openingOpen((a) => trWait(a, (m) => console.error(`fleet: ${m}`))); if (why) { console.error(`fleet: ${why}`); return 2; } }
  let { ms, rest } = takeMachines(args, [ME]);
  if (rest.length && !rest[0].startsWith("-")) { console.error(`fleet: no machine ${rest[0]} in docs/machines.md (${NAMES.join(" ")})`); return 2; }
  // --lanes N: this many lanes on each machine named, for this start only (the machines file
  // keeps its count).
  let want: number | null = null;
  const li = rest.indexOf("--lanes");
  if (li >= 0) {
    if (!/^[0-9]+$/.test(rest[li + 1] ?? "")) { console.error(`fleet: --lanes needs a number of lanes (got '${rest[li + 1] ?? ""}')`); return 2; }
    want = Number(rest[li + 1]);
    rest = [...rest.slice(0, li), ...rest.slice(li + 2)];
  }
  const u = takeUntil(rest, epoch());
  if (typeof u === "string") { console.error(`fleet: ${u}`); return 2; }
  rest = u.rest;
  if (!rest.includes("--max")) rest = [...rest, "--max", "1000"];
  // A run starts when no lane anywhere is running: \`fleet summary\` starts from there by
  // default, and the lane counts an earlier run's starts gave are forgotten. (A machine ssh
  // can't reach may well be running: that isn't a new run.)
  if (allLanes().every(({ m, d }) => laneState(m, d) === "stopped")) {
    fs.mkdirSync("runs", { recursive: true });
    fs.writeFileSync("runs/.fleet-start", `${ymdHm()}\n`);
    // A new run hears of kills and low memory from its own start on, not the last run's.
    fs.rmSync(LANES_FILE, { force: true });
    fs.writeFileSync(MEM_FILE, JSON.stringify(Object.fromEntries(NAMES.map((m) => [m, { since: epoch(), low: false }]))) + "\n");
  }
  for (const m of ms) {
    const count = want ?? lanes(m);
    // The lanes the fleet watches there from now on: these, and any already running past them
    // (an earlier start's), which go on.
    const shown = Math.max(count, ...allLanes([m]).filter((l) => l.n > count && laneState(m, l.d) === "running").map((l) => l.n));
    setOverride(m, shown === lanes(m) ? null : shown);
    // Clones past those (an earlier run's) go, so nothing reads their old logs as this run's.
    dropOrphans(f, m, shown);
    if (!(count > 0)) { say(`=== ${m}: ${want === null ? "docs/machines.md gives it" : "asked for"} 0 lanes`); continue; }
    for (const l of updateSkill(m)) say(l);
    sh(m, checkout(m), PULL_CHECKOUT, { out: "ignore", err: "ignore" });
    for (let n = 1; n <= count; n++) {
      const r = on(m, checkout(m), ["factory/lane.sh", "dir", String(n)], { out: "capture" });
      if (r.status !== 0) { say(`=== ${m} lane ${n}: couldn't make its checkout (unreachable?)`); continue; }
      const d = chomp(r.out);
      const st = laneState(m, d);
      if (st === "running") { say(`=== ${m} lane ${n}: already running`); continue; }
      if (st === "unreachable") { say(`=== ${m} lane ${n}: unreachable over ssh; not started`); continue; }
      say(`=== ${m} lane ${n}`);
      sh(m, d, PULL_LANE);
      if (u.until !== null && u.until <= epoch()) { say(`=== ${m} lane ${n}: not started: its stop time has passed`); continue; }
      const s = on(m, d, ["factory/oversee.sh", "start", ...loopArg, ...(u.until === null ? [] : hoursTo(u.until, epoch())), ...rest], { out: "capture", unset: deployed });
      // Its output's last two lines, blank ones too (as `| tail -2`).
      const out = s.out ? chomp1(s.out).split("\n") : [];
      if (s.status !== 0) out.push(`(${m} lane ${n} didn't start)`);
      for (const l of out.slice(-2)) say(l);
    }
  }
  return 0;
}

// fleet restart <machine> [--lane N]: deploy, then restart its running lanes on the new copy.
export function restart(f: Fleet, args: string[]): number {
  const { NAMES, known, loopArg, deployed, on, updateSkill, laneState, runLanes, allLanes } = f;
  const m = args[0] ?? "";
  if (!known(m)) { console.error(`usage: fleet restart <machine> [--lane N] (machines: ${NAMES.join(" ")})`); return 2; }
  const a = args.slice(1);
  let only = 0;
  if (a.length) {
    if (a.length !== 2 || a[0] !== "--lane" || !/^[1-9][0-9]*$/.test(a[1]) || Number(a[1]) > runLanes(m)) {
      console.error(`fleet: restart ${m} takes --lane N, N from 1 to ${runLanes(m)}`);
      return 2;
    }
    only = Number(a[1]);
  }
  // A deploy that failed, or couldn't fetch (offline), would only restart the lanes on what they run now.
  const out = updateSkill(m);
  for (const l of out) say(l);
  if (out.some((l) => /skill for its lanes: (unreachable|deploy failed|.*couldn't reach)/.test(l))) {
    say(`=== ${m}: nothing restarted: the newest skill isn't deployed there`);
    return 3;
  }
  // Only running lanes are asked; the count is how many the event waits for.
  const run: Lane[] = [];
  for (const l of allLanes([m])) {
    if (only && l.n !== only) continue;
    const st = laneState(m, l.d);
    if (st === "running") run.push(l);
    else if (st === "unreachable") { say(`=== ${m}: unreachable over ssh; nothing restarted`); return 3; }
    else say(`=== ${m} lane ${l.n}: not running; \`just fleet start ${m}\` starts it on the newest runner`);
  }
  if (!run.length) return 3;
  const id = `${ymdHms().replace(/[-: ]/g, "")}-${process.pid}`;
  for (const { n, d } of run) {
    say(`=== ${m} lane ${n}`);
    // The copy just deployed reads the request (as in start).
    if (on(m, d, ["factory/oversee.sh", "restart", ...loopArg, "--id", id, "--of", String(run.length)], { unset: deployed }).status !== 0)
      say(`(${m} lane ${n} wasn't asked, so no restarted event will come for ${m}; check the lanes with \`just fleet state ${m}\`)`);
  }
  return 0;
}

// fleet stop-at <time> [<machine>…]: an earlier stop time for the lanes.
export function stopAt(f: Fleet, args: string[]): number {
  const { takeMachines, each } = f;
  const at = args[0] ?? "";
  const t = timeAt(at, epoch());
  if (t === null) { console.error(`fleet: stop-at needs a time, e.g. 09:00 (got '${at}'; for now, \`fleet last-call\` or \`fleet pause\`)`); return 2; }
  if (t === "past") { console.error(`fleet: ${at} is in the past`); return 2; }
  each(takeMachines(args.slice(1)).ms, ["stop-at", "--at", String(t)]);
  return 0;
}

// fleet tell <machine>[/<lane>] | <unit id> <text…>: a message to the running sessions.
export function tell(f: Fleet, args: string[]): number {
  const { known, loopArg, on, sh, allLanes } = f;
  if (args.length < 2) { console.error("usage: fleet tell <machine>[/<lane>] | <unit id> <text…>"); return 2; }
  const tgt = args[0], text = args.slice(1).join(" ");
  const m = tgt.split("/")[0], ln = tgt.includes("/") ? tgt.slice(tgt.indexOf("/") + 1) : "";
  let targets: Lane[], only: string[] = [];
  if (known(m) && /^[0-9]*$/.test(ln)) {
    targets = allLanes([m]).filter((l) => ln === "" || l.n === Number(ln));
    if (!targets.length) { console.error(`fleet: ${m} has no lane ${ln} (docs/machines.md)`); return 2; }
  } else {
    // A unit: the lane whose running session works it (and still does when the message lands).
    only = ["--unit", tgt];
    targets = allLanes().filter(({ m, d }) => chomp(sh(m, d, "cat runs/inbox/current/unit 2>/dev/null", { out: "capture", err: "ignore" }).out) === tgt);
    if (!targets.length) { say(`fleet: no running session works ${tgt} (or its machine is unreachable); a note on it reaches the next session that takes it`); return 3; }
  }
  let told = false;
  for (const { m, n, d } of targets) {
    say(`=== ${m} lane ${n}`);
    const s = on(m, d, ["factory/oversee.sh", "tell", ...loopArg, ...only, "--", text]).status;
    if (s === 0) told = true;
    else if (s === 255) say(`(${m} is unreachable over ssh: nothing was told there)`);
  }
  return told ? 0 : 3;
}

// fleet usage: each machine's reading of the plan's usage, and which is newest.
export function usage(f: Fleet, args: string[]): number {
  const { NAMES, checkout, sh } = f;
  // Each machine knows only what its own last session saw, which may be from before a plan
  // change: show every machine's reading with its age, and point at the newest.
  let best = "", bestT = 0, unknown = false;
  for (const m of NAMES) {
    const r = sh(m, checkout(m), "factory/usage.sh json && factory/usage.sh show", { out: "capture", err: "ignore" });
    if (r.status === 255) { say(`${m}: unreachable over ssh`); continue; }
    if (r.status !== 0) { say(`${m}: factory/usage.sh failed there (exit ${r.status})`); continue; }
    const ls = chomp(r.out).split("\n");
    const line = ls[ls.length - 1];
    if (line.startsWith("usage: not known yet")) { say(`${m}: ${line}`); continue; }
    let t = "";
    try { const j = JSON.parse(ls[ls.length - 2] ?? ""); if (j?.asOf !== undefined && j.asOf !== null && j.asOf !== false) t = String(j.asOf); } catch {}
    // A skill deployed before readings were dated: its age is unknown, so nothing is "newest".
    if (!/^[0-9]+$/.test(t)) { say(`${m}: ${line} (age unknown: an older skill there; just fleet start deploys the new one)`); unknown = true; continue; }
    say(`${m}: ${line}`);
    if (Number(t) > bestT) { bestT = Number(t); best = m; }
  }
  if (unknown) say("newest: can't tell while a machine's reading has no age");
  else if (NAMES.length > 1 && best) say(`newest: ${best}'s; trust that one`);
  return 0;
}

// fleet run <machine> <command…>: a command in that machine's checkout.
export function run(f: Fleet, args: string[]): number {
  const { NAMES, known, checkout, on } = f;
  const m = args[0] ?? "";
  if (!known(m)) { console.error(`fleet: no machine ${m} in docs/machines.md (${NAMES.join(" ")})`); return 2; }
  return on(m, checkout(m), args.slice(1)).status;
}
