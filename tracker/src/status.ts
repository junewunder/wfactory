// A unit's status, worked out each time from its record, needs, questions, claims and
// resources; what `next` offers; and why nothing is workable when nothing is.
//
// Status (first match wins): dropped; done; broken again (its check passed once and now
// fails); parked (the owner set it aside); waiting on you (an open question or a gate); stuck
// (blocked with a reason); merging (recorded done or in review, its branch not on main yet;
// counts as not done for what needs it); in review; in progress / interrupted (a claim whose
// session is gone); waiting on other work (needs); waiting on a resource; ready. A unit its session
// handed back with its work kept (unclaim) is one of the last three.
import { ctx } from "./ctx.ts";
import { inForce } from "./in-force.ts";
import { die, plural } from "./text.ts";
import { expand, isOpen, matches, name, groupTitle } from "./names.ts";
import { capsOk, capsSomewhere, claimAlive, dataGroup, heldHere, leaseOk, leasedHere, liveLease, lockHeld, resTitle, resourceBusy } from "./machine.ts";
import { ciFirst, ciState } from "./ci.ts";
import { coveredFixes } from "./checks.ts";
import { leastSecs, usualSecs } from "./sessions.ts";
import type { Derived, Group, MissingUnit, State, Status, Unit } from "./types.ts";

export const SETTLED = new Set<Status>(["done", "dropped"]);

export const LABEL: Record<Status, string> = {
  dropped: "dropped", done: "done", broken: "broken again", you: "waiting on you", stuck: "stuck",
  review: "in review", doing: "in progress", interrupted: "interrupted", waiting: "waiting on other work",
  resource: "waiting on a resource", ready: "ready", parked: "parked", merging: "merging",
};

const parkHolds = (T: State, id: string) => { const d = T.decisions.find((x) => x.id === id); return !!d && inForce(T, d); };
export function derive(T: State, u: Unit, memo: Map<string, Derived> = T._memo ||= new Map(), seen = new Set<string>()): Derived {
  if (memo.has(u.id)) return memo.get(u.id)!;
  if (seen.has(u.id)) return { s: "waiting", why: "it's in a needs cycle (tracker lint)" };
  seen.add(u.id);
  const r = u.record || ({} as Partial<NonNullable<Unit["record"]>>);
  const g = T.groupOf.get(u.id);
  let out: Derived;
  // A check also waits for the open fixes it covers (checks.ts), unless the owner parked them.
  const covered = () => coveredFixes(T, u).filter((f) => !["parked", ...SETTLED].includes(derive(T, f, memo, seen).s));
  const unmet = () => [...[...(g?.needs || []).filter((n) => n !== u.id), ...(u.needs || [])].map((n): Unit | MissingUnit => T.byId.get(n) || { id: n, title: n, missing: true })
    .filter((n) => "missing" in n || !SETTLED.has(derive(T, n, memo, seen).s)), ...covered()];
  const waiting = (un: (Unit | MissingUnit)[]): Derived => ({ s: "waiting", unmet: un, ...(un.some((x) => !("missing" in x) && !(u.needs || []).includes(x.id) && !(g?.needs || []).includes(x.id)) ? { why: "a check waits for the open fixes it covers" } : {}) });
  const openQ = T.questions.filter((q) => isOpen(q) && ((r.state === "blocked" && r.on === q.id) || (q.blocks || []).some((s) => matches(T, s, u))));
  if (r.state === "dropped") out = { s: "dropped", why: r.why };
  else if (r.branch && (r.state === "done" || r.state === "review")) out = { s: "merging" };
  else if (r.state === "done") out = { s: "done", how: r.by === "check" ? "check" : r.checker && r.checker !== r.by ? "checked" : u.kind === "gate" ? "owner" : "recorded" };
  else if (r.state === "broken") out = { s: "broken", why: r.evidence };
  // A park a decision made (decide --park) lifts once that decision lapses, is replaced or retired.
  else if (r.state === "parked" && !(r.decision && !parkHolds(T, r.decision))) out = { s: "parked", why: r.why };
  else if (u.kind === "gate") {
    const un = unmet();
    out = un.length ? { s: "waiting", unmet: un } : { s: "you", gate: true };
  } else if (openQ.length) out = { s: "you", qs: openQ };
  else if (r.state === "blocked" && !r.on) out = { s: "stuck", why: r.why };
  else if (r.state === "review") out = { s: "review" };
  // (A claim its session handed back with its work is in progress until that session ends, then
  // shows by its needs and resources, below.)
  else if (r.state === "claimed" && (!r.handedBack || claimAlive(T, u.record!))) out = { s: claimAlive(T, u.record!) ? "doing" : "interrupted" };
  else {
    const un = unmet();
    if (un.length) out = waiting(un);
    else {
      const busy = (u.uses || []).filter((x) => resourceBusy(T, x));
      out = busy.length ? { s: "resource", busy } : { s: "ready" };
    }
  }
  seen.delete(u.id);
  memo.set(u.id, out);
  return out;
}

