// The scorecard's figures, worked out from its records (scorecard-read.ts) for a period: how each
// session ended, units claimed over and over, the review, waiting and CI, and the cost of a
// finished unit; then its lines, each with the share of the period's session cost or lane time
// it accounts for, ranked by it. scorecard.ts prints them.
import type { LogEntry } from "../../tracker/src/types.ts";
import { gaveBackLine } from "../../tracker/src/sessions.ts";
import { fill } from "../../tracker/src/templates.ts";
import { today } from "../../tracker/src/commands/expect.ts";
import type { Records, Row } from "./scorecard-read.ts";
import { ENDINGS, type Ending } from "./scorecard-names.ts";

// What the tracker writes for these (tracker/src/commands/loop.ts review-fix, probes.ts); a test
// runs the tracker's own commands and reads them back, so a change there shows.
const SENT_BACK = /: back to ready: the loop's review asked for fixes$/;
const SENT_BACK_TWICE = /: stuck: the loop's review asked for fixes a second time$/;
const CHECK_DONE = /: now done \(its check passes\)$/;

export interface Line { text: string; share: number | null; of: "cost" | "lane" | null; section: number }
export interface UnitClaims { id: string; title: string; claims: number; endings: Partial<Record<Ending, number>>; cost: number }
export interface GroupCost { id: string; title: string; count: number; median: number; total: number; flagged: boolean }
export interface PredictionNow { id: string; name: string; op: string; value: number; by: string; why: string; state: "open" | "held" | "missed"; now: number | null }
export interface Card {
  since: number | null;
  empty: boolean;
  figures: Record<string, number | null>;
  notRecorded: Record<string, string>;
  lines: Line[];
  units: UnitClaims[];
  groups: GroupCost[];
  unknown: { where: string; what: string; count: number }[];
  predictions: PredictionNow[];
}

