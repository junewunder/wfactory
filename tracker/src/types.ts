// The tracker's data, as it's kept in tracker/ (see store.ts) and held in memory while a
// command runs. Optional fields are left out of the files when unset.

export type Check = "computed" | "independent" | "recorded";
export type RecordState = "claimed" | "review" | "done" | "broken" | "blocked" | "dropped" | "parked";

// How a computed unit's check is run (probes.ts).
export interface Probe {
  cmd?: string;
  file?: string;
  json?: string;
  count?: string;
  match?: string;
  min?: number;
  inputs?: string[];
  timeout?: number;
}

export interface Note {
  at: string;
  by: string;
  text: string;
}

// Something a session or the loop is doing, alive while its process (pid, start) is, or on
// another machine while that machine's heartbeat is fresh (claimAlive).
export interface Liveness {
  at: string;
  by?: string;
  host?: string;
  pid?: number;
  start?: string;
  ended?: string;
  beats?: boolean;
  session?: string;
  lane?: string;     // a landing claim's lane (<host>/<n>): its clone holds the finished copy
}

// Who worked a unit in review, kept with the claim of the session checking it.
export interface Reviewing {
  by?: string;
  at?: string;
  evidence?: string;
}

// A unit's record: what has happened to it. No record is ready (or whatever needs make it).
export interface UnitRecord extends Liveness {
  state: RecordState;
  why?: string;
  on?: string;
  // Parked by a decision (decide --park): the park holds while the decision is in force.
  decision?: string;
  evidence?: string;
  checker?: string;
  worker?: string;
  branch?: string;
  reviewing?: Reviewing;
  resumed?: string;
  dirty?: string[];
  prevSession?: string;
  pushed?: boolean;
  // Merging (done or in review, its branch not on main yet): the lane landing its branch, so two
  // don't both try. The lane that worked it holds it from its claim on, while it lives (landing).
  landing?: Liveness;
  // When its session handed it back with its work kept (unclaim): it shows by its needs and
  // resources, not as interrupted, and whoever claims it next carries on from that work.
  handedBack?: string;
  was?: string;
  via?: string;
}

export interface SetAside {
  path: string;
  host: string;
  at: string;
  commit?: string;
  by?: string;
  mixed?: boolean;   // with other units' outputs, or a set to sort: never put back
}

export interface Unit {
  id: string;
  title: string;
  kind?: "gate";
  detail?: string;
  check?: Check;
  probe?: Probe;
  needs?: string[];
  uses?: string[];
  tags?: string[];
  model?: string;
  host?: string;
  caps?: string[];
  data?: string;
  reads?: string[];
  lane?: string;
  branch?: string;
  priority?: number;
  // The least minutes a session of it needs (--min-minutes): before last call, the loop takes it
  // only with that long left before the lane loses what it uses (sessions.ts, leastSecs).
  minMinutes?: number;
  template?: string;
  params?: Record<string, unknown>;
  record?: UnitRecord;
  notes?: Note[];
  // Where its outputs went when its last session ended unfinished and the store's copy was put
  // back (store.sh): the set in work/.store/aside/ on host, built from commit in session by.
  aside?: SetAside;
  // The loop's review of its finished branch asked for fixes (review-fix): how many times, and the
  // last findings, which its card shows. A second time blocks it for the overseer.
  review?: { fixes: number; at: string; findings: string };
  // The project's check before it lands (project.json ci.land) failed: how many times in a row,
  // and the last failure's line. A third time blocks it for the overseer; landing clears it.
  landCheck?: { fails: number; at: string; evidence: string };
  // When the current round of work on it began: its first claim since it last landed (merged) or
  // was reopened from done. Later claims (a session that ran out, a failed check before landing, a
  // review's fixes) keep it, so that check (FACTORY_UNIT_SINCE) sees what every attempt left.
  round?: string;
  // A ci-fix other groups' CI failures joined, the same cause (ci.ts): their CI comes due when it's done.
  also?: string[];
  // Its place in its group, set as it's loaded; never written.
  _i?: number;
}

