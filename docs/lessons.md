# Lessons

Most rules in [SKILL.md](../SKILL.md) and its step files are here because
something went wrong without them. These are the incidents behind them,
from September and October 2026, running factories on two laptops and a
NAS: what happened, what it cost, and the rule it produced. The numbers
come from the factories' transcripts, tracker logs and git history.

The factories are named by what they did, not by name:

- **the mod factory** ported fighting-game characters from one game into
  mods for another, through a heavy GUI editor, with roughly 4,000 units
  planned;
- **the Flash factory** patched old Flash games to run on a modern player;
- **the translator factory** translated programs between two UI languages,
  judged partly by a model;
- **the desktop factory** built a desktop-automation benchmark;
- **the app factory** built an Android app, with the owner at the bench;
- **the recompiler factory** built a static recompiler for a game console.

Each rule is given as it was written after the incident. Some have changed
since; SKILL.md and docs/design.md say what holds now.

## The oracle

### 1. Check the real target

**What happened.** The Flash factory checked its patches on its own patched
harness. The stock player that people actually run showed bugs the harness
didn't.

**What it cost.** Units recorded as done that weren't, found only by
running the real thing.

**The rule.** The oracle runs against what ships, or against something
proven equivalent. Build and test the oracle before anything else.

### 2. Decide how to handle noise before trusting a regression

**What happened.** In the translator factory, 4 of the 21 "regressions" its
oracle reported turned out to be noise.

**What it cost.** About a fifth of the red marks were false alarms, and each
one would have sent a session to fix something that wasn't broken.

**The rule.** If the oracle samples or judges, decide up front how to
resample (k runs, the old version as a control) and write it in the spec.

### 3. Status comes from a check, so regressions show

**What happened.** In the first trackers, "done" was whatever an agent wrote
down. Yet most units could have been checked by a probe: the Flash
factory's games are done when their verify file passes and the installed
file's hash matches, and the desktop factory's tasks are done when their
verify script passes. Judgment was really needed only for playtests, prose
and fidelity.

**What it cost.** A change to a shared script could break units that were
already done, and nothing would say so until someone happened to look.

**The rule.** Units a probe can decide are `computed`. Nobody marks them
done; the tracker reruns the probe when its inputs change. A unit that passed
and now fails is **broken again**, and `just next` offers it first.

### 4. Never weaken the check to go green

**The rule.** Editing tests, goldens, baselines or pinned dependencies to
turn a red check green is a question for the owner, never a way to finish a
unit. The rule is in every factory's AGENTS.md and spec, and with a git
remote the review before landing looks for a test weakened to pass. A hook
that blocks edits to the oracle comes later, once an agent has actually
been caught gaming it.

The incident behind this one wasn't in the records these lessons were
written from.

## Talking to the owner

### 5. Titles, never bare IDs

**What happened.** Nobody read the tracker file. Every intervention went
through an agent retelling it in chat, and bare IDs got through anyway:
"what's G2 again?", and "what is fix up redirectors?" about a row an agent
had named in its own jargon. Several factories had a gate called G1, so
"G1" could mean different things on the same day.

**What it cost.** A round trip for every question, and answers given to the
wrong question.

**The rule.** Everything the tracker prints is "Title (id)". Text an agent
writes refers to units as `{unit:<id>}`, and the CLI refuses a bare ID, so
one can't reach the owner. In evidence and notes it writes a bare ID as
`{unit:<id>}` instead, and says so: refusing cost lanes turns of resending
long text, and the owner sees the title either way.

### 6. Questions have options, a default, and a scope

**What happened.** Questions were prose with no options and no
consequences. Answers were lost: in the desktop factory, the only question
the tracker ever held was answered in chat, and the agent then deleted the
line. In the mod factory, each answer became a hand-written commit editing
rows, and rows went on saying they were waiting after the answer had come.

**What it cost.** The same question asked twice, and units waiting on
questions that had already been answered.

**The rule.** `just ask` needs at least two options that each say what they
change, a default, and what the question blocks. It refuses a question a
decision already answers. `just answer` records the reply as a decision and
releases every unit it blocked; decisions in scope show on each unit's card,
so 80 units get one question, not 80.

### 7. A question for the owner isn't a reason to stop

**The rule.** A unit that needs the owner waits on its question, and the
loop takes the next one. So "three units in a row blocked" is never a kill
criterion. The kill criterion is a metric that should move and hasn't.
Finding out after a week that the factory was a waste of tokens is the
expensive way to learn it.

