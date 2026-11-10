// The tracker's state on disk: the only module that knows it's JSON files in tracker/, and
// where they are (a clone of origin's main, or this checkout).
//
//   tracker/project.json        name, resources, loops, schema version
//   tracker/groups/<group>.json a group and its units
//   tracker/templates/<t>.json  unit templates ("add Milo" makes his units)
//   tracker/questions.json      questions for the owner, open and answered
//   tracker/decisions.json      the owner's answers and agents' judgement calls
//   tracker/predictions.json    what changes are expected to move on the scorecard (just scorecard expect)
//   tracker/leases.json         which machine leases which group's data, and each machine's heartbeat
//   tracker/log.jsonl           one line per write (merge=union)
//   .tracker/                   gitignored: probe cache, view.html, lock, and main/
//
// Commands read the state with load() and change it inside mutate(): read, change and
// write under the lock, and with an origin, commit and push to origin's main at once.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ctx, git } from "./ctx.ts";
import { procStart } from "./proc.ts";
import { LockBusy, NetError, die, now, writeAtomic } from "./text.ts";
import type { Decision, Group, LogEntry, Prediction, Project, Question, State, Unit, Lease, Overseer } from "./types.ts";

export const SCHEMA = 1;
// How priorities rank (urgentToPriority): 2 = a unit by the higher of its own and its group's.
export const RANKING = 2;

// The state's files, and this checkout's own (.tracker/: cache, page, lock).
function files() {
  const { TDIR, CDIR } = ctx;
  return {
    project: path.join(TDIR, "project.json"),
    groups: path.join(TDIR, "groups"),
    templates: path.join(TDIR, "templates"),
    questions: path.join(TDIR, "questions.json"),
    decisions: path.join(TDIR, "decisions.json"),
    predictions: path.join(TDIR, "predictions.json"),
    leases: path.join(TDIR, "leases.json"),
    log: path.join(TDIR, "log.jsonl"),
    cache: path.join(CDIR, "cache.json"),
    view: path.join(CDIR, "view.html"),
    lock: path.join(CDIR, "lock"),
  };
}
// dir has a tracker (the repo's root, for ctx.ts; init, which makes one).
export const hasStateAt = (dir: string) => fs.existsSync(path.join(dir, "tracker", "project.json"));
// Where the owner's page goes (view.ts).
export const viewFile = () => files().view;

function readJSON<V>(f: string, dflt?: V): V {
  if (!fs.existsSync(f)) return dflt as V;
  try { return JSON.parse(fs.readFileSync(f, "utf8")); }
  catch (e) { return die(`${path.relative(ctx.ROOT, f)} isn't valid JSON (${(e as Error).message}). It's written only by the tracker CLI; restore it from git.`); }
}

// Pretty JSON that diffs well: short arrays of scalars stay on one line.
export function pretty(v: unknown, ind = ""): string {
  const pad = ind + "  ";
  if (Array.isArray(v)) {
    if (!v.length) return "[]";
    if (v.every((x) => x === null || typeof x !== "object")) {
      const one = "[" + v.map((x) => JSON.stringify(x)).join(", ") + "]";
      if (one.length + ind.length < 100) return one;
    }
    return "[\n" + v.map((x) => pad + pretty(x, pad)).join(",\n") + "\n" + ind + "]";
  }
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const ks = Object.keys(o).filter((k) => o[k] !== undefined);
    if (!ks.length) return "{}";
    return "{\n" + ks.map((k) => pad + JSON.stringify(k) + ": " + pretty(o[k], pad)).join(",\n") + "\n" + ind + "}";
  }
  return JSON.stringify(v);
}

// ---------------------------------------------------------------- the lock