export interface CiRun extends Liveness {
  commit?: string;
}
export interface CiPass {
  commit?: string;
  at: string;
  by: string;
  evidence: string;
  steps: string[];
  done: string[];
  open: string[];
  secs?: number;   // how long the run took, for when last call has to begin
  cmds?: Record<string, string>;   // a hash of each step's command it ran: a changed one makes CI due
}
export interface CiFail {
  commit?: string;
  at: string;
  by: string;
  step?: string;
  evidence: string;
  retry?: string;
  secs?: number;
  log?: string;     // where the failing run's whole output is (ci-fail --log), on host
  host?: string;
  known?: string;   // known failing: it failed again on this step after its ci-fix was done (why)
  cmds?: Record<string, string>;   // a hash of each step's command then: a changed one retries it
}
// A run cut off before it had a result (pause asap, the lane stopped, the machine went down).
export interface CiCut {
  at: string;      // when it started
  by?: string;
  host?: string;
  step?: string;   // the step it was on
  why: string;
}
// Work outside the group changed what its build makes (ci-touch, or the loop's ci.affected hook):
// the latest such change, which makes CI stale like a unit of its own finishing.
export interface CiTouch {
  at: string;
  by?: string;
  commit?: string;  // main's code commit that has the change
  why: string;
}
export interface GroupCi {
  steps: string[];
  uses?: string[];
  passed?: CiPass;
  failed?: CiFail;
  running?: CiRun;
  cut?: CiCut;
  touched?: CiTouch;
}

export interface Group {
  id: string;
  title: string;
  template?: string;
  params?: Record<string, unknown>;
  priority?: number;
  order?: number;
  host?: string;
  data?: Record<string, string>;
  needs?: string[];
  ci?: GroupCi;
  units: Unit[];
}

export interface Resource {
  title?: string;
  free?: { cmd?: string };
  named_by?: string | string[];
}

// A CI step as project.json defines it (ci.steps.<name>).
export interface CiStepDef {
  cmd: string;
  publish?: boolean;
  uses?: string[];
  hold?: unknown;  // gone: every run takes its steps' resources as it starts (lint says so)
  caps?: string[];
  timeout?: number;
  retries?: number;
  on_fail?: "unit" | "owner";
  mem?: string;    // its share of the machine's memory budget and its cap (else its past peaks, no cap)
}

export interface StoreInput {
  local: string;
  parts?: Record<string, string>;
}
export interface StoreConfig {
  remote?: string;
  paths?: Record<string, string>;
  inputs?: Record<string, StoreInput>;
  reads?: string | string[];
  rebuilt?: unknown[];
}

export interface Loop {
  title?: string;
  spec?: string;
  groups?: string[];
}

export interface Project {
  schema?: number;
  name: string;
  title?: string;
  resources?: Record<string, Resource>;
  focus?: string[]; // old: load() turns it into group priorities
  ranking?: number; // RANKING once load() has turned old urgent unit priorities into the one order
  loops?: Record<string, Loop>;
  store?: StoreConfig;
  ci?: {
    steps?: Record<string, CiStepDef>;
    // A command, {old} and {new} filled with two of main's code commits, that prints a line
    // "<group>\t<why>" per group whose build that range changes (the loop runs it as main moves).
    affected?: string;
    // The check before a unit lands: {group} is its group (or its data group), "timeout" minutes.
    land?: { cmd: string; timeout?: number };
  };
  // Files of words a tracker write must not add, the first that exists; ~ and $VAR expand, and a
  // path with an unset variable is skipped. For a public origin (store.ts privateWordAdded).
  private_words?: string[];
  // Check units (checks.ts): which units are checks (selectors, default tag:check), and a hook,
  // {unit} and {group} filled, that says whether a check has what it needs to be judged.
  checks?: { units?: string | string[]; ready?: string; ready_timeout?: number };
  // The last of main's code commits the ci.affected hook covered (ci-affected records it).
  ci_affected_at?: string;
  // Minutes a group's CI may stay stale while the group still has work before it comes due
  // (default 120; 0: only once the group is done for the night).
  ci_every?: number;
  // The least minutes a unit's session needs, when neither the unit (minMinutes) nor its past
  // sessions say (default 45): before last call, a unit last call holds back isn't taken with less
  // left before it.
  min_unit_minutes?: number;
  publish?: string;
  // Check-ins with the owner (prune --checked-in): when the last was, every how many days of runs
  // one is offered (default 3), and how many decisions on one open unit's card make one due at
  // once (default 40).
  checkin_at?: string;
  // The most decisions on one open unit's card then: past prune_at, a check-in is due again only
  // once a card carries more.
  checkin_most?: number;
  checkin_days?: number;
  prune_at?: number;
}

