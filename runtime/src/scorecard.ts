// just scorecard: where a run's sessions and time went, from the records alone (no model, no
// network, no daemon). Its parts: scorecard-read.ts reads the records, scorecard-figures.ts works
// out the figures and ranks the lines, scorecard-names.ts names the figures. `fleet summary` ends
// with the card for its run (summaryLines).
import { asksHelp, ymdHm } from "./sys.ts";
import { readTime } from "./when.ts";
import { readRecords } from "./scorecard-read.ts";
import { score, pct, minutes, type Card, type Line } from "./scorecard-figures.ts";
import { NAMES } from "./scorecard-names.ts";

export const SCORECARD_HELP = `just scorecard [--since <when>] [--json]
just scorecard --names

Where a run's sessions and time went, from what the factory already records: the
tracker's log, this machine's lanes' run index and events (runs/index.tsv and
runs/events.log in the checkout, each <checkout>-lane<N> clone beside it, and the
clones removed since, kept in the checkout's runs/removed-clones/), and
the heavy-job history in the machine's wfactory state folder (jobs/history.json).
It makes no model call, no network call, and asks nothing of the daemon. The run
index and events are this machine's, so the session, cost, waiting, lane-time
and review figures cover this machine's lanes (the first line says which); units
and CI come from the tracker's log, every machine's. With an origin, the log is
this checkout's copy of main's, as a tracker command here last fetched it.

It starts with the sessions, what each finished or what became of it, and the
units done, which add up as they stand. Then each line says what share of the
period's session cost, or of its lane time, it accounts for, and the lines are
ranked by it, largest first; lines with neither come last, in this order:
  1. sessions that finished no unit: the waste, those that lost their work
     (killed over memory, cut off, ended for going silent), with a share; then,
     without one, those whose work a later session carries on (sent back by the
     review, handed back), those that ended waiting on the owner (a question,
     stuck) and those that gave their unit back unstarted
  2. units claimed most often since they were last done or added
  3. the review: branches reviewed, sent back for fixes, landed without it
  4. waiting (the usage pause, nothing workable) and group CI, by step
  5. the cost of a finished unit, by group (over twice the factory's median: flagged)
A figure the records can't give says "not recorded" and what would have to be.
A record it doesn't understand is counted under "unknown", and named.

  --since <when>  only what happened since then ("2026-11-01", "-24 hours",
                  "yesterday 18:00"); without it, everything recorded
  --json          every figure by its fixed name, and the lines
  --names         the figures' names, a line each on what it counts

\`just fleet summary\` ends with this card for the run it summarises, less the
lines on what isn't recorded.`;

const say = (s = "") => console.log(s);

// The ranked lines' share, as the plain output shows it.
const shareText = (l: Line) => (l.share === null ? "" : `${pct(l.share)} of ${l.of === "cost" ? "cost" : "lane time"}`);
export const lineText = (l: Line) => `${shareText(l).padEnd(18)}${l.text.trimStart()}`;
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

// The card for the run since then, for `fleet summary`'s end, so the report quotes figures that
// add up instead of working them out: every line but those on what isn't recorded.
export function summaryLines(env: NodeJS.ProcessEnv, cwd: string, since: string): string[] {
  let r;
  try { r = card(env, cwd, since); } catch (e) { return [`Scorecard: couldn't be read (${(e as Error).message})`]; }
  if ("why" in r) return [`Scorecard: ${r.why}`];
  if (r.c.empty) return ["Scorecard: nothing recorded yet"];
  const out = [`Scorecard (\`just scorecard --since "${since}"\`): ${header(r.c, r.lanes, r.host, r.logAge)}`];
  for (const l of r.c.lines.filter((x) => !x.unrecorded)) out.push(`  ${lineText(l)}`);
  return out;
}

export function scorecardCli(args: string[], env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): number {
  if (asksHelp(args)) { say(SCORECARD_HELP); return 0; }
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
      units: c.units, groups: c.groups, unknown: c.unknown }, null, 2));
    return 0;
  }
  if (c.empty) { say("nothing recorded yet"); return 0; }
  say(header(c, r.lanes, r.host, r.logAge));
  for (const l of c.lines) say(lineText(l));
  return 0;
}