// One plain sentence for the owner: "can't start until X is done", "waiting on you: …".
export function sentence(T: State, u: Unit, d = derive(T, u)): string {
  const r = u.record || ({} as Partial<NonNullable<Unit["record"]>>);
  switch (d.s) {
    case "dropped": return `dropped${d.why ? ": " + expand(T, d.why) : ""}`;
    case "parked": return `parked: the owner set it aside${d.why ? " (" + expand(T, d.why) + ")" : ""}; \`just tracker unpark ${u.id}\` brings it back`;
    case "done": return { check: "done (its check passes)", checked: `done (checked by ${r.checker})`, owner: "done (the owner passed it)", recorded: "done (recorded)" }[d.how!];
    case "broken": return `broken again: its check passed before and now fails${d.why ? " (" + d.why + ")" : ""}`;
    case "you": return d.gate ? "waiting on you: it's a gate, for you to look at before what follows goes on" : `waiting on you: ${d.qs!.map((q) => name(q)).join("; ")}`;
    case "stuck": return `stuck: ${expand(T, d.why || "no reason given")}`;
    case "review": return `done, waiting for a second check (worked by ${r.by})`;
    case "merging": return `${r.state === "review" ? "done pending a second check" : "done"}; its branch (${r.branch}) isn't on main yet, so what needs it waits`;
    case "doing": return `in progress (session ${r.by}${r.host ? " on " + r.host : ""})`;
    case "interrupted": return `interrupted: session ${r.by}${r.host ? " on " + r.host : ""} stopped mid-unit`;
    case "waiting": return `can't start until ${d.unmet!.map((n) => ("missing" in n ? `${n.id} (missing)` : name(n))).join(", ")} ${d.unmet!.length > 1 ? "are" : "is"} done${d.why ? "; " + d.why : ""}`;
    case "resource": return `waiting for ${d.busy!.map((x) => resTitle(T, x)).join(" and ")} to be free`;
    default: return "ready";
  }
}

// Units this command looks at: one loop's groups if $LOOP names one.
export function scopeGroups(T: State): Group[] {
  const loops = T.project.loops || {};
  const L = ctx.env.LOOP;
  if (!L || L === "all" || !Object.keys(loops).length) return T.groups;
  const l = loops[L] || die(`no loop "${L}" (${Object.keys(loops).join(", ")})`);
  // The loop's own merges (a lane's merge unit) belong to whichever loop the lane runs, and so do
  // the units that sort what a copy down set aside (group aside, each pinned to its machine).
  return T.groups.filter((g) => (l.groups || []).includes(g.id) || g.id === "merge" || g.id === "aside");
}
// A unit filed for one lane (a merge only that lane can settle) is offered to it alone.
const laneOk = (u: Unit) => !u.lane || u.lane === ctx.env.FACTORY_LANE;
export const hostOk = (T: State, u: Unit) => { const h = u.host || T.groupOf.get(u.id)?.host; return (h ? h === ctx.HOST : !ctx.env.FACTORY_HOST_ONLY) && capsOk(u); };

