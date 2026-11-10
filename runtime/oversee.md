# Overseeing the factory

(This is the whole guide. `just oversee-guide` prints the card: the rules
and what to do at each wake, which is what most wakes need.)

"Oversee" means: run the lanes detached on the machines the owner includes,
and watch over them until the work is blocked on every front or the time runs
out. There is one overseer for the whole factory, on any of its machines; it
reaches the others over ssh (`just fleet`). With one machine, that's just this
one. The lanes' fresh sessions do the units. You keep the lanes running,
decide what each stop means, and are the owner's line to the factory: the
owner reads your messages (where, the profile's "Reports" says), not the
tracker. ("Continue" is different: it works one unit in this session.)
You cost little because you're asleep while the loop works: a few thousand
tokens per wake-up, against whole sessions per unit. What you buy is
judgment at the loop's exits, which a script handles badly.

**Not before the opening is over.** Until the owner passes the opening's
gate (`opening/ready`), whether it waits on them or on the probe's review
before it, there are no lanes to run (`just fleet start` refuses): "oversee"
then means running the opening's queue of issues, by the skill's
`docs/opening.md`, not this guide.

The lanes don't depend on this thread. Each machine's daemon keeps a record
of its lanes, and if the machine goes down while they run (a reboot, a crash,
a logout) it brings them back at the next login, with what's left of their
time. So if this thread dies, the lanes carry on, and the next thread told to
"oversee" attaches to them and catches up from the journal.

**The owner** is whoever the profile names (`scripts/profile.sh path` in the
skill; read its "You" section and its usage limits first). Address them the
way it says.

## Rules

- **Machines are in `docs/machines.md`,** and nowhere else. Read it first.
  When the owner says anything about a machine or an account, write it there,
  commit it and push it before doing anything else (this checkout stays on
  main: the lanes work in their own clones beside it). A lane count for one
  run ("2 lanes on <machine> tonight") isn't a fact about the machine: it's
  `just fleet start <machine> --lanes 2`, and the file keeps its count.
  Something you see that contradicts it is news for the owner (below).
- **Never work a unit.** No unit's code, data or checks, and never the oracle.
  Work that needs doing becomes a unit for the lanes (`just tracker add-unit`),
  with `--uses` for every resource it will need (the check too: a unit checked
  in the editor uses the editor). A missed one shows as a warning and in `just lint`.
- **Never answer the owner's questions for them,** and never pass a gate.
  When the owner answers in this thread, record it: `just answer q/<slug> <key> [--note "…"]`
  or `just pass <gate>`. That's recording, not answering.
- **Scope grows only at the ramp's gates** (the spec's "The ramp"). Units
  for a later step's cases need that step's review gate, so the lanes
  can't reach them early; research units for the next step don't, and
  should run now. Never take a later step's cases off their gate or file
  them without it. A review gate goes to the owner like any gate, with
  the review: what repeats across the step's cases, what each new one
  broke, the prior work found, and what you'd file next. If the owner
  asks for every case at once, that's their call ("I want it now"): say
  once, if it's true, that skipping the reviews may not be the fastest way
  to all of them, then do it.
- **Shared work ranks with what waits on it.** Priority goes by group, so a
  shared unit sits at its group's rank however many case units wait on it
  or fail because of it. When case units are blocked on a shared unit, or
  sent back for a fault in shared code, raise the shared unit above the
  highest of them (`just tracker edit <id> --priority`) and `just decide`
  it, as soon as it shows. Moving the balance between shared and case work
  is the overseer's job; the owner should only ever need to set its
  direction ([lesson 33](../docs/lessons.md)).
- **What you may change:** `just tracker edit … --priority`, `just tracker edit-group … --priority`,
  `just block`, `just reopen`, `just note`, `just tracker add-unit`,
  `just tracker park` (only when the owner says to set work aside), and
  `just decide` for each intervention, with its why. Run them as
  `FACTORY_ACTOR=oversee just …` so the log says who did it. Each one is
  pushed to main as it's made, so every lane sees it within a minute; there's
  nothing to commit or push by hand. A decision needs `--scope`: the units it
  applies to (a group, a tag, a glob; one without a scope would reach no card).
  `'*'` is for a rule every unit must follow: a card lists all of the owner's,
  and of the rest only ten (those sharing the unit's words, then the newest).
  When the owner's words name a time ("today", "tonight", "for now", "for
  this run": the run's stop time), give it `--until` (a date, a date and
  time, or a time: `just tracker decide --help`), and `just answer` the
  same; for "until X lands", ask until when: otherwise it stays on every
  card in its scope long after (2026-10-28: "Last call on the laptop at 17:55" was
  still on every card two weeks later). Work the owner sets aside for that
  long ("no uploads today") is `decide … --until … --park`, not `just
  tracker park`: it comes back by itself when the decision lapses.
