// just scorecard: where a run's sessions and time went, from the records alone (no model, no
// network, no daemon). Its parts: scorecard-read.ts reads the records, scorecard-figures.ts works
// out the figures and ranks the lines, scorecard-names.ts names the figures. The ledger of
// predictions is tracker data (tracker/src/commands/expect.ts); expect and settle write it through
// the tracker, in this process.
import { asksHelp, ymdHm } from "./sys.ts";
import { readTime } from "./when.ts";
import { trIn } from "./tr.ts";
import { today } from "../../tracker/src/text.ts";
import { readRecords } from "./scorecard-read.ts";
import { score, pct, minutes, type Card, type Line, type PredictionNow } from "./scorecard-figures.ts";
import { NAMES, knownName } from "./scorecard-names.ts";

export const SCORECARD_HELP = `just scorecard [--since <when>] [--json]
just scorecard --names
just scorecard expect <name> '<op> <value>' --by <YYYY-MM-DD> --why "…"
just scorecard settle <id> --note "…"

Where a run's sessions and time went, from what the factory already records: the
tracker's log, this machine's lanes' run index and events (runs/index.tsv and
runs/events.log in the checkout and each <checkout>-lane<N> clone beside it), and
the heavy-job history in the machine's wfactory state folder (jobs/history.json).
It makes no model call, no network call, and asks nothing of the daemon. The run
index and events are this machine's, so the session, cost, waiting, lane-time
and review figures cover this machine's lanes (the first line says which); units
and CI come from the tracker's log, every machine's. With an origin, the log is
this checkout's copy of main's, as a tracker command here last fetched it.

Each line says what share of the period's session cost, or of its lane time, it
accounts for, and the lines are ranked by it, largest first; lines with neither
come last, in this order:
  1. sessions that finished no unit, by how they ended
  2. units claimed most often since they were last done or added
  3. the review: branches reviewed, sent back for fixes, landed without it
  4. waiting (the usage pause, nothing workable) and group CI, by step
  5. the cost of a finished unit, by group (over twice the factory's median: flagged)
A figure the records can't give says "not recorded" and what would have to be.
A record it doesn't understand is counted under "unknown", and named.

  --since <when>  only what happened since then ("2026-11-01", "-24 hours",
                  "yesterday 18:00"); without it, everything recorded
  --json          every figure by its fixed name, the lines, and the predictions
  --names         the figures' names, a line each on what it counts

The ledger: \`expect\` records that a change should move a figure by a date (the
name must be one of --names, the date today or later); the scorecard ends with
each open prediction and the figure since it was made, and once its date has
passed, "held" or "missed" by the figure from when it was made to that date,
until \`settle\` closes it. Both write through the tracker.
  just scorecard expect sessions.no_unit.share '< 0.10' --by 2026-12-01 --why "units are passed over when they can't fit"
  just scorecard settle p1 --note "held: the share fell to 0.06"`;

const say = (s = "") => console.log(s);

// The ranked lines' share, as the plain output shows it.
const shareText = (l: Line) => (l.share === null ? "" : `${pct(l.share)} of ${l.of === "cost" ? "cost" : "lane time"}`);
export const lineText = (l: Line) => `${shareText(l).padEnd(18)}${l.text.trimStart()}`;
export const predictionText = (p: PredictionNow) => {
  const now = p.now === null ? "not recorded" : String(p.now);
  return `${p.why} (${p.id}): ${p.name} ${p.op} ${p.value} by ${p.by}: ${p.state === "open" ? `open; ${now} since it was made` : `${p.state.toUpperCase()} (${now} from when it was made to that date)`}`;
};
const header = (c: Card, lanes: string[], hostName: string, logAge: number | null) => {
  const since = c.since === null ? "everything recorded" : `since ${ymdHm(new Date(c.since * 1000))}`;
  const f = c.figures;
  return `This machine's lanes (${hostName}: ${lanes.join(", ") || "none"}), ${since}: ${f["sessions.count"]} sessions, $${(f["sessions.cost"] ?? 0).toFixed(2)}, ${f["lane.minutes"]} min of lane time. Units and CI read the tracker's log: every machine.${logAge === null ? "" : ` The log is this checkout's copy of main's, fetched ${logAge < 120 ? "just now" : `${minutes(Math.round(logAge / 60))} ago`} (a tracker command here, \`just status\`, fetches it).`}`;
};

// The card for the checkout in cwd: null and why, if --since can't be read.
export function card(env: NodeJS.ProcessEnv, cwd: string, sinceText?: string): { c: Card; lanes: string[]; host: string; logAge: number | null } | { why: string } {
  let since: number | null = null;
  if (sinceText !== undefined) {
    since = readTime(sinceText);
    if (since === null) return { why: `scorecard: --since needs a time (got '${sinceText}')` };
  }
  const R = readRecords(env, cwd);
  return { c: score(R, since), lanes: R.lanes, host: R.host, logAge: R.logAge };
}

// The three worst lines and the predictions that came due, for `fleet summary`'s end.
export function summaryLines(env: NodeJS.ProcessEnv, cwd: string, since: string): string[] {
  let r;
  try { r = card(env, cwd, since); } catch (e) { return [`Scorecard: couldn't be read (${(e as Error).message})`]; }
  if ("why" in r) return [`Scorecard: ${r.why}`];
  if (r.c.empty) return ["Scorecard: nothing recorded yet"];
  const out = [`Scorecard, its three worst lines (this machine's lanes since ${since}; \`just scorecard --since "${since}"\` has the rest):`];
  for (const l of r.c.lines.slice(0, 3)) out.push(`  ${lineText(l)}`);
  for (const p of r.c.predictions.filter((x) => x.state !== "open")) out.push(`  prediction ${predictionText(p)}`);
  return out;
}