const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
const share = (a: number, b: number) => (b > 0 ? r4(a / b) : null);
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const atOf = (e: LogEntry) => Math.floor(Date.parse(e.at) / 1000);
const titleOf = (text: string) => text.replace(/: claimed(?: \(.*\))?$/, "");
export const money = (x: number) => `$${x.toFixed(2)}`;
export const pct = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)}%`);
export const minutes = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${Math.round(m % 60)} min` : ""}` : `${Math.round(m)} min`);
const times = (n: number) => (n === 1 ? "once" : n === 2 ? "twice" : `${n} times`);

// A claim in the tracker's log, and how its session ended.
interface Claim { tag: string; unit: string; title: string; i: number; at: number; ending: Ending; row?: Row }

export function score(R: Records, since: number | null, now = new Date()): Card {
  const inP = (t: number) => since === null || t >= since;
  const log = R.log;
  const figures: Record<string, number | null> = {}, notRecorded: Record<string, string> = {};
  const lines: Line[] = [];

  // ------------------------------------------------ how each claim's session ended
  const byTag = new Map<string, number[]>(), byUnit = new Map<string, number[]>();
  log.forEach((e, i) => {
    if (e.tag) (byTag.get(e.tag) ?? byTag.set(e.tag, []).get(e.tag)!).push(i);
    if (e.id) (byUnit.get(e.id) ?? byUnit.set(e.id, []).get(e.id)!).push(i);
  });
  const finishes = (e: LogEntry) => ["done", "review", "drop"].includes(e.cmd) || (e.cmd === "check" && CHECK_DONE.test(e.text));
  const claims: Claim[] = [];
  const claimAt = new Map<number, Claim>();
  log.forEach((e, i) => {
    if (e.cmd !== "claim" || !e.id || !e.tag) return;
    const c: Claim = { tag: e.tag, unit: e.id, title: titleOf(e.text), i, at: atOf(e), ending: "interrupted" };
    claims.push(c); claimAt.set(i, c);
  });
  // The tag's lines after the claim, up to its next claim: about the unit, or about none (an ask).
  const linesOf = (c: Claim) => {
    const out: { e: LogEntry; j: number }[] = [];
    for (const j of byTag.get(c.tag) ?? []) {
      if (j <= c.i) continue;
      const e = log[j];
      if (e.cmd === "claim") break;
      if (!e.id || e.id === c.unit) out.push({ e, j });
    }
    return out;
  };
  const evIn = (row: Row, kind: string, unit?: string) => R.events.some((v) => v.lane === row.lane && v.kind === kind && (unit === undefined || v.unit === unit)
    && v.t >= Math.floor(row.started / 60) * 60 && v.t <= row.end + 120);
  // Was the unit's record at log line i sent back by the review, before the unit's next claim?
  const sentBackAfter = (unit: string, i: number) => {
    for (const j of byUnit.get(unit) ?? []) {
      if (j <= i) continue;
      const e = log[j];
      if (e.cmd === "claim") return false;
      if ((e.cmd === "reopen" && SENT_BACK.test(e.text)) || (e.cmd === "block" && SENT_BACK_TWICE.test(e.text))) return true;
    }
    return false;
  };
  const classify = (c: Claim) => {
    const ls = linesOf(c).map((x) => x.e), fin = linesOf(c).find((x) => x.e.id === c.unit && finishes(x.e));
    if (fin) { c.ending = sentBackAfter(c.unit, fin.j) ? "sent_back" : "finished"; return; }
    if (c.row && evIn(c.row, "oom-kill", c.unit)) { c.ending = "oom"; return; }
    if (c.row && evIn(c.row, "silent")) { c.ending = "silent"; return; }
    if (ls.some((e) => e.cmd === "ask")) { c.ending = "asked"; return; }
    if (ls.some((e) => e.cmd === "block" && e.id === c.unit)) { c.ending = "blocked"; return; }
    const un = ls.find((e) => e.cmd === "unclaim" && e.id === c.unit);
    if (un) { c.ending = gaveBackLine(un) ? "unstarted" : "handed_back"; return; }
    c.ending = "interrupted";
  };

  const claimsOf = new Map<string, Claim[]>();
  for (const c of claims) (claimsOf.get(c.tag) ?? claimsOf.set(c.tag, []).get(c.tag)!).push(c);
  // This machine's sessions: its lanes' run index, each joined to its claim by its tag.
  const rows = R.rows.filter((r) => inP(r.started));
  const sessions = rows.filter((r) => !r.ci);
  const ofRow = new Map<Row, Claim | null>();
  for (const r of sessions) {
    const cs = claimsOf.get(r.tag) ?? [];
    const c = cs.find((x) => x.unit === r.unit) ?? cs.filter((x) => x.at <= r.started + 60).at(-1) ?? null;
    if (c) c.row = r;
    ofRow.set(r, c);
  }
  for (const c of claims) classify(c);
  const endingOf = (r: Row): Ending => ofRow.get(r)?.ending ?? "unknown";
  // A session with lines but no claim: unknown too, and named.
  const unknown = [...R.unknown, ...sessions.filter((r) => !ofRow.get(r)).map((r) => ({ where: `${r.lane}'s run index`, what: `session ${r.tag}, ${byTag.get(r.tag)?.length ? "whose claim isn't in the tracker's log" : "which the tracker's log has no line of"}` }))];

  const cost = (rs: Row[]) => r4(rs.reduce((s, r) => s + (r.cost ?? 0), 0));
  const N = sessions.length, C = cost(sessions);
  const laneRows = rows;
  figures["sessions.count"] = N;
  figures["sessions.cost"] = C;

  // ------------------------------------------------ waiting (lane time)
  let usage = 0, idle = 0;
  for (const lane of R.lanes) {
    const rs = laneRows.filter((r) => r.lane === lane), evs = R.events.filter((v) => v.lane === lane);
    // The usage pause, by its events' kinds: from a pause to the resume, or the lane's stop.
    let until = -Infinity;
    for (const v of evs) {
      if (!/^usage-(?:.+-)?pause$/.test(v.kind) || v.t < until || !inP(v.t)) continue;
      const end = evs.find((x) => x.t >= v.t && x !== v && (/^usage-(?:.+-)?resume$/.test(x.kind) || x.kind === "lane-stop" || x.kind === "usage-stop"))?.t
        ?? rs.find((r) => r.started > v.t)?.started;
      if (end === undefined) continue;
      usage += (end - v.t) / 60; until = end;
    }
    // Nothing workable: the gap between two iterations that holds an idle event, ending at the
    // lane's stop if it stopped first, and starting at the iteration before unless the lane
    // stopped between (then at the event: when it started again isn't recorded).
    const seen = new Set<number>();
    for (const v of evs) {
      if (v.kind !== "idle" || !inP(v.t)) continue;
      const prev = rs.filter((r) => r.started <= v.t).at(-1)?.end, next = rs.find((r) => r.started > v.t)?.started;
      const stop = evs.find((x) => x.kind === "lane-stop" && x.t >= v.t && (next === undefined || x.t < next))?.t;
      const end = stop ?? next;
      if (end === undefined) continue;
      const stoppedBefore = prev !== undefined && evs.some((x) => x.kind === "lane-stop" && x.t > prev && x.t < v.t);
      const start = prev !== undefined && !stoppedBefore ? Math.min(prev, v.t) : v.t;
      if (seen.has(start)) continue;
      seen.add(start);
      idle += Math.max(0, end - start) / 60;
    }
  }
  usage = Math.round(usage); idle = Math.round(idle);
  const ciMinutes = laneRows.filter((r) => r.ci).reduce((s, r) => s + r.minutes, 0);
  const laneMin = laneRows.reduce((s, r) => s + r.minutes, 0) + usage + idle;
  figures["lane.minutes"] = laneMin;

  // ------------------------------------------------ 1. sessions that finished no unit
  const noUnit = sessions.filter((r) => endingOf(r) !== "finished");
  figures["sessions.no_unit.count"] = noUnit.length;
  figures["sessions.no_unit.share"] = share(noUnit.length, N);
  figures["sessions.no_unit.cost"] = cost(noUnit);
  figures["sessions.no_unit.cost_share"] = share(cost(noUnit), C);
  if (N) lines.push({ section: 1, of: "cost", share: share(cost(noUnit), C), text: `Sessions that finished no unit: ${noUnit.length} of ${N} (${pct(share(noUnit.length, N))}), ${money(cost(noUnit))}` });
  for (const k of Object.keys(ENDINGS) as (keyof typeof ENDINGS)[]) {
    const rs = noUnit.filter((r) => endingOf(r) === k);
    figures[`sessions.no_unit.${k}.count`] = rs.length;
    figures[`sessions.no_unit.${k}.share`] = share(rs.length, N);
    figures[`sessions.no_unit.${k}.cost`] = cost(rs);
    figures[`sessions.no_unit.${k}.cost_share`] = share(cost(rs), C);
    if (rs.length) lines.push({ section: 1, of: "cost", share: share(cost(rs), C), text: `  Sessions that ${ENDINGS[k]}: ${rs.length} (${pct(share(rs.length, N))} of sessions), ${money(cost(rs))}` });
  }

  // ------------------------------------------------ 2. units by claims (every machine)
  const open = new Map<string, Claim[]>();
  log.forEach((e, i) => {
    if (!e.id) return;
    if (e.cmd === "add-unit" || e.cmd === "done" || (e.cmd === "check" && CHECK_DONE.test(e.text))) open.set(e.id, []);
    else if (e.cmd === "claim" && claimAt.has(i)) (open.get(e.id) ?? open.set(e.id, []).get(e.id)!).push(claimAt.get(i)!);
  });
  const units: UnitClaims[] = [];
  for (const [id, cs0] of open) {
    const cs = cs0.filter((c) => inP(c.at));
    if (cs.length < 2) continue;
    const endings: Partial<Record<Ending, number>> = {};
    for (const c of cs) endings[c.ending] = (endings[c.ending] ?? 0) + 1;
    units.push({ id, title: cs.at(-1)!.title, claims: cs.length, endings, cost: r4(cs.reduce((s, c) => s + (c.row?.cost ?? 0), 0)) });
  }
  units.sort((a, b) => b.claims - a.claims || b.cost - a.cost || a.id.localeCompare(b.id));
  figures["units.reclaimed.count"] = units.length;
  figures["units.claims.max"] = units[0]?.claims ?? (claims.some((c) => inP(c.at)) ? 1 : 0);
  const SAID: Record<Ending, string> = { finished: "finished", sent_back: "sent back by the review", unstarted: "given back unstarted", handed_back: "handed back with its work kept",
    interrupted: "interrupted or cut off", blocked: "left stuck", asked: "asked the owner", oom: "killed over memory", silent: "silent", unknown: "unknown" };
  for (const u of units.slice(0, 5)) {
    const how = (Object.entries(u.endings) as [Ending, number][]).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${SAID[k]}`).join(", ");
    lines.push({ section: 2, of: "cost", share: share(u.cost, C), text: `${u.title} (${u.id}): claimed ${times(u.claims)} since it was last done or added: ${how}${u.cost ? `; ${money(u.cost)} here` : ""}` });
  }

  // ------------------------------------------------ 3. the review
  const landed = new Set(log.filter((e) => e.cmd === "merged" && inP(atOf(e))).map((e) => `${e.at}|${e.tag ?? ""}|${e.host ?? ""}`)).size;
  const first = log.filter((e) => e.cmd === "reopen" && SENT_BACK.test(e.text) && inP(atOf(e))).length;
  const twice = log.filter((e) => e.cmd === "block" && SENT_BACK_TWICE.test(e.text) && inP(atOf(e))).length;
  const unrev = R.events.filter((v) => v.kind === "review-skipped" && inP(v.t)).length;
  const reviewed = Math.max(0, landed - unrev) + first + twice;
  figures["review.landed.count"] = landed;
  figures["review.reviewed.count"] = reviewed;
  figures["review.sent_back.count"] = first + twice;
  figures["review.sent_back.rate"] = share(first + twice, reviewed);
  figures["review.sent_back_twice.count"] = twice;
  figures["review.unreviewed.count"] = unrev;
  if (landed || reviewed || unrev) lines.push({ section: 3, of: null, share: null, text: `The review: ${reviewed} branch${reviewed === 1 ? "" : "es"} reviewed, ${first + twice} sent back for fixes (${pct(share(first + twice, reviewed))}), ${twice} of them a second time; ${landed} landed, ${unrev} without a review` });

  // ------------------------------------------------ 4. waiting, and CI
  figures["wait.usage.minutes"] = usage;
  figures["wait.usage.share"] = share(usage, laneMin);
  figures["wait.nothing_workable.minutes"] = idle;
  figures["wait.nothing_workable.share"] = share(idle, laneMin);
  if (usage) lines.push({ section: 4, of: "lane", share: share(usage, laneMin), text: `Waiting in the usage pause: ${minutes(usage)}` });
  if (idle) lines.push({ section: 4, of: "lane", share: share(idle, laneMin), text: `Waiting with nothing workable: ${minutes(idle)} (what for isn't recorded: below)` });
  const NR: [string, string, string][] = [
    ["wait.resource.minutes", "Waiting for a resource", "the loop would have to record each wait as it ends: the resource, and the minutes"],
    ["wait.memory.minutes", "Waiting for the memory budget", "the heavy-job queue would have to record each wait as it ends: the job, and the minutes"],
    ["wait.in_flight.minutes", "Waiting for work in flight elsewhere", "the loop would have to record why it waited (the units in progress elsewhere), and the minutes"],
  ];
  for (const [n, what, need] of NR) { figures[n] = null; notRecorded[n] = need; lines.push({ section: 4, of: null, share: null, text: `${what}: not recorded (${need})` }); }

  // CI: runs and their steps from the tracker's log (every machine); time from this machine.
  const stepNames = Object.keys(R.ciSteps);
  const titleCi = (t: string) => { const k = t.indexOf(": CI "); return k < 0 ? null : t.slice(0, k); };
  const started = new Map<string, string[]>();
  const reach = new Map<string, number>(), fail = new Map<string, number>();
  const add = (m: Map<string, number>, s: string) => m.set(s, (m.get(s) ?? 0) + 1);
  let runs = 0, failed = 0;
  for (const e of log) {
    if (!e.cmd.startsWith("ci-")) continue;
    const t = titleCi(e.text);
    if (t === null) continue;
    if (e.cmd === "ci-start") { started.set(t, (/: CI started \((.*)\)$/.exec(e.text)?.[1] ?? "").split(", ").filter(Boolean)); continue; }
    if (!inP(atOf(e))) { if (e.cmd === "ci-pass" || e.cmd === "ci-fail" || e.cmd === "ci-unclaim") started.delete(t); continue; }
    if (e.cmd === "ci-pass") {
      runs++;
      for (const s of (/: CI passed \((.*)\)$/.exec(e.text)?.[1] ?? "").split(", ").filter(Boolean)) add(reach, s);
      started.delete(t);
    } else if (e.cmd === "ci-fail") {
      runs++; failed++;
      const s = stepNames.find((x) => e.text.includes(`: CI failed: ${x} failed`)) ?? /: CI failed: (\S+) failed \(/.exec(e.text)?.[1];
      if (s) {
        const plan = started.get(t) ?? [];
        const k = plan.indexOf(s);
        for (const x of k >= 0 ? plan.slice(0, k + 1) : [s]) add(reach, x);
        add(fail, s);
      }
      started.delete(t);
    } else if (e.cmd === "ci-unclaim") started.delete(t);
  }
  figures["ci.runs"] = runs;
  figures["ci.failed.count"] = failed;
  figures["ci.failed.rate"] = share(failed, runs);
  figures["ci.minutes"] = ciMinutes;
  figures["ci.share"] = share(ciMinutes, laneMin);
  if (runs || ciMinutes) lines.push({ section: 4, of: "lane", share: share(ciMinutes, laneMin), text: `Group CI: ${runs} run${runs === 1 ? "" : "s"}, ${failed} failed (${pct(share(failed, runs))}); ${minutes(ciMinutes)} of this machine's lane time` });
  for (const s of [...new Set([...stepNames, ...reach.keys()])]) {
    const def = R.ciSteps[s]?.cmd;
    const secs: number[] = [];
    if (def) for (const g of R.groups) {
      const cmd = fill(def, { ...g.params, group: g.id });
      for (const [k, v] of Object.entries(R.history)) if ((k === cmd || k.endsWith(` bash -c ${cmd}`)) && Array.isArray(v.secs)) secs.push(...v.secs.filter((x) => typeof x === "number"));
    }
    const n = reach.get(s) ?? 0, f = fail.get(s) ?? 0;
    figures[`ci.step.${s}.runs`] = n;
    figures[`ci.step.${s}.failed`] = f;
    figures[`ci.step.${s}.fail_rate`] = share(f, n);
    figures[`ci.step.${s}.secs`] = secs.length ? median(secs) : null;
    if (n || secs.length) lines.push({ section: 4, of: null, share: null, text: `CI step ${s}: ${n} run${n === 1 ? "" : "s"}, ${f} failed (${pct(share(f, n))}); ${secs.length ? `takes about ${minutes(median(secs) / 60)} (the heavy-job history's last runs)` : "its time isn't in the heavy-job history"}` });
  }

  // ------------------------------------------------ 5. cost of a finished unit (this machine's sessions)
  const rowOfClaim = new Map<number, Row>();
  for (const [r, c] of ofRow) if (c) rowOfClaim.set(c.i, r);
  const unitCosts: { id: string; cost: number }[] = [];
  const since0 = new Map<string, number>();
  log.forEach((e, i) => {
    if (!e.id) return;
    const done = e.cmd === "done" || (e.cmd === "check" && CHECK_DONE.test(e.text));
    if (e.cmd === "add-unit") { since0.set(e.id, i); return; }
    // (A done the review sent back isn't a finished unit: its cost goes to the one that is.)
    if (!done || sentBackAfter(e.id, i)) return;
    const from = since0.get(e.id) ?? -1;
    since0.set(e.id, i);
    if (!inP(atOf(e))) return;
    const rs = (byUnit.get(e.id) ?? []).filter((j) => j > from && j < i && rowOfClaim.has(j)).map((j) => rowOfClaim.get(j)!);
    if (rs.length) unitCosts.push({ id: e.id, cost: cost(rs) });
  });
  const factoryMedian = unitCosts.length ? r4(median(unitCosts.map((u) => u.cost))) : null;
  figures["unit_cost.count"] = unitCosts.length;
  figures["unit_cost.median"] = factoryMedian;
  figures["unit_cost.total"] = r4(unitCosts.reduce((s, u) => s + u.cost, 0));
  const groups: GroupCost[] = [];
  for (const gid of [...new Set(unitCosts.map((u) => u.id.split("/")[0]))].sort()) {
    const xs = unitCosts.filter((u) => u.id.split("/")[0] === gid).map((u) => u.cost);
    const m = r4(median(xs)), tot = r4(xs.reduce((s, x) => s + x, 0));
    groups.push({ id: gid, title: R.groups.find((g) => g.id === gid)?.title ?? gid, count: xs.length, median: m, total: tot, flagged: factoryMedian !== null && m > 2 * factoryMedian });
    figures[`unit_cost.group.${gid}.count`] = xs.length;
    figures[`unit_cost.group.${gid}.median`] = m;
    figures[`unit_cost.group.${gid}.total`] = tot;
  }
  figures["unit_cost.flagged.count"] = groups.filter((g) => g.flagged).length;
  if (unitCosts.length) {
    // (What finished units cost is the work, not waste: only a flagged group's line carries its share.)
    lines.push({ section: 5, of: null, share: null, text: `Cost of a finished unit: median ${money(factoryMedian!)}, ${money(figures["unit_cost.total"]!)} for ${unitCosts.length} unit${unitCosts.length === 1 ? "" : "s"}` });
    const shown = [...groups].sort((a, b) => b.total - a.total).filter((g, k) => k < 5 || g.flagged);
    for (const g of shown) lines.push({ section: 5, of: g.flagged ? "cost" : null, share: g.flagged ? share(g.total, C) : null, text: `  ${g.title} (${g.id}): median ${money(g.median)}, ${money(g.total)} for ${g.count}${g.flagged ? "; over twice the factory's median" : ""}` });
  }

  // ------------------------------------------------ what wasn't understood
  const counted = new Map<string, { where: string; what: string; count: number }>();
  for (const u of unknown) { const k = `${u.where}\t${u.what}`; const x = counted.get(k) ?? counted.set(k, { ...u, count: 0 }).get(k)!; x.count++; }
  const unk = [...counted.values()];
  figures["unknown.count"] = unknown.length;
  if (unknown.length) lines.push({ section: 6, of: null, share: null, text: `Not understood (unknown): ${unknown.length} record${unknown.length === 1 ? "" : "s"}: ${unk.map((u) => `${u.where}: ${u.what}${u.count > 1 ? ` ×${u.count}` : ""}`).join("; ")}` });

  // The order: by share, largest first; lines with neither after, in the order above.
  const ranked = lines.map((l, k) => ({ l, k })).sort((a, b) => {
    const sa = a.l.share, sb = b.l.share;
    if (sa !== null && sb !== null) return sb - sa || a.k - b.k;
    if (sa !== null) return -1;
    if (sb !== null) return 1;
    return a.k - b.k;
  }).map((x) => x.l);

  // The ledger: each open prediction and the figure now; past its date, held or missed.
  const day = today(now);
  const predictions: PredictionNow[] = R.predictions.filter((p) => !p.settled).map((p) => {
    const v = figures[p.name] ?? null;
    const ok = v !== null && ({ "<": v < p.value, "<=": v <= p.value, ">": v > p.value, ">=": v >= p.value, "=": v === p.value } as Record<string, boolean>)[p.op];
    return { id: p.id, name: p.name, op: p.op, value: p.value, by: p.by, why: p.why, now: v, state: day <= p.by ? "open" : ok ? "held" : "missed" };
  });

  const empty = !R.rows.length && !log.some((e) => e.cmd === "claim");
  return { since, empty, figures, notRecorded, lines: ranked, units, groups, unknown: unk, predictions };
}
