// Setting up: init, groups and units, templates, renames.
import fs from "node:fs";
import path from "node:path";
import { ctx } from "../ctx.ts";
import { createState, hasStateAt, loadTemplate, log, mutate, RANKING, SCHEMA, touch } from "../store.ts";
import { die, list, parseArgs, plural, str, strs, type Args } from "../text.ts";
import { checkText, checkTitle, name, rankUnits, resolve } from "../names.ts";
import { resourceKnown, unnamedUses, usesHint } from "../machine.ts";
import { EFFECTS } from "../cards.ts";
import { derive, groupOrderLine, LABEL, orderLine, priorityOf, sentence, SETTLED } from "../status.ts";
import { expandTemplate, fill, type Template } from "../templates.ts";
import { C } from "./registry.ts";
import { ciWaitText } from "../checks.ts";
import type { Check, Group, GroupCi, State, Unit } from "../types.ts";

const CHECKS: Check[] = ["computed", "independent", "recorded"];

C.init = (a) => {
  const o = parseArgs(a);
  const cwd = ctx.cwd;
  if (hasStateAt(cwd)) { console.log("tracker/ already exists"); return 0; }
  const nm = path.basename(cwd);
  createState(cwd, { schema: SCHEMA, ranking: RANKING, name: nm, title: str(o.title) ?? nm, resources: {} });
  repoFiles(cwd);
  console.log(`made tracker/ for ${nm}`);
  return 0;
};
// The repo's own files that make the tracker work with git.
export function repoFiles(root: string) {
  const add = (f: string, line: string) => { const p = path.join(root, f); const s = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : ""; if (!s.split("\n").includes(line)) fs.writeFileSync(p, s + (s && !s.endsWith("\n") ? "\n" : "") + line + "\n"); };
  add(".gitignore", "/.tracker/");
  add(".gitattributes", "tracker/log.jsonl merge=union");
  add(".gitattributes", "tracker/**/*.json merge=tracker-json");
  add(".gitattributes", "memory/MEMORY.md merge=union");
}

function unitFromFlags(T: State, u: Unit, o: Args) {
  if (typeof o.title === "string") u.title = checkTitle(T, o.title);
  if (typeof o.detail === "string") u.detail = checkText(T, "--detail", o.detail);
  if (typeof o.check === "string") { if (!CHECKS.includes(o.check as Check)) die(`--check is one of ${CHECKS.join(", ")}`); u.check = o.check as Check; }
  if (typeof o["probe-cmd"] === "string") u.probe = { cmd: o["probe-cmd"] };
  if (typeof o["probe-file"] === "string") u.probe = { file: o["probe-file"], json: str(o["probe-json"]) };
  if (typeof o.inputs === "string" && u.probe) u.probe.inputs = list(o.inputs);
  if ((typeof o["probe-cmd"] === "string" || typeof o["probe-file"] === "string") && typeof o.check !== "string") u.check = "computed";
  if (typeof o.needs === "string") u.needs = list(o.needs);
  if (typeof o.uses === "string") {
    u.uses = list(o.uses);
    const rs = T.project.resources || {};
    for (const r of u.uses) if (!resourceKnown(T, r)) die(`--uses ${r}: no such resource. --uses takes resource names from tracker/project.json (${Object.keys(rs).length ? Object.entries(rs).map(([k, v]) => (v.title ? `${k} (${v.title})` : k)).join(", ") : "it has none yet"}), or heavy (the machine's heavy-job slots: a unit that runs heavy jobs)`);
  }
  if (typeof o.tags === "string") u.tags = list(o.tags);
  if (typeof o.model === "string") u.model = o.model === "none" ? undefined : o.model;
  if (typeof o.host === "string") u.host = o.host === "none" ? undefined : o.host;
  if (typeof o.caps === "string") u.caps = o.caps === "none" ? undefined : list(o.caps);
  if (typeof o.data === "string") u.data = o.data === "default" ? undefined : o.data;
  if (typeof o.reads === "string") u.reads = o.reads === "default" ? undefined : list(o.reads);
  if (typeof o.lane === "string") u.lane = o.lane === "none" ? undefined : o.lane;
  if (typeof o.branch === "string") u.branch = o.branch === "none" ? undefined : o.branch;
  if (o.priority !== undefined) u.priority = Number(o.priority) || undefined;
  if (o["min-minutes"] !== undefined) {
    const m = String(o["min-minutes"]);
    if (m !== "none" && !/^[0-9]+$/.test(m)) die(`--min-minutes takes whole minutes or none, not "${m}"`);
    u.minMinutes = m === "none" ? undefined : Number(m) || undefined;
  }
  if (o.gate === true) u.kind = "gate";
  return u;
}
function checkNeeds(T: State, u: Unit) {
  u.needs = (u.needs || []).map((n) => (resolve(T, n, { soft: true }) || die(`--needs ${n}: no such unit`)).id);
}