## Work that must never be lost

### 8. The lost laptop-day (the mod factory)

**What happened.** Two losses in one day, both from one-off steps done by
hand. First, a lane had committed its `work` symlink: `work/` in
`.gitignore` matches a folder, not a link. A `git pull` in the second
laptop's checkout replaced its real `work/` with that link. It was restored
from the previous morning's backup. Second, when the NAS was seeded with
each character's data, the copy kept was whichever laptop's had the newer
file times. A publish step had rewritten the times on one laptop's copies,
so they won over the other laptop's newer code.

**What it cost.** About a day of one laptop's work. A fresh-context audit
reopened 25 units across 11 characters. It also found hand fixes that
existed only inside editor assets.

**The rules.**
- Everything is either in git or rebuilt by a command in git. `work/`, the
  store and an editor's project folder are caches of CPU time. A hand fix to
  a derived file becomes a pipeline step. `just rebuildable` lists files with
  no source in git, and `just check` runs it.
- `just drill <group>` rebuilds one group from scratch and compares the
  result with the copy on disk; a difference is a hand fix nobody wrote down.
- Before any one-off step that replaces data, take a snapshot, then decide
  which copy wins by comparing contents (`rsync -rnci`), never file times.
- The lanes keep `/work` and `/.env` out of git in every clone.

### 9. Lanes on one machine share `work/` (the merge stalls)

**What happened.** Two lanes on one laptop share `work/`. One lane's unit
was halfway through writing its outputs there when another lane ran
`just check` to land its own branch. The check saw the half-written files
and failed.

**What it cost.** Another lane's merges stalled three times, half an hour
each.

**The rule.** Any part of the check that looks in `work/` skips the groups
in `$FACTORY_BUSY_GROUPS`: units another lane on this machine is partway
through.

## Running many lanes

### 10. The first two-laptop day (the mod factory)

**What happened.** 9 overseer chats and 137 worker sessions, about $307 at
list price. Both laptops shared one GitHub main, and each lane worked in a
shared checkout.

**What it cost**, in the numbers the next designs were measured against:

| | That day |
|---|---|
| Lanes exiting with "nothing workable" | 11, each restarted by hand about 80 minutes later |
| One laptop's lanes busy | 34% and 56% of the day |
| Hand merges by the overseer | 7 |
| Lines of sync and merge talk in the owner's chat | about 46 |
| Times the overseer got the two-account setup wrong | 4 |
| Work done twice | one character's special moves; two projectile builders |
| Time spent sleeping and polling on long jobs | 6.9 h of 40 h |
| Loops stopped by someone else's lint slip | 3 |
| Data copied by sessions themselves | 30 rsync calls, plus one 36 GB copy killed halfway |

**The rules.**
- A lane with nothing to do waits and looks again until its deadline; it
  stops only when the owner's questions are all that's left.
- Each unit is worked on its own branch, and the loop merges it. The
  session that wrote the code settles its own conflicts. Claims and tracker
  writes go straight to main, so of two lanes racing for a unit exactly one
  gets it.
- One machines file per factory is the only place machine facts live.
- A loop refuses to start only over broken tracker data, never over a slip
  in someone's note.
- Sessions never copy data; the loop does, by lease.
- Jobs that outlast a Bash call go through `just long start` and
  `just long wait`.

The next trial, that night, ran from 00:30 to 09:00 with no "nothing
workable" exits and no restarts by hand. About 80 units were recorded done.

### 11. Shared code is a unit of its own

**What happened.** The mod factory built two projectile builders in one
day, one on each laptop, and wrote one character's special moves twice.

**The rule.** When several units will need the same new code, that code is a
unit, and the units that use it need it. Where every unit adds an entry
somewhere, use one file per entry: two branches adding to one list conflict
on merge, two new files never do.

### 12. Heavy jobs take turns

**What happened.** Two lanes' Blender sweeps plus the mod editor on one
8-core laptop.

**What it cost.** Everything ran about 4 times slower than one sweep alone.

**The rule.** A machine runs only its "Heavy" count of capped and long jobs
at once (usually 1). The rest queue.

### 13. Whatever a lane starts, a lane stops

**What happened.** The mod factory's first overnight run ended at 09:00.
Its mod editor and headless desktop kept running.

