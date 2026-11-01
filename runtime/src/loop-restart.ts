// A lane's loop restarting on the newest deployed copy without stopping (runs/.restart, from
// `oversee.sh restart`), and what holds its locks across the exec.
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { log } from "./session.ts";
import { epoch } from "./sys.ts";
import { platform } from "./os.ts";
import { startBeat } from "./loop-beat.ts";
import { cat, isInt, rm, touch } from "./loop-util.ts";
import type { Loop } from "./loop.ts";

// What a restarted loop is handed (FACTORY_RESTARTED): the run it carries on and what holds the
// locks the loop it replaced held. Its format is read by newer copies than the one that wrote it:
// "<id> <of> <start> <deadline> <i> <was> <fd> <holders>".
export interface Restarted {
  id: string;           // the restart that asked (one per `oversee.sh restart`)
  of: string;           // how many lanes it asked
  start: number; deadline: number; i: number;   // the run's start, stop time and sessions so far
  was: string;          // the copy it ran on before
  fd: string;           // a bash loop's lane-lock descriptor ("-" from a TypeScript one)
  holders: number[];    // the holders of its loop lock and lane lock (0: none)
}
// (One without an id isn't a restart, though the loop still starts counting from its sessions.)
export function restarted(env: NodeJS.ProcessEnv): Restarted | null {
  const r = env.FACTORY_RESTARTED;
  if (!r) return null;
  delete env.FACTORY_RESTARTED;
  const [id = "", of = "", start = "0", deadline = "0", i = "0", was = "", fd = "", hs = ""] = r.split(/\s+/);
  return { id, of, start: Number(start) || 0, deadline: Number(deadline) || 0, i: Number(i) || 0, was, fd, holders: hs.split(",").filter(isInt).map(Number) };
}

// A holder for a lock across a restart: a process given the lock's open file, which keeps it
// until <pid> ends (os.ts, untilEnds). The loop's own descriptors don't survive the exec.
export function holder(fd: number, pid = process.pid): number | null {
  try {
    const [cmd, ...args] = platform.untilEnds(pid);
    const c = spawn(cmd, args, { stdio: ["ignore", "ignore", "ignore", fd], detached: true });
    c.unref();
    return c.pid ?? null;
  } catch { return null; }
}
export function endHolder(pid: number | null) {
  if (!pid) return;
  try { process.kill(pid, "SIGTERM"); } catch { return; }
  // Gone once its lock is: wait for that, up to a second. (A holder from before a restart isn't
  // this image's child, so nothing reaps it: a zombie has let go too.)
  const tick = new Int32Array(new SharedArrayBuffer(4));
  for (let k = 0; k < 100; k++) {
    if (platform.processEnded(pid)) return;
    Atomics.wait(tick, 0, 0, 10);
  }
}
// A loop restarted by a bash loop got its locks as open descriptors, which every command it
// starts would inherit: holders keep them instead. A TypeScript one names its holders.
export function adoptHolders(l: Loop, rs: Restarted) {
  if (isInt(rs.fd)) {
    for (const fd of [9, Number(rs.fd)]) {
      let h: number | null = null;
      try { fs.fstatSync(fd); h = holder(fd); fs.closeSync(fd); } catch {}
      if (fd === 9) l.loopHolder = h; else l.laneHolder = h;
    }
  } else { l.loopHolder = rs.holders[0] || null; l.laneHolder = rs.holders[1] || null; }
}

// The copy of the skill this loop runs: a deployed version's commit, or the folder chosen by hand.
export function skillVer(s: string) { const m = /\/versions\/([^/]+)\/wfactory$/.exec(s); return m ? m[1] : s; }
// .tracker/skill: the copy sessions' `just` reads the recipes of.
export function linkSkill(skill: string) {
  try {
    fs.mkdirSync(".tracker", { recursive: true });
    const tmp = `.tracker/skill.new.${process.pid}`;
    rm(tmp); fs.symlinkSync(skill, tmp); fs.renameSync(tmp, ".tracker/skill");
  } catch {}
}

