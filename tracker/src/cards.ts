// What a session and the owner read: a unit's card, a question with what each option does,
// a decision.
import { ctx } from "./ctx.ts";
import { plural } from "./text.ts";
import { expand, matches, name, groupTitle, selected, stems } from "./names.ts";
import { dataGroup, resTitle } from "./machine.ts";
import { describeProbe, probeOf } from "./probes.ts";
import { coveredFixes, siblingFixes } from "./checks.ts";
import { derive, orderLine, priorityOf, SETTLED, sentence } from "./status.ts";
import type { Decision, Option, Question, State, Unit } from "./types.ts";
import { ended, endedText, inForce, when } from "./decisions.ts";

export function applicableDecisions(T: State, u: Unit) {
  return T.decisions.filter((d) => inForce(T, d) && (d.scope || []).some((s) => matches(T, s, u)));
}
// Of the decisions scoped '*', the card lists all of the owner's (standing instructions) and
// EVERY_MAX of the rest: those that share two words with the unit (its ID, title, detail, group,
// resources), then the newest; in tracker order. A project's '*' decisions pile up, most about other work (2026-10-19:
// 47 of them, a third of every card), and the card is in every turn of the session.
export const EVERY_MAX = 10;
export function everyShown(T: State, u: Unit, every: Decision[]) {
  const others = every.filter((d) => d.by !== "owner");
  if (others.length <= EVERY_MAX) return every;
  const g = T.groupOf.get(u.id);
  const U = stems(`${u.id.replace(/[/.-]/g, " ")} ${u.title} ${expand(T, u.detail)} ${g?.title ?? ""} ${(u.uses || []).map((x) => resTitle(T, x)).join(" ")}`);
  const near = (d: Decision) => { let n = 0; for (const w of stems(expand(T, d.title))) if (U.has(w)) n++; return n >= 2; };
  const pick = new Set<Decision>();
  for (const d of others) if (pick.size < EVERY_MAX && near(d)) pick.add(d);
  // Newest first; of two made the same second, the one recorded later.
  for (const d of others.map((d, i) => [d, i] as const).sort(([a, i], [b, j]) => b.at.localeCompare(a.at) || j - i).map(([d]) => d)) if (pick.size < EVERY_MAX) pick.add(d);
  return every.filter((d) => d.by === "owner" || pick.has(d));
}
export function doneWhen(T: State, u: Unit) {
  const c = u.check || "recorded";
  if (u.kind === "gate") return "the owner passes it (`just pass " + u.id + "`), after looking";
  if (c === "computed") return describeProbe(probeOf(T, u)) + " (you don't mark it done; make the check pass, then `just recheck " + u.id + "`)";
  if (c === "independent") return "a context that didn't do the work checks it: `just done " + u.id + " --checker <its tag> --evidence \"…\"`";
  return "you record it with evidence: `just done " + u.id + " --evidence \"…\"`";
}
// full: this unit's own decisions with their why, and none of those for every unit (a line
// says where they are); "all": every decision for every unit too, each with its why (`show
// --full`, `show --why-all`).
export function card(T: State, u: Unit, head = "", full: boolean | "all" = false) {
  const g = T.groupOf.get(u.id)!;
  const d = derive(T, u);
  const L: string[] = [];
  L.push(`${head}${name(u)}`);
  const gu = g.units.filter((x) => x.kind !== "gate");
  L.push(`  Group: ${g.title}, ${gu.filter((x) => derive(T, x).s === "done").length} of ${gu.length} done`);
  L.push(`  Status: ${sentence(T, u, d)}`);
  if (u.detail) L.push(`  What: ${expand(T, u.detail)}`);
  L.push(`  Done when: ${doneWhen(T, u)}`);
  // Notes next: what the last attempt learned is what a session needs first (2026-10-23: sessions
  // read the card's first 80 lines, and --full put the notes past 200).
  if (u.notes?.length) { L.push("  Notes from earlier attempts:"); for (const n of u.notes) L.push(`    - ${n.at.slice(0, 10)} ${n.by}: ${expand(T, n.text)}`); }
  // What the loop's review asked to fix before the branch lands (review-fix), right after them.
  if (u.review?.findings && !SETTLED.has(d.s)) L.push(`  The loop's review asked for these fixes before it lands (fix them on its branch):\n${u.review.findings.split("\n").map((x) => `    ${expand(T, x)}`).join("\n")}`);
  const needs = [...(g.needs || []), ...(u.needs || [])].map((n) => T.byId.get(n)).filter((x): x is Unit => !!x);
  if (needs.length) L.push(`  Needs: ${needs.map((n) => `${name(n)}${SETTLED.has(derive(T, n).s) ? " ✓" : ""}`).join(", ")}`);
  // A check: the fixes it waits for by naming (checks.ts), and those its sibling checks found.
  const covers = coveredFixes(T, u);
  if (covers.length && !SETTLED.has(d.s)) L.push(`  Covers (open fixes of its group that name it, waited for like needs): ${covers.map((n) => `${name(n)}${SETTLED.has(derive(T, n).s) ? " ✓" : ""}`).join(", ")}`);
  const sib = siblingFixes(T, u, (x) => !["parked", ...SETTLED].includes(derive(T, x).s));
  if (sib.length && !SETTLED.has(d.s)) L.push(`  Open fixes this group's other checks found (not waited for): ${sib.slice(0, 8).map((n) => name(n)).join(", ")}${sib.length > 8 ? ` and ${sib.length - 8} more` : ""}. If one shows in this look too, add it to the needs (\`just tracker edit ${u.id} --add-needs <id>\`) and hand the unit back before the look.`);
  // Titles only, unless --full: a card is in every turn of the session that works it, and most
  // decisions scoped '*' are about other work (2026-10-18: ~50 of them, 10 KB a card).
  // Those scoped to this unit (its ID, a glob, its group or tag) come first. --full gives their
  // why, and only them: the session has the card already; --why-all lists every decision for
  // every unit, with its why (2026-10-23: with them all, a card ran to 42k characters, and
  // sessions cut it short; 2026-10-28: --full listed every one by title, 60 of 77–88 a card, and
  // every session ran it first thing; 2026-10-29: with only this unit's own, 36 of 44 sessions
  // still ran it first, 17k characters for 25 decisions' why, as the card pointed them at it: it
  // points at \`just decisions\`, for the one decision whose why matters).
  const ds = applicableDecisions(T, u), mine = ds.filter((d) => (d.scope || []).some((s) => s !== "*" && matches(T, s, u)));
  const title = (x: Decision) => `${expand(T, x.title)}${x.by === "owner" ? " (the owner)" : ""}`;
  const withWhy = (x: Decision) => decisionText(T, x, true).replace(/\n/g, "\n    ");
  const every = ds.filter((d) => !mine.includes(d));
  const shown = full === "all" ? every : full ? [] : everyShown(T, u, every);
  if (mine.length) {
    L.push(`  Decisions for this unit${full ? "" : ` (why: \`just decisions <words>\`)`}:`);
    for (const x of mine) L.push(`    - ${full ? withWhy(x) : title(x)}`);
  }
  if (shown.length) {
    L.push(`  Decisions for every unit${full === "all" ? "" : mine.length ? "" : ` (why: \`just decisions <words>\`)`}:`);
    for (const x of shown) L.push(`    - ${full === "all" ? withWhy(x) : title(x)}`);
  }
  if (full === true && every.length) { const n = everyShown(T, u, every).length; L.push(`  Decisions for every unit: ${every.length}${n < every.length ? `, ${n} of them on the card by title` : ", on the card by title"} (\`just show ${u.id}\`); \`just decisions <words>\` finds one and gives its why, \`just show ${u.id} --why-all\` all of them`); }
  else if (shown.length < every.length) L.push(`    - and ${every.length - shown.length} more for every unit (\`just decisions <words>\` finds one; \`just show ${u.id} --why-all\` lists them all, with why)`);
  const r = u.record || ({} as Partial<NonNullable<Unit["record"]>>);
  if (r.evidence && (d.s === "done" || d.s === "review" || d.s === "broken")) L.push(`  Evidence: ${expand(T, r.evidence)}`);
  if (r.state === "claimed" && r.reviewing) L.push(`  You're checking it: ${r.reviewing.by} worked it${r.reviewing.evidence ? `; their evidence: ${expand(T, r.reviewing.evidence)}` : ""}. If it holds, record it done with your own evidence; if not, reopen it with a note.`);
  // Handed back by its session with its work kept (unclaim): not interrupted, so no session to resume.
  const back = r.state === "claimed" && !!r.handedBack;
  if (d.s === "interrupted" || back) {
    if (back) L.push(`  Handed back: session ${r.by}${r.host ? ` on ${r.host}` : ""} gave it back at ${r.handedBack} with its work kept`);
    if (r.branch) L.push(`  Its work so far: branch ${r.branch}${r.pushed ? " (the loop checks it out for you)" : ", if the machine it ran on kept it"}`);
    if (r.dirty?.length) L.push(`  Left uncommitted: ${r.dirty.slice(0, 12).join(", ")}${r.dirty.length > 12 ? ` and ${r.dirty.length - 12} more` : ""}`);
    if (r.session && !back) L.push(`  Its session: claude --resume ${r.session}`);
    L.push("  Open what it left, keep what's good, finish it.");
  }
  // Its last attempt's outputs, set aside when it ended unfinished: notes about what's in work/
  // may describe what's no longer there (2026-10-23: a note said a plan was remade, after the
  // put-back had reverted it, and the next session lost an hour on it).
  if (u.aside && !SETTLED.has(d.s)) {
    const x = u.aside;
    const went = `when ${x.by ? `session ${x.by}` : "its last session"} ended it unfinished, its outputs went to ${x.path} on ${x.host}`;
    L.push(x.mixed
      ? `  Set aside: ${went}, mixed with other work, and the store's copy was put back in work/. They aren't put back: rebuild them before trusting earlier notes about what's in work/.`
      : `  Set aside: ${went}${x.commit ? `, built from commit ${x.commit.slice(0, 8)}` : ""}, and the store's copy was put back in work/. The loop puts them back for its next session on ${x.host} only if its branch is still on that commit and nothing else in work/ has changed since, and says so; otherwise rebuild them before trusting earlier notes about what's in work/.`);
  }
  const dg = dataGroup(T, u);
  const extra = [u.model && `Model: ${u.model}`, (u.uses || []).length && `Uses: ${u.uses!.map((x) => resTitle(T, x)).join(", ")}`, (u.host || g.host) && `Machine: ${u.host || g.host}`, (u.caps || []).length && `Needs a machine that can: ${u.caps!.join(", ")}`, u.check && `Check: ${u.check}`].filter(Boolean);
  if (dg) L.push(`  Data: ${groupTitle(T, dg)}'s, which the loop copies down before you start and back after you finish. Never copy data yourself.`);
  if (extra.length) L.push("  " + extra.join("   "));
  if ((u.tags || []).includes("slow-check")) L.push("  Its own check is slow (tag slow-check): at the branch's last step run only `just check`.");
  if ((u.priority || g.priority) && d.s === "ready") L.push(`  Order: priority ${priorityOf(T, u)}${(u.priority || 0) < priorityOf(T, u) ? " (its group's)" : ""}; ${orderLine(T, u)}`);
  return L.join("\n");
}

// ---------------------------------------------------------------- questions

// What an option does to units. One with "drops:" or "releases:" fields does
// exactly that when the owner picks it; one with neither releases everything the
// question blocks, as answers always did.
export const EFFECTS = ["drops", "releases"] as const;
export const hasEffects = (op: Option | undefined) => !!op && EFFECTS.some((k) => op[k]?.length);
export const qBlocked = (T: State, q: Question) => [...T.byId.values()].filter((u) => (q.blocks || []).some((s) => matches(T, s, u)) || (u.record?.state === "blocked" && u.record.on === q.id));
// What's waiting on an open question: an option's effects reach these and nothing else,
// so a selector can't drop a unit a lane is working on or has in review, nor one that's
// done, broken or parked. canWait is the same test before the question exists.
const lanesWork = (u: Unit) => ["claimed", "review"].includes(u.record?.state ?? "");
export const waitingOn = (T: State, q: Question) => qBlocked(T, q).filter((u) => !lanesWork(u) && derive(T, u).qs?.includes(q));
export const canWait = (T: State, u: Unit) => u.kind !== "gate" && (!lanesWork(u) || (u.record!.state === "claimed" && u.record!.by === ctx.TAG)) && !["done", "dropped", "merging", "broken", "parked"].includes(derive(T, u).s);
export const effectOn = (T: State, q: Question, op: Option, k: (typeof EFFECTS)[number], us = waitingOn(T, q)) => selected(T, op[k] || []).filter((u) => us.includes(u));
export function effectsText(T: State, q: Question, op: Option) {
  if (!(q.options || []).some((x) => hasEffects(x) || x.parks)) return "";
  if (!hasEffects(op)) return op.parks ? "puts it off: parks everything it blocks" : "releases everything it blocks";
  return [...EFFECTS.filter((k) => op[k]?.length).map((k) => {
    const us = effectOn(T, q, op, k);
    return `${k} ${plural(us.length, "unit")}${us.length ? ": " + us.slice(0, 4).map((u) => name(u)).join(", ") + (us.length > 4 ? ` and ${us.length - 4} more` : "") : ""}`;
  }), ...(op.parks ? ["parks the rest"] : [])].join("; ");
}
// Units waiting on the question that an option with effects says nothing about.
// An option whose words say units are dropped or released but whose fields don't do it: what lint
// reports and ask refuses, so a question asked never fails the project's lint (one did on main and
// stopped every lane). Its fix, or null.
export function optionWordSlip(op: Option): string | null {
  const text = `${op.label} ${op.changes}`;
  if (/\bdropped\b/i.test(text) && !op.drops?.length) return `option ${op.key} says units are dropped, but answering it drops nothing: end the option with "| drops: <units>"`;
  if (/\breleased\b/i.test(text) && hasEffects(op) && !op.releases?.length) return `option ${op.key} says units are released, but it only drops: add "| releases: <units>"`;
  return null;
}
export const unaccounted = (T: State, q: Question, op: Option) => { const has = new Set(EFFECTS.flatMap((k) => selected(T, op[k] || []))); return waitingOn(T, q).filter((u) => !has.has(u)); };

export function questionText(T: State, q: Question, _full = false) {
  const L = [`${name(q)}`];
  if (q.context) L.push(`   ${expand(T, q.context)}`);
  if (q.example) L.push(`   Example: ${expand(T, q.example)}`);
  for (const op of q.options || []) {
    L.push(`   ${op.key}) ${op.label}${op.key === q.default ? " (default)" : ""}: ${expand(T, op.changes)}`);
    const fx = effectsText(T, q, op);
    if (fx) L.push(`      → ${fx}`);
  }
  const bl = [...T.byId.values()].filter((u) => !SETTLED.has(derive(T, u).s) && ((q.blocks || []).some((s) => matches(T, s, u)) || (u.record?.state === "blocked" && u.record.on === q.id)));
  if (bl.length) L.push(`   Blocks ${plural(bl.length, "unit")}: ${bl.slice(0, 4).map((u) => name(u)).join(", ")}${bl.length > 4 ? ` and ${bl.length - 4} more` : ""}`);
  if (q.asked) L.push(`   Asked ${q.asked.at.slice(0, 10)} by ${q.asked.by}${q.asked.host ? " on " + q.asked.host : ""}`);
  if (q.withdrawn) L.push(`   Withdrawn ${q.withdrawn.at.slice(0, 10)}: ${expand(T, q.withdrawn.why)}`);
  else if (q.answer) {
    const op = (q.options || []).find((x) => x.key === q.answer!.key);
    L.push(`   Answered ${q.answer.at.slice(0, 10)} by ${q.answer.by}: ${op ? `${op.key}) ${op.label}` : q.answer.key}${q.answer.note ? `, "${q.answer.note}"` : ""}`);
  } else L.push(`   Answer: just answer ${q.id} <${(q.options || []).map((x) => x.key).join("|") || "key"}> [--note "…"]`);
  return L.join("\n");
}

// What the owner kept a decision through (prune --keep), as `decisions` says it.
const KEPT: Record<string, string> = { lapse: "lapsed", superseded: "superseded", merge: "a repeat", narrow: "narrowed", code: "held by the code" };
export function decisionText(T: State, d: Decision, full = false) {
  const e = ended(T, d);
  let s = `${expand(T, d.title)} (${d.by === "owner" ? "the owner" : "agent " + d.by}, ${d.at.slice(0, 10)}; ${d.id})${e ? ` [${endedText(T, e)}]` : d.until ? ` [until ${when(d.until)}]` : ""}${d.postpones ? " [put off]" : ""}${d.kept?.length ? ` [kept: not ${d.kept.map((k) => KEPT[k.kind] ?? k.kind).join(", not ")}]` : ""}`;
  if (full) {
    if (d.why) s += `\n  Why: ${expand(T, d.why)}`;
    if (d.question) s += `\n  Answers: ${name(T.questions.find((q) => q.id === d.question))}`;
    if (d.scope?.length) s += `\n  Applies to: ${d.scope.join(", ")}`;
    if (d.replaces) { const r = T.decisions.find((x) => x.id === d.replaces); s += `\n  Replaces: ${r ? name(r) : d.replaces}`; }
  }
  return s;
}
