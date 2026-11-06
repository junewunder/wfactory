---
name: wfactory
description: "Use when starting or retrofitting a software factory: a project where agents grind through many similar units of work (a corpus, a library, a backlog, a tracker of cards or rules) for hours with little supervision, each unit judged by an oracle. Starts with the opening (prior work, the oracle, trial units, worked as the project's issues by parallel threads) until the owner passes the gate to lanes; then the spec, tracker, oracle, memory rules, a machines file and headless loop lanes. Examples: \"start a factory for X\", \"set this up so agents can grind through it overnight\", \"turn this into a tracker-driven loop\", \"I want to point agents at this and walk away\". Also when the owner says \"oversee\" in a factory repo: run the lanes (`just fleet`) and supervise them until every front is blocked (\"continue\" works one unit; \"questions\" goes through what's waiting on the owner; \"prune decisions\" goes through the stale ones with them)."
compatibility: "Linux with systemd, or macOS on Apple silicon. Needs bash, node, curl, just, git, jq and the claude CLI. install.md checks them."
allowed-tools: Bash(bash ${CLAUDE_SKILL_DIR}/scripts/init.sh *)
---

# wfactory

A factory is worth building when there are **many units of the same kind of
work** and **a way to tell a good unit from a bad one** without the owner
looking. Everything here serves those two things. A factory without an
oracle produces confident junk overnight, and a factory with three units is
a to-do list. Most projects have neither on day one, and that's what the
opening is for. If they never will (the work is a handful of one-offs, or
nothing can judge it), say so and don't build one.

Every rule here and in the step files came from a failure
([docs/lessons.md](docs/lessons.md) has them).

**The owner** is the person in the profile: `scripts/profile.sh path` says
where it is (`~/.config/wfactory/profile.md` unless
`$WFACTORY_PROFILE` says otherwise). Read it first. Its "You" section
says what to call them, where they read reports, and how they like to work.
Its tables hold the agent CLI, the usage limits, the machines and an optional
store. No profile yet, or `scripts/profile.sh check` fails: follow
[install.md](install.md) before anything else.

**One machine is the normal case:** one laptop, one lane, no store. Nothing
in setting up needs more. More machines, a shared store for big files and
group CI are opt-in: "Scaling out", at the end.

## Setting up a factory

Starting a factory, or retrofitting one onto a repo, goes in four steps,
each in a file of its own. When you reach a step, read its file, all of it,
before acting on any of it, and finish the step before you read the next.
Each file ends by saying when its step is done and where to go next. A new
factory starts at step 1.

1. **Scaffold** ([docs/scaffold.md](docs/scaffold.md)): `init.sh` lays down
   the factory and files the opening's gate.
2. **The opening** ([docs/opening.md](docs/opening.md)): the one-off work
   (prior work, the oracle, trial units), run as the project's issues until
   the owner passes the gate. The gate's entry checks are the finish line
   from day one, and the owner makes their few design calls here.
3. **Settle the design** ([docs/design-questions.md](docs/design-questions.md)):
   13 questions, yours to settle from what the opening found; the owner
   hears how it's set up, not a question per item.
4. **Pilot, then widen** ([docs/pilot.md](docs/pilot.md)): the first units
   interactively, the ramp's reviews, then the loop unattended.

**Once the owner says to start, keep going.** From the scaffold through the
design to the pilot's first unit, stop only at a gate, at a question that is
the owner's to answer, or before the opening's probe when it needs an
install, an account, a device or money their answer to the brief didn't name
([docs/opening.md](docs/opening.md), step 3). Never stop to ask whether to
carry on to the next step. An owner who says "let's start" and is then asked
"should I continue?" twice has been made to say it three times.

Picking up a factory part way through setting up: `just tracker state
opening/ready` says where it is. Not passed is step 2, whether the gate
waits on the owner (`you`) or on the probe's review before it (`waiting`;
`just status` then shows the probe's review as waiting on the owner).
`parked` is a stop the owner called at the probe: report it, with the
reason `just show opening/ready` gives, and start nothing. Passed, with no units yet outside the
opening's group (its gate, and the probe's), is step 3; units filed
outside it is step 4.

## The tracker

State lives in `tracker/` as JSON, written only by the tracker CLI. The code
is one shared copy in this skill (`tracker/main.ts`; each repo's
`factory/tracker` runs it), so a fix reaches every factory at once. Why it's
built this way: `docs/design.md`. `just tracker --help` documents every
command, `just tracker <command> --help` one of them, and `node --test
tracker/test/` tests it. Text is checked as it's written: a title over 60
characters, a note over 280, evidence under 30 or a bare unit ID is refused
with the fix, the reason on the last line (in evidence and notes a bare ID
is written as `{unit:<id>}` instead, with a warning). `just
lint` reports slips and broken data; a loop refuses to start only over broken
data (`lint --broken`).

