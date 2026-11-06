// Two kinds of finding. Broken data (errs) can mislead every command, so a loop
// refuses to start over it. Slips (bad text: a bare ID, an over-long title or
// note, a half-written question, bloated memory) are worth fixing but harmless
// to the loop; `lint --broken` lists them as warnings. Warnings (a unit naming a
// resource it doesn't use, a bad named_by regex) are printed and never fail.
import fs from "node:fs";
import path from "node:path";
import { ctx } from "../ctx.ts";
import { groupFiles, load, loadCache } from "../store.ts";
import { probeTimeout } from "../probes.ts";
import { list, plural } from "../text.ts";
import { bareIds, isOpen, missingRefs, MAX_NOTE, MAX_TITLE, name, noteLength, selected } from "../names.ts";
import { namedBy, resourceKnown, unnamedUses, usesHint } from "../machine.ts";
import { CI_STEP_KEYS } from "../ci.ts";
import { EFFECTS, hasEffects, unaccounted } from "../cards.ts";
import { memoryIndex } from "./memory.ts";
import { C } from "./registry.ts";
import type { Unit } from "../types.ts";

const CHECKS = ["computed", "independent", "recorded"];

C.lint = (a = []) => {
  const T = load();
  const errs: string[] = [], slips: string[] = [], warns: string[] = [];
  const ids = new Set<string>();
  const bareRef = (where: string, s: string | undefined) => {
    for (const id of bareIds(T, s)) slips.push(`${where}: names ${id} bare; write {unit:${id}}`);
    missingRef(where, s);
  };
  // A {d:…} or {q:…} naming nothing shows to the owner as the raw reference.
  const missingRef = (where: string, s: string | undefined) => {
    for (const m of missingRefs(T, s)) slips.push(`${where}: ${m} names no ${m[1] === "d" ? "decision" : "question"}, so the owner reads it raw (\`just decisions --all\`, \`just questions --all\` list them)`);
  };
  for (const { file, id } of groupFiles()) if (id + ".json" !== file) errs.push(`tracker/groups/${file}: its id is "${id}"; the file must be ${id}.json`);
  for (const g of T.groups) {
    if (!g.title) errs.push(`group ${g.id}: no title`);
    for (const u of g.units) {
      const at = `${u.id}`;
      if (ids.has(u.id)) errs.push(`${at}: duplicate ID`);
      ids.add(u.id);
      if (!u.id.startsWith(g.id + "/")) errs.push(`${at}: is in group ${g.id}, so its ID starts with ${g.id}/`);
      if (!/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9.-]*$/.test(u.id)) errs.push(`${at}: IDs are <group>/<slug>, lowercase words with dashes`);
      if (!u.title) errs.push(`${at}: no title`);
      else {
        if (u.title.length > MAX_TITLE) slips.push(`${at}: title is ${u.title.length} characters (max ${MAX_TITLE}): "${u.title}". Detail goes in --detail.`);
        if (u.title.toLowerCase() === u.id.split("/")[1]) slips.push(`${at}: the title is just the slug; say what it is`);
        bareRef(`${at} title`, u.title);
      }
      bareRef(`${at} detail`, u.detail);
      missingRef(`${at} evidence`, u.record?.evidence);
      for (const n of u.notes || []) { if (noteLength(n.text) > MAX_NOTE) slips.push(`${at}: a note is ${noteLength(n.text)} characters (max ${MAX_NOTE})`); bareRef(`${at} note`, n.text); }
      if ((u.notes || []).length > 3) slips.push(`${at}: more than 3 notes`);
      if (u.check && !CHECKS.includes(u.check)) errs.push(`${at}: check "${u.check}" isn't one of ${CHECKS.join(", ")}`);
      if (u.check === "computed" && !u.probe) errs.push(`${at}: check is computed but there's no probe`);
      for (const n of u.needs || []) if (!T.byId.get(n)) errs.push(`${at}: needs unknown unit ${n}`);
      for (const r of u.uses || []) if (!resourceKnown(T, r)) errs.push(`${at}: uses unknown resource ${r} (add it to tracker/project.json resources)`);
      if (!["done", "dropped"].includes(u.record?.state ?? "")) { const un = unnamedUses(T, u); if (un.length) warns.push(usesHint(T, u, un)); }
      if (u.data && u.data !== "none" && !T.groupById.get(u.data)?.data) errs.push(`${at}: data names ${u.data}, which isn't a group with data`);
      if (u.caps && (!Array.isArray(u.caps) || u.caps.some((c) => typeof c !== "string"))) errs.push(`${at}: caps is a list of capability names`);
      for (const r of u.reads || []) if (r !== "none" && !T.project.store?.inputs?.[r.split(":")[0]]?.parts?.[r.split(":")[1]]) errs.push(`${at}: reads ${r}, which isn't an input part in tracker/project.json store.inputs`);
      const st = u.record?.state;
      if (st && !["claimed", "review", "done", "broken", "blocked", "dropped", "parked"].includes(st)) errs.push(`${at}: unknown record state ${st}`);
      if (st === "blocked" && u.record!.on && !T.questions.some((q) => q.id === u.record!.on)) errs.push(`${at}: blocked on unknown question ${u.record!.on}`);
    }
    for (const n of g.needs || []) if (!T.byId.get(n)) errs.push(`group ${g.id}: needs unknown unit ${n}`);
    if (g.ci && !Array.isArray(g.ci.steps)) errs.push(`group ${g.id}: ci has no steps list`);
    for (const r of g.ci?.uses || []) if (!T.project.resources?.[r]) errs.push(`group ${g.id}: CI uses unknown resource ${r}`);
    for (const s of g.ci?.steps || []) if (!T.project.ci?.steps?.[s]) errs.push(`group ${g.id}: CI step ${s} isn't defined in tracker/project.json ci.steps`);
    if (g.data && (typeof g.data !== "object" || Array.isArray(g.data))) errs.push(`group ${g.id}: data is an object of the values its data paths use`);
    if (g.data && !T.project.store) errs.push(`group ${g.id}: has data, but tracker/project.json has no store`);
    for (const [k, v] of Object.entries(g.data && typeof g.data === "object" ? g.data : {})) if (!String(v).trim() || /[/\\]|\.\./.test(String(v))) errs.push(`group ${g.id}: data value ${k} "${v}" is empty or has a path in it`);
  }
  for (const [k, v] of Object.entries(T.project.ci?.steps || {})) {
    if (typeof v?.cmd !== "string") { errs.push(`project.json ci.steps.${k}: no cmd`); continue; }
    for (const x of Object.keys(v)) if (x === "hold") slips.push(`project.json ci.steps.${k}: hold is gone (every CI run takes its steps' resources as it starts); remove it`);
    else if (!CI_STEP_KEYS.includes(x)) slips.push(`project.json ci.steps.${k}: unknown key ${x} (${CI_STEP_KEYS.join(", ")})`);
    for (const r of v.uses || []) if (!T.project.resources?.[r]) errs.push(`project.json ci.steps.${k}: uses unknown resource ${r}`);
    if (v.on_fail !== undefined && !["unit", "owner"].includes(v.on_fail)) errs.push(`project.json ci.steps.${k}: on_fail is "unit" or "owner"`);
    for (const n of ["timeout", "retries"] as const) if (v[n] !== undefined && !(Number.isInteger(v[n]) && v[n]! >= 0)) errs.push(`project.json ci.steps.${k}: ${n} is a whole number`);
    if (v.mem !== undefined && !/^[0-9]+(\.[0-9]+)?[KMGT]?$/.test(String(v.mem))) errs.push(`project.json ci.steps.${k}: mem is a size (512M, 12G)`);
  }
  const ci = T.project.ci as Record<string, unknown> | undefined;
  for (const k of Object.keys(ci || {})) if (!["steps", "affected", "land"].includes(k)) slips.push(`project.json ci: unknown key ${k} (steps, affected, land)`);
  if (ci?.affected !== undefined && (typeof ci.affected !== "string" || !ci.affected.includes("{old}") || !ci.affected.includes("{new}"))) errs.push(`project.json ci.affected: a command with {old} and {new} in it (two of main's commits)`);
  const land = T.project.ci?.land;
  if (land !== undefined) {
    if (typeof land?.cmd !== "string" || !land.cmd) errs.push(`project.json ci.land: no cmd`);
    if (land?.timeout !== undefined && !(Number.isInteger(land.timeout) && land.timeout > 0)) errs.push(`project.json ci.land: timeout is minutes, a whole number over 0`);
    for (const x of Object.keys(land || {})) if (!["cmd", "timeout"].includes(x)) slips.push(`project.json ci.land: unknown key ${x} (cmd, timeout)`);
  }
  if (T.project.ci_every !== undefined && !(Number.isInteger(T.project.ci_every) && T.project.ci_every >= 0)) errs.push(`project.json ci_every: minutes, a whole number (0: CI only once a group is done for the night)`);
  const ck = T.project.checks;
  if (ck !== undefined) {
    const sels = ck.units;
    if (sels !== undefined && !(typeof sels === "string" || (Array.isArray(sels) && sels.every((x) => typeof x === "string")))) errs.push(`project.json checks.units: the selectors of the check units (a unit ID, a glob such as *-check, tag:<t>, group:<g>), a string or a list`);
    if (ck.ready !== undefined && (typeof ck.ready !== "string" || !ck.ready.trim())) errs.push(`project.json checks.ready: a command ({unit} and {group} filled) that exits 0 when a check can be judged`);
    if (ck.ready_timeout !== undefined && !(Number.isInteger(ck.ready_timeout) && ck.ready_timeout > 0)) errs.push(`project.json checks.ready_timeout: seconds, a whole number above 0`);
  }
  if (T.project.min_unit_minutes !== undefined && !(Number.isInteger(T.project.min_unit_minutes) && T.project.min_unit_minutes >= 0)) errs.push(`project.json min_unit_minutes: minutes, a whole number (0: none)`);
  // A check that ran close to its timeout will time out one day, and a timeout fails it. The
  // cache is rebuilt by the next refresh, so one that won't parse isn't broken data.
  let cache: ReturnType<typeof loadCache> = {};
  try { cache = loadCache(); } catch { /* skip the warning */ }
  for (const u of T.byId.values()) {
    const secs = cache[u.id]?.secs, p = u.probe;
    if (!p?.cmd || secs === undefined || u.record?.state === "dropped") continue;
    if (secs > 0.8 * probeTimeout(p)) warns.push(`${name(u)}: its check took ${Math.round(secs)}s last time, ${Math.round(100 * secs / probeTimeout(p))}% of its ${probeTimeout(p)}s timeout; raise its timeout or make it faster`);
  }
  for (const [k, r] of Object.entries(T.project.resources || {})) for (const re of namedBy(r)) { try { new RegExp(re); } catch (e) { warns.push(`project.json resources.${k}.named_by: "${re}" isn't a regex (${(e as Error).message})`); } }
  if (T.project.publish !== undefined && !["on", "off"].includes(T.project.publish)) errs.push(`project.json publish: "${T.project.publish}" is neither on nor off`);
  const st_ = T.project.store;
  if (st_) {
    if (typeof st_.remote !== "string") errs.push("project.json store: no remote (host:path, or a path)");
    if (!st_.paths || typeof st_.paths !== "object" || !Object.keys(st_.paths).length) errs.push("project.json store: no paths (name → path template, e.g. \"out\": \"work/out/{group}\")");
    for (const [k, t] of Object.entries(st_.paths || {})) if (!/\{[a-z_][a-z0-9_]*\}/i.test(t) || /^\{[^}]*\}$/.test(t)) errs.push(`project.json store.paths.${k}: "${t}" must name a group's own folder ({group} or a data value inside a path)`);
    for (const r of list(st_.reads ?? [])) if (!st_.inputs?.[r.split(":")[0]]?.parts?.[r.split(":")[1]]) errs.push(`project.json store.reads: ${r} isn't an input part`);
  }
  for (const l of T.leases) if (!T.groupById.get(l.id)?.data) slips.push(`lease on ${l.id}, which isn't a group with data (\`just tracker lease release ${l.id} --force\`)`);
  // needs cycles
  const state = new Map<string, number>();
  const visit = (u: Unit, trail: string[]) => {
    if (state.get(u.id) === 2) return;
    if (state.get(u.id) === 1) { errs.push(`needs cycle: ${[...trail, u.id].join(" → ")}`); return; }
    state.set(u.id, 1);
    for (const n of u.needs || []) { const v = T.byId.get(n); if (v) visit(v, [...trail, u.id]); }
    state.set(u.id, 2);
  };
  for (const u of T.byId.values()) visit(u, []);
  for (const q of T.questions) {
    const at = q.id;
    if (!isOpen(q)) continue;
    if (!q.title?.endsWith("?")) slips.push(`${at}: the title should be the question, ending with ?`);
    if ((q.options || []).length < 2) slips.push(`${at}: fewer than two options`);
    for (const op of q.options || []) if (!op.changes) slips.push(`${at}: option ${op.key} doesn't say what it changes`);
    for (const op of q.options || []) {
      const text = `${op.label} ${op.changes}`;
      if (/\bdropped\b/i.test(text) && !op.drops?.length) slips.push(`${at}: option ${op.key} says units are dropped, but answering it drops nothing: end the option with "| drops: <units>" (ask it again and withdraw this one)`);
      if (/\breleased\b/i.test(text) && hasEffects(op) && !op.releases?.length) slips.push(`${at}: option ${op.key} says units are released, but it only drops: add "| releases: <units>" (ask it again and withdraw this one)`);
      for (const k of EFFECTS) for (const s of op[k] || []) if (!selected(T, [s]).length) slips.push(`${at}: option ${op.key} ${k} ${s}, which matches no unit`);
      if (hasEffects(op) && !op.parks) { const miss = unaccounted(T, q, op); if (miss.length) slips.push(`${at}: option ${op.key} doesn't say what happens to ${miss.map((u) => name(u)).join(", ")}, so answering it leaves them stuck`); }
    }
    if (!(q.options || []).some((x) => x.key === q.default)) slips.push(`${at}: no default among its options`);
    bareRef(`${at} title`, q.title); bareRef(`${at} context`, q.context);
    for (const op of q.options || []) bareRef(`${at} option ${op.key}`, op.changes);
  }
  for (const d of T.decisions) { bareRef(`${d.id} title`, d.title); missingRef(`${d.id} why`, d.why); if (d.replaces && !T.decisions.some((x) => x.id === d.replaces)) errs.push(`${d.id}: replaces unknown ${d.replaces}`); if (d.retired?.other && !T.decisions.some((x) => x.id === d.retired!.other)) errs.push(`${d.id}: retired for unknown ${d.retired.other}`); if (d.until && Number.isNaN(Date.parse(d.until))) errs.push(`${d.id}: until isn't a time (${d.until})`); }
  lintRepo(slips);
  for (const w of warns) console.error(`warning: ${w}`);
  if (a.includes("--broken")) {
    for (const e of slips) console.error(`warning: ${e}`);
    if (errs.length) { for (const e of errs) console.error(e); return 1; }
    console.log(`no broken data${slips.length ? ` (${plural(slips.length, "slip")} to fix when convenient, above)` : ""}`);
    return 0;
  }
  if (errs.length || slips.length) { for (const e of [...errs, ...slips]) console.error(e); return 1; }
  console.log(`lint ok${warns.length ? ` but ${plural(warns.length, "warning")}, above` : ""} (${plural(ids.size, "unit")} in ${plural(T.groups.length, "group")}, ${plural(T.questions.filter(isOpen).length, "open question")}, ${plural(T.decisions.length, "decision")})`);
  return 0;
};
const SPEC_WORDS = 4000, SPEC_LINE = 1000;
function lintRepo(errs: string[]) {
  const ROOT = ctx.ROOT;
  const lc = (f: string) => fs.readFileSync(f, "utf8").split("\n").length;
  const A = path.join(ROOT, "AGENTS.md");
  if (fs.existsSync(A) && lc(A) > 120) errs.push(`AGENTS.md is ${lc(A)} lines (max 120): move detail to docs/ or memory/`);
  // The spec holds rules; a tool's workings go in docs/tools/. Words, not lines: a spec of page-long lines passed a line count.
  let loops: Record<string, { spec?: string }> = {};
  try { loops = JSON.parse(fs.readFileSync(path.join(ROOT, "tracker", "project.json"), "utf8")).loops || {}; } catch { /* no project.json: just the default spec */ }
  for (const s of new Set(["docs/factory.md", ...Object.values(loops).map((l) => l?.spec).filter((x): x is string => !!x)])) {
    const p = path.join(ROOT, s);
    if (!fs.existsSync(p)) continue;
    const text = fs.readFileSync(p, "utf8"), words = text.split(/\s+/).filter(Boolean).length;
    if (words > SPEC_WORDS) errs.push(`${s} is ${words} words (max ${SPEC_WORDS}): it holds rules; move how a tool works to docs/tools/<tool>.md and leave a one-line pointer`);
    text.split("\n").forEach((l, i) => { if (l.length > SPEC_LINE) errs.push(`${s}:${i + 1}: line is ${l.length} chars (max ${SPEC_LINE}): split it, or move its detail to docs/tools/`); });
  }
  const M = path.join(ROOT, "memory");
  if (fs.existsSync(M)) for (const f of fs.readdirSync(M).filter((f) => f.endsWith(".md"))) {
    const p = path.join(M, f), ls = fs.readFileSync(p, "utf8").split("\n");
    if (f === "MEMORY.md") {
      ls.forEach((l, i) => { if (l.length > 200) errs.push(`memory/MEMORY.md:${i + 1}: index line is ${l.length} chars (max 200)`); });
      if (fs.readFileSync(p, "utf8") !== memoryIndex(M)) errs.push("memory/MEMORY.md isn't what the memory files' frontmatter makes: give each file title/hook (open: true for Open), then `just memory`");
    }
    else if (ls.length > 100) errs.push(`memory/${f} is ${ls.length} lines (max 100): split it or cut the history`);
  }
}
