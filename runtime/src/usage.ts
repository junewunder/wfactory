// How much of the plan's usage is left, from the loop's own transcripts.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { profileGet } from "./profile.ts";
import { dayHm, enterRoot, epoch, hm, asksHelp } from "./sys.ts";

export const HELP = `
usage.sh — how much of the plan's usage is left, from the lanes' own transcripts.

Every headless session's stream-json log (runs/*.jsonl) carries
\`rate_limit_event\` lines with the share of the plan used and the reset time,
for the 5-hour window and for the week, covering the whole plan (every
machine and chat). This reads the newest one, from the checkout's runs/ and
its lanes' clones beside it, wherever among them it's run (<checkout>-lane<N>/runs/).

One reading per machine. The plan is shared by every factory on the machine,
so the newest reading read here is also written to one file in the machine's
wfactory state folder ($FACTORY_USAGE_FILE, default
~/.local/state/wfactory/usage.json), and the newer of that file's and this
factory's own is the one shown and acted on. The owner's interactive sessions
leave no reading on disk, so their use shows in the next headless session's.

A figure is only as fresh as its event: a machine whose last session was hours
ago still shows what the plan was then (before an upgrade, say). So \`show\`
says when its event was (the transcript line before it, else the file's
time), and \`just fleet usage\` asks every machine and points at the newest.

The week's line. At any moment the lanes may have used up to
  (time since the week began / 7 days) × (100 − keep back)
percent of the week; the week began 7 days before its reset. Ahead of the
line, every lane pauses between units until the moment the line reaches
what's used (worked out from the reading and the clock, so no new reading is
needed to resume), or until the week's reset if that comes first. On the line
or behind it, they carry on. So a week on its line ends with the share kept
back left, and nothing else.

Usage:
  factory/usage.sh show     one line: what's used in each window, when it resets,
                            where the week's line is and until when the lanes
                            pause for it, and how old the reading is
  factory/usage.sh check    exit 0 = carry on; 4 = pause: prints the epoch the
                            lanes resume at, then why on a second line
  factory/usage.sh json     the numbers, for scripts (asOf: the event's epoch;
                            line: the share kept back, the share the line
                            allows now, and pausedUntil, null unless ahead)

Settings:
  FACTORY_USAGE_PAUSE_LEFT  pause every lane below this much of the 5-hour window
                            LEFT (percent). Default: the profile's "pause below",
                            else 8. 0 never pauses.
  FACTORY_USAGE_KEEP_BACK   the share of the week kept back for the owner's own
                            use (percent). Default: the profile's "keep back",
                            else 15. 0 keeps nothing back: the lanes may use the
                            whole week, evenly. "off": the week is shown, never
                            acted on.
A window whose reset time has passed counts as fresh. No transcript with a
rate_limit_event yet means nothing is known: \`check\` says carry on.`;

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Obj = { [k: string]: Json };
const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);

// The transcripts to look in, newest first: the checkout's runs/ and its lanes' (<checkout>-lane<N>/runs/).
function transcripts(root: string) {
  const dirs = [path.join(root, "runs")];
  const up = path.dirname(root), base = path.basename(root) + "-lane";
  try { for (const d of fs.readdirSync(up).sort()) if (d.startsWith(base)) dirs.push(path.join(up, d, "runs")); } catch {}
  const files: { f: string; t: bigint }[] = [];
  for (const d of dirs) {
    let names: string[]; try { names = fs.readdirSync(d); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith(".jsonl")) continue;
      const f = path.join(d, n);
      try { files.push({ f, t: fs.statSync(f, { bigint: true }).mtimeNs }); } catch {}
    }
  }
  return files.sort((a, b) => a.t !== b.t ? (b.t > a.t ? 1 : -1) : b.f < a.f ? -1 : b.f > a.f ? 1 : 0).slice(0, 10).map((x) => x.f);
}

// "2026-10-15T12:00:00Z" (fractions of a second dropped) → epoch seconds; else null.
function isoEpoch(s: string) {
  const m = /^(\d+)-(\d+)-(\d+)T(\d+):(\d+):(\d+)Z$/.exec(s.replace(/\.[0-9]+Z$/, "Z"));
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000 : null;
}