// --data k=v,… : the values a group's data paths are filled with (project.json store.paths); it marks
// the group as one whose data lives on the store. --data none: code only. Editing merges into what's there.
function groupDataFlag(v: Args[string], old?: Record<string, string>) {
  if (v === undefined) return old;
  if (v === "none") return undefined;
  if (v === true) return { ...(old || {}) };
  const out = { ...(old || {}) };
  for (const kv of list(v)) {
    const i = kv.indexOf("=");
    if (i < 1 || !kv.slice(i + 1).trim()) die(`--data takes k=v pairs with a value (e.g. --data mod=3816038068), or none`);
    out[kv.slice(0, i)] = kv.slice(i + 1).trim();
  }
  return out;
}
// --ci drill,publish: the group's CI steps, each defined in project.json ci.steps; none turns CI off.
function ciFlag(T: State, v: Args[string]): GroupCi | undefined {
  if (v === undefined || v === "none") return undefined;
  const steps = list(v === true ? "" : v);
  if (!steps.length) die("--ci needs the steps it runs, e.g. --ci drill,publish (or none)");
  for (const s of steps) if (!T.project.ci?.steps?.[s]) die(`--ci ${s}: no such step in tracker/project.json ci.steps (${Object.keys(T.project.ci?.steps || {}).join(", ") || "none defined"})`);
  return { steps };
}
C["add-group"] = (a) => {
  const o = parseArgs(a);
  return mutate((T) => {
    const id = o._[0] || die("usage: add-group <group> --title \"…\"");
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) die("group IDs are lowercase words with dashes");
    if (T.groupById.get(id)) die(`group ${id} exists`);
    const g: Group = { id, title: typeof o.title === "string" ? checkTitle(T, o.title) : die("--title needed"), priority: o.priority ? Number(o.priority) : undefined, order: Math.max(0, ...T.groups.map((x) => x.order ?? 0)) + 1, host: str(o.host), data: groupDataFlag(o.data), needs: typeof o.needs === "string" ? list(o.needs) : undefined, ci: ciFlag(T, o.ci), units: [] };
    T.groups.push(g); T.groupById.set(id, g); T.dirty.add("group:" + id);
    log(T, "add-group", null, `new group: ${g.title}`);
    console.log(`added group ${g.title} (${id})`);
    if (g.priority) console.log(`priority ${g.priority}: ${groupOrderLine(T, g)} (once it has units)`);
    return 0;
  });
};

C["edit-group"] = (a) => {
  const o = parseArgs(a);
  return mutate((T) => {
    const g = T.groupById.get(o._[0]) || die(`no group "${o._[0] ?? ""}" (${T.groups.map((x) => x.id).join(", ")})`);
    if (typeof o.title === "string") g.title = checkTitle(T, o.title);
    if (typeof o.host === "string") g.host = o.host === "none" ? undefined : o.host;
    if (o.data !== undefined) g.data = groupDataFlag(o.data, g.data);
    if (o.priority !== undefined) g.priority = Number(o.priority) || undefined;
    if (typeof o.needs === "string") g.needs = list(o.needs).map((n) => (resolve(T, n, { soft: true }) || die(`--needs ${n}: no such unit`)).id);
    if (o.ci !== undefined) { const steps = ciFlag(T, o.ci); g.ci = steps ? { ...g.ci, steps: steps.steps } : undefined; }
    T.dirty.add("group:" + g.id); log(T, "edit-group", null, `${g.title}: edited (${Object.keys(o).filter((k) => k !== "_").join(", ")})`);
    console.log(`edited ${g.title} (${g.id})`);
    if (o.priority !== undefined) { T._memo = null; console.log(`priority ${g.priority || 0}: ${groupOrderLine(T, g)}`); }
    return 0;
  });
};