**What it cost.** 250% CPU for hours, until the owner had an agent stop
them.

**The rule.** The project's `factory/tidy` says what to shut down. The last
lane on a machine runs it as it stops, and the overseer's last step is
`just fleet tidy`.

### 14. A unit too big for the night is a unit too big

**What happened.** One night, one session waited 580 minutes on a sweep
over every character. It held a lane the whole time and ran past the 09:00
stop until the overseer paused it. A "hold" state that freed the lane while
the job ran was designed and dropped: it touched claims, leases, CI and the
data copy-back.

**The rule.** A job expected to run over an hour, or past the stop time,
means the unit should be split per item. Near the stop time `just long wait`
says "out of time", and the loop ends a session still running 20 minutes
after it.

### 15. Publishing is CI, not a unit

**What happened.** Publishing and the reproducibility drill were units.
One morning, 13 publish units were ready but kept losing to focus and to
interrupted units. Separately, groups that still had ready work never ran
dry, so their publish never came due, and the night's work had to be
published by hand after the 09:00 stop.

**What it cost.** The owner parked about 49 units by hand to get the
publishes through.

**The rule.** A step that verifies or ships a group's finished work is the
group's CI. The tracker works out when it's due, and lanes run due CI before
any unit. An hour before the stop time comes **last call**: no new units,
work in flight lands, and every group whose CI is stale runs it.

## The overseer

### 16. Judgment at the loop's exits

**What happened.** The mod factory's first night stopped twice with work
still open. Once was at a gate the remaining units didn't need. The other
was at the end of a hand-written brief.

**The rule.** One overseer supervises the lanes. It sleeps while they work
(a few thousand tokens per wake-up), decides what each stop means, and never
works a unit or answers a question for the owner.

### 17. A brief sets priorities, not a fence

**What happened.** The second laptop was handed "F01 → F03, backup F05". It
finished at 2am and stopped. F07, a unit it had just written itself, was
workable offline.

**The rule.** A brief for another session ends with "then keep taking
whatever `just next` offers that this machine may do."

### 18. Recovery after a crash

**What happened.** After crashes and reboots in three factories,
interrupted units looked like work in progress. The owner had to write
recovery briefs, or ask "did we lose a bunch of work?"

**The rule.** A claim whose session is gone shows as **interrupted**, and
its work is committed to the unit's branch and pushed. Whoever claims it
next, on either machine, carries on from it.

### 19. Priority isn't file order

**What happened.** An overseer tried to hand-edit the mod factory's tracker
to add a "Now" section, because moving rows was the only way to change what
`next` picked. The owner stopped it.

**The rule.** Priorities, never row order. The tracker's JSON is written
only by its CLI.

## The code

### 20. One copy of the loop, deployed

**What happened.** Each factory carried its own copy of the tracker and
loop scripts, and the copies drifted. One laptop ran a day-old copy of the
loop. The Flash factory still carried a rule for a tool it never used.

**The rule.** The loop's code lives only in this skill. Each machine deploys
a pushed commit, and a running loop keeps the version it started with. A
factory's `factory/` holds stubs. A session's edits to those stubs are
dropped at merge unless the unit is tagged `factory`.

### 21. What earns its keep

- **The justfile.** Agents ran `just` recipes about 1,500 times in a month.
- **A cap on memory files.** The app factory measured that files over
  about 150 lines were opened about once in fourteen sessions. Hence the
  100-line lint and "one fact, one place".
- **No stale recipes.** The Flash factory's uncapped `just probe` was worse
  than no recipe at all.
- **The independent check in the same session.** One early factory left
  units in review "for a later session", and finishing it took about 30
  hand-typed "continue" sessions.

### 22. Audits find bugs where the tests don't go

Each fresh-context review of the loop, store and tracker code found about
ten bugs, mostly in paths the tests never ran. The worst ones: waiting
lanes ran checks on a stale tree and marked just-merged units broken; three
different short outages to the NAS could lose unsent work silently; and a
recipe added to the skill broke every `just` in a factory that already had
a recipe with that name. Each fix came with a test that fails on the old
code. That's why the test suites in this repo are large, and why they
must pass at every commit.

### 23. Find a unit by its words, and look before filing one (the mod factory)