// The lock's owner is gone (or its PID now belongs to another process). A live owner keeps
// it however long it takes (refresh runs probes of up to 15 minutes each); only a lock that
// never got its owner written goes after 20 minutes.
function staleLock() {
  const P = files();
  let age = 0, owner = 0, start = "";
  try { age = Date.now() - fs.statSync(P.lock).mtimeMs; } catch { return false; }
  try { const [o, s = ""] = fs.readFileSync(path.join(P.lock, "pid"), "utf8").trim().split(" "); owner = Number(o); start = s; } catch {}
  if (!(owner > 0)) return age > 1_200_000;
  const now = procStart(owner);
  return now === null || !!(start && now !== start);
}
// Under the lock, any writeAtomic temp file is one a crashed write left: never committed.
function sweepTmp() {
  const walk = (d: string) => { let es: fs.Dirent[] = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (/\.tmp-\d+$/.test(e.name)) { try { fs.rmSync(f); } catch {} } } };
  walk(ctx.TDIR);
}
let lockDepth = 0;
export function withLock<R>(fn: () => R): R {
  const P = files();
  if (lockDepth) { lockDepth++; try { return fn(); } finally { lockDepth--; } }
  fs.mkdirSync(ctx.CDIR, { recursive: true });
  const w = Number(ctx.env.FACTORY_LOCK_WAIT || 30), t0 = Date.now(), wait = (Number.isFinite(w) && w >= 0 ? w : 30) * 1000;
  for (;;) {
    try { fs.mkdirSync(P.lock); break; } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      // Breaking a stale lock happens under a second, short-lived lock, and only after looking
      // again: two processes that both saw it stale would otherwise each remove it, the second
      // removing the first's new lock, and both would be in.
      if (staleLock()) {
        let broke = false;
        try { fs.mkdirSync(P.lock + ".break"); broke = true; } catch (e2) {
          if ((e2 as NodeJS.ErrnoException).code !== "EEXIST") throw e2;
          // A breaker that died mid-break (it takes milliseconds) goes after 10 s.
          try { if (Date.now() - fs.statSync(P.lock + ".break").mtimeMs > 10_000) fs.rmSync(P.lock + ".break", { recursive: true, force: true }); } catch {}
        }
        if (broke) { try { if (staleLock()) fs.rmSync(P.lock, { recursive: true, force: true }); } catch {} finally { fs.rmSync(P.lock + ".break", { recursive: true, force: true }); } continue; }
      }
      if (Date.now() - t0 > wait) throw new LockBusy("the tracker is locked by another command (.tracker/lock); try again");
      spawnSync("sleep", ["0.1"], { env: ctx.env });
    }
  }
  try { fs.writeFileSync(path.join(P.lock, "pid"), `${process.pid} ${procStart(process.pid) || ""}`); } catch {}
  lockDepth = 1;
  sweepTmp();
  try { return fn(); } finally { lockDepth = 0; try { fs.rmSync(P.lock, { recursive: true, force: true }); } catch {} }
}

// ---------------------------------------------------------------- reading and writing

