// The scorecard's figures by name (scorecard.ts): each one's fixed name in --json, and a line on
// what it counts, for `just scorecard --names` and for `expect`, which refuses a name not here.
// A <part> in a name stands for one of a set: an ending, a CI step, a group.

// How a session that finished no unit ended, by its name in the figures, and as the scorecard says it.
export const ENDINGS = {
  unstarted: "gave their unit back unstarted",
  handed_back: "handed their unit back, work kept",
  interrupted: "were interrupted or cut off",
  blocked: "left their unit stuck",
  asked: "asked the owner",
  sent_back: "had their unit sent back by the review",
  oom: "were killed over memory",
  silent: "were ended for going silent",
  unknown: "have no claim in the tracker's log",
} as const;
export type Ending = keyof typeof ENDINGS | "finished";

export const NAMES: [string, string][] = [
  ["sessions.count", "sessions this machine's lanes ran in the period (rows of their run index, CI runs aside)"],
  ["sessions.cost", "what those sessions cost, in dollars (the run index's cost_usd)"],
  ["lane.minutes", "lane time: the minutes of the lanes' sessions and CI runs, and the waits below"],
  ["sessions.no_unit.count", "sessions that finished no unit: not done, checked done, sent for a second check or dropped (or done, then sent back by the review)"],
  ["sessions.no_unit.share", "their share of all sessions"],
  ["sessions.no_unit.cost", "what they cost"],
  ["sessions.no_unit.cost_share", "their share of the sessions' cost"],
  ["sessions.no_unit.<ending>.count", `those that ended one way; <ending> is one of ${Object.keys(ENDINGS).join(", ")}`],
  ["sessions.no_unit.<ending>.share", "their share of all sessions"],
  ["sessions.no_unit.<ending>.cost", "what they cost"],
  ["sessions.no_unit.<ending>.cost_share", "their share of the sessions' cost"],
  ["units.reclaimed.count", "units claimed twice or more since they were last done or added (the tracker's log: every machine)"],
  ["units.claims.max", "the most claims of one unit since it was last done or added"],
  ["review.landed.count", "branches landed on main (the tracker's log)"],
  ["review.reviewed.count", "branches the loop's review gave a verdict on: those landed, less those landed without it, and each sent back"],
  ["review.sent_back.count", "times the review sent a branch back for fixes"],
  ["review.sent_back.rate", "those as a share of the branches reviewed"],
  ["review.sent_back_twice.count", "times it sent one back a second time (the unit is then stuck)"],
  ["review.unreviewed.count", "branches landed without the review (this machine's review-skipped events)"],
  ["wait.usage.minutes", "lane time paused for usage (usage-pause until usage-resume or the lane's stop)"],
  ["wait.usage.share", "its share of lane time"],
  ["wait.nothing_workable.minutes", "lane time between two iterations with nothing workable (the gaps holding an idle event)"],
  ["wait.nothing_workable.share", "its share of lane time"],
  ["wait.resource.minutes", "lane time waiting for a resource: not recorded"],
  ["wait.memory.minutes", "lane time waiting for the memory budget: not recorded"],
  ["wait.in_flight.minutes", "lane time waiting for work in flight elsewhere: not recorded"],
  ["ci.runs", "group CI runs that ended (passed or failed; the tracker's log: every machine)"],
  ["ci.failed.count", "those that failed"],
  ["ci.failed.rate", "their share of the runs"],
  ["ci.minutes", "lane time in CI runs on this machine (the run index)"],
  ["ci.share", "its share of lane time"],
  ["ci.step.<step>.runs", "runs that reached the step"],
  ["ci.step.<step>.failed", "runs that failed at it"],
  ["ci.step.<step>.fail_rate", "its failures as a share of the runs that reached it"],
  ["ci.step.<step>.secs", "how long the step takes: the median of the heavy-job history's last runs of its command (not by period)"],
  ["unit_cost.count", "units done in the period that this machine's sessions worked on"],
  ["unit_cost.median", "the median cost of one: its sessions here since it was last done or added"],
  ["unit_cost.total", "what they cost in all"],
  ["unit_cost.flagged.count", "groups whose median is over twice the factory's"],
  ["unit_cost.group.<group>.count", "the group's units done"],
  ["unit_cost.group.<group>.median", "their median cost"],
  ["unit_cost.group.<group>.total", "their cost in all"],
  ["unknown.count", "records the scorecard doesn't understand (each is named)"],
];

// Is name one of the figures? <ending> must be an ending; <step> and <group> any id.
export function knownName(name: string): boolean {
  const part = (p: string) => p === "<ending>" ? `(?:${Object.keys(ENDINGS).join("|")})` : "[A-Za-z0-9_-]+";
  return NAMES.some(([n]) => new RegExp(`^${n.split(".").map((x) => /^<.*>$/.test(x) ? part(x) : x.replace(/[-_]/g, "\\$&")).join("\\.")}$`).test(name));
}
