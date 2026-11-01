// Unit templates (tracker/templates/<t>.json): "add Milo" makes his units, and `sync` adds
// those a template makes once the data files it reads exist.
import fs from "node:fs";
import path from "node:path";
import { ctx } from "./ctx.ts";
import { cap, die, slugify } from "./text.ts";
import { MAX_TITLE } from "./names.ts";
import type { Probe, Unit } from "./types.ts";

export interface UnitSpec {
  slug: string;
  title: string;
  each?: string;
  as?: string;
  kind?: "gate";
  detail?: string;
  check?: Unit["check"];
  probe?: Probe;
  needs?: string[];
  uses?: string[];
  tags?: string[];
  model?: string;
  host?: string;
  priority?: number;
  template?: string;
}
export interface Template {
  name: string;
  title?: string;
  param?: string;
  needs?: string[];
  ci?: { steps?: string[] };
  units?: UnitSpec[];
}

// {name}, {Name} (capitalised) and {a.b} filled from vars; unknown ones are left as written.
export function fill(s: unknown, vars: Record<string, unknown>) {
  return String(s).replace(/\{([A-Za-z_][\w.]*)\}/g, (m, k: string) => {
    const up = k[0] === k[0].toUpperCase() && k[0] !== k[0].toLowerCase();
    const key = up ? k[0].toLowerCase() + k.slice(1) : k;
    const v = key.split(".").reduce<unknown>((o, p) => (o == null ? undefined : (o as Record<string, unknown>)[p]), vars);
    if (v === undefined) return m;
    return up ? cap(String(v)) : String(v);
  });
}
const fillDeep = (x: unknown, vars: Record<string, unknown>): unknown => (typeof x === "string" ? fill(x, vars) : Array.isArray(x) ? x.map((y) => fillDeep(y, vars)) : x && typeof x === "object" ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, fillDeep(v, vars)])) : x);

export function expandTemplate(tpl: Template, gid: string, params: Record<string, unknown>): Unit[] {
  const vars = { ...params, group: gid };
  const out: Unit[] = [];
  for (const spec of tpl.units || []) {
    if (spec.each) {
      const [file, ptr = ""] = fill(spec.each, vars).split("#");
      const f = path.join(ctx.ROOT, file);
      if (!fs.existsSync(f)) continue; // appears once an earlier unit makes the file (sync)
      let items = JSON.parse(fs.readFileSync(f, "utf8"));
      for (const p of ptr.split("/").filter(Boolean)) items = items?.[p];
      for (const it of Array.isArray(items) ? items : []) out.push(mk(spec, { ...vars, [spec.as || "item"]: it }));
    } else out.push(mk(spec, vars));
  }
  const local = new Set(out.map((u) => u.id));
  for (const u of out) {
    u.needs = (u.needs || []).flatMap((n) => (n === "*" ? out.filter((x) => x !== u && x.kind !== "gate").map((x) => x.id) : [local.has(`${gid}/${n}`) ? `${gid}/${n}` : n]));
  }
  return out;
  function mk(spec: UnitSpec, v: Record<string, unknown>): Unit {
    const s = fillDeep(spec, v) as UnitSpec;
    if ((s.title || "").length > MAX_TITLE) die(`template ${tpl.name} makes the title "${s.title}" (${s.title.length} characters, max ${MAX_TITLE}): shorten it in tracker/templates/${tpl.name}.json and put the rest in "detail"`);
    const u: Unit = { id: `${gid}/${slugify(s.slug)}`, title: s.title, kind: s.kind, detail: s.detail, check: s.check || (s.probe ? "computed" : undefined), probe: s.probe, needs: s.needs, uses: s.uses, tags: s.tags, model: s.model, host: s.host, priority: s.priority, template: s.template || tpl.name };
    return u;
  }
}
