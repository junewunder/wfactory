// What this machine and its lanes can take: claims alive or not, the lanes' locks,
// resources, capabilities, and the leases on groups' data.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { lockHeld as fileLockHeld } from "../../runtime/src/sys.ts";
import { ctx } from "./ctx.ts";
import { procStart } from "./proc.ts";
import { log } from "./store.ts";
import { die, list, now } from "./text.ts";
import type { CiRun, Group, Lease, Liveness, State, Unit, UnitRecord } from "./types.ts";

// ---------------------------------------------------------------- liveness

// A claim or CI run on another machine: one the loop made (`beats`) lives while that machine's
// heartbeat is fresh (`lease beat`), so a dead laptop's work frees up in FACTORY_LEASE_STALE;
// one made by hand, up to 12 hours.
export function claimAlive(T: State, r: Liveness) {
  if (r.ended) return false;
  const age = Date.now() - Date.parse(r.at);
  if (r.host && r.host !== ctx.HOST) return age < 12 * 3600e3 && (!r.beats || age < ctx.STALE_MS || hostBeatAge(T, r.host) < ctx.STALE_MS);
  if (r.pid) return procStart(r.pid) === r.start;
  return age < 2 * 3600e3;
}
// The groups a session on this machine is working on now, other than this session's own: each
// live claim's group and the group whose data it works on, with the units that hold them. Lanes
// here share work/, so what such a group has there is that session's, half-written. (`busy`
// also counts claims that ended there; these are only the live ones.)
export function heldHere(T: State) {
  const out = new Map<string, Unit[]>();
  for (const u of T.byId.values()) {
    const r = u.record;
    if (r?.state !== "claimed" || r.host !== ctx.HOST || (r.by === ctx.TAG && ctx.TAG !== "manual") || !claimAlive(T, r)) continue;
    for (const g of new Set([T.groupOf.get(u.id)?.id, dataGroup(T, u)])) if (g && T.groupOf.get(u.id)?.id !== "merge") out.set(g, [...(out.get(g) || []), u]);
  }
  return out;
}

// A unit recorded finished on its branch keeps its claim's life as its landing claim: the lane that
// worked it lands it while that lane lives, and no other lane takes it from under it meanwhile.
export const landingOf = (r: Partial<UnitRecord>): { landing?: Liveness } => r.state === "claimed" && r.branch && !r.ended
  ? { landing: { at: now(), by: r.by, host: r.host, pid: r.pid, start: r.start, beats: r.beats, session: r.session, lane: ctx.env.FACTORY_LANE || undefined } } : {};
// Is this landing claim the calling lane's own: its loop's process ($FACTORY_PID) on this machine?
export const landingMine = (l: Liveness) => l.host === ctx.HOST && !!ctx.env.FACTORY_PID && l.pid === Number(ctx.env.FACTORY_PID) && procStart(l.pid) === l.start;

// ---------------------------------------------------------------- resources

// Lanes on one machine share a lock folder ($FACTORY_LOCKS). loop.sh holds
// unit-<id>.lock and res-<resource>.lock for a session's life; a lock someone
// holds means another lane has that unit or resource right now.
const lockFile = (kind: string, id: string) => path.join(ctx.env.FACTORY_LOCKS!, `${kind}-${id.replace(/\//g, "__")}.lock`);
export function lockHeld(kind: "unit" | "res" | "ci", id: string) {
  if (!ctx.env.FACTORY_LOCKS) return false;
  const f = lockFile(kind, id);
  if (ctx.heldCache.has(f)) return ctx.heldCache.get(f)!;
  const held = fileLockHeld(f);
  ctx.heldCache.set(f, held);
  return held;
}

// "heavy", unless the project defines a resource by that name, is built in: the machine's
// heavy-job slots (runtime/heavy.sh). A unit that runs heavy jobs says --uses heavy, and no lane is
// handed one while every slot is held (by another lane's job, a long job, a CI step). No lock is
// held for it: with two slots, two such units can run at once.
export const HEAVY = "heavy";
export const builtinHeavy = (T: State, n: string) => n === HEAVY && !T.project.resources?.[HEAVY];
export const resourceKnown = (T: State, n: string) => !!T.project.resources?.[n] || builtinHeavy(T, n);
// The slots: $FACTORY_HEAVY, else the machines file's Heavy column, else 1; their locks in
// $FACTORY_CPU_LOCKS (heavy.ts's folder).
function heavySlotsHeld() {
  const env = ctx.env;
  const n = /^[1-9][0-9]*$/.test(env.FACTORY_HEAVY || "") ? Number(env.FACTORY_HEAVY) : ctx.MHEAVY.get(ctx.HOST) || 1;
  const d = env.FACTORY_CPU_LOCKS || `${env.XDG_RUNTIME_DIR || `/tmp/factory-${process.getuid?.() ?? 0}`}/factory-cpu`;
  for (let i = 1; i <= n; i++) {
    const f = path.join(d, `slot-${i}.lock`);
    if (!fileLockHeld(f)) return false;
  }
  return true;
}

