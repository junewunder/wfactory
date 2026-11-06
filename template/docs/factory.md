# __PROJECT__: the factory

The standing spec. `tracker/` holds state, questions and decisions (through
the tracker CLI), and this file holds what doesn't change from unit to unit. Replace
every fill-in placeholder before the first unattended run (`just loop` refuses
until then), and keep it short: rules here, each with a pointer; how a tool
works goes in `docs/tools/<tool>.md` (`just lint` caps this file at 4,000
words). A loop session gets "The loop" below in its prompt (keep that
heading), with any section whose heading ends "(every session)", and looks
up the rest when its unit needs a rule.

## Goal

<fill: one paragraph. What this produces, who uses it, and what it's for.>

**The far line:** <fill: the loftiest version the owner can imagine this making. The direction, not the finish.>
**The satisfied line:** <fill: the least result the owner would use and be glad of. This is "done", and the oracle's bar. Both lines are provisional: each change goes here with the output that showed it.>

**The reference:** what the oracle compares against, which differences from it are bugs, and the owner's departures: `docs/departures.md`.

**Worth the tokens because:** <fill: the payoff that justifies the run, in a line.>

## The opening

Before the factory there's the opening: one-off work (prior work, the
harness, the oracle, trial units) filed as the project's issues, not as
tracker units. It ends when the owner passes the opening's gate
(`just pass opening/ready`), and `just loop` and `just fleet start` refuse
until then. If the probe's review is filed (`opening/probe`), the gate
needs it passed first. The owner passes the gate when each of these holds.

Until a check holds, replace its fill-in with what it needs and which item
in the opening's queue makes it hold: "needs X (queue item)". Once it
holds, the evidence replaces that.

- **The oracle** is a check outside the code being built, run on the real
  target, and it has judged a trial unit: <fill: needs … (the queue item that
  makes it hold); then what it is, and the unit it judged>
- **Like units:** a pile of units of one kind, and a recipe that makes one
  without hand work: <fill: needs … (the queue item that makes it hold);
  then how many, and the recipe>
- **The unit's size** was measured on trial units: <fill: needs … (the
  queue item that makes it hold); then the sizes tried and how long each
  took>
- **The owner can look** at the output themselves: <fill: needs … (the
  queue item that makes it hold); then how (a viewer, a play script, a
  page)>
- **The machine's limits** are set (Resources, below): its memory reserve and
  heavy-job count (`docs/machines.md`), and any job's memory that its measured
  peaks won't cover.
- **The goal's two lines** (Goal, above) were asked again with trial
  output in front of the owner: <fill: needs … (the queue
  item that makes it hold); then what they saw, and what changed>
- **Which differences are bugs:** the reference's kind, its floor and its
  taste layer are in `docs/departures.md`, and the owner has seen trial
  output that differs from it: <fill: needs … (the queue item that makes
  it hold); then the output they saw>
- **The owner's design calls** are made: where they want to look (the
  gates, in Done and stopping), how the scope grows (The ramp), and lanes
  or machines the profile doesn't settle: <fill: needs … (the queue item
  that makes it hold); then where each is written, and any still open>

Every report during the opening counts against these: how many hold, and
for each that doesn't, what will make it hold.

Once the gate is passed, cut this section to a line: when it was passed,
and where each check's evidence is.

## The unit

<fill: what one tracker unit is (one game, one program, one paper, one rule…),
and how big. One unit should fit comfortably in one fresh session.>