// The factory's checkout, also for one of its lane clones (<checkout>-lane<N>).
export function factoryRoot(root: string) {
  const lane = [...root.matchAll(/-lane[0-9]/g)].pop();
  return lane ? root.slice(0, lane.index) : root;
}

// The newest rate_limit_event among the newest transcripts, with "at": its epoch. Events
// carry no time of their own: it's the last timestamped line before one, else the file's time.
export function latest(root: string): Obj | null {
  for (const f of transcripts(root)) {
    let text: string;
    try { text = fs.readFileSync(f, "utf8"); } catch { continue; }
    if (!text.includes('"type":"rate_limit_event"')) continue;
    let ev: Obj | null = null, at: string | null = null, ts: string | null = null;
    for (const line of text.split("\n")) {
      if (!line.includes('"type":"rate_limit_event"') && !line.includes('"timestamp":"')) continue;
      let l: unknown; try { l = JSON.parse(line); } catch { continue; }
      if (!isObj(l)) continue;
      if (l.type === "rate_limit_event") { ev = l; at = ts; }
      else if (typeof l.timestamp === "string") ts = l.timestamp;
    }
    if (!ev) continue;
    let mtime = 0; try { mtime = Math.floor(fs.statSync(f).mtimeMs / 1000); } catch {}
    return { ...ev, at: (at !== null ? isoEpoch(at) : null) ?? mtime };
  }
  return null;
}

// ---------------------------------------------------------------- one reading per machine

// The machine's reading: the newest any factory's lanes here have read, as latest() gives it
// (the event, "at": its epoch) with "from": the checkout whose lanes read it.
export const sharedFile = (env: NodeJS.ProcessEnv = process.env) =>
  env.FACTORY_USAGE_FILE || path.join(env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "wfactory", "usage.json");
const at = (ev: Obj | null) => ev !== null && typeof ev.at === "number" ? ev.at : -1;
function shared(env: NodeJS.ProcessEnv): Obj | null {
  try { const j: unknown = JSON.parse(fs.readFileSync(sharedFile(env), "utf8")); return isObj(j) && j.type === "rate_limit_event" ? j : null; } catch { return null; }
}
// The newer of this factory's own reading and the machine's; its own, when newer, becomes the
// machine's (written whole, then renamed: a reader never sees half of one). A machine's reading
// dated past now (by more than AHEAD_S: the clock was set back, or the file is wrong) is as
// none, or it would be the newest until its date came.
const AHEAD_S = 300;
export function newest(root: string, env: NodeJS.ProcessEnv = process.env, now = epoch()): Obj | null {
  const own = latest(root), file = shared(env), theirs = at(file) > now + AHEAD_S ? null : file;
  if (own === null || at(theirs) > at(own)) return theirs ?? own;
  if (at(own) > at(theirs)) {
    try {
      const f = sharedFile(env), tmp = `${f}.${process.pid}.tmp`;
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify({ ...own, from: root }) + "\n"); fs.renameSync(tmp, f);
    } catch {}
  }
  return own;
}

// ---------------------------------------------------------------- the week's line

export const WEEK_S = 7 * 86400;
// The share of the week (0 to 1) the lanes may have used by now: the share of the week gone,
// less the share kept back (percent). The week began 7 days before its reset.
export function lineAt(resetsAt: number, now: number, keepBack: number) {
  const gone = Math.min(1, Math.max(0, (now - (resetsAt - WEEK_S)) / WEEK_S));
  return gone * (1 - keepBack / 100);
}
// The moment the line reaches a share used: the week's reset, if it never does before it (more
// is used than the week allows with its share kept back).
export function lineReaches(used: number, resetsAt: number, keepBack: number) {
  const most = 1 - keepBack / 100;
  return most <= 0 || used >= most ? resetsAt : Math.min(resetsAt, Math.ceil(resetsAt - WEEK_S + (used / most) * WEEK_S));
}
// The share of the week kept back, in percent: FACTORY_USAGE_KEEP_BACK, else the profile's "keep
// back" (or "stop below", its row's old name), else 15. null: "off", the week isn't acted on.
// Anything that isn't a share is taken as the default, never as off.
export function keepBack(env: NodeJS.ProcessEnv = process.env): number | null {
  const v = (env.FACTORY_USAGE_KEEP_BACK || profileGet("keep back", "", env) || profileGet("stop below", "", env)).trim().replace(/\s*%$/, "");
  if (v.toLowerCase() === "off") return null;
  const n = /^\d+(\.\d+)?$/.test(v) ? Number(v) : NaN;
  return n >= 0 && n <= 100 ? n : 15;
}

