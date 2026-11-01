// The heartbeat: each lane's state, what the busy ones work on, each machine's memory, and what's
// for the owner; and what's at stake at the start of a wait.
import { spawnSync } from "node:child_process";
import { hm } from "./sys.ts";
import { LAST_LINE } from "./fleet-scripts.ts";
import { gb, lines, say } from "./fleet-util.ts";
import type { Fleet } from "./fleet-ctx.ts";

// A length of time as the beat says it: "40 s", "12 min", "1h05".
export const dur = (s: number) => s < 60 ? `${Math.max(0, Math.round(s))} s` : s < 3600 ? `${Math.floor(s / 60)} min` : `${Math.floor(s / 3600)}h${String(Math.floor(s / 60) % 60).padStart(2, "0")}`;
// When a session started, from its transcript's name (<YYYYMMDD-HHMMSS>-<tag>.jsonl), in epoch seconds.
export const startedOf = (f: string) => {
  const m = /^(\d{4})(\d\d)(\d\d)-(\d\d)(\d\d)(\d\d)-/.exec(f);
  return m ? Math.floor(new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() / 1000) : 0;
};

// The heartbeat's last part: what's for the owner. Lanes in last call wait for work in flight to
// land, and the wait line names it: "<unit> in progress on <machine>", "<unit> merging on
// <machine>". Only a lane on that machine lands it, so when none there is busy (and the machine
// answers), the wait can't end: that's for the owner, not "nothing for you". A unit named without
// a machine (or past the first few) could be anywhere: then only no busy lane at all counts.
export function forYou(busyOn: Set<string>, away: string[], quiet: string[], questions: number): string {
  const FLIGHT = "once work in flight lands (";
  const stalled = (w: string) => {
    let what = w.slice(w.indexOf(FLIGHT) + FLIGHT.length);
    if (what.includes("; looking again")) what = what.slice(0, what.indexOf("; looking again"));
    what = what.slice(0, Math.max(0, what.lastIndexOf(")")));
    const named = [...what.matchAll(/ (?:in progress|merging)(?: on ([^\s,;)]+))?/g)].map((m) => m[1] ?? "");
    const anywhere = !named.length || named.includes("") || / and \d+ more\b/.test(what);
    const ok = anywhere ? busyOn.size === 0 && !away.length : named.every((h) => !busyOn.has(h) && !away.includes(h));
    return ok ? what : "";
  };
  const held = quiet.filter((w) => w.includes(FLIGHT)).map(stalled).find(Boolean);
  const stuck = held ? `the lanes wait for work in flight to land (${held}), but no lane where it is is working, so the wait won't end` : "";
  return [questions > 0 ? `${questions} waiting on you` : "", stuck].filter(Boolean).join("; ") || "nothing for you";
}

// A wait's timer with nothing at stake: under the hour the overseer's prompt cache lives, so a quiet
// wake still finds its context cached (docs/goal-ts.md, "The overseer stays a chat thread").
export const QUIET_MINUTES = 55;

// What's at stake at the start of a wait, which keeps its timer at 30 minutes rather than 55: ""
// when nothing is. (A stop time "within the hour" counts a wait's length past it too.)
export function stake(o: { news: number; away: number; forYou: string; waiting: number; low: number; deadlines: number[]; now: number }): string {
  if (o.news) return "news";
  if (o.away) return "a machine unreachable";
  if (o.forYou !== "nothing for you") return o.forYou;
  if (o.waiting) return "a lane waiting";
  if (o.low) return "memory low";
  if (o.deadlines.some((d) => d - o.now < 75 * 60)) return "a stop time within the hour";
  return "";
}