export interface Option {
  key: string;
  label: string;
  changes: string;
  drops?: string[];
  releases?: string[];
}

export interface Question {
  id: string;
  title: string;
  context?: string;
  example?: string;
  options?: Option[];
  default?: string;
  scope?: string[];
  blocks?: string[];
  asked?: { at: string; by: string; host?: string };
  answer: null | { key: string; note?: string; by: string; via?: string; at: string; decision: string };
  withdrawn?: { at: string; by: string; why: string };
}

export interface Decision {
  id: string;
  title: string;
  why: string;
  by: string;
  at: string;
  question?: string;
  scope?: string[];
  replaces?: string;
  via?: string;
  // When it stops holding (decide --until): it leaves the cards then, and stays in `decisions --all`.
  until?: string;
  // Taken off the cards by pruning (prune --apply): a later decision says the same or more
  // (superseded), it repeats one (merged), or the code and its tests now hold it (code).
  retired?: { kind: "superseded" | "merged" | "code"; at: string; by: string; other?: string; where?: string };
  // What the owner said to keep it through (prune --keep): the pass doesn't propose it for that again.
  kept?: { kind: string; at: string; by: string }[];
}

export interface Lease {
  id: string;
  host: string;
  at: string;
  beat?: string;
  by?: string;
  from?: string;
}

export interface LogEntry {
  at: string;
  actor: string;
  tag?: string;
  host?: string;
  cmd: string;
  id?: string;
  text: string;
  [more: string]: unknown;
}

// A unit's status, worked out each time (status.ts derive).
export type Status = "dropped" | "done" | "broken" | "you" | "stuck" | "review" | "doing" | "interrupted"
  | "waiting" | "resource" | "ready" | "parked" | "merging";
export interface MissingUnit {
  id: string;
  title: string;
  missing: true;
}
export interface Derived {
  s: Status;
  why?: string;
  how?: "check" | "checked" | "owner" | "recorded";
  gate?: boolean;
  qs?: Question[];
  unmet?: (Unit | MissingUnit)[];
  busy?: string[];
}

// The thread overseeing the factory (leases.json "overseer"): the newest to attach wins.
export interface Overseer { id: string; host: string; at: string }

// Everything a command works on: the files' contents, with indexes, and what it changed.
export interface State {
  project: Project;
  groups: Group[];
  questions: Question[];
  decisions: Decision[];
  leases: Lease[];
  hosts: Record<string, string>;
  overseer: Overseer | null;
  byId: Map<string, Unit>;
  groupOf: Map<string, Group>;
  groupById: Map<string, Group>;
  // What to write: "project", "questions", "decisions", "leases", "group:<id>".
  dirty: Set<string>;
  logs: LogEntry[];
  _memo?: Map<string, Derived> | null;
}

// A command: its arguments after the command's name in, its exit code out (none is 0).
export type Command = (a: string[]) => number | void;
export type Commands = Record<string, Command>;