// What a unit ranks by: the higher of its own priority and its group's, so a unit can rise above
// other groups' but never drops below its own group's.
export const priorityOf = (T: State, u: Unit) => Math.max(u.priority ?? 0, T.groupOf.get(u.id)?.priority ?? 0);
// A group's CI fix comes before other work at any priority: until it lands, the group's CI holds
// its own new units (ciHolds), and a fault in shared code goes on breaking other groups' builds
// (29 Oct: one fix sat ready for 7 hours behind higher-priority work, and its fighter missed a
// playtest).
const ciFixFirst = (u: Unit) => (u.tags?.includes("ci-fix") ? 0 : 1);
// Ties at that go by group priority, group order, unit priority, unit order: within a group, the
// order is as it always was.
const tieKey = (T: State, x: Unit) => { const g = T.groupOf.get(x.id)!; return [-(g.priority || 0), g.order ?? 0, -(x.priority || 0), x._i!]; };
// The order units are offered in.
export function rankCmp(T: State) {
  const rank = (x: Unit) => [ciFixFirst(x), -priorityOf(T, x), ...tieKey(T, x)];
  return (a: Unit, b: Unit) => { const A = rank(a), B = rank(b); for (let i = 0; i < A.length; i++) if (A[i] !== B[i]) return A[i] - B[i]; return 0; };
}

// Every unit u needs (its group's needs and its own) is done or dropped.
// So is every open fix it covers, if it's a check (checks.ts).
export const needsMet = (T: State, u: Unit) => [...(T.groupOf.get(u.id)?.needs || []).filter((n) => n !== u.id), ...(u.needs || [])]
  .every((n) => { const x = T.byId.get(n); return x && SETTLED.has(derive(T, x).s); })
  && coveredFixes(T, u).every((f) => ["parked", ...SETTLED].includes(derive(T, f).s));

// A new unit of a group whose due CI comes first (ci.ts ciFirst), or of one whose data it works
// on, waits for that CI: faults show while there's time to fix them. Its group's ci-fix doesn't.
export function ciHolds(T: State, memo = new Map<string, Group | null>()) {
  const first = (gid: string | null | undefined) => {
    if (!gid) return null;
    if (!memo.has(gid)) { const g = T.groupById.get(gid); memo.set(gid, g?.ci && ciFirst(T, g) ? g : null); }
    return memo.get(gid)!;
  };
  return (u: Unit) => (u.tags?.includes("ci-fix") ? null : first(T.groupOf.get(u.id)?.id) || first(dataGroup(T, u)));
}

export type Pick =
  | { code: 0; unit: Unit; lcLate?: Late[]; lastCallIn?: number }
  | { code: 1 | 3; all: Unit[]; wait: boolean; held: Unit[]; skip: Set<string>; forCi?: Group[]; sharing?: Unit[]; heldBack?: Unit[]; backOf?: Group[]; gaveBack?: Unit[]; late?: Late[]; timeLeft?: number; lcLate?: Late[]; lastCallIn?: number };
