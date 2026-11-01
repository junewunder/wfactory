// How much of the plan's usage is left, from the loop's own transcripts.
import fs from "node:fs";
import path from "node:path";
import { profileGet } from "./profile.ts";
import { dayHm, enterRoot, epoch, hm, asksHelp } from "./sys.ts";

export const HELP = `
usage.sh — how much of the plan's usage is left, from the loop's own transcripts.

Every headless session's stream-json log (runs/*.jsonl) carries
\`rate_limit_event\` lines with the share of the plan used and the reset time,
for the 5-hour window and for the week, covering the whole plan (every
machine and chat). This reads the newest one, from the checkout's runs/ and
its lanes' clones beside it, wherever among them it's run (<checkout>-lane<N>/runs/).

A figure is only as fresh as its event: a machine whose last session was hours
ago still shows what the plan was then (before an upgrade, say). So \`show\`
says when its event was (the transcript line before it, else the file's
time), and \`just fleet usage\` asks every machine and points at the newest.

Usage:
  factory/usage.sh show     one line: what's used in each window, when it resets,
                            and how old the reading is
  factory/usage.sh check    exit 0 = carry on; 4 = pause until the 5-hour window
                            resets (prints its epoch)
  factory/usage.sh json     the numbers, for scripts (asOf: the event's epoch)

Threshold (percent of the window LEFT):
  FACTORY_USAGE_PAUSE_LEFT  pause every lane below this much of the 5-hour window. Default:
                            the profile's "pause below", else 8. 0 never pauses.
The week's figure is shown, never acted on.
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

// jq's order, for comparing whatever a transcript holds: null < false < true < numbers < strings < arrays < objects.
const rank = (x: Json | undefined) => x === null || x === undefined ? 0 : x === false ? 1 : x === true ? 2 : typeof x === "number" ? 3 : typeof x === "string" ? 4 : Array.isArray(x) ? 5 : 6;
const le = (a: Json | undefined, b: Json) => rank(a) !== rank(b) ? rank(a) < rank(b) : typeof a === "number" || typeof a === "string" ? a <= (b as typeof a) : true;
const or = (x: Json | undefined, d: Json) => x === null || x === undefined || x === false ? d : x;

// Each window's share used (0 once its reset has passed) and its reset, and when the reading was.
export function usageJson(ev: Obj | null, now = epoch()): Obj {
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
    return { five_hour: win(w?.five_hour), seven_day: win(w?.seven_day), asOf: ev === null ? null : ev.at ?? null };
  } catch { return {}; }
}

export interface Usage { ev: Obj | null; json: Obj; now: number }
export const readUsage = (root: string): Usage => { const ev = latest(root); return { ev, json: usageJson(ev), now: epoch() }; };

// Percent used, rounded up, so 92.5% used counts as under 8% left; null if not known.
function pct(u: Usage, k: string) {
  const w = u.json[k];
  const used = isObj(w) ? w.used : null;
  return typeof used === "number" ? Math.ceil(used * 100) : null;
}
// How long before now an epoch was: "40 min ago", "5h ago", "3 days ago".
function ago(u: Usage, t: number) {
  const s = Math.max(0, u.now - t);
  return s < 5400 ? `${Math.floor(s / 60)} min ago` : s < 172800 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)} days ago`;
}
function resets(u: Usage, k: string, fmt: (d: Date) => string) {
  const w = u.json[k], t = isObj(w) ? w.resetsAt : null;
  return typeof t === "number" ? fmt(new Date(t * 1000)) : "";
}

export function usageShow(u: Usage) {
  if (!u.ev) return "usage: not known yet (no session transcript with a rate_limit_event)";
  const t = u.json.asOf;
  const asof = typeof t === "number" ? ` (as of ${dayHm(new Date(t * 1000))}, ${ago(u, t)})` : "";
  return `usage${asof}: 5-hour window ${pct(u, "five_hour") ?? ""}% used, resets ${resets(u, "five_hour", hm)} · week ${pct(u, "seven_day") ?? ""}% used, resets ${resets(u, "seven_day", dayHm)}`;
}

// What the loop does next: 0 carry on; 4 pause, with the 5-hour window's reset.
export function usageCheck(u: Usage, env: NodeJS.ProcessEnv = process.env): { code: 0 | 4; out?: string } {
  if (!u.ev) return { code: 0 };
  const int = (s: string) => /^\s*-?\d+\s*$/.test(s) ? Number(s) : null;
  const pauseLeft = int(env.FACTORY_USAGE_PAUSE_LEFT || profileGet("pause below", "8", env));
  const f = pct(u, "five_hour");
  if (f !== null && pauseLeft !== null && 100 - f < pauseLeft) {
    const fw = u.json.five_hour;
    return { code: 4, out: String(isObj(fw) ? fw.resetsAt ?? null : null) };
  }
  return { code: 0 };
}

export function usageCli(args: string[], env: NodeJS.ProcessEnv = process.env): number {
  const cmd = args[0] ?? "show";
  if (asksHelp(args)) { console.log(HELP); return 0; }
  if (!enterRoot("usage.sh", env)) return 1;
  const root = env.FACTORY_ROOT!;
  // The checkout, also when run in one of its lane clones.
  const lane = [...root.matchAll(/-lane[0-9]/g)].pop();
  const u = readUsage(lane ? root.slice(0, lane.index) : root);
  switch (cmd) {
    case "json": console.log(JSON.stringify(u.json)); return 0;
    case "show": console.log(usageShow(u)); return 0;
    case "check": { const c = usageCheck(u, env); if (c.out !== undefined) console.log(c.out); return c.code; }
    default: console.error(`usage.sh: unknown command ${cmd} (show | check | json)`); return 2;
  }
}
