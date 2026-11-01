// fleet wait: until a lane stops, news comes or the time runs out, then what it found.
import fs from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { spawnSync } from "node:child_process";
import { epoch, expandHome, hm, tryLock, ymdHm } from "./sys.ts";
import type { LaneAsk, MachineAsk, MachineSeen } from "./daemon.ts";
import { QUIET_MINUTES, beat, beatOf, stake } from "./fleet-beat.ts";
import { state } from "./fleet-lanes.ts";
import { cat, chomp, gb, lines, say } from "./fleet-util.ts";
import type { Fleet, Lane } from "./fleet-ctx.ts";

// fleet wait [--minutes N] [--as <id>].
export async function wait(f: Fleet, args: string[]): Promise<number> {
  const { env, ME, note, watchOn, tier, onlyTier, service, laneState, MEM_FILE, allLanes, floorOf } = f;
  let mins = "", as = "";
  for (let i = 0; i < args.length; i += 2) {
    if (args[i] === "--minutes") mins = args[i + 1] ?? "";
    else if (args[i] === "--as") as = args[i + 1] ?? "";
  }
  if (mins && !/^[0-9]+(\.[0-9]+)?$/.test(mins)) { console.error(`fleet: --minutes needs a number (got '${mins}')`); return 2; }
  // One wait per overseer: a second would wake it twice, and outlive what it was for.
  fs.mkdirSync("runs", { recursive: true });
  const lockFile = `runs/.wait-${(as || "-").replace(/[^A-Za-z0-9._-]/g, "_")}.lock`;
  const held = tryLock(lockFile);
  if (held === null) {
    const [pid = "?", since = "?"] = chomp(cat(lockFile)).split(" ");
    console.error(`fleet: a wait for ${as ? `overseer ${as}` : "this overseer"} is already running (pid ${pid}, since ${since}): it wakes you when it returns, so don't start another. If it's a stray, end it first (kill ${pid}).`);
    return 2;
  }
  fs.ftruncateSync(held, 0); fs.writeSync(held, `${process.pid} ${hm()}\n`);
  const every = Number(env.FACTORY_WAIT_EVERY) > 0 ? Number(env.FACTORY_WAIT_EVERY) : 60;
  const L = allLanes();
  const key = (l: Lane) => `${l.m}\t${l.n}\t${l.d}`;
  const ask = (l: Lane): LaneAsk => ({ unit: service(l.d), dir: l.m === ME ? expandHome(l.d, env) : l.d });
  // What each machine's memory said at the last wait (runs/.fleet-memory): the newest kill
  // already told, and whether it was already under the floor (told once, until it recovers).
  let memSeen: Record<string, { since: number; low: boolean }> = {};
  try { memSeen = JSON.parse(cat(MEM_FILE)) ?? {}; } catch {}
  const t0 = epoch();
  const ms = [...new Set(L.map((l) => l.m))];
  for (const m of ms) memSeen[m] ??= { since: t0, low: false };
  const mAsk = (m: string): MachineAsk => ({ since: memSeen[m].since, floor: floorOf(m), low: memSeen[m].low });
  // "-": not reachable yet; its count is taken at the first look that reaches it, so old
  // events aren't news.
  const was = new Map<string, boolean>(), seen = new Map<string, number | "-">(), gone = new Map<string, boolean>();
  const deadlines: number[] = [];
  const ac = new AbortController();
  const stopped: string[] = [], news: string[] = [];
  let later = 0, replaced: { id: string; host: string; at: string } | null = null;
  // What a machine's answer says of its memory: kills since the last told, and falling under
  // the floor, as event lines (date, machine, lane "-", kind, message), by tier.
  const machineNews = (m: string, x: MachineSeen | undefined) => {
    if (!x) return;
    const put = (at: number, kind: string, text: string) => {
      const l = [ymdHm(new Date(at * 1000)), m, "-", kind, text].join("\t");
      if (tier(kind) === "wake") news.push(l); else later++;
      note(as, `${kind} on ${m}: ${text}`);
    };
    for (const k of x.ooms ?? []) {
      if (k.at < memSeen[m].since) continue;
      put(k.at, "oom", `the kernel killed ${k.task || "a process"} (pid ${k.pid}${k.rss ? `, holding ${gb(k.rss)}` : ""})${k.unit ? ` in ${k.unit}` : ""}: ${k.machine ? "the machine ran out of memory" : "it reached its unit's memory cap"}`);
      memSeen[m].since = Math.max(memSeen[m].since, k.at + 1);
    }
    if (x.avail !== null && x.avail !== undefined) {
      const floor = floorOf(m);
      if (x.avail < floor && !memSeen[m].low) { put(epoch(), "memory-low", `${m} has ${gb(x.avail)} of memory available, under its ${gb(floor)} reserve (docs/machines.md, Reserve and GPU)`); memSeen[m].low = true; }
      else if (x.avail >= floor + 2 ** 29) memSeen[m].low = false;
    }
  };
  await Promise.all(ms.map(async (m) => {
    const ls = L.filter((l) => l.m === m);
    const r = await watchOn(m, { op: "look", lanes: ls.map(ask), machine: mAsk(m) }, ac.signal);
    // A machine ssh can't reach may well be running: watched until it answers.
    ls.forEach((l, i) => {
      was.set(key(l), r ? r.lanes[i].running : true); seen.set(key(l), r ? r.lanes[i].count : "-");
      const dl = r?.lanes[i].deadline;
      if (r?.lanes[i].running && dl) deadlines.push(dl);
    });
    machineNews(m, r?.machine);
  }));
  // How long: what was asked, else 30 minutes while anything is at stake and QUIET_MINUTES when nothing
  // is (every machine answers, nothing waits on the owner, every running lane is busy, memory
  // is above the floor, no lane is within the hour of its stop time).
  let atStake = "";
  if (!mins) {
    const b = beatOf(f);
    atStake = stake({ news: news.length, away: b.away.length, forYou: b.forYou, waiting: b.waiting, low: b.low.length, deadlines, now: t0 });
    mins = atStake ? "30" : String(QUIET_MINUTES);
  }
  const end = t0 + Math.floor(Number(mins) * 60);
  const nap = async (s: number) => { try { await sleep(s * 1000, undefined, { signal: ac.signal }); } catch {} };
  // Each machine's daemon is asked to answer once one of its lanes stops or logs an event, or
  // the machine has news; one that can't be reached is asked again every FACTORY_WAIT_EVERY
  // seconds.
  const machineWatch = async (m: string) => {
    while (!ac.signal.aborted && epoch() < end && !news.length) {
      const ls = L.filter((l) => l.m === m && was.get(key(l)));
      const first = ls.some((l) => seen.get(key(l)) === "-");
      const r = await watchOn(m, first ? { op: "look", lanes: ls.map(ask), machine: mAsk(m) }
        : { op: "watch", lanes: ls.map(ask), seen: ls.map((l) => ({ running: true, count: seen.get(key(l)) as number })), until: end, machine: mAsk(m) }, ac.signal);
      if (ac.signal.aborted) return;
      if (!r) { for (const l of ls) gone.set(key(l), true); await nap(every); continue; }
      let unsure = false;
      ls.forEach((l, i) => {
        const k = key(l), s = seen.get(k)!, now = r.lanes[i];
        gone.set(k, false);
        // A stop is checked with the service manager once more before it's news.
        if (!now.running) { if (laneState(l.m, l.d) === "stopped") { stopped.push(`${l.m}/lane${l.n}`); was.set(k, false); } else unsure = true; }
        if (s === "-") { seen.set(k, now.count); return; }
        if (now.count > s) {
          const fresh = now.fresh ?? "";
          news.push(...onlyTier("wake", fresh));
          later += onlyTier("summary", fresh).length;
          seen.set(k, now.count);
        }
      });
      machineNews(m, r.machine);
      if (stopped.length || news.length) ac.abort();
      // A first look, or one that found only summary events: watch on at once. (The time
      // runs out at the end; nothing to wait for between.) A lane the daemon took for
      // stopped that the service manager still runs is watched on after a pause.
      else if (unsure) await nap(Math.min(every, 5));
    }
  };
  // The overseer that waits (--as): a newer one attached (fleet attach) replaces it.
  const overseerWatch = async () => {
    if (!as) return;
    while (!ac.signal.aborted && epoch() < end) {
      const r = spawnSync("factory/tracker", ["overseer", "--json"], { env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      try { const o = JSON.parse(r.stdout); if (o && o.id && o.id !== as) { replaced = o; ac.abort(); return; } } catch {}
      await nap(every);
    }
  };
  if (news.length) ac.abort();
  // Until something wakes it, or the time runs out (with no lane running, that's all).
  const timer = nap(Math.max(0, end - epoch())).then(() => ac.abort());
  await Promise.all([...ms.map(machineWatch), overseerWatch()]);
  await timer;
  fs.writeFileSync(MEM_FILE, JSON.stringify(memSeen) + "\n");
  const r = replaced as { id: string; host: string; at: string } | null;
  // What it found comes first, and why it woke and the heartbeat last, so the end of its output
  // (all a finished background command shows) is enough. Every way of waking exits 0 (a
  // background command's failure status would read as something gone wrong).
  if (r) {
    const line = `woke: replaced by another overseer: ${r.id} on ${r.host}, since ${r.at}`;
    say("This thread no longer oversees the factory: stop here, and don't wait again. The lanes go on; the new overseer has them.");
    say(line);
    note(as, `wait: ${line}`);
    return 0;
  }
  let why: string;
  if (stopped.length) why = `woke: a lane stopped: ${stopped.join(" ")}${news.length ? " (and news, above)" : ""}`;
  else if (news.length) {
    const kinds = new Map<string, number>();
    for (const l of news) { const k = l.split("\t")[3] ?? ""; kinds.set(k, (kinds.get(k) ?? 0) + 1); }
    why = `woke: news: ${[...kinds].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, c]) => `${k}${c > 1 ? ` ×${c}` : ""}`).join(", ")}`;
  } else why = `woke: time: ${mins} min passed with nothing to act on${atStake ? ` (30, not ${QUIET_MINUTES}: ${atStake})` : ""}`;
  note(as, `wait: ${why}`);
  if (stopped.length) {
    const sm = [...new Set(stopped.map((s) => s.split("/")[0]))].sort();
    process.stdout.write(lines(state(f, sm, true)).map((l) => l + "\n").join(""));
    say(`stopped: ${stopped.join(" ")}`);
  }
  for (const l of L) if (gone.get(key(l))) say(`unreachable at the last look: ${l.m} lane ${l.n}`);
  if (news.length) {
    say("--- for the owner:");
    for (const l of news) { const f = l.split("\t"); say([...f.slice(0, 2), ...f.slice(3)].join(" · ")); }
  }
  if (later) say(`(${later} more for the morning summary: \`just fleet summary\`)`);
  say(why);
  beat(f);
  return 0;
}