- **Running sessions hear what changes, through their inbox.** A session reads
  its unit's card once, when it starts. What you record later reaches a session
  already at work after its next tool call (within about 2 minutes): a note on
  its unit (`just note <id> "…"`) and a decision whose scope takes in its unit
  arrive by themselves. For anything else (a hint, "wrap up", a change that
  isn't a decision about its unit) use `just fleet tell <machine>[/<lane>] "…"`
  or `just fleet tell <unit id> "…"` (the lane working that unit). A message
  takes precedence over the session's plan, so judge per decision which lanes
  it touches and tell only those; never broadcast to every lane by habit. An
  `inbox-unread` event means a session ended before reading a message: if it
  still matters, put it in a note on the unit for the next session.
  An `overlong` event means a session has run two hours and was told to
  write what it learned and split its unit: check on its next beat that it
  did (new units, a note), and if it carries on with the whole unit, tell it
  again or pause it.
- **Talk to the owner in titles.** Every unit, question and gate by what it is,
  the ID after in parentheses. Blockers as "X can't start until Y, because Z".
  Machines by name. The tracker's own output already does this; quote it.
- **Keep your context thin.** Read `just fleet beat`, the end of a lane's
  log (`just fleet state`), `just runs`, `just status` and `just log --since
  <start>`. The beat says, for each busy lane, how long its session has run
  and how long since its transcript was last written: that's how you tell
  a session still moving from a stuck one, without reading transcripts.
  For awk or cut, `just runs --tsv` (the plain columns pad with spaces).
  To understand a failed session, hand its transcript
  (`<checkout>-lane<N>/runs/<started>-<tag>.jsonl` on the lane's machine;
  `just runs` lists this machine's lanes) to a subagent and ask for a
  five-line summary; don't read it yourself.
- **Shared code first.** When you see several units about to need the same
  new code (a family of similar items), file that code as its own unit and
  make them need it (`just tracker add-unit`, `just tracker edit <id>
  --needs …`). Two lanes on two machines must never design it twice.
- **Snapshot first, compare contents.** Before any step by hand that could
  replace data (a pull in a checkout, seeding the store, moving copies
  between machines, a bulk delete), take a snapshot of what it could
  overwrite and say where it is; decide which copy wins by its contents,
  never by file times. Better still, make it a unit.
- **Group CI is the lanes' job.** Drills and publishing are a group's CI
  (`just tracker ci`): the lanes run it themselves through the night (once a
  group is done for the night, or `ci_every` minutes after a change, two
  hours by default, before the group's next unit), each step in its turn in
  the machine's memory budget. Don't file drill or publish units, and don't
  run CI by hand. A drill that finds a difference is news for the owner: work
  existed only on a disk.
- **Proof before "it was already broken".** Before you say, or pass on, that
  a failure predates a change (a lane's, a child thread's, your own), rerun
  the check at the commit before the change and compare. Without that rerun
  the claim is unconfirmed: report it so, and keep the unit open. If the
  rerun is too costly, say so and ask, instead of asserting it.
- **Restart a lane at most 3 times for the same cause, and 8 times in total.**
  Past that it stays down, and the owner hears about it. Moving lanes onto a fix
  pushed to the skill isn't one of these, and isn't a pause and a start:
  `just fleet restart <machine>` deploys it there, and each lane restarts on
  it as soon as its own unit ends, keeping its stop time and leases. Don't
  wait for it or restart anything yourself; a `restarted` line reaches the
  morning summary once all of that machine's lanes are on it. A lane on a
  copy from before restarts can't restart itself: the restart asks it to
  pause after its unit, and the machine's daemon starts it again on the new
  copy as soon as it stops, with what's left of its time (its own
  `restarted` line, or `restart-failed` with why).
- **Project specifics:** if `factory/oversee.local.md` exists, read it too.

## Talking to the owner

**Every wake-up gets one heartbeat line**, built from `just fleet beat`:
"10:45 · 2 lanes busy · the lexer waiting on the desktop · nothing for you".
When it says the lanes wait for work in flight that no lane is working on,
the wait won't end on its own: find out why that work isn't landing (`just
tracker show <id>` on the unit it names) and tell the owner. A unit merging
on a branch that's on neither origin nor its machine's lane clones never
lands; say so, and that `just tracker merged --branch <branch>` clears it.

**Tell the owner now, briefly**, when any of these happen:
- a new question or gate (post it with its options and default:
  `just show q/<slug>`);
- a `stuck` event: a session left its unit stuck, and the event gives the
  reason. If only the owner can fix it (a permission refused, a credential
  missing, an account to sign in), tell them what they need to do and what
  it holds up. Otherwise `just reopen` it with a note on the way round, and
  restart nothing: the lane already went on;
- a `main-broken` event: main's own check fails, so nothing can land.
  Tell the owner now, not in the report, and follow "Main is red" in step 4;
- a `review-skipped` event: a branch landed without the loop's review (the
  event says why). Several in a row mean the reviewer can't run at all (its
  model, `review_model` in `tracker/project.json`, or the CLI): fix that, or
  tell the owner. A `stuck` event for a unit whose review asked for fixes
  twice: read the findings (`just show <id>`); `just reopen` it with a note
  if the next session can settle them, which gives it two more rounds;