export type Beat = { text: string[]; busy: number; waiting: number; stopped: number; away: string[]; low: string[]; forYou: string };
// The heartbeat: each lane's state, what the busy ones work on (how long, and how long since
// the session's transcript was last written), each machine's memory, and what's for the owner.
export function beatOf(f: Fleet): Beat {
  const { env, allLanes, laneState, sh, runLanes, memOf, floorOf } = f;
  let busy = 0, waiting = 0, stoppedn = 0;
  const doing: string[] = [], quiet: string[] = [], away: string[] = [], busyOn = new Set<string>();
  const ms = new Set<string>();
  for (const { m, n, d } of allLanes()) {
    const st = laneState(m, d);
    if (st === "unreachable") { away.push(m); continue; }
    ms.add(m);
    if (st === "stopped") { stoppedn++; continue; }
    const r = sh(m, d, LAST_LINE, { out: "capture", err: "ignore" });
    const ls = r.status === 0 ? lines(r.out) : [];
    const rs = ls.includes("RESTART") ? " (then restarts)" : "";
    const ses = ls.find((l) => l.startsWith("SESSION "))?.split(" ");
    const last = ls.filter((l) => l !== "RESTART" && !l.startsWith("SESSION ")).pop() ?? "";
    const after = (s: string, sep: string) => { const i = s.indexOf(sep); return i < 0 ? s : s.slice(i + sep.length); };
    const why = `${m} lane ${n} ${after(last, " loop: ")}`;
    // In its exit steps (copying back, tidying): stopped, though its service hasn't ended yet.
    if (last.includes("loop: stopping: ") || last.includes("loop: the last lane on")) { stoppedn++; quiet.push(why); }
    else if (last.includes("loop: restarting on")) { waiting++; quiet.push(why); }
    else if (last.includes("loop: waiting") || last.includes("usage pause")) { waiting++; quiet.push(why); }
    else if (last.includes("loop: iteration")) {
      busy++; busyOn.add(m);
      const t = after(after(last, ": "), ": ");
      const k = t.lastIndexOf(" (session");
      let live = "";
      if (ses && ses.length >= 4) {
        const now = Number(ses[1]), wrote = Number(ses[2]), began = startedOf(ses[3]);
        live = `${began ? `, ${dur(now - began)} in` : ""}, transcript written ${dur(now - wrote)} ago`;
      }
      doing.push(`${m}${runLanes(m) > 1 ? `/${n}` : ""}: ${k < 0 ? t : t.slice(0, k)}${live}${rs}`);
    } else { busy++; busyOn.add(m); }
  }
  const q = lines(spawnSync("factory/tracker", ["questions"], { env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).stdout ?? "")
    .filter((l) => /^[0-9]+\. |^Gate: /.test(l)).length;
  const mem: string[] = [], low: string[] = [];
  for (const m of [...ms].sort()) {
    const { available: a, held } = memOf(m), floor = floorOf(m);
    if (a === null) continue;
    if (a < floor) low.push(m);
    // What holds its budget of heavy jobs: the biggest three, by name.
    const hs = held.slice(0, 3).map((h) => `${h.what} ${gb(h.mem)}`).join(", ") + (held.length > 3 ? `, ${held.length - 3} more` : "");
    mem.push(`${m} ${gb(a)}${a < floor ? ` (under its ${gb(floor)} reserve)` : ""}${held.length ? ` (budget held by ${hs})` : ""}`);
  }
  const fy = forYou(busyOn, away, quiet, q);
  let line = `${hm()} · ${busy} busy, ${waiting} waiting, ${stoppedn} stopped`;
  if (away.length) line += `, ${away.length} unreachable (${[...new Set(away)].sort().join(" ")})`;
  if (doing.length) line += ` · ${doing.join("; ")}`;
  if (mem.length) line += ` · memory available: ${mem.join(", ")}`;
  line += ` · ${fy}`;
  return { text: [line, ...quiet.map((w) => `  (${w})`)], busy, waiting, stopped: stoppedn, away: [...new Set(away)], low, forYou: fy };
}
export const beat = (f: Fleet, b = beatOf(f)) => { for (const l of b.text) say(l); };