export function load(): State {
  const P = files();
  if (!fs.existsSync(P.project)) die(`no tracker here (${path.relative(ctx.cwd, P.project) || P.project}). Run from a factory repo, or \`tracker init\`.`);
  const project = readJSON<Project>(P.project);
  if ((project.schema || 0) > SCHEMA) die(`tracker/ is schema ${project.schema}, and this CLI knows ${SCHEMA}. Update the wfactory skill.`);
  const groups: Group[] = [];
  for (const f of fs.existsSync(P.groups) ? fs.readdirSync(P.groups).filter((f) => f.endsWith(".json")).sort() : []) {
    const g = readJSON<Group>(path.join(P.groups, f));
    g.units ||= [];
    groups.push(g);
  }
  const focused = focusToPriority(project, groups);
  const urgent = urgentToPriority(project, groups);
  groups.sort((a, b) => (b.priority || 0) - (a.priority || 0) || (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id));
  const L = readJSON<{ leases?: Lease[]; hosts?: Record<string, string>; overseer?: Overseer }>(P.leases, {});
  const T: State = {
    project, groups,
    questions: readJSON<{ questions: Question[] }>(P.questions, { questions: [] }).questions,
    decisions: readJSON<{ decisions: Decision[] }>(P.decisions, { decisions: [] }).decisions,
    predictions: readJSON<{ predictions: Prediction[] }>(P.predictions, { predictions: [] }).predictions,
    leases: L.leases || [], hosts: L.hosts || {}, overseer: L.overseer || null,
    byId: new Map(), groupOf: new Map(), groupById: new Map(), dirty: new Set(), logs: [],
  };
  for (const g of groups) {
    T.groupById.set(g.id, g);
    g.units.forEach((u, i) => { T.byId.set(u.id, u); T.groupOf.set(u.id, g); u._i = i; });
  }
  if (focused) T.dirty.add("project");
  if (focused?.length) {
    for (const g of focused) T.dirty.add("group:" + g.id);
    log(T, "focus", null, `focus became group priority: ${focused.map((g) => `${g.title} ${g.priority}`).join(", ")}`);
  }
  if (urgent) T.dirty.add("project");
  if (urgent?.length) {
    for (const u of urgent) T.dirty.add("group:" + T.groupOf.get(u.id)!.id);
    const few = urgent.slice(0, 10).map((u) => `${u.title} ${u.priority}`).join(", ");
    log(T, "priority", null, `priorities of 100 or more, which ran ahead of every group, now rank above them all: ${few}${urgent.length > 10 ? ` and ${urgent.length - 10} more` : ""}`);
  }
  return T;
}

// Trackers from before priority was the only order kept a focus list: groups that ran before
// every other, in its order. It becomes priorities above the highest of the rest, so ready units
// and due CI run in the order they did (and interrupted, broken and review units, which follow
// group priority, now favour those groups too). A mutate() writes it; a read just sorts by it.
function focusToPriority(project: Project, groups: Group[]): Group[] | null {
  if (!project.focus) return null;
  const focus = project.focus.map((id) => groups.find((g) => g.id === id)).filter((g, i, a): g is Group => !!g && a.indexOf(g) === i);
  delete project.focus;
  const top = Math.max(0, ...groups.filter((g) => !focus.includes(g)).map((g) => g.priority || 0));
  focus.forEach((g, i) => { g.priority = top + focus.length - i; });
  return focus;
}

// Trackers from before one order (2026-10) ranked a unit's own priority only against its group's
// other units, unless it was 100 or more: then it ran ahead of every group. Now a unit ranks by
// the higher of its own priority and its group's, so each unit at 100 or more becomes the top
// group priority plus its old one, and still runs ahead of every group (among themselves they now
// go by their old priority, not by group). A mutate() writes it, with ranking set; a read just
// sorts by it.
function urgentToPriority(project: Project, groups: Group[]): Unit[] | null {
  if ((project.ranking ?? 0) >= RANKING) return null;
  project.ranking = RANKING;
  const top = Math.max(0, ...groups.map((g) => g.priority || 0));
  const out: Unit[] = [];
  for (const g of groups) for (const u of g.units) if ((u.priority || 0) >= 100) { u.priority = top + u.priority!; out.push(u); }
  return out;
}

// The order keys are written in, which keeps diffs small and files alike.
const UNIT_KEYS = ["id", "title", "kind", "detail", "check", "probe", "needs", "uses", "tags", "model", "host", "caps", "data", "reads", "lane", "branch", "priority", "minMinutes", "template", "params", "record", "notes", "review", "landCheck", "round", "aside", "also"];
const GROUP_KEYS = ["id", "title", "template", "params", "priority", "order", "host", "data", "needs", "ci", "units"];
const order = (o: object, keys: string[]) => { const r: Record<string, unknown> = {}; for (const k of keys) { const v = (o as Record<string, unknown>)[k]; if (v === undefined || v === null || (Array.isArray(v) && !v.length && k !== "units") || v === "") continue; r[k] = v; } return r; };
const groupFile = (g: Group) => { const out = order(g, GROUP_KEYS); out.units = g.units.map((u) => order(u, UNIT_KEYS)); return out; };