**What happened.** The tracker had no way to look a unit up by what it was
about. Seven lane runs searched `just tracker --help` for a search command,
then guessed IDs and got "no unit" errors. One lane filed a unit about a
missing menu row in the editor's screenshots while a unit for the same fix,
worded differently, was already ready in the queue; two lanes wrote
competing fixes for it, and they clashed at the merge. Another filed a unit
with `--uses` set to a resource's title instead of its name, and it broke
`just lint` for every lane until someone fixed it.

**What it cost.** Wasted turns on each guess, one fix written twice and a
merge conflict, and every lane's lint failing at once.

**The rule.** `just find <words>` ranks units by their title, detail and ID.
`add-unit` lists the open units most like the new one and warns when one
may be the same work (a warning, since two units can share words and be
different work), and refuses a `--uses` that isn't a resource.

### 24. A refusal a lane can read

**What happened.** In one two-night run of the mod factory, the tracker
refused about twenty `just done` and `just note` calls: a bare unit ID in
the evidence, or a note over 280 characters. The reason came first and the
whole evidence, fixed, after it, and lanes pipe tracker writes through
`| tail -2`, so all they saw was `error: recipe done failed`. To find out
why, agents in ten runs sent `just done <id> --evidence "x"`, which worked:
the unit was recorded done with "x" as its evidence. Most reopened it; one
stayed done that way until the retro.

**What it cost.** Two to four turns per refusal, resending long text, and
done records whose evidence said nothing.

**The rule.** A refusal's reason is its last line, and it says nothing was
recorded. Evidence under 30 characters, or a run of one character, is
refused. `--dry-run` on `done`, `review` and `note` makes every check and
records nothing, so no one has to record a placeholder to see what the
tracker says. A bare ID in evidence or a note is written as `{unit:<id>}`,
with a warning (5).

### 25. A session's shell is the lane's, not the owner's

**What happened.** In the same run, the lanes' Bash tool ran the owner's
interactive setup. The CLI snapshots the user's shell (zsh and `~/.zshrc`,
where `ls` was a replacement tool) and, since the sessions didn't take its
Grep and Glob tools, put its own ugrep and bfs in place of `grep` and
`find`. Seven commands failed on flags those don't take, and the sessions
fell back to `command ls` and `/bin/ls`. Separately, the CLI gives each
command a stdin that never ends, adding `< /dev/null` only when it sees no
heredoc and no `<`. A `grep` with an empty variable for its file and a `<`
in its quoted pattern read that stdin and sat out the whole 10-minute
limit, and so did a command with a heredoc in it.

**What it cost.** Twenty minutes of two sessions waiting on nothing, and
retries on every tripped command.

**The rule.** The loop sets the session's shell: `CLAUDE_CODE_SHELL` is
`runtime/lane-bash.sh` (plain bash, stdin from `/dev/null`, `unalias -a` in
the snapshot, and the PATH the owner's own shell sets up, which is where
tools like cargo come from), and the sessions take Grep and Glob so `grep`
and `find` are the system's.

## Growing the scope

### 26. From one case to all of them (the mod factory)

**What happened.** The mod factory piloted one character. The second, a day
later, was picked because it looked simple too, so the pair shared every
feature that mattered and taught the code little the first hadn't. Four
days later a group took on every character in the game, on code shaped by
those two. What didn't fit went into per-character tables and branches in
shared code. Only on day nine was the pipeline redesigned around one class
per character with hooks, and the redesign was proved on five characters
chosen because they differed from each other, not because they were next.

**What it cost.** The shared code came two scope steps late: code already
written for the whole cast had to be ported onto it stage by stage, each
port proved by rebuilding the five before and after, and the port was
still under way four days on.

**The rule.** Scope grows as a staged rollout, with a review between steps
and each step's new cases picked to be unlike those already built. At each
review, look for the signs that shared code is due
([pipelines/](pipelines/README.md)), and write it then, against all the
unlike cases so far. Going straight to "all" is the owner's call ("I want
it now"), made after hearing that it may not be the fastest way there.

### 27. The opening nobody wrote down (eight factories, over four weeks)

**What happened.** Of eight factories, one had units and an oracle on its
first day. The others spent their first days on one-off work: a harness, a
pipeline, research, an interpreter. One owner gave up on the skill's design
questions after a day, asked to work out together what one unit of work
was, and ran the work as issues in parallel threads instead, which went
well. Where the skill did run from day one, lanes started before the ground
was ready: one factory went from setup to overseen lanes in three minutes,
with its real check arriving three and a half hours in; another ran four
days of lanes over its whole scope on a check against its own formulas,
before one against the real target existed. The prior work that mattered
most (the target's own code with its real names, someone else's ports of
the same thing, existing calculators) was found by the owner, late, after a
25-minute research sweep. Two factories died on whether the project should
exist at all: one cheaply, after a night of research and a gate, one after
a week of pipeline.