// A unit passed over for want of time, and the seconds it needs.
export interface Late { unit: Unit; secs: number }
// What a lane passes over for now (`next --skip-units`, `--time-left`, `--last-call-in`): units its
// sessions gave back unstarted this run, and units whose usual session (sessions.ts) is longer
// than the seconds left before its stop. Neither counts as work still moving: waiting won't make
// it fit. And units its last call will hold back (lastCall: of those groups, or on their data, or
// using those resources) whose least time (leastSecs) is longer than the seconds left before it
// (#159: sessions claimed an editor unit with too little time left, and gave it back). Those count
// as moving: last call comes, and the lane goes on from there.
export interface NotNow { units?: Set<string>; timeLeft?: number; lastCall?: { in: number; groups: Set<string>; uses: Set<string> } }
// What this lane could take now, in the order `next` offers it: its own unit in progress, then a
// CI fix (ciFixFirst), then by priority (priorityOf). At equal priority an interrupted, broken or review unit (not your own),
// or one handed back with its work, comes back first, then one whose data this machine already leases, so data moves only when rank
// says it should; then group priority, group order, unit priority, unit order.
// skip: resources this lane takes no unit with (`next --skip-uses`: the loop keeps them free for
// CI before last call). A unit working on a group's data that another session here is working on
// (sharedHere) isn't taken: that data is one copy in work/, the other session's until it ends.
// skipGroups: groups whose units, and units working on whose data, this lane takes none of
// (`next --skip-groups`: in last call, the groups whose CI runs here tonight).
export function ranked(T: State, groupFilter?: string, skip = new Set<string>(), skipGroups = new Set<string>()): Unit[] {
  const TAG = ctx.TAG;
  const groups = scopeGroups(T).filter((g) => !groupFilter || g.id === groupFilter);
  const shared = sharedHere(T);
  const skipped = (u: Unit) => (u.uses || []).some((r) => skip.has(r)) || (!own(u) && (!!shared(u) || inGroups(T, u, skipGroups)));
  const st = (u: Unit) => derive(T, u).s;
  const free = (u: Unit) => !(u.uses || []).some((r) => resourceBusy(T, r));
  const own = (u: Unit) => u.record?.state === "claimed" && u.record.by === TAG && st(u) === "doing";
  const held = ciHolds(T);
  // An interrupted or broken unit whose needs went unmet since (one was reopened) waits for them.
  const back = (u: Unit) => { const s = st(u); return free(u) && (s === "review" ? u.record?.by !== TAG : (s === "interrupted" || s === "broken") && needsMet(T, u)); };
  const units = groups.flatMap((g) => g.units).filter((u) => u.kind !== "gate" && hostOk(T, u) && laneOk(u) && !lockHeld("unit", u.id) && leaseOk(T, u) && !skipped(u)
    && (own(u) || (st(u) === "ready" && !held(u)) || back(u)));
  const BACK: Partial<Record<Status, number>> = { interrupted: 0, broken: 1, review: 2 };
  const key = (u: Unit) => [own(u) ? 0 : 1, ciFixFirst(u), -priorityOf(T, u), u.record?.handedBack ? 0 : BACK[st(u)] ?? 3, leasedHere(T, u) ? 0 : 1, ...tieKey(T, u)];
  return units.sort((a, b) => { const A = key(a), B = key(b); for (let i = 0; i < A.length; i++) if (A[i] !== B[i]) return A[i] - B[i]; return 0; });
}
// u is in one of these groups, or works on one's data.
const inGroups = (T: State, u: Unit, gs: Set<string>) => gs.size > 0 && (gs.has(T.groupOf.get(u.id)?.id ?? "") || gs.has(dataGroup(T, u) ?? ""));
// The data group a unit works on, when a session here other than this one (heldHere), or the
// group's CI, is working on that group now, with who is; else null.
export function sharedHere(T: State) {
  const held = heldHere(T);
  const ci = (g: string) => { const x = T.groupById.get(g); return !!x?.ci && ((!!x.ci.running && x.ci.running.host === ctx.HOST && claimAlive(T, x.ci.running)) || lockHeld("ci", g)); };
  return (u: Unit) => {
    const g = dataGroup(T, u);
    if (!g) return null;
    const by = [...(held.get(g) || []).filter((x) => x !== u).map((x) => `session ${x.record!.by} here (${name(x)})`), ...(ci(g) ? [`its CI, running here`] : [])];
    return by.length ? { group: g, by } : null;
  };
}
// `next`: the first of ranked. code 0 = found, 1 = nothing workable here, 3 = nothing can move
// until the owner answers. With 1, wait says other work is still moving (in progress elsewhere,
// waiting on a resource, ready for another machine). Units --skip-uses holds back still count
// as moving, so the lane waits rather than stops. Units --skip-groups holds back count only while
// their group's CI (or their data's) is running, due or stale: the lane waits for that CI, then
// stops once nothing else is left.
export function pick(T: State, groupFilter?: string, skip = new Set<string>(), skipGroups = new Set<string>(), notNow: NotNow = {}): Pick {
  const TAG = ctx.TAG;
  const groups = scopeGroups(T).filter((g) => !groupFilter || g.id === groupFilter);
  const skipped = (u: Unit) => (u.uses || []).some((r) => skip.has(r));
  const st = (u: Unit) => derive(T, u).s;
  const gaveBack: Unit[] = [], late: Late[] = [], lcLate: Late[] = [];
  const lc = notNow.lastCall;
  const lcHolds = (u: Unit) => !!lc && (inGroups(T, u, lc.groups) || (u.uses || []).some((r) => lc.uses.has(r)));
  const found = (u: Unit): Pick => ({ code: 0, unit: u, ...(lc ? { lcLate, lastCallIn: lc.in } : {}) });
  for (const u of ranked(T, groupFilter, skip, skipGroups)) {
    // This session's own claim is never passed over.
    if (u.record?.state === "claimed" && u.record.by === TAG) return found(u);
    if (notNow.units?.has(u.id)) { gaveBack.push(u); continue; }
    const secs = notNow.timeLeft === undefined ? null : u.minMinutes ? u.minMinutes * 60 : usualSecs(T, u);
    if (secs !== null && secs > notNow.timeLeft!) { late.push({ unit: u, secs }); continue; }
    if (lcHolds(u)) { const need = leastSecs(T, u); if (need > lc!.in) { lcLate.push({ unit: u, secs: need }); continue; } }
    return found(u);
  }
  // Held back: what --skip-groups keeps this lane from starting, a unit waiting for a busy resource
  // too. Work in flight, and one waiting on the owner, parked or stuck, stays with the rest, so the
  // stop says so.
  const back = groups.flatMap((g) => g.units).filter((x) => x.kind !== "gate" && inGroups(T, x, skipGroups)
    && !SETTLED.has(st(x)) && !["doing", "merging", "you", "parked", "stuck"].includes(st(x)));
  const all = groups.flatMap((g) => g.units).filter((x) => !back.includes(x));
  // Workable here but for another session here on their data: they wait for it to end.
  const shared = sharedHere(T);
  const sharing = all.filter((x) => x.kind !== "gate" && shared(x) && hostOk(T, x) && laneOk(x) && leaseOk(T, x) && !(x.uses || []).some((r) => skip.has(r))
    && (st(x) === "ready" || (st(x) === "review" && x.record?.by !== TAG) || (["interrupted", "broken"].includes(st(x)) && needsMet(T, x))));
  const ownerHolds = all.some((x) => st(x) === "you");
  // Ready here but for their group's due CI: they wait for it, like a busy resource.
  const ciHeld = ciHolds(T);
  const forCi = all.filter((x) => x.kind !== "gate" && st(x) === "ready" && ciHeld(x) && hostOk(T, x) && laneOk(x) && !skipped(x));
  // Workable here but for --skip-uses: they wait for the resource like a busy one.
  const held = all.filter((x) => x.kind !== "gate" && skipped(x) && hostOk(T, x) && laneOk(x) && leaseOk(T, x)
    && (st(x) === "ready" || (st(x) === "review" && x.record?.by !== TAG) || (["interrupted", "broken"].includes(st(x)) && needsMet(T, x))));
  // Can anything move without the owner? Then a loop waits for it instead of stopping.
  const live = new Map<string, boolean>();
  const ciLive = (gid: string | null | undefined) => {
    if (!gid) return false;
    if (!live.has(gid)) { const g = T.groupById.get(gid); live.set(gid, !!g?.ci && ["running", "due", "stale"].includes(ciState(T, g).s)); }
    return live.get(gid)!;
  };
  // (Not what this lane passed over for now: waiting won't make it fit.)
  const passed = new Set([...gaveBack, ...late.map((x) => x.unit)]);
  const moving = lcLate.length > 0 || back.some((x) => ciLive(T.groupOf.get(x.id)?.id) || ciLive(dataGroup(T, x))) || held.length > 0 || forCi.length > 0 || sharing.length > 0 || all.some((x) => x.kind !== "gate" && !passed.has(x) && (["doing", "resource", "merging"].includes(st(x)) || (st(x) === "interrupted" && needsMet(T, x)) || lockHeld("unit", x.id)
    || (["ready", "broken", "review", "interrupted"].includes(st(x)) && capsSomewhere(x) && (st(x) === "ready" || st(x) === "review" || needsMet(T, x)) && (!hostOk(T, x) || !leaseOk(T, x) || (x.uses || []).some((r) => resourceBusy(T, r))))));
  const heldBack = back.filter((x) => hostOk(T, x) && laneOk(x));
  const backOf = [...new Set(heldBack.map((x) => { const g = T.groupOf.get(x.id)!; return skipGroups.has(g.id) ? g : T.groupById.get(dataGroup(T, x)!)!; }))];
  return { code: ownerHolds && !moving ? 3 : 1, all, wait: moving, held, skip, forCi: [...new Set(forCi.map((x) => ciHeld(x)!))], sharing, heldBack, backOf, gaveBack, late, timeLeft: notNow.timeLeft, lcLate, lastCallIn: lc?.in };
}

