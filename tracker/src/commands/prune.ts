// prune: the pruning pass over the decisions. --propose lists what it would lapse, retire or
// narrow, and changes nothing; --apply does one the owner approved, through the tracker's own
// writes, so `decisions --all` keeps the history; --keep records one the owner kept; --due is the
// check-in offer, when one is due.
import { C } from "./registry.ts";
import { ctx } from "../ctx.ts";
import { die, now, list, parseArgs, plural, str, strs } from "../text.ts";
import { expand, findD, matches, name } from "../names.ts";
import { load, log, mutate, readLog, touch } from "../store.ts";
import { decisionText } from "../cards.ts";
import { CHECKIN_DAYS, decisionParks, ended, freedText, endedText, inForce, lapseOf, mostOnACard, parseUntil, PRUNE_AT, proposals, when, type Proposal } from "../decisions.ts";
import type { Decision, State } from "../types.ts";

const KIND: Record<Proposal["kind"], string> = { lapse: "Lapse", superseded: "Superseded", narrow: "Narrow", code: "In the code", merge: "Merge" };
const entry = (T: State, p: Proposal, i: number) => [
  `${i + 1}. ${expand(T, p.title)} (${p.by === "owner" ? "the owner" : "agent " + p.by}, ${when(p.at).slice(0, 10)}; ${p.d})`,
  `   ${KIND[p.kind]}: ${expand(T, p.why)}${p.unasked ? " (a lane's own, which only lapsed: it may be applied without asking)" : ""}`,
  `   Apply: ${p.apply}   Keep: just tracker prune --keep ${p.d} ${p.kind}`,
].join("\n");

// Whether a check-in is due: there's something for the owner to prune, and either CHECKIN_DAYS
// days (project.json "checkin_days", which the owner's taste check-in shares) have passed since
// the last one with a unit claimed since, or an open unit's card carries more than PRUNE_AT
// decisions ("prune_at") and more than it did at the last check-in (the owner may keep many).
export function due(T: State, ps = proposals(T)) {
  const days = T.project.checkin_days ?? CHECKIN_DAYS, at = T.project.prune_at ?? PRUNE_AT;
  const last = T.project.checkin_at || T.decisions.map((d) => d.at).sort()[0] || now();
  const most = mostOnACard(T);
  const since = (Date.now() - Date.parse(last)) / 864e5;
  const ran = (readLog() || []).some((l) => l.cmd === "claim" && l.at > last);
  const owners = ps.filter((p) => !p.unasked);
  const why = most > at && most > (T.project.checkin_most ?? 0) ? `an open unit's card carries ${plural(most, "decision")}, over ${at}` : since >= days && ran ? `${Math.floor(since)} days of runs since ${T.project.checkin_at ? "the last check-in" : "the first decision"} (${when(last).slice(0, 10)})` : "";
  return { due: !!why && owners.length > 0, why, last: T.project.checkin_at || null, days, most, at, owners, unasked: ps.filter((p) => p.unasked) };
}

function lapse(T: State, d: Decision, until?: string) {
  d.until = until ? parseUntil(until) : lapseOf(d)?.until || now();
  T.dirty.add("decisions");
  log(T, "prune", null, `${Date.parse(d.until) <= Date.now() ? "lapsed" : "lapses " + when(d.until)}: ${d.title}`, { more: { d: d.id } });
}

const KNOWN = new Set(["_", "propose", "json", "apply", "lapse", "until", "superseded-by", "merge-into", "in-code", "narrow", "keep", "apply-unasked", "restore", "checked-in", "due"]);
const ACTIONS = ["lapse", "superseded-by", "merge-into", "in-code", "narrow"];
const USAGE = "usage: prune [--propose] [--json] | --apply <d> (--lapse [--until T] | --superseded-by <d> | --merge-into <d> | --in-code \"<file or test>\" | --narrow <selector>,…) | --keep <d> <kind> | --due [--json] | --apply-unasked | --restore <d> | --checked-in";

