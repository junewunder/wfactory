// The scorecard's records, read as they are (scorecard.ts): the tracker's log, once; this
// machine's lanes' run index and events (the checkout's runs/ and each <checkout>-lane<N>/runs/
// beside it); the heavy-job history in the machine's wfactory state folder; and the tracker's
// project, groups and predictions. Nothing is written and nothing is asked of another process
// beyond git naming the checkout's origin, as the tracker does to find its state. A line or row
// these readers don't understand goes to `unknown`, named, never dropped.
import fs from "node:fs";
import path from "node:path";
import { makeContext } from "../../tracker/src/ctx.ts";
import type { LogEntry, Prediction } from "../../tracker/src/types.ts";
import { EVENTS_PROBLEM, EVENTS_SUMMARY, EVENTS_WAKE } from "./fleet-help.ts";
import { jobsHome } from "./heavy.ts";
import { host as hostOf } from "./sys.ts";

// One row of a lane's runs/index.tsv: a session, or a group's CI run (ci). started is epoch
// seconds; end is started plus its whole minutes.
export interface Row { lane: string; started: number; end: number; tag: string; unit: string; title: string; result: string; cost: number | null; minutes: number; ci: boolean }
// One line of a lane's runs/events.log: t is epoch seconds (the minute it names), unit its sixth
// field if it has one.
export interface Ev { lane: string; t: number; kind: string; msg: string; unit: string }
export interface Unknown { where: string; what: string }
export interface Group { id: string; title: string; params: Record<string, unknown> }
export interface Records {
  host: string;
  root: string;            // the checkout the lanes are clones of
  lanes: string[];         // their labels, as `just runs` shows them: checkout, lane1, …
  log: LogEntry[];
  rows: Row[];
  events: Ev[];
  history: Record<string, { secs?: number[] }>;
  ciSteps: Record<string, { cmd?: string }>;
  groups: Group[];
  predictions: Prediction[];
  unknown: Unknown[];
  logAge: number | null;   // seconds since the copy of main's log was fetched; null: the checkout's own
}

// Every command the tracker writes to its log (tracker/src: log(T, "<cmd>", …)), and two older
// ones still in logs. A test keeps the list whole.
export const LOG_CMDS = new Set(`add add-group add-unit answer aside-set ask block check check-ready checked-in ci-fail ci-fix-shared
  ci-known ci-pass ci-retry ci-split ci-start ci-touch ci-unclaim claim decide done drop edit edit-group expect expect-settle focus
  landing lanes-stopped lease merged note overseer park pass prune priority publish rebuilt release rename reopen review settle sync
  unclaim unpark withdraw ci-lost`.split(/\s+/));
// Every kind of event the lanes and daemons write (EVENTS_* in fleet-help.ts and the kinds no tier
// names), and an older one. A project's own kinds (tracker/project.json "events") count too.
export const EVENT_KINDS = new Set([...EVENTS_WAKE, ...EVENTS_SUMMARY, ...EVENTS_PROBLEM,
  ..."overlong store-empty store-moved store-seeded store-up-retried usage-stop".split(" ")]);

const read = (f: string): string | null => { try { return fs.readFileSync(f, "utf8"); } catch { return null; } };
const parse = <T>(text: string | null): T | null => { if (text === null) return null; try { return JSON.parse(text) as T; } catch { return null; } };

// A run index's start ("20261021-102459", or "2026-10-21T10:24:59"), local time, as epoch seconds.
export function startedAt(s: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(s) ?? /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (!m) return null;
  const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0)).getTime();
  return Number.isNaN(t) ? null : Math.floor(t / 1000);
}
// An events.log time ("2026-10-21 11:18", local) as epoch seconds.
const eventAt = (s: string) => { const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{1,2}):(\d{2})$/.exec(s); return m ? Math.floor(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])).getTime() / 1000) : null; };