// "runs before X, after Y": where a unit sits in the order `next` offers ready units.
export function orderLine(T: State, u: Unit) {
  const cmp = rankCmp(T);
  const units = scopeGroups(T).flatMap((g) => g.units).filter((x) => x.kind !== "gate" && (x === u || derive(T, x).s === "ready"));
  units.sort(cmp);
  const i = units.indexOf(u);
  if (i < 0) return "";
  const before = units[i + 1], after = units[i - 1];
  if (!before && !after) return "no other ready unit to compare with";
  return [before ? `runs before ${name(before)}` : "runs after every other ready unit", after && before ? `after ${name(after)}` : after ? `(last: after ${name(after)})` : "(first of the ready units)"].join(", ");
}
export function groupOrderLine(T: State, g: Group) {
  const cmp = rankCmp(T);
  const lead = (x: Group) => x.units.filter((v) => v.kind !== "gate" && !SETTLED.has(derive(T, v).s)).sort(cmp)[0];
  const gs = scopeGroups(T).filter((x) => x === g || lead(x)).sort((a, b) => { const A = lead(a), B = lead(b); if (!A || !B) return A ? 1 : B ? -1 : 0; return cmp(A, B); });
  const i = gs.indexOf(g);
  if (i < 0 || gs.length < 2) return "no other open group to compare with";
  return gs[i + 1] ? `its units run before ${gs[i + 1].title} (${gs[i + 1].id})'s` : `its units run after every other open group's (last: after ${gs[i - 1].title} (${gs[i - 1].id}))`;
}

