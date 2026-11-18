// The scorecard's figures by name (scorecard.ts): each one's fixed name in --json, and a line on
// what it counts, for `just scorecard --names`. A <part> in a name stands for one of a set: an
// ending or what became of one, a CI step, a group.

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
} as const;
export type Ending = keyof typeof ENDINGS | "finished" | "unknown";

// What became of a session that finished no unit, by its ending. Only lost work is waste: a unit
// sent back by the review or handed back keeps its branch, and the next session carries on from
// it (landing.ts, saveBranch); a question waits on the owner; a unit given back unstarted cost
// next to nothing. A session killed over memory, cut off or ended for going silent was ended
// before it could finish or hand its work back.
export const OUTCOMES = {
  lost: { said: "lost their work", endings: ["oom", "interrupted", "silent"] },
  carried_on: { said: "left their work for a later session to carry on", endings: ["sent_back", "handed_back"] },
  waiting: { said: "ended waiting on the owner", endings: ["asked", "blocked"] },
  unstarted: { said: "gave their unit back unstarted", endings: ["unstarted"] },
} as const satisfies Record<string, { said: string; endings: (keyof typeof ENDINGS)[] }>;
export type Outcome = keyof typeof OUTCOMES;
// Each ending's own words inside its outcome's line ("2 sent back by the review ($5.00)").
export const ENDING_SAID: Record<keyof typeof ENDINGS, string> = {
  unstarted: "given back unstarted", handed_back: "handed back with their work kept", interrupted: "cut off",
  blocked: "left their unit stuck", asked: "asked the owner", sent_back: "sent back by the review",
  oom: "killed over memory", silent: "ended for going silent",
};

export const NAMES: [string, string][] = [
  ["sessions.count", "sessions this machine's lanes ran in the period (rows of their run index, CI runs aside)"],
  ["sessions.cost", "what those sessions cost, in dollars (the run index's cost_usd)"],
  ["lane.minutes", "lane time: the minutes of the lanes' sessions and CI runs, and the waits below"],
  ["sessions.finished.count", "sessions that finished their unit: done, checked done, sent for a second check or dropped"],
  ["units.done.count", "units done in the period, each once (the tracker's log: every machine)"],
  ["sessions.no_unit.count", "sessions that finished no unit: not done, checked done, sent for a second check or dropped (or done, then sent back by the review)"],
  ["sessions.unrecorded.count", "loop sessions on this machine the tracker's log has a claim of but no run index has (a lane's records lost with its clone)"],
  ["sessions.unknown.count", "sessions whose claim isn't in this checkout's copy of the tracker's log (named under unknown; neither finished nor not)"],
  ["sessions.no_unit.share", "their share of the sessions whose ending is known (not sessions.unknown)"],
  ["sessions.no_unit.cost", "what they cost"],
  ["sessions.no_unit.cost_share", "their share of those sessions' cost"],
  ["sessions.lost.count", "the waste: sessions that finished no unit and lost their work (sessions.no_unit.lost)"],
  ["sessions.lost.share", "their share of the sessions whose ending is known"],
  ["sessions.lost.cost", "what they cost"],
  ["sessions.lost.cost_share", "their share of those sessions' cost"],
  ["sessions.no_unit.<outcome>.count", `those that came to one end; <outcome> is one of ${Object.keys(OUTCOMES).join(", ")} (${Object.entries(OUTCOMES).map(([k, o]) => `${k}: ${o.endings.join(", ")}`).join("; ")})`],
  ["sessions.no_unit.<outcome>.cost", "what they cost"],
  ["sessions.no_unit.sent_back.next_cost", "what the sessions that carried on a unit the review sent back cost (the next claim of it after each send-back)"],
  ["sessions.no_unit.<ending>.count", `those that ended one way; <ending> is one of ${Object.keys(ENDINGS).join(", ")}`],
  ["sessions.no_unit.<ending>.share", "their share of the sessions whose ending is known"],
  ["sessions.no_unit.<ending>.cost", "what they cost"],
  ["sessions.no_unit.<ending>.cost_share", "their share of those sessions' cost"],
  ["units.reclaimed.count", "units claimed twice or more since they were last done or added (the tracker's log: every machine)"],
  ["units.claims.max", "the most claims of one unit since it was last done or added"],
  ["review.landed.count", "branches this machine's lanes landed on main (the tracker's log)"],
  ["review.reviewed.count", "branches the review gave a verdict on here: those landed, less those landed without it (review-skipped), and each sent back"],
  ["review.sent_back.count", "times the review here sent a branch back for fixes"],
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
  ["ci.step.<step>.secs", "how long the step takes: the median of its passing runs in the heavy-job history (by the run's date; undated older entries only for everything recorded)"],
  ["unit_cost.count", "units done in the period that this machine's sessions worked on"],
  ["unit_cost.median", "the median cost of one: its sessions here since it was last done or added"],
  ["unit_cost.total", "what they cost in all"],
  ["unit_cost.flagged.count", "groups whose median is over twice the factory's"],
  ["unit_cost.group.<group>.count", "the group's units done"],
  ["unit_cost.group.<group>.median", "their median cost"],
  ["unit_cost.group.<group>.total", "their cost in all"],
  ["unknown.count", "records the scorecard doesn't understand (each is named)"],
];
