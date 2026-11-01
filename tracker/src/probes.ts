// Probes: the checks the tracker runs for computed units. Status is computed from them, so a
// unit that passed and now fails shows as broken again. A probe whose inputs (globs) haven't
// changed isn't run again: the cache keeps what it gave for them. A probe that exits 75 couldn't
// run here (the code `just capped` gives when there's no turn in the memory budget): a check
// that didn't run says nothing, so nothing changes and nothing is cached. A timeout still fails.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { ctx } from "./ctx.ts";
import { load, loadCache, log, touch, type ProbeCache } from "./store.ts";
import { UsageError, list, now } from "./text.ts";
import { name } from "./names.ts";
import { landingOf } from "./machine.ts";
import type { Probe, State, Unit } from "./types.ts";

// notRun: it exited 75. secs: how long a command probe ran, for lint's warning near its timeout.
export interface ProbeResult { pass: boolean; evidence: string; notRun?: boolean; secs?: number }
export const NOT_RUN = 75;
export const probeTimeout = (p: Probe) => p.timeout || 900;
// Probes already run outside the tracker's lock (probesFirst), by unit.
export type Ran = Map<string, { fp: string | null; res: ProbeResult }>;

export function probeOf(_T: State, u: Unit) {
  if (!u.probe) return null;
  return u.probe;
}
export function describeProbe(p: Probe | null) {
  if (!p) return "(no probe set: tracker edit <id> --probe-cmd …)";
  if (p.cmd) return `\`${p.cmd}\` passes`;
  if (p.file && p.json) return `\`${p.file}\` exists and \`${p.json}\` holds`;
  if (p.file) return `\`${p.file}\` exists`;
  if (p.count) return `\`${p.count}\` has at least ${p.min ?? 1} lines matching /${p.match}/`;
  return JSON.stringify(p);
}
function fingerprint(p: Probe) {
  const globs = list(p.inputs || (p.file ? [p.file] : p.count ? [p.count] : []));
  if (!globs.length) return null;
  // Each file the globs match (** any folders deep), with its size and modification time, as
  // bash's globstar listed them (a glob split at spaces, matches in the locale's order, a leading
  // ./ kept), so fingerprints from before still match.
  let files = "";
  for (const g of globs.flatMap((x) => x.split(/\s+/)).filter(Boolean)) {
    const dot = g.startsWith("./") ? "./" : "";
    for (const f of fs.globSync(g, { cwd: ctx.ROOT }).map((x) => dot + x).sort((a, b) => a.localeCompare(b))) {
      try { const st = fs.statSync(path.resolve(ctx.ROOT, f)); if (st.isFile()) files += `${f} ${st.size} ${Math.floor(st.mtimeMs / 1000)}\n`; } catch {}
    }
  }
  return crypto.createHash("sha1").update(JSON.stringify(p) + files).digest("hex").slice(0, 12);
}
function runProbe(p: Probe): ProbeResult {
  const ROOT = ctx.ROOT;
  if (p.cmd) {
    const t0 = Date.now();
    const r = spawnSync("bash", ["-c", p.cmd], { cwd: ROOT, encoding: "utf8", timeout: probeTimeout(p) * 1000, maxBuffer: 64 << 20, env: ctx.env });
    const secs = Math.round((Date.now() - t0) / 100) / 10;
    if ((r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") return { pass: false, evidence: `timed out after ${probeTimeout(p)}s`, secs };
    const lines = ((r.stdout || "") + (r.stderr || "")).trim().split("\n").filter(Boolean);
    const evidence = (lines.pop() || `exit ${r.status}`).slice(0, 200);
    return { pass: r.status === 0, evidence, notRun: r.status === NOT_RUN || undefined, secs };
  }
  if (p.file) {
    const f = path.join(ROOT, p.file);
    if (!fs.existsSync(f)) return { pass: false, evidence: `${p.file} is missing` };
    if (!p.json) return { pass: true, evidence: `${p.file} exists` };
    const r = spawnSync("jq", ["-e", p.json, f], { encoding: "utf8", env: ctx.env });
    return { pass: r.status === 0, evidence: `${p.file}: ${p.json} → ${(r.stdout || r.stderr || "").trim().slice(0, 80)}` };
  }
  if (p.count) {
    const f = path.join(ROOT, p.count);
    if (!fs.existsSync(f)) return { pass: false, evidence: `${p.count} is missing` };
    const n = fs.readFileSync(f, "utf8").split("\n").filter((l) => new RegExp(p.match!).test(l)).length;
    return { pass: n >= (p.min ?? 1), evidence: `${n} lines match /${p.match}/ in ${p.count} (need ${p.min ?? 1})` };
  }
  return { pass: false, evidence: "unknown probe" };
}
// The command a refresh (not --all) would run for this unit's probe now: its inputs changed since
// the cache's result. null for none (no command probe, or nothing to run), so the loop reserves
// memory only for what will run.
export function probeDue(T: State, u: Unit, cache: ProbeCache): string | null {
  const p = probeOf(T, u), r = u.record;
  if (!p?.cmd || r?.state === "dropped") return null;
  if (r?.branch && (r.state === "done" || r.state === "review")) return null;
  const fp = fingerprint(p);
  return fp && cache[u.id]?.fp !== fp ? p.cmd : null;
}
// Run one unit's probe and record the result. Returns a line for the user, or "".
export function applyProbe(T: State, u: Unit, cache: ProbeCache, force: boolean, ran?: Ran) {
  const p = probeOf(T, u);
  const r = u.record || ({} as Partial<NonNullable<Unit["record"]>>);
  if (!p || r.state === "dropped") return "";
  // Done on a branch that isn't on main yet: main's code can't pass its check.
  if (!force && r.branch && (r.state === "done" || r.state === "review")) return "";
  const fp = fingerprint(p);
  const c = cache[u.id];
  // The cache says what the check gave for these inputs; the state may not show
  // it yet (a write that was done again on newer state), so apply it anyway.
  if (!force && !fp) return "";
  const pre = ran?.get(u.id), fresh = pre && pre.fp === fp;
  const known = !force && !fresh && c && c.fp === fp;
  if (known && c.pass === (r.state === "done")) return "";
  const res = fresh ? pre!.res : known ? { pass: c.pass, evidence: c.evidence } : runProbe(p);
  if (ran && !fresh && !known) ran.set(u.id, { fp, res });
  if (res.notRun) {
    // Nothing cached, so the next settle or refresh runs it again, inputs changed or not. Logged
    // once, while a result is dropped: the loop refreshes before every claim, and a probe that
    // keeps getting no turn would add a line each time.
    if (c) log(T, "check", u.id, `${u.title}: its check couldn't run here (exit ${NOT_RUN}); left as it was`);
    delete cache[u.id];
    return `${name(u)}: its check couldn't run here (${res.evidence}); left as it was`;
  }
  const secs = known ? c.secs : res.secs;
  cache[u.id] = { fp, pass: res.pass, at: known ? c.at : now(), evidence: res.evidence, ...(secs !== undefined ? { secs } : {}) };
  if (res.pass && r.state !== "done") {
    const worker = r.state === "claimed" || r.state === "review" ? r.by : undefined;
    // Passed on its own branch (the loop's settle): done once the branch is on main.
    const branch = r.state === "claimed" && r.by === ctx.TAG ? r.branch : undefined;
    u.record = { state: "done", by: "check", worker, at: now(), evidence: res.evidence, branch, host: branch ? r.host : undefined, ...(branch ? landingOf(r) : {}) };
    touch(T, u); log(T, "check", u.id, `${u.title}: now done (its check passes)`);
    return `${name(u)}: now done (${res.evidence})`;
  }
  if (!res.pass && r.state === "done" && r.by === "check") {
    u.record = { state: "broken", at: now(), was: r.at, evidence: res.evidence };
    touch(T, u); log(T, "check", u.id, `${u.title}: broken again (${res.evidence})`);
    return `${name(u)}: BROKEN AGAIN, its check passed before (${res.evidence})`;
  }
  if (res.pass && r.state === "done" && r.by !== "check") {
    // done by hand, and its check agrees: from now on the check owns it
    u.record = { ...(r as NonNullable<Unit["record"]>), by: "check", worker: r.by, evidence: res.evidence };
    touch(T, u);
    return "";
  }
  return res.pass ? `${name(u)}: still passes` : `${name(u)}: not done yet (${res.evidence})`;
}
// Probes can take minutes, and the tracker's lock held that long starves other writers (a
// lease's heartbeat, a claim). So the probes run first, on a copy of the state read without
// the lock, and the write under the lock reuses their results (unless the inputs changed since).
export function probesFirst(fn: (T: State, cache: ProbeCache, ran: Ran) => void): Ran {
  const ran: Ran = new Map();
  try { fn(load(), loadCache(), ran); } catch (e) { if (!(e instanceof UsageError)) throw e; }
  return ran;
}