// Called after every write with the state as written (view.ts rebuilds the owner's page).
let afterSave: ((T: State) => void) | null = null;
export const onSaved = (fn: (T: State) => void) => { afterSave = fn; };

function save(T: State) {
  const P = files(), d = T.dirty;
  if (d.has("project")) writeAtomic(P.project, pretty(T.project) + "\n");
  if (d.has("questions")) writeAtomic(P.questions, pretty({ questions: T.questions }) + "\n");
  if (d.has("decisions")) writeAtomic(P.decisions, pretty({ decisions: T.decisions }) + "\n");
  if (d.has("predictions")) writeAtomic(P.predictions, pretty({ predictions: T.predictions }) + "\n");
  if (d.has("leases")) writeAtomic(P.leases, pretty({ leases: T.leases, ...(Object.keys(T.hosts).length ? { hosts: T.hosts } : {}), ...(T.overseer ? { overseer: T.overseer } : {}) }) + "\n");
  for (const g of T.groups) {
    if (!d.has("group:" + g.id)) continue;
    writeAtomic(path.join(P.groups, g.id + ".json"), pretty(groupFile(g)) + "\n");
  }
  if (T.logs.length) {
    fs.mkdirSync(ctx.TDIR, { recursive: true });
    fs.appendFileSync(P.log, T.logs.map((l) => JSON.stringify(l)).join("\n") + "\n");
  }
  if ((d.size || T.logs.length) && afterSave) { try { afterSave(load()); } catch (e) { process.stderr.write(`(view not rebuilt: ${(e as Error).message})\n`); } }
}
// Mark a unit's group to be written.
export const touch = (T: State, u: Unit) => T.dirty.add("group:" + (T.groupOf.get(u.id)?.id ?? u));
export function log(T: State, cmd: string, id: string | null, text: string, extra: { actor?: string; more?: Record<string, unknown> } = {}) {
  T.logs.push({ at: now(), actor: extra.actor || ctx.ACTOR, tag: ctx.TAG, host: ctx.HOST, cmd, ...(id ? { id } : {}), text, ...extra.more });
}

// The log, oldest line first as written; null if there's none. Lines that don't parse are skipped.
export function readLog(): LogEntry[] | null {
  if (!fs.existsSync(files().log)) return null;
  return fs.readFileSync(files().log, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l) as LogEntry; } catch { return null; } }).filter((x): x is LogEntry => !!x);
}
export const hasState = () => fs.existsSync(files().project);
// Where the state's tracker/ folder is.
export const stateDir = () => ctx.TDIR;
// Each group file's name and the id inside it (lint: they must agree).
export function groupFiles(): { file: string; id: string }[] {
  const P = files();
  const fs_ = fs.existsSync(P.groups) ? fs.readdirSync(P.groups).filter((f) => f.endsWith(".json")) : [];
  return fs_.map((f) => ({ file: f, id: readJSON<Group>(path.join(P.groups, f)).id }));
}
// A unit template, tracker/templates/<name>.json.
export function loadTemplate<V>(nm: string): V {
  const f = path.join(files().templates, nm + ".json");
  return readJSON<V>(f) || die(`no template ${path.relative(ctx.ROOT, f)}`);
}

// The probe cache (.tracker/cache.json): what each computed unit's check gave for its inputs.
// secs: how long a command probe took that time.
export interface CacheEntry { fp: string | null; pass: boolean; at: string; evidence: string; secs?: number }
export type ProbeCache = Record<string, CacheEntry>;
export const loadCache = () => readJSON<ProbeCache>(files().cache, {});
export const saveCache = (c: ProbeCache) => writeAtomic(files().cache, JSON.stringify(c));