export function resourceBusy(T: State, name_: string) {
  if (ctx.resCache.has(name_)) return ctx.resCache.get(name_)!;
  if (builtinHeavy(T, name_)) { const b = heavySlotsHeld(); ctx.resCache.set(name_, b); return b; }
  const r = T.project.resources?.[name_];
  let busy = lockHeld("res", name_);
  if (!busy && r?.free?.cmd) busy = spawnSync("bash", ["-c", r.free.cmd], { cwd: ctx.ROOT, stdio: "ignore", timeout: 30_000, env: ctx.env }).status !== 0;
  ctx.resCache.set(name_, busy);
  return busy;
}
export const resTitle = (T: State, n: string) => T.project.resources?.[n]?.title || (builtinHeavy(T, n) ? "this machine's heavy-job slots" : n);
// A resource's "named_by" (regexes, case-sensitive) are words that mean a unit needs it, e.g. the
// editor's ["\\bpreview\\b", "just look"]. The resources a unit's title, detail or probe names but
// doesn't --uses; add-unit, edit and lint warn about them (a warning: one unit filed without it
// mustn't fail every lane's lint). Gates are the owner's, so they're skipped.
export const namedBy = (r: { named_by?: string | string[] } | undefined) => ([] as unknown[]).concat(r?.named_by ?? []).map(String);
export function unnamedUses(T: State, u: Unit) {
  if (u.kind === "gate") return [];
  const text = [u.title, u.detail, u.probe?.cmd].filter((x) => typeof x === "string").join("\n");
  return Object.entries(T.project.resources || {}).filter(([n, r]) => !(u.uses || []).includes(n)
    && namedBy(r).some((re) => { try { return new RegExp(re).test(text); } catch { return false; } })).map(([n]) => n);
}
export const usesHint = (T: State, u: Unit, rs: string[]) => `${u.id}: says it needs ${rs.map((r) => resTitle(T, r)).join(" and ")} but doesn't use it; add --uses ${[...(u.uses || []), ...rs].join(",")} so lanes take it as a lock`;

// ---------------------------------------------------------------- capabilities

// This machine can do all a unit (or CI step) needs.
export const capsOk = (u: { caps?: string[] }) => !ctx.CAPS || (u.caps || []).every((c) => ctx.CAPS!.has(c));
// Some machine in the machines file can do it (no machines file: assume so).
export const capsSomewhere = (u: Unit) => !(u.caps || []).length || !ctx.MCAPS.size || [...ctx.MCAPS.values()].some((m) => u.caps!.every((c) => m.has(c))) || capsOk(u);

// ---------------------------------------------------------------- leases

// A group with `data` (the values its data paths are filled with) keeps its big
// files on the store (project.json "store"), not in git. One machine at a time
// leases it: the lease is taken with the claim of the group's first unit there,
// in the same push, so a tie has one winner. The loop copies the data down, and
// back after every unit; only the holder writes it. A lease whose heartbeat is
// older than FACTORY_LEASE_STALE seconds (default 1800) is stale and can be
// taken over. Leases live in tracker/leases.json, on main like claims.
export const hasStore = (T: State) => !!T.project.store;
// The group whose data a unit works on: its `data` ("none" for code-only), else its own group if that has data.
export const dataGroup = (T: State, u: Unit): string | null => { if (!hasStore(T) || u.data === "none") return null; if (u.data) return u.data; const g = T.groupOf.get(u.id); return g?.data ? g.id : null; };
export const leaseOf = (T: State, gid: string | null) => T.leases.find((l) => l.id === gid);
export const leaseAge = (l: Lease) => Date.now() - Date.parse(l.beat || l.at);
export const liveLease = (T: State, gid: string | null) => { const l = leaseOf(T, gid); return l && leaseAge(l) < ctx.STALE_MS ? l : null; };
export const leasedHere = (T: State, u: Unit) => { const g = dataGroup(T, u); return !!g && liveLease(T, g)?.host === ctx.HOST; };
// A machine's own heartbeat (leases.json "hosts") is kept while its loop has claims or CI running
// there; with its leases' heartbeats, it says the machine is still up.
export const hostBeatAge = (T: State, h: string) => Math.min(...[T.hosts[h], ...T.leases.filter((l) => l.host === h).map((l) => l.beat || l.at)].filter(Boolean).map((t) => Date.now() - Date.parse(t)), Infinity);
// The loop's claims, landing claims and CI runs on this machine, which its heartbeat keeps alive elsewhere.
export const beatRecords = (T: State): [Liveness, Unit | Group][] => ([...T.byId.values()].map((u) => (u.record?.state === "claimed" ? [u.record, u] : u.record?.landing ? [u.record.landing, u] : null)).filter(Boolean) as [Liveness, Unit | Group][])
  .concat(T.groups.map((g) => (g.ci?.running ? [g.ci.running, g] : null)).filter(Boolean) as [CiRun, Group][])
  .filter(([r]) => r.beats && r.host === ctx.HOST && !r.ended);