**What it cost.** Days of lanes on checks that graded their own homework,
work rebuilt once prior work turned up, and a week on a project nobody had
asked "can this be done?" about.

**The rule.** A factory starts with an opening: a one-message brief with the
quality bar in it, prior work first and long, a viability probe with its
stop line written down first, and a queue of one-off issues worked in
parallel (the harness, an oracle outside the code and on the real target,
the owner's way of looking, a recipe, trial units). It ends at a gate the
owner passes once the entry checks hold, and no lane starts before.

## A lane's own clone

### 28. A link out of the clone, and papercuts that add up (the mod factory)

**What happened.** Each lane's clone links `work/` to the checkout's, about
1.8 million files on one laptop. The CLI refused every write that resolved
through that link (40 Bash calls over two nights), while the tools followed
it fine. When the command had a pipe in it, the refusal said the command
"contains multiple operations" needing approval and listed parts like
`head`, so sessions split their commands, which never helped; some dropped a
backup or an edit to get past it. One session looked for a file with `find
-L` over the whole shared `work/`, reached 8.8G and was killed out of
memory, losing 49 minutes of work. The same nights, sessions Read image
sheets whole (about 670K characters each, 3.7M in one session), tried a
Python image library the project didn't have, and one spike ran a single
4-hour session against a card that said two.

**What it cost.** A redone hour, a retry per refusal, a dropped edit, and
context spent on full-size images.

**The rule.** The loop passes `--add-dir` for the real directory behind
each top-level link in a lane's clone, so the CLI and the tools agree on
where things are. The prompt says compound commands pass and a refusal of
one is about where it writes, that shared data is never walked, to look at
images through `just view-image`, and to check `docs/tools.md` before
reaching for a tool. A session that runs two hours, twice a session's
hour, is told through its inbox to write what it learned and split the
unit.

## CI through the night

### 29. All of CI at last call (the mod factory)

**What happened.** Eighteen characters' CI went stale around midnight, but
a group with ready work never counts as done for the night, so none of it
came due until last call. The lanes stopped taking units at 07:05 and every
group's CI started at once: drills with Blender builds and editor runs of
5 to 8 GB each, on a machine that had just had a machine-wide out-of-memory
kill. It froze at 07:12. Three groups failed on a fault (nothing owned one
kind of baked file) that would have shown at midnight, and two were cut off
by the freeze. The owner woke up thinking CI hadn't run at all.

**What it cost.** A night's CI with nothing passed, a fault found seven
hours late, and a frozen laptop.

**The rule.** CI that has been stale `ci_every` minutes (two hours by
default) comes due even with work left, and comes before the group's new
units. Each CI step takes its turn in the machine's memory budget like any
heavy job. Last call (lesson 15, still the backstop for what changed
late) starts early enough for the CI still to run, by how long each group's
took last time. A run cut short is recorded, and the morning summary says
per group whether CI passed, failed (on what), was cut off, or never
started.

### 31. CI's rebuild stayed on the laptop that ran it (the mod factory)

**What happened.** A group's CI copied its data down from the store and
rebuilt stages in it (exported models, built stages and their stamps, the
packaged mod), but only units ever copied data back, so the store kept the
last unit's copy. One character had three different builds at once: the
store's, and one on each laptop after its own CI runs. CI that ran on the
other laptop than the last one copied down the older copy and rebuilt
everything: over four days, every one of the 16 runs after a laptop switch
rebuilt the whole editor chain (10 to 30 minutes each), against 23 of 41 on
the same laptop.

**What it cost.** A good part of about 31 lane-hours of CI in those days,
spent rebuilding what another laptop had already built from the same main.

**The rule.** A CI run copies what it rebuilt back to the store as it ends,
stamped as the group's CI, after a pass or a failure: its steps run main's
code, so what they write is merged work. It goes the way a unit's copy back
does (the lease holder only, only over the copy it came from, owed and tried
again if the store is out of reach), and only when the run started on the
store's copy with nothing else waiting to reach the store. A run cut short,
or one whose step was killed, copies nothing back, and a live CI run holds up other copy backs of its
group, since its outputs would go half-written.

## Checks

### 32. Checks claimed before they could pass (the mod factory)

**What happened.** The mod factory splits a fix into the work and a check
unit that looks at the result in the game. In one overnight run, three
checks were claimed, ran for an hour or more, and were handed back
unfinished. One check of a character's throws ran three times. Its second
attempt did a look, three strips and three reviews before finding that
its main defect was already filed as an open fix. That fix had come from
a sibling check's look, and it named only the sibling. The same session
noted early that the reference emulator couldn't script a throw, so there
were no reference stills to review against. The third attempt still ran
the strip review without them, and it failed. The unit that would make
those stills was filed only then. Another check spent 68 minutes on
in-game move tests before its strip review failed on new fixes. A third
check's note, written by its fix's session, said "look after her CI
rebuild", but that character's group had no CI. The check spent 12 calls
finding that out, rebuilt by hand (about 50 minutes) and failed anyway.

**What it cost.** About 7 lane-hours over two laptops, with none of those
checks finished.

**The rule.** A check waits for the open fixes of its group that name it
(`{unit:<check>}` in their detail or notes) or that its detail names, as
if it needed them. Its card lists the open fixes its sibling checks found,
for the session to weigh before the look. A project with references to
judge against declares a `checks.ready` hook. A check the hook says can't
be judged yet isn't handed out: it waits on the unit that provides the
reference, filed by the hook if need be. A note, evidence or detail that
waits on CI is refused when the group has no CI, and the refusal asks for
the rebuild command instead.

## Shared work and case work

### 33. The balance moved only when the owner moved it (the mod factory)

**What happened.** Three things, over three weeks and 2,229 units:

- **Shared faults were fixed on the case that found them.** One character
  grew to 145 units and 2,646 lines of its own code, much of it the source
  game's common item code (throwing, holding, drawing an item), which four
  other characters need as well. The source names its common code apart
  from each character's; the factory waited for the rule of three instead.
- **Shared fixes went out as a unit per case.** Nine fixes became 15 to 28
  near-identical units each ("rerun this stage on the new code"), 436 in
  all, a fifth of the tracker. Most were filed before group CI built each
  character from main, and stayed filed after it did. On 2026-11-01 one
  character's CI was found to have applied such a fix with no unit run.
- **Shared units waited at their group's priority**, below the characters
  failing on them. The owner moved the balance by hand five times: shared
  first; infra first, with all character work parked; a pilot fast-track;
  shared code before the first five characters; an infra sprint. The fourth
  came from a study: the characters' look checks kept failing on shared
  faults (a pose drawn a frame behind, late effects) while the shared fix
  was ranked last.

**What it cost.** The rollout units were 41% done, against 48% to 72% for
every other kind of work, and were sent back 69 times for 177 finished
(the characters' own work: 39 for 414). 174 were dropped on 2026-11-01,
once CI was shown to apply them. Rounds of look checks spent finding the
same shared faults again on each character.

**The rule.** Where the source splits common code from per-case code, that
split is the line from the first case. A problem found on one case is
asked, as it's filed, whether every case that does the same thing has it.
A shared fix that the cases only need rebuilt goes out through the build
and CI, with its judges in CI, and a unit per case only where each needs
judgement of its own. The overseer ranks a shared unit above the case work
waiting on it ([docs/pipelines/](pipelines/README.md); `runtime/oversee.md`).

## The build

### 35. One folder per laptop was the cache, the workspace and the release (the mod factory and the recompiler factory)

**What happened.** In the mod factory each character's built outputs
lived in one folder per laptop, written in place: at once the cache, the
units' workspace and what got published. Units, side scripts and hand
edits all wrote it, and a unit could change its character's folder while
its code was still on a branch. The checks read that folder, not what the
commit builds, so one commit passed on one laptop and failed on the
other. The checks' results were committed, so every unit rewrote the same
generated files. Over two weeks, 114 of 271 CI runs failed, and only 4 of
the 114 were the tests failing (one of those on a parser, not a
character). About 58 were copies older than the drill's rules, about 20
copies ahead of git, 20 main not rebuilding after a shared change, and 12
the upload. The owner then ruled that CI publishes what main builds and
reports drift without going red, and the factory grew its own build
system one incident at a time: keys per stage, then masking the bytes an
export changes every run, then keys that count only the code a stage can
reach (lesson 31 was another of these). The recompiler factory, whose
build tool already keys outputs by their inputs, had none of this.

**What it cost.** 16.5 of 287 lane session-hours went to sessions fixing
CI. In the last six days the five characters were red from under a fifth
to nearly half of the time, and a red meant drift far more often than a
broken character, so a real failure looked like the rest. Then weeks
building by hand what a build tool keyed by inputs gives on day one.

**The rule.** Design question 14 settles whether the build is a function
of the commit. The spec's "The build", which every session gets, says
where derived files live, that only the build writes them, that the checks
read what the commit builds, and that results derived from a build aren't
committed. Outputs and check results are stored under a key of everything
that made them, and a step that can't be keyed is named in the spec with
what stands in for it ([docs/pipelines/](pipelines/README.md)). Drift the
drill finds is filed for whatever wrote it, not a red check for the commit
that ran it.

## The owner's part

### 30. A finish line that moved, and a goal set before anything existed (the recompiler and mod factories)

**What happened.** The recompiler factory ran its opening as three sprints,
outside the skill and before any scaffold, so nothing wrote down what
"ready" meant. Each sprint ended on "one more sprint". When the owner asked
again, the answer was a design round nobody had mentioned. In that round
the agent put all eleven of its design questions to the owner. They
answered "okay" to nine, asked why the one on resources was a question at
all, and gave a real answer only on the goal. After "let's start", the
agent still stopped twice to ask whether to go on. Separately, the mod
factory's owner set the goal on day two as "recreate the original game as
faithfully as possible", before anything had been ported. Two weeks in,
with real output to look at, they found they didn't want it identical,
only identical up to the point they actually cared about.

**What it cost.** Three rounds of the owner asking "are we ready?", a
design round of rubber stamps, and in the mod factory an oracle holding
work to a bar the owner had never wanted.

**The rule.** The opening's entry checks are written down when the
scaffold goes in, and every report counts against them. The owner's
design calls (the goal, gates, the ramp, machines) are made during the
opening; the rest of the design is the agent's, and the owner hears how
it's set up. The goal is asked as two lines: the furthest it could go,
and where they'd be satisfied. The satisfied line is asked again over
real output at the probe, the trials and every ramp review. Once the
owner says start, the agent stops only at gates and real questions.

### 34. The reference was the oracle, and the owner wanted something else (the mod factory and the recompiler factory)

**What happened.** The mod factory's oracle compared each character
against the source game, and on day two the owner set a standing rule:
whenever there's a choice, do what the source game did, as exactly as
possible, even where it reads oddly in the target game; adapting to the
target is a later phase the owner starts. Sessions built the source's
rules into every character, and the checks held them there. As the owner
played the result, they kept the target game's own rule in one place
after another. A week in, a page appeared to map which rules followed
which game, and a month in it held 34 kept from the
target against 15 kept from the source. Fifteen of those calls came on
one day, along with commits that took out source behaviour built to
match, such as the source's slower ledge options for a badly hurt fighter, 461
lines
across 30 files. Only then did the checks learn the calls: the frame
audit's exceptions had to cite an owner's decision, and a test failed
when the page cited one that no longer stood. The recompiler factory
went the same way on a smaller scale. Its far line was "plays as the
reference emulator does", and later the owner split the builds in two:
unmodded builds match the emulator byte for byte, and modded builds are
plain programs that keep none of its state.

**What it cost.** Weeks of sessions matching rules the owner ended up
not wanting, then the work of taking them out, and checks that until the end
counted every one of the owner's departures as a bug for a lane to fix
back.

**The rule.** The opening asks how the result relates to its
reference: every difference is a bug, the reference with departures, or
raw material. It never says "port", which means differences expected to
some owners and identical to an agent. For the reference with
departures, the floor (what everything stands on) is matched first and
exactly. The taste layer (feel, controls, defaults, looks) gets the
version that costs least to build and change, and each choice goes to
the owner as a candidate departure over real output, filed without
holding up the unit that found it. `docs/departures.md` holds the kind,
the layers and each departure the owner makes, citing their decision;
every exception a check takes cites one, and fails once it no longer
stands. Such an exception applies the owner's call, so lesson 4
(never weaken the check to go green) still holds: a lane never makes one
without the owner's decision. Matching everything first is the owner's call, as a phase they
start, after hearing what it costs.