**Units** have IDs like `lexer/string-escapes` (`<group>/<slug>`) and a title of 60
characters at most, in plain words. Each has a `check`:
- `computed`: a probe decides (`--probe-cmd "just check-unit lexer string-escapes"`,
  or `--probe-file out/x.json --probe-json '.pass == true'`, with `--inputs`
  globs so `refresh` reruns only what changed). Nobody marks it done. A probe
  that passed and now fails turns the unit **broken again**, and `next`
  offers it first. One that exits 75 couldn't run here (as `just capped`
  does with no turn in the memory budget): the unit stays as it was, and the
  probe runs again next time. A timeout is a failure.
- `independent`: done needs `--checker` from a context that didn't work it.
- `recorded`: an agent records done with `--evidence`.

Units can also have `needs`, `uses` (a resource from `project.json`, with a
`free` probe: a desktop app only one session can drive, "someone is using the desktop"), `model`
(the loop runs that unit on it) and `tags`. A group can carry `needs` (which
hold its CI too) and `priority` for all its units (`just tracker edit-group`). Priority is the
one way to say what `next` prefers. A unit ranks by the higher of its own
priority and its group's, so a unit can rise above other groups' units but
never drops below its own group's. Ties go by group priority, group order,
unit priority, then unit order (row order in a file never matters). At equal
priority only, a lane comes back first to interrupted, broken and review
units, then to units whose data its machine already leases, so data moves
only when a higher priority calls for it. Setting a
priority prints what the unit or group now runs before, and `just tracker
queue` shows what each machine takes next and why. `just tracker park <id|selector> --why "…"` sets work aside for the owner: it isn't offered,
waited on or counted as theirs to do, until `unpark`.

**Templates** (`tracker/templates/<name>.json`) make a group's units from
parameters: `just tracker add lexer --template module`. A template unit
with `"each": "work/{name}/api.json#/functions"` makes one unit per item once
that file exists (`just tracker sync lexer`).

**Talking to the owner.** Everything the CLI prints is "Title (id)". Text an
agent writes (notes, details, questions) refers to units as `{unit:<id>}`:
the tracker writes a bare ID in evidence or a note so, refuses one elsewhere,
and `lint` rejects any that got in, so a bare ID can't reach the owner.

**Questions** go through `just ask`: the question in plain words, at least
two options that each say what they change, a default, `--blocks` (units or
selectors like `tag:unicode`, `*/string-escapes`, `group:lexer`) and `--scope`
for what the answer will apply to later. `ask` refuses a question that a
decision already answers or that the owner already has open. An option whose
answer drops or releases units ends with `| drops: <units>` and `| releases:
<units>` (`--option "drop | Drop the old API | its eight units are dropped |
drops: group:legacy"`); it must then name every unit the question blocks, and
`show` and `questions` print what each option does. `just answer q/<slug>
<key>` records the owner's reply as a decision and does what the option says;
an option with neither field releases every unit the question blocked.
An option that puts the work off ("not yet") is marked `--parks <key>`:
answered so, its units are parked, and while that decision holds they aren't
offered (even reopened) and `ask` refuses to ask about them again, until
`unpark`.
Decisions in scope show on each unit's card, so 80 units that share a
question get it asked once, not 80 times. Gates are units of kind `gate`;
`just pass <id>`.

**The owner's view:** `just view` opens `.tracker/view.html`, rebuilt on
every write: what needs the owner (questions with their options, gates,
broken and interrupted units), what happened since the last look, a progress
bar per group, and the decisions. Away from the computer, the owner reads
the overseer wherever the profile's "Reports" says.

**Snapshot first, compare contents.** Any one-off step by hand that replaces
data: pulling into a checkout whose ignored folders hold work, seeding a
store, moving or merging copies between machines, a bulk delete. First take
a snapshot of everything it could overwrite (a ZFS snapshot on the store, a
tarball or a borg archive on a laptop), and say where it is. Then decide
which copy wins by comparing contents (`rsync -rnci`, a diff of the files),
never by file times: an upload, a publish or a copy rewrites times without
changing a byte.

Tracker writes reach origin at once, with no check first. If the factory's
origin is public, set `"private_words"` in `tracker/project.json` to the files
of words a write must not add (the first that exists; `~` and `$VAR` expand; a
list kept outside git, since it names what it hides). A write adding one is
refused, and a machine with no list can't write at all.

## "Continue": one unit

Before the opening's gate is passed, "continue" works the next issue in the
opening's queue instead (the skill's [docs/opening.md](docs/opening.md), all
of it). With the gate passed and no units yet outside the opening's group
(its gate, and the probe's), "continue" is the next setup step: read the
skill's [docs/design-questions.md](docs/design-questions.md), all of it.

When the owner says "continue" in a factory repo, work **one unit** by
`docs/factory.md`'s loop, then report: the unit, its new state, questions
waiting, and what `just next` offers now.
- **Finish the unit, including its independent check.** Spawn a verifier
  subagent with a fresh context, waited on in the same call
  (`run_in_background: false`). Give it the unit, the acceptance criteria and
  where the output is, and ask for a verdict with evidence. Then
  `just done <id> --checker <tag> --evidence "…"`. Don't leave it in
  `review` for "a later session": finishing those took one factory
  about 30 hand-typed "continue" sessions.
- **A unit that needs the owner ends the unit, not the factory.** `just ask`
  (it blocks the unit) and say in the report what `just next` offers instead.

## "Oversee": supervise the lanes

Before the opening's gate is passed, there are no lanes: "oversee" runs the
opening's queue (read the skill's [docs/opening.md](docs/opening.md), all of
it, and run the queue as its "Running the queue" says). With the gate passed
and no units yet outside the opening's group (its gate, and the probe's),
there's nothing for lanes to do: say so, and settle the design first (the
skill's [docs/design-questions.md](docs/design-questions.md)).

