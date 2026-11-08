// The owner's page, rebuilt after every write (store.ts onSaved) and by `view`.
import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { ctx } from "../ctx.ts";
import { load, onSaved, readLog, viewFile } from "../store.ts";
import { now, writeAtomic } from "../text.ts";
import { expand, isOpen, matches, name } from "../names.ts";
import { effectsText } from "../cards.ts";
import { ended, endedText } from "../decisions.ts";
import { derive, priorityOf, SETTLED, sentence } from "../status.ts";
import { VIEW_HTML } from "../view-html.ts";
import { ciOutcome, ciState, ciText } from "../ci.ts";
import { C } from "./registry.ts";
import type { Question, State, Status, Unit } from "../types.ts";

function viewData(T: State) {
  const st = (u: Unit) => derive(T, u);
  const log = readLog() || [];
  // Each unit's first and latest line in the log, for the units list's sorts.
  const first = new Map<string, string>(), last = new Map<string, string>();
  for (const x of log) if (x.id) { if (!first.has(x.id)) first.set(x.id, x.at); last.set(x.id, x.at); }
  // Its place in the order next would offer it at equal standing: priority, then the group's and its own order.
  const order = new Map<string, number>();
  const all = T.groups.flatMap((g, gi) => g.units.map((u) => ({ u, k: [-priorityOf(T, u), -(g.priority || 0), g.order ?? gi, -(u.priority || 0), u._i ?? 0] })));
  all.sort((a, b) => { for (let i = 0; i < a.k.length; i++) if (a.k[i] !== b.k[i]) return a.k[i] - b.k[i]; return 0; }).forEach((x, i) => order.set(x.u.id, i));
  const groups = T.groups.map((g) => ({
    id: g.id, title: g.title, host: g.host || null,
    // Its CI: how its latest run went (passed, failed on what, cut off), or that it never started.
    ci: g.ci ? ciOutcome(T, g) ?? { s: ciState(T, g).s, text: ciText(T, g) } : null,
    units: g.units.map((u) => { const d = st(u); return { id: u.id, title: u.title, gate: u.kind === "gate", s: d.s, p: priorityOf(T, u), o: order.get(u.id) ?? 0, first: first.get(u.id) || null, last: last.get(u.id) || null, how: d.how || null, label: sentence(T, u, d), detail: u.detail ? expand(T, u.detail) : null, evidence: u.record?.evidence ? expand(T, u.record.evidence) : null, notes: (u.notes || []).map((n) => `${n.at.slice(0, 10)} ${n.by}: ${expand(T, n.text)}`)}; }),
  }));
  const blocksOf = (q: Question) => [...T.byId.values()].filter((u) => !SETTLED.has(st(u).s) && ((q.blocks || []).some((s) => matches(T, s, u)) || (u.record?.state === "blocked" && u.record.on === q.id))).map((u) => name(u));
  const questions = T.questions.filter(isOpen).map((q) => ({ id: q.id, title: q.title, context: expand(T, q.context), example: q.example ? expand(T, q.example) : null, options: (q.options || []).map((o) => ({ ...o, changes: expand(T, o.changes), effects: effectsText(T, q, o) })), default: q.default, blocks: blocksOf(q), asked: q.asked}));
  const gates = [...T.byId.values()].filter((u) => u.kind === "gate" && st(u).s === "you").map((u) => ({ id: u.id, title: u.title, detail: u.detail ? expand(T, u.detail) : null }));
  const pick_ = (s: Status) => [...T.byId.values()].filter((u) => st(u).s === s).map((u) => ({ id: u.id, title: u.title, label: sentence(T, u) }));
  const decisions = T.decisions.slice().reverse().map((d) => ({ id: d.id, title: expand(T, d.title), why: expand(T, d.why), by: d.by, at: d.at, replaced: ((e) => e && endedText(T, e))(ended(T, d)), q: d.question ? T.questions.find((x) => x.id === d.question)?.title : null }));
  const log_ = log.slice(-400).map((x) => ({ ...x, text: expand(T, x.text) }));
  return { title: T.project.title || T.project.name, built: now(), groups, questions, gates, broken: pick_("broken"), interrupted: pick_("interrupted"), stuck: pick_("stuck"), decisions, log: log_ };
}
function writeView(T: State) {
  T._memo = null;
  const data = JSON.stringify(viewData(T)).replace(/</g, "\\u003c");
  writeAtomic(viewFile(), VIEW_HTML.replace("__DATA__", () => data).replace("__TITLE__", () => (T.project.title || T.project.name).replace(/</g, "")));
}
onSaved(writeView);

C.view = (a) => {
  const T = load();
  writeView(T);
  console.log(viewFile());
  if (a.includes("--open")) spawnSync("xdg-open", [viewFile()], { stdio: "ignore", detached: true, env: ctx.env } as SpawnSyncOptions);
  return 0;
};