// "2 units using the editor, held back: too little time before last call (45 min needed, 40 left)"
export function lcLateWhy(T: State, late: Late[], left: number) {
  const m = (secs: number) => Math.round(secs / 60);
  const lens = [...new Set(late.map((x) => m(x.secs)))].sort((a, b) => a - b);
  const uses = [...new Set(late.flatMap((x) => x.unit.uses || []))].sort();
  return `${plural(late.length, "unit")}${uses.length ? ` using ${uses.map((r) => resTitle(T, r)).join(" or ")}` : ""}, held back: too little time before last call (${lens.length > 1 ? `${lens[0]} to ${lens.at(-1)}` : lens[0]} min needed, ${m(left)} left)`;
}
export function idleWhy(T: State, p: Extract<Pick, { code: 1 | 3 }>) {
  const by: Partial<Record<Status, Unit[]>> = {};
  for (const u of p.all) { const s = derive(T, u).s; if (!SETTLED.has(s)) (by[s] ||= []).push(u); }
  const parts: string[] = [];
  if (p.late?.length) {
    const m = (secs: number) => Math.round(secs / 60);
    const lens = [...new Set(p.late.map((x) => m(x.secs)))].sort((a, b) => a - b);
    parts.push(`${plural(p.late.length, "unit")} whose usual session (${lens.length > 1 ? `${lens[0]} to ${lens.at(-1)}` : lens[0]} min) won't fit in the ${m(p.timeLeft!)} min left before the stop`);
  }
  if (p.lcLate?.length) parts.push(lcLateWhy(T, p.lcLate, p.lastCallIn!));
  if (p.gaveBack?.length) parts.push(`${plural(p.gaveBack.length, "unit")} this lane's sessions gave back unstarted this run`);
  if (p.heldBack?.length) parts.push(`${plural(p.heldBack.length, "unit")} of ${p.backOf!.map((g) => g.title).join(", ")} or on ${p.backOf!.length > 1 ? "their" : "its"} data, held back (--skip-groups: landing one would make that CI run again)`);
  if (p.held?.length) parts.push(`${plural(p.held.length, "unit")} using ${[...p.skip].map((r) => resTitle(T, r)).join(" or ")}, which this lane keeps free for CI (--skip-uses)`);
  if (p.sharing?.length) {
    const shared = sharedHere(T), gs = [...new Set(p.sharing.map((u) => shared(u)!.group))];
    const by = [...new Set(p.sharing.flatMap((u) => shared(u)!.by))];
    parts.push(`${plural(p.sharing.length, "unit")} working on ${gs.map((g) => groupTitle(T, g)).join(", ")}'s data, which ${by.join(" and ")} ${by.length > 1 ? "are" : "is"} working on`);
  }
  if (p.forCi?.length) parts.push(`new units of ${p.forCi.map((g) => g.title).join(", ")} wait for ${p.forCi.length > 1 ? "their" : "its"} CI, which is due and runs first`);
  if (by.you) parts.push(`${plural(by.you.length, "unit")} waiting on you`);
  if (by.review) parts.push(`${plural(by.review.length, "unit")} in review that this session worked (a fresh context has to check ${by.review.length > 1 ? "them" : "it"})`);
  if (by.resource) parts.push(`${plural(by.resource.length, "unit")} waiting for a resource`);
  if (by.stuck) parts.push(`${plural(by.stuck.length, "unit")} stuck`);
  if (by.doing) parts.push(`${plural(by.doing.length, "unit")} in progress elsewhere`);
  if (by.merging) parts.push(`${plural(by.merging.length, "unit")} done and waiting to merge into main`);
  const lane = (by.ready || []).filter((u) => hostOk(T, u) && lockHeld("unit", u.id));
  if (lane.length) parts.push(`${plural(lane.length, "unit")} in another lane on this machine`);
  const other = (by.ready || []).filter((u) => !hostOk(T, u) && capsSomewhere(u));
  if (other.length) parts.push(`${plural(other.length, "unit")} for another machine`);
  const nobody = (by.ready || []).filter((u) => !capsSomewhere(u));
  if (nobody.length) parts.push(`${plural(nobody.length, "unit")} needing what no machine in docs/machines.md can do (${[...new Set(nobody.flatMap((u) => u.caps!))].join(", ")})`);
  const workable = [...(by.ready || []), ...(by.interrupted || []), ...(by.broken || [])].filter((u) => hostOk(T, u) && !leaseOk(T, u));
  const elsewhere = workable.filter((u) => liveLease(T, dataGroup(T, u)));
  if (elsewhere.length) parts.push(`${plural(elsewhere.length, "unit")} of ${[...new Set(elsewhere.map((u) => `${groupTitle(T, dataGroup(T, u)!)} (leased by ${liveLease(T, dataGroup(T, u))!.host})`))].join(", ")}`);
  const noRoom = workable.filter((u) => !liveLease(T, dataGroup(T, u)));
  if (noRoom.length) parts.push(ctx.env.FACTORY_LEASES === "1"
    ? `${plural(noRoom.length, "unit")} needing a new lease, which this machine's cache has no room for`
    : `${plural(noRoom.length, "unit")} whose data isn't leased here (run them through the loop, which copies the data: \`just loop --max 1\`)`);
  const unmet = [...(by.interrupted || []), ...(by.broken || [])].filter((u) => !needsMet(T, u));
  if (unmet.length) parts.push(`${plural(unmet.length, "interrupted or broken unit")} waiting on what ${unmet.length > 1 ? "they need" : "it needs"} (reopened since)`);
  if (by.waiting && !parts.length) parts.push(`${plural(by.waiting.length, "unit")} waiting on other work that can't move`);
  if (by.parked && !parts.length) parts.push(`${plural(by.parked.length, "unit")} parked`);
  return parts.length ? `nothing workable: ${parts.join("; ")}` : "nothing workable: every unit is done or dropped";
}

// Why a unit sits where it does in ranked(), for `queue`: its priority and where that comes
// from, what state brings it back, and where its data is.
export function rankWhy(T: State, u: Unit) {
  const p = priorityOf(T, u);
  const parts = [p ? `priority ${p}${(u.priority || 0) < p ? " (its group's)" : ""}` : "no priority"];
  const s = derive(T, u).s;
  if (s === "doing") parts.push("this lane's own, in progress");
  else if (s !== "ready") parts.push(`${LABEL[s]}, so it comes back first among units of its priority`);
  const dg = dataGroup(T, u);
  if (dg) { const l = liveLease(T, dg); parts.push(l ? "its data is here" : `its data is on the store and moves to ${ctx.HOST}`); }
  return parts.join("; ");
}