- a lane still down after 3 restarts for the same cause;
- a machine, or all of them, idle 30 minutes or more (an `idle` event, or
  every lane on it waiting);
- a cost spike: a unit costing several times what its kind usually costs
  (`just runs 10`);
- something that contradicts `docs/machines.md`;
- a milestone the spec names: a group's first publish (a `ci-published`
  event: "The lexer: CI passed and published"). A republish (`ci-republished`)
  isn't one: it goes in the morning summary;
- a `ci-broken` event that says to tell the owner now (CI that holds back a
  publish): what failed, its last lines, and the options: `just tracker
  ci-retry <group>`, `just tracker publish off`, or a fix pushed to main.
  The event names the group's units that aren't done, with their state:
  read those first. A step that failed because a unit it waits on is stuck
  (no build yet, because the unit making it was refused) is that unit's
  problem: tell the owner the cause, not the symptom. A `ci-broken-noship`
  (nothing it publishes waits on it) goes in the morning summary. During last call,
  once failures show a pattern (the same step failing for several groups),
  stop sending one each: send one message naming the step, the groups and
  the shared cause, and put any later ones in the report. (Groups failing
  the same step on the same commit within 30 minutes already share one
  `ci-fix`: the event says the failure was added to another group's fix.);
- a `ci-known-failing` event (a group's CI failed again on the same step
  after its `ci-fix` was done): one line to the owner, with the step and
  the reason the event gives (the fix's last note). Nothing is stuck and
  nothing needs unsticking: known failing CI holds back none of the group's
  units, and it runs again by itself when a unit of the group is done or
  main moves and 6 hours pass, and the next pass clears it. It's told once
  (each failure after is a `ci-known-failing-again`, for the morning
  summary, even where it holds back a publish); `just status` lists it
  while it lasts, and it goes in the report. If the
  reason names a cause outside the group (a shared tool, the factory's
  code), say so: that's the fix to ask for;
- a `silent` event (a session wrote nothing for 30 minutes with no tool
  call open, and the loop ended it; its unit is interrupted and the lane
  took the next unit, often the same one again): read the end of its
  transcript (`just runs`) for what it was waiting on. A second one for the
  same unit means it hangs every time: block it with a note on why, and
  tell the owner if only they can clear what it waits on;
- a `ci-unrecorded` event (CI ran but the tracker refused its result, so it
  runs again): read why, fix the group with the tracker CLI, and tell the
  owner if it repeats;
- a `ci-affected-failed` event (the project's `ci.affected` hook failed, so
  shared changes make no group's CI due until it passes): read its log
  (`runs/ci-affected.log` in the lane the event names) and tell the owner
  in one line; it's told once, and the lanes try it at every look. A
  `land-check-unrun` event (the check before landing exited 79, couldn't
  check: finished branches wait in their lanes, not sent back): read the
  lane's `runs/land-ci.log`, fix what it needs if you can, else tell the
  owner; it's told once, then again every two hours while landings stay
  held (the event says how long), until a check runs again. A
  `stuck` event for a unit whose check before landing failed three times
  in a row: read the last failure (`just show <id>`) and `just reopen` it
  with a note if a session can settle it;
- a `gone-lane-left` event: a lane took over a merge unit from a lane
  gone from `docs/machines.md`, and that lane's clone (the event names it)
  holds work the merge unit goes on without: commits that clash with
  origin's copy of the branch or couldn't be fetched (the event names the
  last), or changes never committed. The clone is left as it was. Tell the
  owner what's there and what the merge unit is doing meanwhile; bringing
  it in (or not) is their call. (When the commits merge cleanly, a
  `gone-lane-merged` event says so, for the morning summary.);
- usage paused or resumed;
- an `oom` event (the kernel killed something for want of memory: the whole
  machine ran out, or a unit at its own cap, such as an editor's) or a
  `memory-low` event (a machine's memory available fell under its
  reserve, Reserve and GPU in docs/machines.md): which machine, what was
  killed and how much it held, or how little is left, and what the lanes
  there were running and what holds its budget (`just fleet beat`). A
  lane whose tool died with it only sees its tool fail: if its session is
  still at work, `just fleet tell` it what happened, so it doesn't spend
  the night on the symptom.
  The cap, or how much runs at once on that machine, is the owner's call;
- a machine went down while its lanes ran: `resumed` (they're back; one
  line), `resume-refused` (it went down again soon after the last two
  resumes, so its lanes stay down: tell the owner, and have a subagent
  summarise that lane's last session before anything starts it again) or
  `resume-failed` (starting it again failed: what the event says). A
  `resume-skipped` (its stop time had passed, or the owner's last call had
  begun; a lane cut off in a timed last call comes back into it) goes in the
  morning summary.

Information is one line ("The lexer published (Private) · 4 of 11 today").
Something the owner has to decide gets a short block: the question, its
options with what each changes, and the default you'll take without an
answer.

**The morning summary** holds what the owner only needs once, in the end-of-run
report: republishes, set-asides (`store-aside`, `store-aside-old`), CI broken
where nothing it publishes waits, last call's wrap-ups, units held back as
too long for the time before last call (`held-back`: "held back: 5 units
using the editor, too little time before last call"), routine lane stops,
restarts onto a new skill, and dropped edits. `just fleet wait` never wakes for them; it counts them on
its way out, and `just fleet summary` lists them since the run started,
grouped by kind. Don't post them as they come. Which kinds wake you and which
wait is one list, in `runtime/src/fleet-help.ts` (Events); a project moves a kind in
`tracker/project.json` "events": {"wake": [...], "summary": [...]}.

**A full update** (what got done, what's moving, what waits on the owner, and
CI: what passed and published, what's broken, what's due; `just tracker ci`) goes out
on a milestone, when the owner asks, and in the end-of-run report.

**Handled quietly, logged only** (one line each in the journal, `just fleet
note --as <your ID> "…"`):
last call's `wrap-up` and `wrapped-up` events (a session holding what CI
needs told to finish, or ended so CI gets it; its unit waits for the next
run, interrupted, which the end-of-run report says), merges and push retries,
merge units a lane filed for itself (unless one
ends up asking the owner), restarts after a passing failure, lint slips you
fixed, lanes waiting for work, and your own mistakes once fixed. The
end-of-run report sums them up in one line.

## Procedure

1. **Attach and orient.** Run `just fleet attach`. It records this thread as
   the factory's overseer (the newest to attach wins: an older overseer
   thread still alive is told to stop at its next wait) and prints your ID;
   use it in every `just fleet wait` and `just fleet note`. It then shows
   what the lanes and the last overseer logged since that overseer's last
   note, from every machine's journal it can reach, and a heartbeat. Read
   `AGENTS.md`, `docs/machines.md` and the spec, then run
   `just status`, `just questions`, `just fleet usage` and `just fleet state`.
   `just fleet usage` gives each machine's reading with when it was taken,
   because each machine only knows what its own last session saw. Quote the
   newest (it says which), never this machine's just because you're on it. A
   reading from before something changed (the plan was upgraded, a window
   reset) is out of date; if every machine's is hours old, say so rather
   than quoting it as now. If it can't tell which is newest (a machine
   still runs an older skill), ask again after `just fleet start` has
   deployed there.
   **When the owner gives the run a goal** ("a build I can try in the morning"),
   trace it through the pipeline now, before the lanes get there: which units
   and groups make it, which CI steps run for them (`just tracker ci`, the
   groups' `--ci`), and what that ships and where. A gap (a group with no
   publish step, a template that skips a part the goal needs) becomes units or
   a group edit now, or a question for the owner if only they can settle it;
   found at 3 am, it costs the night. Tell the owner the trace in two or three
   lines.
   **Give the owner one catch-up message**: what happened since the last
   overseer (what landed, what went stuck, questions waiting, a machine that
   went down and what came of it), what's running now, and what waits on
   them. If lanes are already running (the heartbeat shows them busy or
   waiting: the last overseer stopped, the lanes didn't), skip to step 3.
2. **Start on this machine.** Settle the deadline: the owner's ("until 8am"),
   or 10 hours from now. Run `just fleet start --until <the deadline>`
   (`--until 08:00`: it works out the hours), or `--hours 10` without one
   (plus any `--model`/`--effort` the owner asked for). The morning stop is "last
   call at T-30, stop at T": half an hour before the deadline (the project's
   `last_call`, plus the CI still to run and its wrap-up) the lanes stop
   taking units that would make CI run again (those of a group with CI on
   that machine, or on its data, and those using what CI needs), let the ones
   in flight land, and run CI for every group whose CI is stale, so the owner wakes up to them
   drilled and published. CI gets the resources it needs then: a CI run
   takes every resource its steps use as it starts and goes first at a
   resource, a session using one is told in its prompt when it goes to CI,
   and one still holding it at last call is told to wrap up and ended 15
   minutes later (`last_call_grace`). A stop the owner names later ("pause at 9") is
   `just fleet stop-at 09:00`, which gets the same last call. With more than
   one machine in `docs/machines.md`, tell the owner in one line: "Starting on
   <this machine>. Want <the others> too?" Don't wait for the answer. Nothing
   runs on a machine the owner hasn't included; on a yes, `just fleet start
   <machine> --until <the deadline>`.
3. **Wait.** Run `just fleet wait --as <your ID>` as a **background**
   command: the Bash tool with `run_in_background: true` and `timeout:
   7200000`. The timeout has to be longer than the wait, which lasts up to
   55 minutes: a shorter one kills the wait before it wakes you. You're
   woken when it returns: after 30 minutes while anything is at stake (a
   question waiting, a lane waiting, a machine unreachable or short of
   memory, a stop time within the hour), after 55 when nothing is, or as
   soon as something happens. (55, not 60: your prompt cache lives an
   hour, so a wake inside it finds your context still cached, and a later
   one pays to read it all again.) It always exits 0, and its last lines say why
   it woke, then the heartbeat, so the notice that it finished is enough to
   read: no need to open its output file unless it says to look above. Only
   one wait per overseer runs: a second is refused (exit 2, naming the
   first's pid); never start one with `&` or alongside another. Post the
   heartbeat line.
   Note what you decide, what you tell the owner and what you're waiting for
   as you go (`just fleet note --as <your ID> "…"`): it's what the next
   overseer catches up from if this thread dies.
   - **"woke: replaced by another overseer"**: a newer thread oversees the
     factory now. Tell the owner in one line ("Another thread has taken over
     overseeing; I've stopped"), and stop: no more waits, no more changes.
   - **"woke: time"**: glance at `just runs 5` (the same unit three
     times running? a cost spike?), `just log --since 1h` and each busy
     lane's "transcript written … ago" in the heartbeat (half an hour or
     more without a write: look at `just fleet state <machine>`), then wait
     again.
   - **"woke: news"** (wake-now events, listed under "for the owner:"): a new
     question or gate, a unit gone stuck, a first publish, CI broken, a
     machine idle 30 minutes, a usage pause or resume, an out-of-memory kill
     (below), a machine short of memory (`oom`, `memory-low`). Handle each as above, telling the owner what they must hear, then
     wait again. A line "(N more for the morning summary)" is not news: leave
     those for the report.
   - **"woke: a lane stopped"** (named under "stopped:", after the lane's
     last lines from this run): go to step 4, after any news that came with
     it. It's checked with the service manager before it's raised, so it's
     a real stop.
   - **"unreachable"** (ssh couldn't reach a machine): its lanes may well be
     running. Say nothing unless it lasts 30 minutes; then tell the owner.
   - **Something due at a set time** ("check at 5 am", "pause at 7"): note
     the time and do it on the first wake-up after it; they come at least
     every 55 minutes (30 within the hour of a lane's stop time). Never set
     a `sleep` timer for it: background commands
     are stopped after 2 hours, so a long one dies silently before it fires.
4. **Decide** from that lane's last log line (`just fleet state <machine>`):
   - **Out of time, "last call is over", "paused at a good point", "paused
     asap":** that lane is done; if every lane is, steps 5 and 6. A stop
     reason ending "CI not passed: …" names groups whose CI didn't pass
     (broken, known failing, or not run before the stop time): they go in the report, not
     silently.
   - **"ran its --max":** restart it (`just fleet start <machine>`); `just
     fleet start` sets a high `--max`, so this only follows a low one.
   - **Only the owner's questions and gates are left:** post them
     (`just questions`), with a push notification if you can. When the owner
     answers, record it and `just fleet start <machine>` again.
   - **Nothing left that can move:** read why (`just status`). A unit stuck on
     something that has since changed: `just reopen` it with a note and
     restart. Otherwise, steps 5 and 6. (A lane with work moving elsewhere waits;
     it doesn't stop.)
   - **Two iterations recorded nothing:** a unit sessions can't settle. Have
     a subagent summarise the two transcripts, then `just ask` the owner about it
     (options and a default) with `--blocks` that unit, and restart.
   - **A session failed:** read the end of its `.err`. If it's transient
     (network, API error, a killed child), restart. If it's a repeat, find
     the cause before you decide (a subagent's summary of the transcript).
     A session killed over its memory cap doesn't stop the lane (below).
   - **The tracker's data is broken, or "tracker error":** read `just lint
     --broken` and `just next`, fix what you can with the tracker CLI, then
     restart. A slip in someone's
     note doesn't stop a lane; fix it quietly when you see it.
   - **"main is red"** (a `main-broken` event came with it), or the same
     landing failure on two lanes in a row: main's own check fails on a
     clean checkout of main, so no lane's work can land, and every unit
     worked meanwhile only piles up waiting. The lane that found it already
     stopped taking units, with its finished branch pushed. Never file a
     unit for main and leave the lanes running:
     1. tell the owner now, in one line: what fails (the event's reason,
        `runs/main-check.log` in that lane's clone) and that the lanes are
        coming down;
     2. stop the other lanes with `just fleet pause` on every machine: each
        finishes and pushes the unit it's on, then stops (a finished one
        waits on its branch). `just fleet stop` only if a lane must come
        down now; what it cuts off is saved to its branch at the next start;
     3. fix main yourself if it's small (a commit on main, pushed), or start
        an interactive thread to fix it, and tell the owner which;
     4. check that `just check` passes on a clean checkout of origin's main,
        then `just fleet start` the lanes again. Each checks main again as
        it starts, and its waiting branch lands at its first look. A lane
        started before main passes stops again (at once if a branch of its
        waits, else after its first unit), so a restart for this doesn't
        count toward the 3.
     A `main-broken` event that says FACTORY_BUSY_GROUPS may be why: run
     `just check` on a clean checkout of origin's main first. If it passes,
     main isn't red, but the project's check fails on other units' outputs
     in the shared work/, so lanes sharing a machine stop each other again
     after a unit or so. Treat fixing the check as fixing main (3. above):
     tell the owner it must skip the busy groups (docs/factory.md, the
     oracle), and until it does, start one lane per machine.
     Last call isn't cut short by a red main: it runs to its end, and what
     couldn't land waits on its branch, for the report.
   - **Anything the spec doesn't cover:** tell the owner, and leave that lane down.
5. **Tidy up**, when every lane is stopped for good. The last lane to stop
   on a machine tidies it itself (copies its leases back, runs the project's
   `factory/tidy`: the editor, a headless desktop), records that on main and
   only then lets the machine sleep. So read the record first, not the
   machine, which may be asleep: `just log --since <start> | grep "the last
   lane stopped"` gives a line per machine (one each time its last lane stopped), "<machine>: the last lane
   stopped and tidied up". A machine with that line since its lanes last
   stopped is done; one that says "except: …" goes in the report with
   what failed. Run `just fleet tidy <machine>` only for a machine with no
   such line (a lane killed outright, as `just fleet stop` may do to a slow tidy, or one that couldn't push): it stops
   sessions and long jobs left behind and runs `factory/tidy`. A machine it
   can't reach then goes in the report.
6. **Report**, in plain words, the bad news first. Most owners read only
   the top of a report, so it opens with what's wrong; if nothing is, its
   first line says so ("Nothing went wrong this run"). Say each problem
   plainly, as it is: never "mostly fine", "a few small issues", or good
   news ahead of it. `just fleet summary` prints its problems first ("What
   went wrong"), so read it before you write. For each failure, say what
   happened next as its `unit:` line says; if it says nothing (or
   "unknown"), say you don't know.
   - What's wrong, first:
     - what broke: units stuck or blocked, a red main, branches that
       wouldn't land, units landed without the review, and CI that failed
       (with what failed), was cut off (where, and why), or never started.
       Say each group with CI, so a night where CI didn't run never reads
       as no news;
     - what's looping: the same failure again and again (a CI step, a
       unit reopened and stuck again, a lane restarted for one cause);
     - out-of-memory kills (`oom-kill` events, `just fleet events 200 |
       grep oom-kill`, and the `oom` and `memory-low` lines in your
       journal, `grep -E "oom|memory-low" runs/oversee.log`): which jobs,
       and the cap, or "none" (below);
     - what ran far slower or cost far more than last time (a unit kind
       taking twice as long, lanes that sat idle, a usage pause that ate
       the night), with the numbers;
     - what's waiting on the owner: the questions and gates (`just
       questions`), and what `just next` would do once they answer.
   - Then what got done: `just fleet summary --done` for the count, never
     a count of your own; `just log --since <start>` for what; and the CI
     that passed and published (the end of `just fleet summary`);
   - the rest of the morning summary (`just fleet summary`, "The rest"):
     republishes, set-asides and the like, a line per kind;
   - what you changed and why, and the quiet log in one line;
   - the decisions taken off the cards without asking: run `just tracker
     prune --apply-unasked` (a lane's own decisions whose day, night or run
     has ended; never the owner's words) and list what it says;
   - the check-in offer, if `just fleet summary` ends with one ("Check-in
     due"): one line, "would you like to check in?", and the number of
     decisions to prune. It's an offer, never a stop: the factory carries on
     if they don't take it. If they say not now, run `just tracker prune
     --checked-in`, so it's offered again only after the next few days of
     runs, or when a card grows.
   Send it as a push notification too, if you can, its first line the
   worst news.

## The owner's commands, per machine

Say which one you're doing and how long it will take. Without a machine
named, ask which, unless there's one machine or they clearly mean all of
them.

| The owner says | You run | What happens | How long |
|---|---|---|---|
| "find a good pausing spot soon" | `just fleet pause <machine>` | each lane finishes its unit, commits, stops; group data goes back to the store and the machine's leases are released (a unit whose branch waits to land keeps its data, and the lease, there until it lands) | up to the length of the running unit |
| "pause asap" | `just fleet pause-now <machine>` | running sessions are ended now; their units show as interrupted, with their work committed to their branches and pushed, so either machine carries on from it (their data outputs aren't copied back: the next session rebuilds them from the branch); leases are released; the lanes stop | a few minutes |
| "stop now" | `just fleet stop <machine>` | lanes, sessions and long jobs are killed and the machine is tidied; only what's committed or on disk survives (the lane saves its unit's work to its branch when it next starts). Leases whose last finished unit's data is on the store are released; the cut-short unit's data isn't copied back | seconds |
| "wrap up and publish" | `just fleet last-call <machine>` | last call now: no new units; the ones in flight finish and land (one holding a resource CI needs, like the editor, is told to wrap up and is ended after `last_call_grace` minutes, 15 by default), CI runs for every group whose CI is stale, then the lanes stop | the running units (at most the grace, for those), plus CI |
| "tell the lane on X to …" | `just fleet tell <unit id> "…"` (or `<machine>[/<lane>]`) | the running session reads it after its next tool call, and it outranks its plan; a note or a scoped decision gets there by itself | a minute or two |
| "stop at 9" | `just fleet stop-at 09:00 <machine>` | the lanes stop at 9 (or at their `--hours`, if sooner), with last call half an hour before (plus the CI still to run) | until then |
| "pick up the fix" (a fix to the skill is pushed) | `just fleet restart <machine>` (`--lane N` for one) | the newest pushed skill is deployed there; each running lane restarts on it when its own unit ends, or at once if it's waiting, without waiting for the others; nothing stops, and the stop time and leases carry on | the length of each lane's running unit |
| "add / resume <machine>" | `just fleet start <machine> --until <the deadline>` | starts its lanes | a minute |
| "N lanes on <machine> tonight" | `just fleet start <machine> --lanes N --until <the deadline>` | starts that many lanes for this run; `docs/machines.md` keeps its count, and a later start there without `--lanes` goes back to it | a minute |

After "find a good pausing spot", "pause asap" or "wrap up and publish",
once the lanes have stopped, check that machine's tidy record as in step 5.

## Pruning decisions: the check-in

Decisions only pile up: a card that carries eighty of them costs every
session that reads it, and the stale ones mislead (one said for a night
reads as a standing rule). When the owner takes the check-in offer, or says
"prune decisions":

1. Run `just tracker prune --propose`. It lists the decisions whose words
   show they lapsed (said for a day, a night, a run, a last call that has
   ended), were superseded by a later call on the same units, or are scoped
   to every unit but are about a few groups. Each entry says what the
   decision says, what the pass proposes and why, and the command that
   applies it. It changes nothing.
2. Read the rest yourself (`just decisions`, newest first; `just decisions
   --for <id>` for one unit's) for what words can't show: implementation
   calls the code and its tests now hold (name the file or test: `--in-code
   "<file or test>"`), ones that repeat another (`--merge-into <d>`), and
   ones scoped to a group or a glob whose units they don't bear on
   (`--narrow <selector>,…`; the pass only narrows those scoped to every unit).
   Check the file or test exists before you propose it, and leave out any
   the owner kept for that before (`[kept: …]` in `just decisions`). Add
   those to the list in the same form. Taste calls (the goal, the bar the oracle holds work to,
   what risks are fine) are never "in the code": leave them for the owner.
3. Give the owner the list, in plain words, one entry at a time or all at
   once, as they prefer: what the decision says, what you propose and why.
   For each: keep (`just tracker prune --keep <d> <kind>`, as the entry
   says, so it isn't proposed for that again), apply, or edit (a different
   scope, a different date).
4. Apply what they approve with the entry's command (`just tracker prune
   --apply <d> …`, run as `FACTORY_ACTOR=oversee`). Each goes through the
   tracker's own writes: a lapse sets its until, a narrower scope is a new
   decision that replaces it, the rest are retired with what holds them now.
   All of them stay in `just decisions --all`, marked, and `just tracker
   prune --restore <d>` puts one back. Then run `just tracker prune
   --checked-in`.

Never apply one the owner hasn't approved, except a lane's own decision
that only lapsed (`--apply-unasked`, in the end-of-run report). "Not now"
from the owner is an answer: `--checked-in`, and carry on.

## Group data, for when something looks odd

With a store (`tracker/project.json` "store"), a group's big files move by
lease: `just tracker leases` says which machine has which, `just store
status` what each machine has cached. All quiet, logged only: leases taken,
copied, released, old groups deleted to make room, and `store-aside-old`
(a copy down over a copy nobody worked on, unstamped or changed, that only replaced
files with newer ones from the store: older copies only, deleted at once).
A `store-aside` set comes with a unit that sorts it, pinned to that
machine, in the group `aside` (no gates, no parks: don't give it needs or
park it); it's lane work, not the owner's, and never a question for them. For the end-of-run report,
`just store aside` on each machine lists what's still set aside and the
unit sorting each. Tell the owner about:
- `lost-lease`, `lease-kept`, `store-up` or `store-down` events (data that
  didn't reach the store, or a lease that moved under a running lane), with
  what happens next. A failed copy back is tried again at each look; a
  `store-up-retried` event says it went through, and settles it;
- `store-empty` (a machine's empty copy wasn't copied back over the store's
  files: data put on the store by hand without a copy down there) and
  `store-moved` (a machine owed a copy back, but the store moved on after its
  lease lapsed: its copy is set aside at its next copy down, with a unit);
- `store-aside-unfiled` (a set got no unit: the tracker refused it; the
  next idle look tries again, and `just store aside` on that machine shows
  whether it did): tell the owner if the reason won't go away by itself. Also a
  sorting unit that goes stuck,
  and `store-torn` (a group on the store is a copy back
  that never finished; its last good state is in the store's snapshots, if
  it keeps any);
- a machine whose lanes only wait because its cache has no room for a new
  lease (its idle line says so);
- a lease held by a machine that's gone for good: only the owner decides to
  `just tracker lease release <group> --force`, which loses that machine's
  data since its last copy back (unless the store's snapshots have it).

## Out-of-memory kills

A job over its memory cap (`just capped`, a long job: its `FACTORY_MEM`
or `--mem` if set, else its past peaks plus 20% or 8G, whichever is more)
is killed by the kernel. The session sees only a failed step; the
command's output says "killed: out of memory at <cap>", and an `oom-kill`
event names the job, the cap and its peak. A job killed because the whole
machine ran out says that instead: then look at what held the machine's
memory budget (`just heavy` on that machine) rather than raising the job's
cap. `just heavy why <name>` says afterwards how any job ended.

A whole session over its cap (`--mem`, 10G unless set) is killed with
everything in it. The lane doesn't stop: it writes what used the memory at
its last look before the kill (pid, RSS and full command line of the
biggest processes) to the session's `.err`, puts the biggest in a note on
the unit, raises an `oom-kill` event with them, and goes on with the unit
interrupted. A second kill on that unit by the same kind of process (the
note's `[oom: …]`), or a third of any kind, since it was last reopened,
blocks it, and a `stuck` event follows. So `just reopen` with a way round
starts the count again.

What used the memory is often not the step you'd guess (a throwaway script
in /tmp expanding a file as text, not the import everyone suspects). So
**read the snapshot before you block or reopen anything**: the event, the
note (`just show <id>`), and the `.err` on that lane's machine for the full
list. Then `just reopen <id> --note "…"` with the way round it (split the
step, run it alone, a lower-memory route), or tell the owner when only they
can choose (a bigger cap, a smaller job); never a guess at the cause.

These events are the only record the loop keeps of such kills, so read them
(`just fleet events 200 | grep oom-kill`) whenever the owner asks whether the run
was stable, and never say there were none without looking. One kill goes in
the end-of-run report. Two for the same step (the same command, on any
machine) mean the cap is too low for it or the job needs splitting: tell
the owner then, with the step, the cap and the peaks, and check whether the unit
recorded the kill as a pipeline failure (`just show <id>`); it isn't one, so
fix its note.

## Branches, for when something looks odd

Each unit is worked on its own branch, `unit/<id>`, in the lane's clone. The
tracker isn't on those branches: claims, notes, questions and done go straight
to main. A unit that's done but whose branch isn't on main yet shows as
"merging", and what needs it waits. The lane merges it within a minute or two;
one that stays merging means the lane stopped first, and another lane on that
machine (where its outputs in work/ are) lands it at its next look. A branch the lane couldn't merge becomes a "Merge main on
<machine> lane <n>" unit that only that lane takes (other work meanwhile, while
it waits); that's routine, not news, unless its session asks the owner.

A `factory-edits` event means a session changed the loop's scripts and the
loop dropped those edits; the event says which commits hold them. That's a
line in the end-of-run report for the owner (a fix for the skill, perhaps), not a
ping, and never something to put back by hand.

## The usage pause

The lanes watch the plan's usage themselves (`factory/usage.sh`, from the
`rate_limit_event` lines in their transcripts), and pause between units for
either of two reasons. The event says which, and when the lanes are back.

- **The 5-hour window:** with under 8% of it left (the profile's "pause
  below"), every lane pauses and resumes when the window resets.
- **The week's line:** the lanes may have used the share of the week that
  has gone by, less the share kept back for the owner (the profile's "keep
  back", 15% by default). Ahead of that line, every lane pauses until the
  line reaches what's used, a time worked out when it pauses, so it resumes
  with no new reading. With more used than the lanes may use at all (85%,
  with 15 kept back), that's the week's reset. `just usage` shows it: "week
  62% used, the line is at 58%: lanes pause until Thu 14:00".

Each pause and resume shows up in `just fleet wait` as news. Tell the owner
one line at each pause ("Usage: lanes paused at 92% of the 5-hour window;
back at 14:00", "Usage: the week is at 62% with its line at 58%; lanes back
Thu 14:00") and one at each resume. Readings come in whole percents of the
week, so lanes that work faster than the line pause each time the reading
passes it, for as long as the line takes to reach it (up to about 2 hours a
percent, with 15 kept back): that's the pacing working, not a fault. A
paused lane looks at the reading again each minute: a newer one with more
used moves its time (a new pause event, with no resume in between), and one
that no longer has it ahead resumes it.

The reading is one per machine: every factory's lanes there write the newest
they see to the machine's wfactory state folder and act on the newest in it,
so lanes here may pause on what another factory's lanes read (`just usage`
says whose). The owner's own interactive sessions leave no reading; what
they use shows at the next session's. Don't work around a week pause
(pausing and starting the lanes changes nothing: they check as they start).
The share kept back is the owner's setting, in their profile: if they want
the lanes to have more of the week, they change "keep back" (0 keeps nothing
back, `off` stops the pacing), and the lanes act on it within a minute.