// jq's order, for comparing whatever a transcript holds: null < false < true < numbers < strings < arrays < objects.
const rank = (x: Json | undefined) => x === null || x === undefined ? 0 : x === false ? 1 : x === true ? 2 : typeof x === "number" ? 3 : typeof x === "string" ? 4 : Array.isArray(x) ? 5 : 6;
const le = (a: Json | undefined, b: Json) => rank(a) !== rank(b) ? rank(a) < rank(b) : typeof a === "number" || typeof a === "string" ? a <= (b as typeof a) : true;
const or = (x: Json | undefined, d: Json) => x === null || x === undefined || x === false ? d : x;

// Each window's share used (0 once its reset has passed) and its reset, when the reading was,
// and the week's line: the share kept back, the share the line allows now, and until when the
// lanes pause for it (null unless they're ahead of it). No line (null) without the week's
// figures, or with keep back off.
export function usageJson(ev: Obj | null, now = epoch(), keep: number | null = null): Obj {
  try {
    const info = ev === null ? null : or(ev.rate_limit_info, null);
    if (info !== null && !isObj(info)) return {};
    const w = info === null ? null : or(info.unifiedWindows, null);
    if (w !== null && !isObj(w)) return {};
    const win = (x: Json | undefined): Json => {
      if (x === null || x === undefined) return null;
      if (!isObj(x)) throw new Error("not a window");
      return { used: le(or(x.resetsAt, 0), now) ? 0 : or(x.utilization, 0), resetsAt: x.resetsAt ?? null };
    };
    const week = win(w?.seven_day);
    let line: Json = null;
    if (keep !== null && isObj(week) && typeof week.used === "number" && typeof week.resetsAt === "number") {
      const until = lineReaches(week.used, week.resetsAt, keep);
      line = { keepBack: keep, allowed: lineAt(week.resetsAt, now, keep), pausedUntil: now < until ? until : null };
    }
    return { five_hour: win(w?.five_hour), seven_day: week, asOf: ev === null ? null : ev.at ?? null, line };
  } catch { return {}; }
}

export interface Usage { ev: Obj | null; json: Obj; now: number }
// What's known now: the machine's newest reading (newest(), which writes this factory's there
// when it's the newer), as numbers.
export function readUsage(root: string, env: NodeJS.ProcessEnv = process.env): Usage {
  const now = epoch(), ev = newest(root, env, now);
  return { ev, json: usageJson(ev, now, keepBack(env)), now };
}