// A record the loop makes carries `beats`, and stamps this machine's heartbeat in the same write.
export function beatsHere<R extends Liveness>(T: State, r: R): R {
  if (ctx.env.FACTORY_ACTOR !== "loop") return r;
  T.hosts[ctx.HOST] = now(); T.dirty.add("leases");
  return { ...r, beats: true };
}
// Leases decide whether this machine may take u: held here, or free and this lane may take new
// ones (the loop sets FACTORY_LEASES=1, and FACTORY_NO_NEW_LEASE=1 when its cache has no room).
export function leaseOk(T: State, u: Unit) {
  const g = dataGroup(T, u);
  if (!g) return true;
  const l = liveLease(T, g);
  if (l) return l.host === ctx.HOST;
  return ctx.env.FACTORY_LEASES === "1" && ctx.env.FACTORY_NO_NEW_LEASE !== "1";
}
export function takeLease(T: State, gid: string) {
  const { HOST, TAG } = ctx;
  const old = leaseOf(T, gid), t = now();
  const l: Lease = { id: gid, host: HOST, at: t, beat: t, by: TAG, ...(old && old.host !== HOST ? { from: old.host } : {}) };
  T.leases = old ? T.leases.map((x) => (x === old ? l : x)) : [...T.leases, l];
  T.dirty.add("leases");
  const g = T.groupById.get(gid);
  log(T, "lease", null, `${g ? g.title : gid}: leased by ${HOST}${old && old.host !== HOST ? ` (taken over from ${old.host}, whose lease went stale)` : ""}`, { more: { group: gid } });
  return l;
}
export function dropLease(T: State, gid: string, why: string) {
  const l = leaseOf(T, gid);
  if (!l) return false;
  T.leases = T.leases.filter((x) => x !== l);
  T.dirty.add("leases");
  const g = T.groupById.get(gid);
  log(T, "release", null, `${g ? g.title : gid}: released by ${ctx.HOST}${l.host !== ctx.HOST ? ` (it was ${l.host}'s)` : ""}${why ? `: ${why}` : ""}`, { more: { group: gid } });
  return true;
}

// ---------------------------------------------------------------- a group's data here

// A path template filled with a group's data values; null if it names a value the group doesn't have.
const fillVars = (t: string, vars: Record<string, string>) => { let miss = false; const s = t.replace(/\{([a-z_][a-z0-9_]*)\}/gi, (m, k: string) => (vars[k] === undefined ? ((miss = true), m) : String(vars[k]))); return miss ? null : s; };
const localPath = (p: string) => (p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : path.isAbsolute(p) ? p : path.join(ctx.ROOT, p));
// Its data paths here, by name (store.paths filled with its values).
export function dataPaths(T: State, g: Group) {
  const vars: Record<string, string> = { group: g.id, ...g.data };
  return Object.entries(T.project.store!.paths || {}).flatMap(([k, t]) => { const p = fillVars(t, vars); return p === null ? [] : [{ name: k, local: localPath(p) }]; });
}
export function groupData(T: State, g: Group, reads?: unknown) {
  const st = T.project.store!;
  const vars: Record<string, string> = { group: g.id, ...g.data };
  const paths = dataPaths(T, g);
  const rs = reads === "none" || (Array.isArray(reads) && reads[0] === "none") ? [] : list(reads ?? st.reads ?? []);
  const inputs = rs.flatMap((r) => {
    const [iname, part] = r.split(":");
    const inp = st.inputs?.[iname] || die(`reads ${r}: no input "${iname}" in tracker/project.json store.inputs`);
    const t = inp.parts?.[part] ?? die(`reads ${r}: input ${iname} has no part "${part}"`);
    const rel = fillVars(t, vars);
    return rel === null ? [] : [{ input: iname, part, rel, local: localPath(path.join(inp.local, rel)) }];
  });
  return { group: g.id, title: g.title, ...(g.priority ? { priority: g.priority } : {}), paths, inputs, lease: liveLease(T, g.id) || null };
}
// Is anything under dir (a file, or dir itself) written after t (ms)? Past 200,000 entries it
// says past: yes by default, as a hand-back wants (keeping what wasn't work costs nothing;
// dropping work loses it); null for "can't tell".
export function newerIn(dir: string, t: number, past: boolean | null = true): boolean | null {
  const stack = [dir];
  for (let n = 0; stack.length; n++) {
    if (n >= 200_000) return past;
    const d = stack.pop()!;
    let st: fs.Stats;
    try { st = fs.statSync(d); } catch { continue; }
    if (st.mtimeMs > t) return true;
    if (!st.isDirectory()) continue;
    try { for (const e of fs.readdirSync(d)) stack.push(path.join(d, e)); } catch {}
  }
  return false;
}