Otherwise, run `just oversee-guide` and follow the card it prints, all of
it, reading the whole guide (`just oversee-guide --full`) where the card
points to it: together they are the whole of overseeing. In short, one overseer runs the whole
factory: it attaches first (`just fleet attach`), starts the lanes as
systemd user services that outlive it (`just fleet start --hours N`), and
sleeps on `just fleet wait` between wake-ups. It never works a unit, never
touches the oracle and never answers the owner's questions for them.

**A brief for another session sets priorities, not a fence.** When you hand
a session a list of units (another machine, a scoped run), end it with "then
keep taking whatever `just next` offers that this machine may do, until
nothing is workable", and say what it must not touch. A session handed only
its list stops when the list is done, with work it could still do left open.

## "Questions": the owner answers

When the owner says "questions" (or "what's waiting on me", "I can answer
things now") in a factory repo, run `just questions` and go through them
**one at a time**: the question in plain words, each option with what it
changes, the default, and what it blocks. Use `just show q/<slug>` for one.
Record each reply with `just answer q/<slug> <key> [--note "…"]`, or `just
pass <gate>`. If the owner can't tell the options apart, show an example
(code, a screenshot) rather than repeating them. When the owner answers a
question in passing in any session, record it the same way before doing
anything else: an answer that only lives in chat gets asked again.

## "Prune decisions": the check-in

Decisions only pile up, and every one in a unit's scope is on its card. The
overseer offers a check-in in its report when one is due (every few days of
runs, `"checkin_days"` in `tracker/project.json`, default 3; or when a card
carries more than `"prune_at"` decisions, default 40): `just fleet summary`
ends with the offer then. It's an offer, never a stop. When the owner says
"prune decisions", or takes the offer, follow `runtime/oversee.md`'s
"Pruning decisions" (`just oversee-guide --full`): `just tracker prune
--propose` lists what's lapsed, superseded or scoped too wide, you add what
the code now holds and what repeats, and the owner says keep, apply or edit
for each. Nothing is taken off a card without their yes, except a lane's own
decision whose night is over.

When the owner names a time for a decision ("today", "tonight", "for this
run"), record it with `--until`, or ask until when.

## Several loops in one repo

A repo that holds separate deliverables the owner moves one at a time can
run a loop for each, with its own groups and spec (`"loops"` in
`tracker/project.json`). Whether to split, and how it works:
[docs/design-questions.md](docs/design-questions.md), "Several loops in one
repo". In a repo that has several, work on and report on only the loop the
owner names; if they don't name one, ask which.

## Scaling out

One machine with one lane is the default. When a factory needs more, read
[docs/scaling-out.md](docs/scaling-out.md) for the part it needs:

- **More lanes or more machines.** These need an origin (on one machine, a
  bare repo on the same disk is enough). Each unit is then worked on its own
  branch in its own lane clone, and the loop merges it. Claims and tracker
  writes go straight to origin's main, so two lanes never get one unit.
  Machines are rows in the profile and in `docs/machines.md`, and
  capabilities (`--caps`), not host pins, tie units to a machine.
- **Group data on a store.** Files too big for git that later units of the
  group need live on a NAS or any ssh machine (the profile's `store`). They
  move by lease, and the loop does all the copying.
- **Group CI and last call.** A drill or a publish over a group's finished
  work is the group's CI, not a unit. The lanes run it through the night,
  two hours after a change by default and before the group's next unit, and
  again at last call before the morning stop. A project opts in to two more
  in `tracker/project.json` `ci`: `"affected"`, a command that names the
  groups a range of main changes, so shared code landing anywhere makes
  their CI due; and `"land"`, a per-group check the loop runs before each
  unit lands, so a unit that left the group's copy ahead of git goes back to
  its own session.
- **Check units.** A unit that judges other units' fixes in the built
  thing (a look in the game or editor) is a check, by `tracker/project.json`
  `checks.units` (selectors, such as `*-check`; default `tag:check`). A
  check waits for the open fixes of its group that name it (`{unit:<check>}`
  in their detail or notes) or that its detail names, as if it needed them.
  `checks.ready`, a command with `{unit}` and `{group}`, says whether a
  check has what it needs to be judged (a reference to compare against);
  until it does, the check waits on the unit that provides it, which the
  hook can file.