C.prune = (a) => {
  const o = parseArgs(a, ["narrow"]);
  const odd = Object.keys(o).filter((k) => !KNOWN.has(k));
  if (odd.length) die(`prune doesn't know --${odd.join(", --")}\n${USAGE}`);
  if (o.apply) {
    const ref = str(o.apply) || die("prune --apply needs a decision: d/<slug>");
    const acts = ACTIONS.filter((k) => o[k] !== undefined);
    if (acts.length !== 1) die(`prune --apply <d> needs one of --lapse [--until T], --superseded-by <d>, --merge-into <d>, --in-code "<file or test>" or --narrow <selector>,…${acts.length ? ` (got --${acts.join(" and --")})` : ""}`);
    return mutate((T) => {
      const d = findD(T, ref) || die(`no decision ${ref}`);
      const e = ended(T, d);
      if (e) die(`${name(d)} is already off the cards (${endedText(T, e)})`);
      const other = (flag: string) => { const x = findD(T, String(o[flag])) || die(`--${flag}: no decision ${o[flag]}`); if (x === d) die(`--${flag} names the decision itself`); if (!inForce(T, x)) die(`--${flag}: ${name(x)} isn't in force (${endedText(T, ended(T, x)!)})`); return x; };
      const by = ctx.TAG, parks = decisionParks(T);
      // What it had parked (decide --park) comes back with it off the cards: say which.
      const freed = () => { const f = freedText(T, parks); if (f) console.log(f); };
      if (o.lapse) lapse(T, d, str(o.until) ?? str(o.lapse));
      else if (o["superseded-by"] || o["merge-into"]) {
        const kind = o["superseded-by"] ? "superseded" : "merged", x = other(o["superseded-by"] ? "superseded-by" : "merge-into");
        d.retired = { kind, at: now(), by, other: x.id };
        T.dirty.add("decisions");
        log(T, "prune", null, `${kind === "merged" ? "merged into" : "superseded by"} ${x.title}: ${d.title}`, { more: { d: d.id, other: x.id } });
      } else if (o["in-code"]) {
        const where = str(o["in-code"]) || die("--in-code needs where: the file or test that holds it");
        d.retired = { kind: "code", at: now(), by, where };
        T.dirty.add("decisions");
        log(T, "prune", null, `the code holds it (${where}): ${d.title}`, { more: { d: d.id } });
      } else {
        // A narrower scope is a new decision that replaces it, as `decide --replaces` makes. It
        // keeps the date it was made (what's newer than what, and when its words lapse).
        const scope = strs(o.narrow).filter((x): x is string => typeof x === "string").flatMap(list);
        if (!scope.length) die("--narrow needs the narrower scope: a unit ID, a glob, group:<g>, tag:<t>");
        let id = "";
        for (let n = 2; !id || T.decisions.some((x) => x.id === id); n++) id = `${d.id}-${n}`;
        const nd: Decision = { id, title: d.title, why: d.why, by: d.by, at: d.at, scope, replaces: d.id, via: by, ...(d.question ? { question: d.question } : {}), ...(d.until ? { until: d.until } : {}), ...(d.kept ? { kept: d.kept } : {}) };
        T.decisions.push(nd); T.dirty.add("decisions");
        // Its parks within the narrower scope hold on under the new one.
        for (const u of parks) if (u.record!.decision === d.id && scope.some((s) => matches(T, s, u))) { u.record!.decision = id; touch(T, u); }
        log(T, "decide", null, `narrowed to ${scope.join(", ")}: ${d.title}`, { more: { d: id } });
        console.log(`recorded: ${decisionText(T, nd)}, on ${scope.join(", ")}`);
        freed();
        return 0;
      }
      console.log(decisionText(T, d));
      freed();
      return 0;
    });
  }
  if (o.keep) {
    const ref = str(o.keep) || die("prune --keep needs a decision: d/<slug>");
    const kind = o._[0];
    if (!kind || !Object.keys(KIND).includes(kind)) die(`prune --keep ${ref} needs what the owner kept it through: ${Object.keys(KIND).join(", ")}`);
    return mutate((T) => {
      const d = findD(T, ref) || die(`no decision ${ref}`);
      d.kept = [...(d.kept || []).filter((k) => k.kind !== kind), { kind, at: now(), by: ctx.TAG }];
      T.dirty.add("decisions");
      log(T, "prune", null, `kept (not ${KIND[kind as Proposal["kind"]].toLowerCase()}): ${d.title}`, { more: { d: d.id } });
      console.log(`Kept: ${name(d)}. The pass won't propose it for that again.`);
      return 0;
    });
  }
  if (o["apply-unasked"]) return mutate((T) => {
    const ps = proposals(T).filter((p) => p.unasked), parks = decisionParks(T);
    for (const p of ps) lapse(T, findD(T, p.d)!);
    console.log(ps.length ? `Lapsed without asking (${plural(ps.length, "lane's own decision")}, for the report; \`just tracker prune --restore <d>\` puts one back):\n${ps.map((p) => `- ${expand(T, p.title)} (${p.d}): ${p.why}`).join("\n")}` : "No lane's own decision has lapsed.");
    const f = freedText(T, parks);
    if (f) console.log(f);
    return 0;
  });
  if (o.restore) {
    const ref = str(o.restore) || die("prune --restore needs a decision: d/<slug>");
    return mutate((T) => {
      const d = findD(T, ref) || die(`no decision ${ref}`);
      const e = ended(T, d);
      if (!e || e.kind === "replaced") die(`${name(d)} wasn't lapsed or retired${e ? ` (${endedText(T, e)}: \`just decide --replaces\` records a new call)` : ""}`);
      // A retired one keeps the time it was to lapse at; a lapsed one holds again with no end.
      if (d.retired) delete d.retired; else delete d.until;
      T.dirty.add("decisions");
      log(T, "prune", null, `back on the cards: ${d.title}`, { more: { d: d.id } });
      console.log(decisionText(T, d));
      return 0;
    });
  }
  if (o["checked-in"]) return mutate((T) => {
    T.project.checkin_at = now(); T.project.checkin_most = mostOnACard(T); T.dirty.add("project");
    log(T, "checked-in", null, "checked in with the owner");
    console.log(`Checked in. The next check-in is offered after ${T.project.checkin_days ?? CHECKIN_DAYS} days of runs, or once an open unit's card carries more than ${Math.max(T.project.prune_at ?? PRUNE_AT, T.project.checkin_most)} decisions.`);
    return 0;
  });
  const T = load();
  const ps = proposals(T);
  if (o.due) {
    const x = due(T, ps);
    if (o.json) { console.log(JSON.stringify({ ...x, owners: x.due ? x.owners : [] })); return 0; }
    if (!x.due) return 0;
    const L = [`Check-in due (${x.why}): ${plural(x.owners.length, "decision")} to prune. Would the owner like to check in? An offer, not a stop.`];
    x.owners.slice(0, 10).forEach((p, i) => L.push(entry(T, p, i).replace(/^/gm, "  ")));
    if (x.owners.length > 10) L.push(`  and ${x.owners.length - 10} more: \`just tracker prune --propose\``);
    if (x.unasked.length) L.push(`  Also ${plural(x.unasked.length, "lane's own decision")} that only lapsed, which \`just tracker prune --apply-unasked\` takes off without asking.`);
    console.log(L.join("\n"));
    return 0;
  }
  if (o._.length) die(USAGE);
  if (o.json) { console.log(JSON.stringify({ proposals: ps, inForce: T.decisions.filter((d) => inForce(T, d)).length, mostOnACard: mostOnACard(T) }, null, 1)); return 0; }
  const live = T.decisions.filter((d) => inForce(T, d)).length;
  if (!ps.length) { console.log(`Nothing to prune of ${plural(live, "decision")} in force, by their words. Read them for ones the code now holds or that repeat another (\`just decisions\`).`); return 0; }
  console.log(`${plural(ps.length, "decision")} to prune, of ${live} in force (the most on one open unit's card: ${mostOnACard(T)}). Nothing is changed until each is applied:\n`);
  ps.forEach((p, i) => console.log(entry(T, p, i) + "\n"));
  console.log("These are found by their words: lapsed, superseded by a later call, repeated, scoped wider than they're about. Read the rest for ones the code and its tests now hold (--in-code \"<file or test>\") or that repeat another (--merge-into <d>).");
  return 0;
};