// Percent, rounded up, so 92.5% used counts as under 8% left; null if not known. (Rounded to a
// millionth first: 0.07 × 100 is a hair over 7 as a float, and isn't 8%.)
const up = (x: Json | undefined) => typeof x === "number" ? Math.ceil(Math.round(x * 1e6) / 1e4) : null;
// The line's percent, to a tenth, rounded down: readings come in whole percents, so a lane
// paused at 43% used reads "the line is at 42.6%", never a line that looks reached.
const tenth = (x: Json | undefined) => typeof x === "number" ? (Math.floor(Math.round(x * 1e6) / 1e3) / 10).toFixed(1) : "";
const pct = (u: Usage, k: string) => { const w = u.json[k]; return up(isObj(w) ? w.used : null); };
// How long before now an epoch was: "40 min ago", "5h ago", "3 days ago".
function ago(u: Usage, t: number) {
  const s = Math.max(0, u.now - t);
  return s < 5400 ? `${Math.floor(s / 60)} min ago` : s < 172800 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)} days ago`;
}
function resets(u: Usage, k: string, fmt: (d: Date) => string) {
  const w = u.json[k], t = isObj(w) ? w.resetsAt : null;
  return typeof t === "number" ? fmt(new Date(t * 1000)) : "";
}
export const dayHmAt = (t: number) => dayHm(new Date(t * 1000));
// Where the week is against its line: "62% used, the line is at 58.3%"; "" with no line.
function against(u: Usage) {
  const l = u.json.line;
  return isObj(l) ? `${pct(u, "seven_day") ?? ""}% used, the line is at ${tenth(l.allowed)}%` : "";
}

export function usageShow(u: Usage, root = "") {
  if (!u.ev) return "usage: not known yet (no session transcript with a rate_limit_event)";
  const t = u.json.asOf, from = u.ev.from;
  // Another factory's lanes read it: say whose, so a pause here with no session of its own is explained.
  const whose = typeof from === "string" && root && from !== root ? `, read by ${path.basename(from)}'s lanes` : "";
  const asof = typeof t === "number" ? ` (as of ${dayHm(new Date(t * 1000))}, ${ago(u, t)}${whose})` : "";
  const l = u.json.line;
  const week = isObj(l)
    ? `week ${against(u)}${typeof l.pausedUntil === "number" ? `: lanes pause until ${dayHmAt(l.pausedUntil)}` : ""}; resets ${resets(u, "seven_day", dayHm)}`
    : `week ${pct(u, "seven_day") ?? ""}% used, resets ${resets(u, "seven_day", dayHm)}`;
  return `usage${asof}: 5-hour window ${pct(u, "five_hour") ?? ""}% used, resets ${resets(u, "five_hour", hm)} · ${week}`;
}

// A pause the lanes take between units: for which window, why (as its event says it), the epoch
// they resume at, whether that's the window's reset (the loop then waits its slack past it), and
// what the resume says.
export interface Pause { window: "5-hour" | "week"; why: string; until: number; reset: boolean; back: string }

// What the loop does next: 0 carry on; 4 pause, until the 5-hour window resets or the week's
// line reaches what's used (the later, when both hold).
export function usageCheck(u: Usage, env: NodeJS.ProcessEnv = process.env): { code: 0 | 4; out?: string; pause?: Pause } {
  if (!u.ev) return { code: 0 };
  const int = (s: string) => /^\s*-?\d+\s*$/.test(s) ? Number(s) : null;
  const pauseLeft = int(env.FACTORY_USAGE_PAUSE_LEFT || profileGet("pause below", "8", env));
  const pauses: Pause[] = [];
  const f = pct(u, "five_hour"), fw = u.json.five_hour;
  if (f !== null && pauseLeft !== null && 100 - f < pauseLeft && isObj(fw) && typeof fw.resetsAt === "number") {
    pauses.push({ window: "5-hour", why: `under ${pauseLeft}% of the 5-hour window left`, until: fw.resetsAt, reset: true, back: "the 5-hour window reset" });
  }
  const l = u.json.line, sw = u.json.seven_day;
  if (isObj(l) && typeof l.pausedUntil === "number" && isObj(sw)) {
    const reset = l.pausedUntil === sw.resetsAt;
    pauses.push({ window: "week", why: `the week is ahead of its line (${against(u)})`, until: l.pausedUntil, reset,
      back: reset ? "the week reset" : `the week's line reached what's used (${pct(u, "seven_day")}%)` });
  }
  if (!pauses.length) return { code: 0 };
  const pause = pauses.reduce((a, b) => b.until > a.until ? b : a);
  return { code: 4, out: `${pause.until}\n${pause.why}`, pause };
}

export function usageCli(args: string[], env: NodeJS.ProcessEnv = process.env): number {
  const cmd = args[0] ?? "show";
  if (asksHelp(args)) { console.log(HELP); return 0; }
  if (!enterRoot("usage.sh", env)) return 1;
  const root = factoryRoot(env.FACTORY_ROOT!);
  const u = readUsage(root, env);
  switch (cmd) {
    case "json": console.log(JSON.stringify(u.json)); return 0;
    case "show": console.log(usageShow(u, root)); return 0;
    case "check": { const c = usageCheck(u, env); if (c.out !== undefined) console.log(c.out); return c.code; }
    default: console.error(`usage.sh: unknown command ${cmd} (show | check | json)`); return 2;
  }
}