// runs/.restart ("<id> <lanes>", from `oversee.sh restart`): start the newest deployed copy in
// this one's place. It returns only if it couldn't, and the lane goes on as it was.
export function restart(l: Loop) {
  const r = cat("runs/.restart") ?? ""; rm("runs/.restart");
  let [id = "", of = ""] = r.split(/\s+/);
  id ||= `${epoch()}-${process.pid}`; if (!isInt(of)) of = "1";
  const SKILL = process.env.FACTORY_SKILL ?? "";
  // A deployed copy is looked up again (factory/skill: `current`); one chosen by hand is kept.
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.FACTORY_LAST_CALL; delete env.FACTORY_HOST_ONLY;
  if (process.env.FACTORY_SKILL_FROM === "deploy") { delete env.FACTORY_SKILL; delete env.FACTORY_SKILL_FROM; }
  // A copy that can't even start (none deployed, a broken copy) is no runner to restart on: go on here.
  const ok = spawnSync("bash", ["-c", '[ -x factory/loop.sh ] && . factory/skill && bash -n "$FACTORY_SKILL/runtime/loop.sh" && "$FACTORY_NODE" "$FACTORY_SKILL/runtime/main.mjs" loop --check'], { env, stdio: "ignore" }).status === 0;
  if (!ok) {
    linkSkill(SKILL);   // the look above relinked it to the newest
    log("restart: the newest runner can't start here (factory/skill, or its loop.sh doesn't parse); carrying on with this one");
    l.event("restart-failed", `lane ${l.lane} on ${l.host}: the newest runner can't start there (factory/skill, or its loop.sh doesn't parse); the lane carries on with ${skillVer(SKILL)}`);
    return;
  }
  log(`restarting on the newest runner (this one is ${skillVer(SKILL)})`);
  // The locks go on, held for the new loop by processes that end with it (this pid goes on).
  if (l.loopFd !== null && !l.loopHolder) l.loopHolder = holder(l.loopFd);
  if (l.laneFd !== null && !l.laneHolder) l.laneHolder = holder(l.laneFd);
  // The new loop starts its own heartbeat and stay-awake holder. (This one's holder watches this
  // pid, which goes on: left alone, it would hold on beside the new one's until the lane stops.)
  l.stopBeat(); l.stopAwake();
  env.FACTORY_RESTARTED = `${id} ${of} ${l.clock.start} ${l.clock.deadline} ${l.i} ${skillVer(SKILL).replace(/ /g, "_")} - ${[l.loopHolder, l.laneHolder].map((p) => p ?? 0).join(",")}`;
  // (The holders' pids last: 0 for a lock it didn't hold.)
  const prog = path.resolve("factory/loop.sh");
  try { process.execve!(prog, [prog, ...l.args], env as Record<string, string>); } catch (e) {
    log(`restart: couldn't start the newest runner (${(e as Error).message}); carrying on with this one`);
    l.beatPid = startBeat(l.here); l.startAwake();
  }
}

// The restarted loop, once running: the lanes this restart asked note themselves done; the last
// of them tells the morning summary.
export function restartedRunning(l: Loop, rs: Restarted) {
  const L = process.env.FACTORY_LOCKS!, ver = skillVer(process.env.FACTORY_SKILL ?? "");
  log(`restarted on the newest runner: ${ver} (was ${rs.was})`);
  const rd = `${L}/restart-${rs.id}`;
  fs.mkdirSync(rd, { recursive: true }); touch(`${rd}/${l.checkout}${l.o.loop ? `-${l.o.loop}` : ""}`);
  const n = fs.readdirSync(rd, { withFileTypes: true }).filter((e) => e.isFile()).length;
  let told = false;
  if (n >= (Number(rs.of) || 1)) { try { fs.mkdirSync(`${rd}/told`); told = true; } catch {} }
  if (told) l.event("restarted", `${rs.of === "1" ? `lane ${l.lane} on ${l.host} is` : `all ${rs.of} restarted lanes on ${l.host} are`} on the newest runner, ${ver} (was ${rs.was})`);
  // Restarts more than a day old have told what they had to.
  for (const e of fs.readdirSync(L)) {
    if (!e.startsWith("restart-")) continue;
    try { if (Date.now() - fs.statSync(`${L}/${e}`).mtimeMs > 1440 * 60_000) fs.rmSync(`${L}/${e}`, { recursive: true, force: true }); } catch {}
  }
}