// A new tracker/ in dir (init).
export function createState(dir: string, project: Project) {
  const t = path.join(dir, "tracker");
  fs.mkdirSync(path.join(t, "groups"), { recursive: true });
  writeAtomic(path.join(t, "project.json"), pretty(project) + "\n");
  writeAtomic(path.join(t, "questions.json"), pretty({ questions: [] }) + "\n");
  writeAtomic(path.join(t, "decisions.json"), pretty({ decisions: [] }) + "\n");
  fs.writeFileSync(path.join(t, "log.jsonl"), "");
}

// ---------------------------------------------------------------- shared state
//
// The state is main's, not this checkout's. When the repo has an `origin`,
// every command reads tracker/ from a small clone of origin's main kept in
// .tracker/main/ (fetched when it's over FACTORY_FETCH_EVERY seconds old,
// default 20), and every write is committed there and pushed to origin's main
// at once. If someone else pushed first, the write is dropped and done again
// on the new state; for a claim that means picking again. So a unit's branch
// never carries tracker/ changes, and a question reaches the overseer within
// seconds. Without an origin (or with FACTORY_STATE=local) tracker/ in this
// checkout is the state, as before.

// The clone of origin's main that holds the state: blobless, tracker/ only.
function ensureState() {
  const { SDIR, CDIR, MAIN, ORIGIN, ROOT } = ctx;
  if (fs.existsSync(path.join(SDIR, ".git"))) return;
  fs.mkdirSync(CDIR, { recursive: true });
  const tmp = `${SDIR}.tmp-${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  let r = git(["clone", "-q", "--no-checkout", "--filter=blob:none", "--branch", MAIN, ORIGIN!, tmp]);
  if (r.status) die(`couldn't clone origin's ${MAIN} for the tracker's state: ${(r.stderr || "").trim()}`);
  git(["-C", tmp, "sparse-checkout", "set", "tracker"]);
  r = git(["-C", tmp, "checkout", "-q", MAIN]);
  if (r.status) die(`couldn't check out the tracker's state: ${(r.stderr || "").trim()}`);
  for (const k of ["user.name", "user.email"]) { const v = git(["-C", ROOT, "config", k]).stdout.trim(); if (v) git(["-C", tmp, "config", k, v]); }
  mergeDriver(tmp);
  fs.renameSync(tmp, SDIR);
}
// git runs `tracker merge-json` for tracker JSON (see .gitattributes); the setting is per clone.
// Through the factory's own stub when it has one: this file's path may be a deployed version
// that's deleted days later. Without one, through tracker.mjs, which finds the Node to run.
function mergeDriver(dir: string) {
  const stub = path.join(ctx.ROOT, "factory", "tracker");
  const want = fs.existsSync(stub) ? `${JSON.stringify(stub)} merge-json %O %A %B %P` : `node ${JSON.stringify(new URL("../tracker.mjs", import.meta.url).pathname)} merge-json %O %A %B %P`;
  if (git(["-C", dir, "config", "merge.tracker-json.driver"]).stdout.trim() !== want) {
    git(["-C", dir, "config", "merge.tracker-json.name", "tracker JSON: keep both sides' entries"]);
    git(["-C", dir, "config", "merge.tracker-json.driver", want]);
  }
}
const ahead = () => Number(git(["-C", ctx.SDIR, "rev-list", "--count", `origin/${ctx.MAIN}..HEAD`]).stdout.trim() || 0);
let synced = false, offlineSaid = false, mutating = false;
// A new command in this process starts unsynced (index.ts run).
export function resetSession() { synced = false; offlineSaid = false; }
// Bring the state up to origin's main. Writes this machine couldn't push (origin
// was unreachable) are replayed on top. Returns false when origin can't be reached.
function syncState({ force = false } = {}) {
  const { ORIGIN, SDIR, MAIN, ROOT } = ctx;
  if (!ORIGIN) return true;
  ensureState();
  mergeDriver(SDIR);
  let age = Infinity;
  try { age = (Date.now() - fs.statSync(path.join(SDIR, ".git", "FETCH_HEAD")).mtimeMs) / 1000; } catch {}
  if (!force && (synced || age < Number(ctx.env.FACTORY_FETCH_EVERY ?? 20))) return true;
  const f = git(["-C", SDIR, "fetch", "-q", "origin", MAIN]);
  synced = true;
  if (f.status) {
    if (!offlineSaid) process.stderr.write(`(couldn't reach origin: the tracker is working from this machine's last copy of main)\n`);
    offlineSaid = true;
    return false;
  }
  if (ahead()) {
    const r = git(["-C", SDIR, "rebase", "-q", `origin/${MAIN}`]);
    if (r.status) {
      git(["-C", SDIR, "rebase", "--abort"]);
      die(`this machine has tracker writes it couldn't push, and they clash with origin's main. They're in ${path.relative(ROOT, SDIR)} (git log origin/${MAIN}..HEAD); redo them by hand, then \`git -C ${path.relative(ROOT, SDIR)} reset --hard origin/${MAIN}\`.`);
    }
  } else git(["-C", SDIR, "reset", "-q", "--hard", `origin/${MAIN}`]);
  return true;
}
// Before a command: git in this checkout merges tracker JSON with the driver, and the state
// is origin's main as of a few seconds ago (writes fetch it themselves).
export function prepare(cmd: string) {
  if (cmd !== "merge-json" && fs.existsSync(path.join(ctx.ROOT, ".git"))) mergeDriver(ctx.ROOT);
  if (ctx.ORIGIN && !["dir"].includes(cmd)) withLock(() => syncState());
}
// Console output from a write that may be done again: printed once it has landed.
function buffered<R>(fn: () => R) {
  const out: [(...x: unknown[]) => void, unknown[]][] = [], ol = console.log, oe = console.error;
  console.log = (...x: unknown[]) => out.push([ol, x]); console.error = (...x: unknown[]) => out.push([oe, x]);
  try { const r = fn(); return { r, flush: () => { for (const [f, x] of out) f(...x); } }; }
  finally { console.log = ol; console.error = oe; }
}