// add-unit lists the open units that score at least LIKE for the new title (rankUnits), and warns
// from CLOSE up.
const LIKE = 0.4, CLOSE = 0.6;
C["add-unit"] = (a) => {
  const o = parseArgs(a);
  return mutate((T) => {
    const id = o._[0] || die("usage: add-unit <group>/<slug> --title \"…\"");
    const [gid, slug] = id.split("/");
    const g = T.groupById.get(gid) || die(`no group "${gid}" (add-group first)`);
    if (!slug || !/^[a-z0-9][a-z0-9.-]*$/.test(slug)) die("unit IDs are <group>/<slug>, lowercase words with dashes");
    if (T.byId.get(id)) die(`${id} exists`);
    const u = unitFromFlags(T, { id } as Unit, o);
    if (!u.title) die("--title needed: what it is, in plain words (60 characters at most)");
    checkNeeds(T, u);
    const at = typeof o.after === "string" ? g.units.findIndex((x) => x.id === resolve(T, o.after as string).id) + 1 : g.units.length;
    // The open units most like it, looked for before it's added (by its title, as `find` would).
    const like = rankUnits(T, u.title).filter(([x, s]) => s >= LIKE && x.kind !== "gate" && !SETTLED.has(derive(T, x).s)).slice(0, 3);
    g.units.splice(at, 0, u); T.byId.set(id, u); T.groupOf.set(id, g); touch(T, u);
    if (u.detail) ciWaitText(T, u, "--detail", u.detail);
    log(T, "add-unit", id, `new unit: ${u.title}`);
    console.log(`added ${name(u)}`);
    if (like.length) console.log(`The open units most like it:\n${like.map(([x]) => `  - ${name(x)}: ${LABEL[derive(T, x).s]}`).join("\n")}`);
    // Warned, not refused: two units can share words and be different work. Filed anyway, two
    // lanes write competing fixes that clash at the merge.
    if (like[0]?.[1] >= CLOSE) console.error(`warning: ${name(like[0][0])} may already be this work: read it (just show ${like[0][0].id}). Only if it is the same, drop this one (just drop ${id} --why "same work as {unit:${like[0][0].id}}") and say what you found in a note on that one (just note ${like[0][0].id} "…").`);
    const un = unnamedUses(T, u); if (un.length) console.error(`warning: ${usesHint(T, u, un)}`);
    if (o.priority !== undefined) console.log(`${prioLine(T, u)}: ${orderLine(T, u)}`);
    return 0;
  });
};