export function scorecardCli(args: string[], env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): number {
  if (asksHelp(args)) { say(SCORECARD_HELP); return 0; }
  if (args[0] === "expect") return expect(args.slice(1), env, cwd);
  if (args[0] === "settle") return settle(args.slice(1), env, cwd);
  let json = false, names = false, since: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") json = true;
    else if (a === "--names") names = true;
    else if (a === "--since" && i + 1 < args.length) since = args[++i];
    else if (a.startsWith("--since=")) since = a.slice(8);
    else { console.error(`scorecard: unknown argument '${a}' (just scorecard --help)`); return 2; }
  }
  if (names) {
    const w = Math.max(...NAMES.map(([n]) => n.length));
    for (const [n, what] of NAMES) say(`${n.padEnd(w + 2)}${what}`);
    return 0;
  }
  const r = card(env, cwd, since);
  if ("why" in r) { console.error(r.why); return 2; }
  const { c } = r;
  if (json) {
    say(JSON.stringify({ host: r.host, lanes: r.lanes, since: c.since === null ? null : new Date(c.since * 1000).toISOString(), empty: c.empty, figures: c.figures, not_recorded: c.notRecorded,
      lines: c.lines.map((l) => ({ text: l.text.trim(), share: l.share, of: l.of === "cost" ? "session cost" : l.of === "lane" ? "lane time" : null })),
      units: c.units, groups: c.groups, unknown: c.unknown, predictions: c.predictions }, null, 2));
    return 0;
  }
  if (c.empty) { say("nothing recorded yet"); return 0; }
  say(header(c, r.lanes, r.host, r.logAge));
  for (const l of c.lines) say(lineText(l));
  if (c.predictions.length) {
    say("Predictions:");
    for (const p of c.predictions) say(`  ${predictionText(p)}`);
  }
  return 0;
}

// The tracker in this process, from the checkout, its output passed on.
function tracker(args: string[], env: NodeJS.ProcessEnv, cwd: string): number {
  const r = trIn(args, env, cwd);
  process.stdout.write(r.out); process.stderr.write(r.err);
  return r.code;
}

function expect(a: string[], env: NodeJS.ProcessEnv, cwd: string): number {
  const usage = `usage: just scorecard expect <name> '<op> <value>' --by <YYYY-MM-DD> --why "…"`;
  const pos: string[] = [];
  let by: string | undefined, why: string | undefined;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--by") by = a[++i];
    else if (a[i] === "--why") why = a[++i];
    else pos.push(a[i]);
  }
  const [name, test] = pos;
  if (!name || !test || !by || !why || pos.length > 2) { console.error(usage); return 2; }
  if (!knownName(name)) { console.error(`scorecard: "${name}" isn't one of the scorecard's figures (\`just scorecard --names\` lists them)`); return 2; }
  if (/^\d{4}-\d{2}-\d{2}$/.test(by) && by < today()) { console.error(`scorecard: --by ${by} is in the past (today is ${today()})`); return 2; }
  return tracker(["expect", name, "--test", test, "--by", by, "--why", why], env, cwd);
}

function settle(a: string[], env: NodeJS.ProcessEnv, cwd: string): number {
  const i = a.indexOf("--note"), note = i >= 0 ? a[i + 1] : undefined, id = a.find((x, k) => k !== i && k !== i + 1);
  if (!id || !note) { console.error(`usage: just scorecard settle <id> --note "…"`); return 2; }
  return tracker(["expect-settle", id, "--note", note], env, cwd);
}