**How "done" is decided** (each unit's `check`): <fill: *computed* where a
probe can tell (set with `just tracker edit` and `--probe-cmd` or
`--probe-file`; the tracker runs it, and agents can't mark the unit done),
*independent* where a fresh context must judge, *recorded* where an agent
records it with evidence.>

**Inputs it may read:** <fill>
**What it produces, and where:** <fill>

## The oracle

What decides a unit is right. `just check` is the mechanical part and must pass
before anything is marked `done`.

- **`just check` runs:** <fill: tests, typecheck, golden diffs, a regression
  gate against a saved baseline…>
- **Beyond `just check`:** <fill: what else counts as evidence, and what
  evidence the record must cite (a screenshot path, a probe output, a quoted
  line), or "nothing">
- **Known noise:** <fill: how flaky the oracle is and what to do about it
  (resample k times, compare against the old version as a control), or "none
  known yet">
- **Lanes share `work/`:** lanes on one laptop share `work/` (and an
  editor's mod folders), so another lane's unit leaves half-written,
  uncommitted outputs there. Any part of `just check` that looks there skips
  the groups in `$FACTORY_BUSY_GROUPS` (the loop sets it;
  `factory/tracker busy` prints it). Two units of one group at once on a
  laptop skip each other's group too, so a skipped group is checked by the
  next landing once it's free, and by its CI. <fill: how this check skips
  them, or "it never looks at work/">
- **The oracle checks the real target,** not a convenient stand-in. If the
  result ships somewhere (a device, stock software, a printed page), the check
  runs there or against something proven equivalent.
- **Departures from the reference:** a difference from the reference is a
  bug unless `docs/departures.md` lists it. Each exception a check takes
  for one cites the owner's decision, and fails once that decision no
  longer stands or isn't the owner's (`just decisions --all --json`, or
  `just show d/<slug> --json` for one: `by`, `in_force`). <fill: how the
  checks read the page and their exceptions, or "every difference is a
  bug">
  A check that fails on a listed departure is missing its exception: add
  it, citing the decision (that applies the owner's call; it doesn't
  weaken the oracle), and never change the work back to the reference.

**Independent check:** <fill: one of the two>
- *mechanical*: `just check` passing is enough; the worker records the unit done.
- *independent*: a context that didn't do the work checks it. In a session,
  spawn a verifier subagent with a fresh context (give it the unit, its
  acceptance criteria and where the output is; ask for a verdict with
  evidence; a cheaper model is fine for mechanical checks). In the headless
  loop the next iteration picks up `review` units. The tracker enforces this
  for units whose check is `independent`.

**Review before landing:** with an origin, the loop reviews every finished
branch before it merges it into main: once `just check` passes on it, a fresh
session reads the branch's diff (outside `tracker/`), the unit's card and
`CODING_STANDARDS.md` if the project has one, and passes it or asks for
fixes. Fixes send the unit back to ready on its branch with the findings on
its card; a second round of fixes makes it stuck, for the overseer. The
reviewer's model is `review_model` in `tracker/project.json` (the lane's by
default). Standards every unit's code must meet belong in
`CODING_STANDARDS.md`, where the reviewer reads them, not in a section of
this spec that lanes don't get.

**Never make the oracle pass by changing the oracle.** Editing tests, goldens,
baselines, scenarios or pinned dependencies to turn a red check green is a
decision for the owner (`just ask`), never a way to finish a unit.

## What must never be lost

Everything this factory makes is either in git, or rebuilt by a command in
git from inputs that can be fetched again. `work/`, the store and any
editor project are caches of CPU time; losing them costs a rebuild, never
work. If a file vanished and running the scripts wouldn't bring it back
without judgement calls, it belongs in git.

- **The pipeline:** <fill: its shape (the wfactory skill's
  docs/pipelines/), its one layer of polymorphism, and where each kind's
  code lives>
- **Written, so in git:** <fill: what sessions and the owner write: code, specs,
  frame data, configs, and where each lives in the repo>
- **Derived, so rebuilt:** <fill: each kind of output and the command that
  rebuilds it from git and the inputs, e.g. "work/out/<item>: `just build
  <item>`">
- **Hand fixes to derived files** become a pipeline step, and a unit with
  one isn't done until a rebuild reproduces it: fix the generator or its
  input first; else a script step that makes the change; a binary patch
  (xdelta, bsdiff) from the pipeline's output, applied by that step, only
  as a last resort.
- **`just rebuildable`** lists files on disk with no source or copy in git;
  `just check` runs it. <fill: what it scans>
- **The drill:** `just drill <group>` rebuilds one group into a scratch
  folder and compares it with the current copy. <fill: how long one group
  takes; under a minute, `just check` drills one group per run in turn;
  otherwise the overseer files a drill unit each run and after pipeline
  changes>

## Done and stopping

- **The factory is done when:** <fill: the satisfied line (Goal), as a
  checkable end state.>
- **Stop and report to the owner when:** <fill: the kill criteria, e.g. three units
  in a row produce nothing usable, or the metric hasn't moved in N units.>
  Ask the owner about what you found (`just ask`) and stop; a factory that
  keeps running past its point is spending the owner's usage on nothing. A
  unit that needs the owner is not a stop rule: it waits on its
  question and the loop takes the next workable one, until `just next` has
  nothing left.
- **Gates:** a unit of kind gate (`just tracker add-unit <id> --gate --title
  "Review the lexer's output"`) holds back the units that need it, and what needs those,
  until the owner passes it (`just pass <id>`). Work that doesn't need it goes on.

## The ramp

Scope grows in steps, each a small multiple of the last, and a step's
review is a gate the next step's units need. Pick each step's new cases to
be as unlike the ones already built as possible, never the next easy one.
At each review, either the cases built so far share something (three or
more unlike ones), which becomes shared-code units, or one more unlike case
joins the step. Each review also files research units for what the next
step's cases will need that nobody has found out yet, and every review and
research unit looks for prior work first: someone else's tool, library or
port to copy or check against. And each review asks the owner whether the
goal's two lines still hold, now that there's more to look at.

- **How the cases differ:** <fill: the ways that matter (size, format,
  features used, known oddities)>
- **The steps:** <fill: each step's cases, why each is in it (what makes it
  unlike the others), and the review gate the next step needs; or "one
  step: the owner checks every case and wants them now">

## The loop

"Continue" means: run this loop for **one unit**, then report. No other
context is needed. Assume the previous session was cut off mid-unit. "Oversee"
means something else: run the lanes detached (`just fleet`) and supervise
them, following the overseer's guide (`just oversee-guide`).

1. **Orient.** Know which machine this is and what it can do: its section of
   `docs/machines.md` (a loop session has it in its prompt). Run
   `just status`. Run `git status` and leave changes you didn't make alone:
   another agent may own them.
2. **Pick and claim.** `just next --claim` names the unit, claims it and prints
   its card: what done means, its needs, the decisions that apply (titles;
   `just show <id> --full` when one's reasons matter), notes from earlier attempts. (The
   headless loop has already done this for you, and checked out the unit's
   branch.) An interrupted unit means a session
   stopped mid-unit: the card says where its work is (its branch, which the
   loop checks out, or what it left uncommitted). Keep what's good, finish it.
3. **Do** the unit, within the rules in `AGENTS.md`. Where it touches the
   taste layer (`docs/departures.md`), follow the departures and the calls
   kept there. A choice with no line there takes the page's default and
   goes to the owner as a candidate departure, filed as that page says,
   without holding up this unit. Never make a departure, or an exception
   in a check, without the owner's decision.
4. **Check.** Run `just check`. If the unit's check is independent, get it now
   (verifier subagent), or `just review <id> --evidence "…"` and leave it for
   a later session.
5. **Record**, the moment the unit is settled:
   - computed: `just recheck <id>` (the tracker runs its probe; you don't mark
     it). recorded or independent: `just done <id> --evidence "…"
     [--checker <tag>]`. Or `just drop <id> --why "…"`.
   - What the next attempt must know: `just note <id> "…"` (280 characters).
   - A judgement call: `just decide --title "…" --why "…" --scope <selector>`
     (the units it applies to: their group, a tag or a glob; `'*'` only for a
     rule every unit must follow, as cards list ten of those besides the
     owner's).
   - A discovered fact that would cost real time to rediscover goes in
     `memory/` (see the memory rules in `AGENTS.md`).
   - A new unit you discovered: first `just find <words> --open`; if it's
     filed already, `just note` that unit instead. If not,
     `just tracker add-unit <group>/<slug> --title "…"`, with `--uses <resource>` for every resource it needs, checking included.
     If several units will need the same new code (a family of similar
     items), that code is a unit of its own, and they need it (`--needs`).
     Two sessions on two machines must never design the same module twice.
6. **Commit:** <fill: the commit policy, e.g. "commit locally after each unit,
   message `<id> <status>: <what>`; never push" or "leave the diff for the
   owner">.
   Stage only this unit's files (`git add <paths>`, never `git add -A`), and
   never `tracker/`: the tracker CLI pushes its own writes to main. On a
   unit branch (the loop's), the last step is to merge the latest main into
   it, settle any conflict, rerun the checks and commit; the loop then merges
   the branch into main (the worker prompt: `just prompt`), running `just check` once more
   first. A unit whose own check takes more than about 5 minutes is tagged
   `slow-check` (`just tracker edit <id> --tags slow-check`), and that step
   skips it.
7. **Stop** after this one unit, interactive or headless. Interactively,
   report in a few lines, in titles: the unit and its new status, questions
   waiting, and what `just next` offers now.

When something needs the owner: check `just decisions <words>` first. If it isn't
answered, `just ask` with options (each saying what it changes), a default and
`--blocks` for what waits on it. That ends this unit, not the run: the loop
moves on to the next workable unit. Don't guess.

## Resources

- **Memory:** run anything heavy (builds, checkers, emulators, the pipeline)
  through `just capped <cmd>`, or a recipe that already uses it. A runaway
  child must die in its own scope, not take the desktop and every other agent
  down.
  A command killed for going over the cap says "killed: out of memory at
  <cap>": that's the cap, not the pipeline, so record it as such. One killed
  because the whole machine ran out says that instead. `just heavy why
  <name>` tells either from a crash afterwards.
- **The memory budget:** each machine's memory less its reserve
  (`docs/machines.md`, Reserve and GPU) is shared by its heavy jobs, across
  its lanes. A heavy job reserves its share before it starts (`FACTORY_MEM`
  or `--mem`, else its last peaks plus 20%, else 4G) and waits while the
  budget has no room. Something a job leaves running that must keep its share
  (an editor) is started with `just capped --hold`. One started some other
  way (an editor opened by hand, a long-lived service) gets a standing
  reservation, `just heavy reserve <name> <size> --pid <pid>` (or `--unit
  <unit>`), kept until it exits or `just heavy release <name>`; no `free -g`
  check of our own beside the budget. A tool that makes its own
  `systemd-run` scope escapes all this: run it through `just capped` instead.
- **CPU:** a heavy job that isn't known to be short also takes one of the
  machine's heavy-job slots, as many as its "Heavy" in `docs/machines.md`
  (usually 1); a short one runs beside it if the budget has room. `just
  heavy` shows what holds the budget and slots, and what waits. `just capped
  --light` / `just long start <name> --light` skip both for something small.
- **Machines:** which machines run the factory, their lanes, accounts and
  what each can do are in `docs/machines.md`, and only there.
- **Shared resources are locks.** Something only one unit may use at a time
  on a machine (an editor, a device, the screen) is a resource in
  `tracker/project.json`, and units that need it say so (`--uses <name>`).
  A resource's `named_by` lists the words (regexes) that mean a unit needs
  it, such as an editor's `["\\bPIE\\b", "just look"]`: a unit naming one in its
  title, detail or probe without `--uses` gets a warning when it's filed and
  from `just lint` (a warning only: it never fails a check).
  A lane holds the resource for its session's life; the machine's other
  lanes take other units meanwhile. <fill: the resources, e.g. "the Pixel 8",
  "the desktop", or "none">
- **Display, devices, shared state:** <fill: e.g. "needs a display (Xvfb)",
  "installs into the ES-DE library, so back up first", or "none">
- **GUI:** Sessions start with no display: the loop clears `DISPLAY` and
  `XAUTHORITY` and points `WAYLAND_DISPLAY` at nothing, so a window opens only
  on a display the session sets up itself (a private headless desktop, a
  virtual framebuffer, a container), not on the owner's screen. The unit's
  check, `factory/pre-session` and the landing checks get the same. Don't open
  apps through D-Bus or the desktop (`xdg-open` and the like): those still
  reach the owner's, and this rule is all that stops them. An app that would read or write the owner's own config
  gets pointed elsewhere by `session_env` in `tracker/project.json` (`just
  loop --help`). <fill: "none", or which app and
  which desktop-control tool drives it, and the private display it runs on, on
  a machine `docs/machines.md` says can. Make the desktop a resource (above)
  when more than one lane could drive it, and cite evidence outside the GUI (a
  file, a log line) rather than a screenshot alone.>
- **Lists every unit adds to clash.** When each unit adds an entry somewhere
  (a registry, an import list, a table), prefer one file per entry, found by
  name (a folder the code scans), over one shared list: two branches adding
  to the same list conflict on merge, two new files never do.
- **Tidy:** <fill: what `factory/tidy` shuts down when the last lane on a
  machine stops (an editor, a headless desktop, a device), or "nothing".
  Something a lane starts and leaves running between units must be stopped
  there, or it runs on after the factory has finished.>
- **Long jobs:** anything that may outlast one Bash call runs as
  `just long start <name> -- <cmd>` and is waited on with `just long wait <name>`.
  A job over about an hour means the unit is too big: <fill: how a unit is
  split per item here (a template's `each`, one unit per file), or "ask the
  owner">.