// A unit ranks by the higher of its priority and its group's: say so when the group's is higher.
const prioLine = (T: State, u: Unit) => { const p = priorityOf(T, u); return `priority ${u.priority || 0}${p > (u.priority || 0) ? ` (it ranks at its group's ${p})` : ""}`; };

C.edit = (a) => {
  const o = parseArgs(a);
  return mutate((T) => {
    const u = resolve(T, o._[0]);
    unitFromFlags(T, u, o);
    if (typeof o.detail === "string") ciWaitText(T, u, "--detail", o.detail);
    // --add-needs adds to what the unit already needs; --needs replaces the list.
    if (typeof o["add-needs"] === "string") u.needs = [...new Set([...(u.needs || []), ...list(o["add-needs"])])];
    if (typeof o.needs === "string" || typeof o["add-needs"] === "string") { checkNeeds(T, u); u.needs = [...new Set(u.needs)]; }
    touch(T, u); log(T, "edit", u.id, `${u.title}: edited (${Object.keys(o).filter((k) => k !== "_").join(", ")})`);
    console.log(`edited ${name(u)}`);
    const un = unnamedUses(T, u); if (un.length && !["done", "dropped"].includes(u.record?.state ?? "")) console.error(`warning: ${usesHint(T, u, un)}`);
    if (o.priority !== undefined) { T._memo = null; console.log(`${prioLine(T, u)}: ${orderLine(T, u) || `it isn't ready (${sentence(T, u)}), so it has no place in the order yet`}`); }
    return 0;
  });
};

C.rename = (a) => mutate((T) => {
  const u = resolve(T, a[0]);
  const to = a[1] || die("usage: rename <id> <new-id>");
  if (T.byId.get(to)) die(`${to} exists`);
  const [gid] = to.split("/");
  const from = u.id;
  const g0 = T.groupOf.get(from)!, g1 = T.groupById.get(gid) || die(`no group "${gid}"`);
  u.id = to;
  if (g0 !== g1) { g0.units.splice(g0.units.indexOf(u), 1); g1.units.push(u); T.dirty.add("group:" + g0.id); }
  T.dirty.add("group:" + g1.id);
  const fix = <V>(s: V): V => (typeof s === "string" ? s.split(`{unit:${from}}`).join(`{unit:${to}}`) as V : s);
  for (const g of T.groups) for (const x of g.units) {
    if (x.needs?.includes(from)) { x.needs = x.needs.map((n) => (n === from ? to : n)); T.dirty.add("group:" + g.id); }
    if (x.detail?.includes(`{unit:${from}}`)) { x.detail = fix(x.detail); T.dirty.add("group:" + g.id); }
    for (const n of x.notes || []) if (n.text.includes(`{unit:${from}}`)) { n.text = fix(n.text); T.dirty.add("group:" + g.id); }
  }
  for (const g of T.groups) if (g.needs?.includes(from)) { g.needs = g.needs.map((n) => (n === from ? to : n)); T.dirty.add("group:" + g.id); }
  const cp = g0.ci?.passed;
  if (cp) for (const k of ["done", "open"] as const) if (cp[k]?.includes(from)) { cp[k] = g0 === g1 ? cp[k].map((n) => (n === from ? to : n)) : cp[k].filter((n) => n !== from); T.dirty.add("group:" + g0.id); }
  for (const q of T.questions) { q.blocks = (q.blocks || []).map((b) => (b === from ? to : b)); q.context = fix(q.context); for (const op of q.options || []) { op.changes = fix(op.changes); for (const k of EFFECTS) if (op[k]) op[k] = op[k]!.map((b) => (b === from ? to : b)); } }
  for (const d of T.decisions) { d.scope = d.scope?.map((b) => (b === from ? to : b)); d.title = fix(d.title); d.why = fix(d.why); }
  T.dirty.add("questions"); T.dirty.add("decisions");
  log(T, "rename", to, `${u.title}: renamed from ${from}`);
  console.log(`renamed ${from} → ${to}`);
  return 0;
});

// --- templates
C.add = (a) => {
  const o = parseArgs(a, ["set"]);
  return mutate((T) => {
    const gid = o._[0] || die("usage: add <group> --template T --set k=v …");
    if (T.groupById.get(gid)) die(`group ${gid} exists; \`just sync ${gid}\` adds what its template now makes`);
    const tpl = loadTemplate<Template>(typeof o.template === "string" ? o.template : die("--template needed"));
    const params: Record<string, unknown> = Object.fromEntries(strs(o.set).map((s) => { if (s === true) die("--set needs k=v (e.g. --set venue=Battlefield)"); const i = (s as string).indexOf("="); return [(s as string).slice(0, i), (s as string).slice(i + 1)]; }));
    params[tpl.param || "name"] ??= gid;
    const g: Group = { id: gid, title: str(o.title) ?? fill(tpl.title || "{Name}", { ...params, group: gid }), template: tpl.name, params, order: Math.max(0, ...T.groups.map((x) => x.order ?? 0)) + 1, host: str(o.host), needs: tpl.needs, ci: tpl.ci ? { steps: [...tpl.ci.steps || []] } : undefined, units: [] };
    g.units = expandTemplate(tpl, gid, params);
    T.groups.push(g); T.groupById.set(gid, g); T.dirty.add("group:" + gid);
    log(T, "add", null, `new group ${g.title} from template ${tpl.name}: ${plural(g.units.length, "unit")}`);
    console.log(`added ${g.title} (${gid}): ${plural(g.units.length, "unit")}${(tpl.units || []).some((x) => x.each) ? ". Units made from data files appear with `just sync " + gid + "` once those files exist." : ""}`);
    return 0;
  });
};
C.sync = (a) => mutate((T) => {
  const g = T.groupById.get(a[0]) || die(`no group "${a[0]}"`);
  if (!g.template) die(`${g.title} wasn't made from a template`);
  const want = expandTemplate(loadTemplate<Template>(g.template!), g.id, g.params || {});
  const have = new Set(g.units.map((u) => u.id));
  const added = want.filter((u) => !have.has(u.id));
  // a new unit goes after the template neighbour that precedes it
  for (const u of added) {
    const i = want.indexOf(u);
    const prev = want.slice(0, i).reverse().find((x) => have.has(x.id));
    const at = prev ? g.units.findIndex((x) => x.id === prev.id) + 1 : 0;
    g.units.splice(at, 0, u); have.add(u.id);
  }
  // a gate that needs "*" picks up the new units too
  const wantById = new Map(want.map((u) => [u.id, u]));
  for (const u of g.units) { const w = wantById.get(u.id); if (w && u.kind === "gate" && w.needs!.length !== (u.needs || []).length) u.needs = w.needs; }
  const orphans = g.units.filter((u) => !wantById.has(u.id) && u.template);
  T.dirty.add("group:" + g.id);
  if (added.length) log(T, "sync", null, `${g.title}: ${plural(added.length, "unit")} added from its template`);
  console.log(`${g.title}: ${plural(added.length, "unit")} added${orphans.length ? `; ${plural(orphans.length, "unit")} the template no longer makes (drop them with a reason): ${orphans.map((u) => name(u)).join(", ")}` : ""}`);
  return 0;
});