// The records as the checkout in cwd sees them.
export function readRecords(env: NodeJS.ProcessEnv, cwd: string): Records {
  const unknown: Unknown[] = [];
  // The tracker's state where its commands read it (origin's main in .tracker/main), else the
  // checkout's own tracker/ (no copy of main made yet).
  const c = makeContext(env, "scorecard", cwd);
  const own = path.join(c.ROOT, "tracker");
  const tdir = fs.existsSync(path.join(c.TDIR, "project.json")) ? c.TDIR : own;
  // (Not fetched here: no network. How old the copy is goes in the header.)
  let logAge: number | null = null;
  if (tdir !== own) { try { logAge = Math.max(0, Math.round((Date.now() - fs.statSync(path.join(c.SDIR, ".git", "FETCH_HEAD")).mtimeMs) / 1000)); } catch {} }
  const project = parse<{ ci?: { steps?: Record<string, { cmd?: string }> }; events?: { wake?: unknown; summary?: unknown } }>(read(path.join(tdir, "project.json"))) ?? {};
  const kinds = new Set([...EVENT_KINDS, ...[project.events?.wake, project.events?.summary].flatMap((x) => Array.isArray(x) ? x.map(String) : [])]);

  // The log, read once.
  const log: LogEntry[] = [];
  const text = read(path.join(tdir, "log.jsonl")) ?? "";
  for (const l of text.split("\n")) {
    if (!l.trim()) continue;
    const e = parse<LogEntry>(l);
    if (!e || typeof e !== "object" || typeof e.cmd !== "string" || typeof e.at !== "string") { unknown.push({ where: "the tracker's log", what: "a line that isn't a log entry" }); continue; }
    if (!LOG_CMDS.has(e.cmd)) unknown.push({ where: "the tracker's log", what: `"${e.cmd}"` });
    log.push(e);
  }

  // This machine's lanes: the checkout and its clones beside it.
  const root = c.ROOT.replace(/-lane[0-9]+$/, "");
  const parent = path.dirname(root), base = path.basename(root);
  let sibs: string[] = [];
  try { sibs = fs.readdirSync(parent).filter((d) => new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-lane[0-9]+$`).test(d)).sort((a, b) => Number(a.slice(base.length + 5)) - Number(b.slice(base.length + 5))); } catch {}
  const rows: Row[] = [], events: Ev[] = [], lanes: string[] = [];
  for (const d of [root, ...sibs.map((s) => path.join(parent, s))]) {
    const lane = d === root ? "checkout" : `lane${d.slice(root.length + 5)}`;
    const idx = read(path.join(d, "runs", "index.tsv")), evs = read(path.join(d, "runs", "events.log"));
    if (idx === null && evs === null) continue;
    lanes.push(lane);
    for (const l of (idx ?? "").split("\n").slice(1)) {
      if (!l.trim()) continue;
      const f = l.split("\t"), t = startedAt(f[0] ?? "");
      const mins = Number(f[7]);
      if (f.length < 8 || t === null || !Number.isFinite(mins)) { unknown.push({ where: `${lane}'s run index`, what: "a row that doesn't parse" }); continue; }
      const m = /^(.*) \(([^()]+)\)$/.exec(f[3]);
      const ci = f[4].startsWith("CI ") && f[5] === "" && f[6] === "";
      const cost = f[6] === "" ? null : Number(f[6]);
      rows.push({ lane, started: t, end: t + mins * 60, tag: f[1], unit: ci ? "" : m?.[2] ?? "", title: m?.[1] ?? f[3], result: f[4], cost: Number.isFinite(cost) ? cost : null, minutes: mins, ci });
    }
    for (const l of (evs ?? "").split("\n")) {
      if (!l.trim()) continue;
      const f = l.split("\t"), t = eventAt(f[0] ?? "");
      if (f.length < 5 || t === null) { unknown.push({ where: `${lane}'s events`, what: "a line that doesn't parse" }); continue; }
      if (!kinds.has(f[3])) unknown.push({ where: `${lane}'s events`, what: `"${f[3]}"` });
      events.push({ lane, t, kind: f[3], msg: f[4], unit: f[5] ?? "" });
    }
  }
  rows.sort((a, b) => a.started - b.started);
  events.sort((a, b) => a.t - b.t);

  // The heavy-job history: this project's commands only.
  const histFile = path.join(jobsHome(env), "history.json"), histText = read(histFile);
  const all = parse<Record<string, { secs?: number[] }>>(histText);
  if (histText !== null && (!all || typeof all !== "object")) unknown.push({ where: "the heavy-job history", what: "a file that isn't JSON" });
  const history: Records["history"] = {};
  for (const [k, v] of Object.entries(all ?? {})) if (k.startsWith(`${base}\t`)) history[k.slice(base.length + 1)] = v;

  const groups: Group[] = [];
  try {
    for (const f of fs.readdirSync(path.join(tdir, "groups")).filter((x) => x.endsWith(".json")).sort()) {
      const g = parse<{ id?: string; title?: string; params?: Record<string, unknown> }>(read(path.join(tdir, "groups", f)));
      if (g?.id) groups.push({ id: g.id, title: g.title ?? g.id, params: g.params ?? {} });
    }
  } catch {}
  const predictions = parse<{ predictions?: Prediction[] }>(read(path.join(tdir, "predictions.json")))?.predictions ?? [];
  return { host: hostOf(env), root, lanes, log, rows, events, history, ciSteps: project.ci?.steps ?? {}, groups, predictions, unknown, logAge };
}