// The first private word (project.json private_words: the first of those files that exists, one
// word a line, # for comments, matched ignoring case) in what this write adds. Tracker writes
// reach origin at once, with no check between, so on a public repo this is the only one in time.
// None of the files there: refused too, since nothing could be checked.
function privateWordAdded(files: string[] | undefined): string | null {
  if (!files?.length) return null;
  const expand = (f: string) => {
    let unset = false;
    const out = f.replace(/^~(?=\/)/, () => ctx.env.HOME ?? "~").replace(/\$(\w+)/g, (_, v) => {
      if (!ctx.env[v]) unset = true;
      return ctx.env[v] ?? "";
    });
    return unset ? null : out;
  };
  const list = files.map(expand).find((f) => f && fs.existsSync(f));
  if (!list) die(`no list of private words on this machine (project.json private_words: ${files.join(", ")}), so this write can't be checked; nothing was recorded. Copy the list here first.`);
  const words = fs.readFileSync(list!, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map((w) => w.toLowerCase());
  const added = git(["-C", ctx.SDIR, "diff", "--cached", "-U0", "--no-ext-diff"]).stdout.split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++")).join("\n").toLowerCase();
  return words.find((w) => added.includes(w)) ?? null;
}

const REFUSED = /rejected|fetch first|non-fast-forward|cannot lock ref|failed to update ref|stale info/;
// Read, change, write: the whole thing under the lock. With shared state, the
// write is committed and pushed to origin's main; if someone pushed first, it's
// thrown away and done again on the new state. strict (claims): a write that
// can't reach origin fails instead of waiting on this machine.
export const mutate = <R>(fn: (T: State) => R, { strict = false } = {}): R => withLock(() => {
  const { ORIGIN, SDIR, MAIN } = ctx;
  if (!ORIGIN || lockDepth > 1 && mutating) { const T = load(); const r = fn(T); save(T); return r; }
  mutating = true;
  try {
    for (let attempt = 1; ; attempt++) {
      const online = syncState({ force: true });
      if (!online && strict) throw new NetError("couldn't reach origin, and a claim has to be pushed to count; trying again later");
      const T = load();
      const b = buffered(() => fn(T));
      save(T);
      git(["-C", SDIR, "add", "-A", "--", "tracker", ":(exclude,glob)tracker/**/*.tmp-*"]);
      if (git(["-C", SDIR, "diff", "--cached", "--quiet"]).status === 0) {
        // Nothing new, but earlier writes this machine couldn't push go now.
        if (online && ahead()) {
          const p = git(["-C", SDIR, "push", "-q", "origin", `HEAD:${MAIN}`]);
          if (p.status && REFUSED.test(p.stderr || "") && attempt < 8) continue;
        }
        b.flush(); return b.r;
      }
      let hit: string | null;
      try { hit = privateWordAdded(T.project.private_words); } catch (e) { git(["-C", SDIR, "reset", "-q", "--hard", "HEAD"]); throw e; }
      if (hit) {
        git(["-C", SDIR, "reset", "-q", "--hard", "HEAD"]);
        die(`this write has a private word in it ("${hit}"), and tracker writes are published at once; nothing was recorded. Say it another way and run it again.`);
      }
      const what = T.logs.map((l) => l.text);
      const msg = `tracker: ${what[0] || ctx.cmd}${what.length > 1 ? ` (and ${what.length - 1} more)` : ""}`;
      const c = git(["-C", SDIR, "commit", "-q", "--no-verify", "-m", msg]);
      if (c.status) die(`couldn't commit the tracker's state: ${(c.stderr || c.stdout).trim()}`);
      if (!online) { b.flush(); process.stderr.write("(not pushed yet: the next tracker write that reaches origin takes it)\n"); return b.r; }
      const p = git(["-C", SDIR, "push", "-q", "origin", `HEAD:${MAIN}`]);
      if (p.status === 0) { b.flush(); return b.r; }
      const refused = REFUSED.test(p.stderr || "");
      if (!refused || attempt >= 8) {
        if (strict) { git(["-C", SDIR, "reset", "-q", "--hard", "HEAD~1"]); throw new NetError(`couldn't push the claim (${(p.stderr || "").trim().split("\n").pop()}); trying again later`); }
        b.flush(); process.stderr.write(`(not pushed yet: ${(p.stderr || "").trim().split("\n").pop()}; the next tracker write takes it)\n`); return b.r;
      }
      // Someone else's write landed first: drop ours and do it again on theirs.
      git(["-C", SDIR, "reset", "-q", "--hard", "HEAD~1"]);
    }
  } finally { mutating = false; }
});

// The leases on origin's main as it is now, read without touching the state clone's files:
// they belong to whoever holds the tracker's lock (a write in progress, a refresh running its
// probes). null without an origin.
export function originLeases(): Lease[] | null {
  const { ORIGIN, SDIR, MAIN } = ctx;
  if (!ORIGIN) return null;
  if (git(["-C", SDIR, "fetch", "-q", "origin", MAIN]).status) die("couldn't reach origin to check the lease");
  const r = git(["-C", SDIR, "show", `origin/${MAIN}:tracker/leases.json`]);
  let ls: Lease[] = []; try { ls = r.status ? [] : JSON.parse(r.stdout).leases || []; } catch { die("couldn't read origin's tracker/leases.json"); }
  return ls;
}

// main's newest commit outside tracker/: the state's own writes land on main all the time, and
// they aren't new work.
export function codeHead({ fresh = false } = {}): string | null {
  if (ctx.codeHead !== undefined && !fresh) return ctx.codeHead;
  const ref = ctx.ORIGIN || git(["-C", ctx.ROOT, "rev-parse", "--verify", "-q", ctx.MAIN]).status ? "HEAD" : ctx.MAIN;
  return (ctx.codeHead = git(["-C", ctx.SDIR, "log", "-1", "--format=%H", ref, "--", ".", ":(exclude)tracker"]).stdout.trim() || null);
}
