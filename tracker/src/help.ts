// What the tracker prints for --help: USAGE for the tracker as a whole, HELP for one command.
// Every command has an entry (tracker/test/cli.test.ts checks).

export const USAGE = `tracker — the factory tracker (v2). One shared copy, in the wfactory
skill; each factory repo calls it through \`factory/tracker\` and its just
recipes. Design: docs/design.md.

State lives in the repo's tracker/ folder as JSON, written only by this CLI:
  tracker/project.json        name, resources, loops, schema version
  tracker/groups/<group>.json a group and its units
  tracker/templates/<t>.json  unit templates ("add lexer" makes its units)
  tracker/questions.json      questions for the owner, open and answered
  tracker/decisions.json      the owner's answers and agents' judgement calls
  tracker/leases.json         which machine leases which group's data, and each machine's heartbeat
  tracker/log.jsonl           one line per write (merge=union)
  .tracker/                   gitignored: probe cache, view.html, lock, and
                              main/ (below)

The state is main's, not this checkout's. When the repo has an \`origin\`,
every command reads tracker/ from a small clone of origin's main kept in
.tracker/main/ (fetched when it's over FACTORY_FETCH_EVERY seconds old,
default 20), and every write is committed there and pushed to origin's main
at once. If someone else pushed first, the write is dropped and done again
on the new state; for a claim that means picking again. So a unit's branch
never carries tracker/ changes, and a question reaches the overseer within
seconds. Without an origin (or with FACTORY_STATE=local) tracker/ in this
checkout is the state, as before. A fetch or push that gets no answer
gives up after FACTORY_GIT_TIMEOUT seconds (default 180; ssh itself gives up
on a dead connection in about a minute) and counts as origin unreachable.
On a public origin, "private_words" in project.json names files of words a
write must not add (the first that exists; ~ and $VAR expand). A write that
adds one is refused, and with no such file on the machine every write is.

Commands take .tracker/lock while they read or write. One that waits over
FACTORY_LOCK_WAIT seconds (default 30) for another command to let it go
exits 75: nothing is wrong with the data, so try again.

Everything it prints names a thing by its title first, ID in parentheses.
Text fields refer to units as {unit:<id>} (also {q:<id>}, {d:<id>}) and are
expanded to titles when shown, so a bare ID never reaches the owner.

Usage: tracker <command> [args]   (just <command> in a factory repo)

For agents:
  next [--claim] [--group G] [--skip-uses r,…] [--json]   the unit to work, with its context
  claim <id>                            claim a unit you were told to work
  queue [-n N] [--json]                 what each machine's lanes take next, and why
  show <id> [--full|--why-all] [--json] a unit, group, question or decision
  find <words> [--open] [-n N]          units by words in their title or detail, best first
  status [<group> | --all]              counts; a few lines at any scale
  questions [--all]                     what's waiting on the owner
  check <id> (just recheck <id>) | refresh [--group G] [--all] [--due]   run probes (computed units)
  done <id> --evidence "…" [--checker <tag>] [--dry-run]
  review <id> --evidence "…" [--dry-run]   hand to a second checker
  block <id> (--on q/<slug> | --why "…")
  reopen <id> [--note "…"]              back to ready
  drop <id> --why "…"
  park <id | selector> --why "…"        the owner set it aside: not offered, not waited on
  unpark <id | selector>                back to ready (also lifts the owner's "later" on it)
  note <id> "…" [--dry-run]             for the next attempt (keeps 3)
  ask --title "…?" --context "…" --option "a | label | what it changes" …
      --default a --blocks <selector> … [--scope <selector> …] [--force]
      an option may end "| drops: <selector>, …" and "| releases: <selector>, …";
      then it must say which of the two happens to every unit the question blocks;
      --parks <key>: that option puts the work off ("not yet"): answered so, what it blocks is parked
  answer <q> <key> [--note "…"] [--via <thread>] [--until T | --for-run]   record the owner's answer
  withdraw <q> --why "…"                close a question nobody needs answered
      (re-asked as another, or moot); no decision is recorded
  pass <gate> [--note "…"] [--force]    the owner says a gate is fine
  decide --title "…" --why "…" --scope <selector> … [--replaces d/<slug>] [--by owner] [--until T | --for-run] [--park]
  decisions [words…] [--for <id>] [--all]
  prune [--propose] [--json] | --apply <d> … | --keep <d> <kind> | --due | --apply-unasked | --restore <d> | --checked-in
                                        decisions to take off the cards: proposed, applied once approved
  ci [<group>] [--json] [--since T]     each group's CI: passed, stale, due, running, broken, off;
                                        --since: what became of it since T (passed, failed, cut off, never started)
  ci-start <group> [--force] | ci-pass <group> --evidence "…" | ci-fail <group> --evidence "…"
  ci-retry <group>                      try broken CI again now
  ci-touch <group> --why "…" [--commit C]   work outside the group changed its build: CI stale
  ci-affected [--json] | <new> --touches F   the loop's ci.affected hook: what it covered; record a range
  ci-land <id> [--json]                 the checks the loop runs before a unit lands (ci.land), or why none
  ci-split <group>                      take a group out of another group's shared ci-fix
  ci-next [--claim] [--json] [--group G] the due CI this lane runs before any unit (the loop)
  ci-unclaim <group> [--release-lease] [--cut "…" --step S]  give back CI the loop claimed and couldn't start or finish
  publish [on|off]                      whether CI runs the steps that ship
  log [--since 8h|2026-10-09] [--group G] [-n N]
Setting up:
  init [--title "…"]                    make tracker/ here
  add-group <group> --title "…" [--host H] [--priority N] [--needs id,…] [--ci step,…]
  edit-group <group> [--title "…"] [--host H|none] [--priority N] [--needs id,…] [--ci step,…|none]
  add <group> --template T [--title "…"] [--set k=v …]   a group from a template
  sync <group>                          add units a template now makes
  add-unit <group>/<slug> --title "…" [unit flags]
  edit <id> [unit flags]                unit flags: --title --detail --check
      computed|independent|recorded --probe-cmd "…" --probe-file F [--probe-json E]
      --inputs glob,… --needs id,… --uses r,… --tags t,… --model M --host H
      --priority N --min-minutes N|none; edit only: --add-needs id,… (adds to --needs' list)
  rename <id> <new-id>                  updates every reference
  lint [--broken] | view | where <loop> | settle <id> (loop.sh, after a session)
  merged <id>… | --branch B             loop.sh: the unit's branch is on main now
  review-fix <branch> --findings "…"    loop.sh: its review asked for fixes; back to ready (stuck the 2nd time)
  land-fail <branch> --evidence "…"    loop.sh: its check before landing failed; back to ready (stuck the 3rd time)
  unclaim <id> [--unstarted]            give back this session's claim (its work kept, if it did any)
  lanes-stopped [--failed "…"]          loop.sh: this machine's last lane stopped and tidied up
  held-at <host> <time> [--json]        the units whose sessions on host were open then (fleet summary)
  overseer [take <id>]                  which thread oversees the factory (fleet attach)
  leases | lease holder|mine|idle|beat|take|release   group data leases
  data <group> | --unit <id> | --all    where a group's data lives (factory/store.sh)
  rebuilt [add <glob> --why "…"]        files a pipeline step rebuilds: a copy down doesn't keep them
  state <id> [--branch|--by|--host]     one unit's status key, for scripts
  aside-set <id> <set> | --clear        store.sh: where its unfinished outputs were set aside
  busy [--except <id>] [--live]         groups with outputs here not on main yet (checks skip them)
  dir                                   where the state's tracker/ folder is
  memory [--check]                      rebuild memory/MEMORY.md from the memory files
  merge-json <base> <ours> <theirs> <path>   git's merge driver for tracker JSON

\`<command> --help\` explains one command.

Text is checked when it's written: a title over 60 characters, a note over
280, or a unit named by a bare ID (not {unit:<id>}) is refused with the fix,
the reason on the last line. Evidence for done and review, and notes, are the
exception for bare IDs: they're written as {unit:<id>}, with a warning (not
inside \`code\`, and not a path like <id>.json). Evidence under 30
characters is refused. --dry-run on done, review and note checks without
recording.
\`lint\` reports those slips and broken data; \`lint --broken\` fails only on
broken data (what a loop refuses to start over) and lists slips as warnings.

Selectors (--blocks, --scope): a unit ID, a glob (\`*\` /string-escapes),
group:<g>, tag:<t>, template:<t>, or * for everything.

Status, derived each time (first match wins): dropped; done; broken again
(its check passed once and now fails); parked (the owner set it aside); waiting
on you (an open question or a gate); stuck (blocked with a reason);
merging (recorded done or in review, its branch not on main yet; counts as
not done for what needs it); in review; in progress / interrupted (a claim
whose session is gone); waiting on other work (needs); waiting on a
resource; ready.

\`next\` order: this session's own unit in progress, then by priority (the
higher of a unit's own and its group's). At equal priority, interrupted,
broken and review units (not your own) come first, then units whose data
this machine already leases, then group priority, group
order, unit priority, unit order. \`queue\` shows it per machine. Exit 0 =
found, 1 = nothing workable here, 3 = nothing can move until the owner answers,
2 = usage or data error. With exit 1, \`--json\` says \`"wait": true\` when
other work is still moving (in progress elsewhere, waiting on a resource,
ready for another machine), so a loop should look again later rather than
stop.

Environment: FACTORY_TAG (session tag; else $CLAUDE_CODE_SESSION_ID's first
8, else "manual"), FACTORY_SESSION (full session ID, for resume),
FACTORY_ACTOR (loop | oversee | session | owner), FACTORY_HOST (else the
hostname), FACTORY_HOST_ONLY=1 (take only units whose host is this one, so a
second machine leaves unpinned units to the first), FACTORY_PID (the process a
claim lives with; else the nearest \`claude\` ancestor), LOOP (one loop of
several in project.json), FACTORY_LOCKS (a folder of lock files shared by
the lanes on one machine: a held \`unit-<id>.lock\` means another lane has
that unit, a held \`res-<name>.lock\` means a resource is in use; loop.sh
takes them), FACTORY_BRANCHES=1 (loop.sh: claims record the unit's branch,
unit/<id>), FACTORY_LANE (this lane, <host>/<n>: a unit with a \`lane\` is
offered to that lane only), FACTORY_STATE=local, FACTORY_MAIN (main's
name, default main), FACTORY_CAPS (what this machine can do, comma-separated:
a unit with caps it lacks isn't offered), FACTORY_LEASES=1 (loop.sh: a claim
may take a new lease on its group's data), FACTORY_NO_NEW_LEASE=1 (no room
for one), FACTORY_LEASE_STALE / FACTORY_LEASE_BEAT (seconds), FACTORY_STORE
(the store, overriding project.json's), FACTORY_LAST_CALL=1 (loop.sh, in the
last call before its stop time: no unit of a group whose CI runs here starts,
so only its work in flight is left tonight, and CI comes due for every group
whose CI is stale).`;

// `<command> --help`: one command's usage.
// What add-unit and edit print first: lanes grepped their flags out of --help (2026-10-23).
const UNIT_EXAMPLES = `Examples:
  just tracker add-unit parser/dates --title "Parse ISO dates" --detail "…" --needs parser/lexer --uses editor
  just tracker edit parser/dates --add-needs parser/tz     (one more unit it needs first; --needs replaces them)
  just tracker edit parser/dates --detail "…"              (--title, --uses, --priority the same way)`;
const UNIT_FLAGS = `Unit flags: --title "…" (60 characters at most) --detail "…" --check computed|independent|recorded
  --probe-cmd "…" | --probe-file F [--probe-json E]  (setting a probe makes the unit computed)
  --inputs glob,… --needs id,… --uses resource,… --tags t,… --model M|none --host H|none --priority N
  --min-minutes N|none (the least time a session of it needs: \`next --last-call-in\`)
  --caps c,…|none (only a machine that can do all of these takes it: docs/machines.md "Can")
  --data <group>|none|default (whose data it works on; default: its own group's, if that has data)
  --reads input:part,…|none|default (the read-only inputs it needs copied down; default: store.reads)`;
export const HELP: Record<string, string> = {
  next: `next [--claim] [--group G] [--skip-uses resource,…] [--skip-groups group,…] [--skip-units id,…] [--time-left S]
  [--last-call-in S --last-call-groups group,… --last-call-uses resource,…] [--json]
The unit to work now, with its card. --claim claims it for this session.
--skip-uses: take no unit that uses any of these resources, not even an interrupted one (the
loop keeps them free for CI); such units count as work still moving.
--skip-groups: take no unit of these groups, nor one working on their data (in last call, the
loop holds back the groups whose CI runs here tonight: landing one would make that CI run
again). Such units count as moving only while their group's CI (or their data's) is running,
due or stale.
--skip-units: take none of these units (the loop: ones its sessions gave back unstarted this run).
--time-left: S seconds are left before the lane's stop; take no unit whose usual session is
longer: the unit's --min-minutes, else the median of its own latest sessions in the log, else
of its template's units', else of the units using the same resources (a session that gave its
unit back unstarted doesn't count).
Neither counts as moving; with --json, "late" counts the units --time-left passed over.
--last-call-in: S seconds are left before the lane's last call, which will hold back units of
--last-call-groups (or on their data) and units using --last-call-uses; take none of those whose
least time is longer: the unit's --min-minutes, else its usual session as above, else
tracker/project.json "min_unit_minutes" (default 45). They count as moving (last call comes, and
the lane goes on from there); with --json, "lc_late" counts them and "lc_why" says so.
A new unit of a group whose CI is due (\`ci\`) waits for that CI, and counts as moving too.
A check unit (tracker/project.json checks.units, selectors; default tag:check) waits for the open
fixes of its group that name it, or that its detail names. With checks.ready (a command, {unit} and
{group} filled), a check goes out only once it exits 0: otherwise the check waits on the units its
"needs <id>" lines name, filed first by a "file <group>/<slug> <title>" line (and a "detail …"
line after it), or, naming none, is stuck with its last line as the reason. Exit 75: it couldn't
tell here, and the check goes out as before.
Exit 0 = a unit; 1 = nothing workable here (with --json, "wait": true means other
work is still moving, so look again later); 3 = nothing can move until the owner answers.`,
  queue: `queue [-n N] [--json]
What each machine in docs/machines.md takes next, best first (N each, default 3), and why: the
priority it ranks by, a state that brings it back first, and where its data is. It's what \`next\`
offers there now, as the loop sees it (new leases allowed), after any due CI a lane there runs
first; a unit two machines list goes to the
first lane to ask. Other machines' lane locks and resources can't be seen from here, so they're
taken as free.`,
  claim: `claim <id>
Claim a unit you were told to work (next --claim picks and claims in one go). A check whose
checks.ready hook says it can't be judged yet isn't claimed (exit 1): it waits on what the hook named. With FACTORY_BRANCHES, a
unit claimed by a session that already holds one goes on that one's branch, the branch it's working on,
and lands with it.`,
  show: `show <id | group | q/<slug> | d/<slug>> [--full | --why-all] [--json]
A unit's card, a group's units, a question with its options, or a decision. Notes from
earlier attempts come right after what done means.
A card names the decisions that apply by title, this unit's own first, and some of those for
every unit; --full adds who made this unit's own, when, and why, and lists every decision for
every unit (by title: \`just decisions <words>\` gives one's why); --why-all gives those whys too.
--json (a unit): its status, notes and the decisions that apply, as JSON.`,
  find: `find <words> [--open] [-n N]
Units whose ID, title or detail has these words, best match first (title and ID count most), with
their status. --open: leave out done and dropped units. -n: how many (default 20).
Use it before guessing an ID, and before add-unit, in case the work is already filed.`,
  status: `status [<group> | all | --all]
Counts, what's waiting on the owner, what's next. With loops, \`status <loop>\` or LOOP=<loop>.`,
  questions: `questions [--all]
Questions and gates waiting on the owner, each option with what it changes. --all includes answered ones.`,
  check: `check <id>   (just recheck <id>)
Run a computed unit's probe now and record the result.`,
  refresh: `refresh [--group G] [--all] [--due]
Rerun the probes whose inputs changed (--all: every probe). --due: print the commands
it would run now, as JSON ({"due": […]}), running and recording nothing.`,
  done: `done <id> --evidence "…" [--checker <tag>] [--dry-run]
Record a recorded or independent unit done. An independent unit needs --checker from a
context that didn't work it. Computed units are done when their probe passes.
Evidence says what shows it's done (a test that passed, a file, a log or screenshot
path), in 30 characters or more; a bare unit ID in it is written as {unit:<id>}.
--dry-run makes every check and shows what would be recorded, recording nothing.`,
  review: `review <id> --evidence "…" [--dry-run]
Hand a unit to a later session for its independent check. Evidence as for done.`,
  block: `block <id> --on q/<slug> | --why "…"
The unit waits on the owner's question, or is stuck on something else (say what).`,
  reopen: `reopen <id> [--note "…"]
Put a unit back to ready, clearing its record.`,
  drop: `drop <id> --why "…"
Drop a unit for good.`,
  park: `park <id | selector> --why "…"
The owner set this work aside: it isn't offered, isn't waited on, and isn't counted as
anything for the owner to do. Selectors: group:<g>, tag:<t>, a glob. Undo with unpark.`,
  unpark: `unpark <id | selector>
Bring parked units back to ready. A unit the owner put off (ask --parks) shows as parked while the
decision holds, even after a reopen; unpark is what brings it back.`,
  note: `note <id> "…" [--dry-run]
What the next attempt must know (280 characters at most, {unit:<id>} counting as the
ID; the last 3 are kept). Name units as {unit:<id>}; a bare ID is written so, with a
warning. --dry-run checks it and shows it, noting nothing.
A note (or evidence, or a detail) that waits on CI ("look after her CI rebuild") is refused when
neither the unit's group nor the group whose data it works on has CI: give the rebuild command.`,
  ask: `ask --title "…?" --context "…" --option "a | label | what it changes" --option "b | …"
    --default a --blocks <id or selector> … [--scope <selector> …] [--example "…"] [--id <slug>] [--parks <key>] [--force]
Ask the owner. Refused if a decision already answers it or a similar question is open.
--parks <key>: that option puts the work off ("not yet", "leave it for later"). Answered so, the
units waiting on the question are parked (with drops: or releases:, the ones it doesn't name), and
the decision is a postponement: while it holds, a unit the question was asked from or blocks, or
that its --scope names (not '*'), is never offered, even after a reopen, until \`unpark\`. Asking
again about a unit the owner put off is refused, --force or not.`,
  answer: `answer q/<slug> <key> [--note "…"] [--via <thread>] [--until T | --for-run]
Record the owner's answer as a decision and release the units it blocked (an option asked with
--parks parks them instead, and the decision remembers it put them off). Key "other" needs --note.
--until and --for-run: the answer holds until then, as for decide.`,
  withdraw: `withdraw q/<slug> --why "…"
Close a question nobody needs answered (re-asked as another, or moot). No decision is recorded.`,
  pass: `pass <gate> [--note "…"] [--force]
The owner says a gate is fine; what it held back goes on. A gate whose needs aren't all done
or dropped is refused, naming each; --force passes it anyway, with a warning naming them.`,
  decide: `decide --title "…" --why "…" --scope <selector> … [--replaces d/<slug>] [--by owner] [--until T | --for-run] [--park]
Record a judgement call. It shows on the card of each unit in its scope, and reaches a session
already working one (the loop's inbox). --scope is required: a unit ID, a glob, group:<g>,
tag:<t>, or '*' for every unit. With --replaces, the scope of what it replaces is the default.
--until: it holds until then, and then leaves the cards (\`decisions --all\` still lists it, as
lapsed). A date (2026-10-29: the end of that day), a date and time (2026-10-29T18:00), or a time
(18:00: the next time the clock reads it). Set it when the owner's words name a time: "today",
"tonight", "for now", "until X lands". --for-run: until the run's stop time (in a lane's session;
elsewhere, give the stop time as --until). --park: the units in its scope are parked while it
holds ("no uploads today"), and come back by themselves once it lapses, is replaced or retired;
a decision or pruning that ends one lists the units it frees.`,
  prune: `prune [--propose] [--json]
prune --apply <d> (--lapse [--until T] | --superseded-by <d> | --merge-into <d> | --in-code "<file or test>" | --narrow <selector>,…)
prune --keep <d> <lapse|superseded|merge|narrow|code>
prune --due [--json] | --apply-unasked | --restore <d> | --checked-in
Decisions only pile up; pruning takes the stale ones off the cards, with the owner's say-so.
--propose (the default) lists, in plain words, each decision in force that its words show
lapsed (it was for a day, a night or a run that has ended), superseded (a later call on the
same units, worded alike, that says it changes it), merged (it repeats an earlier one) or
scoped wider than it's about (scoped '*', and it names a few groups). Each entry ends with the
command that applies it. It changes nothing; --json gives the same as JSON. Ones the code and
its tests now hold, and most repeats, are for whoever reads the rest (\`decisions\`) to add.
--apply does one, once the owner approves: --lapse sets its until (by default, when its words
ended); --superseded-by, --merge-into and --in-code retire it; --narrow records it again on the
narrower scope, replacing it. Each leaves the cards and stays in \`decisions --all\`, marked.
--keep records that the owner kept one: the pass doesn't propose it for that again.
--due prints the check-in offer when one is due, and nothing otherwise: there is something for
the owner to prune, and either "checkin_days" days (default 3, in tracker/project.json) with a
run have passed since the last check-in, or an open unit's card carries more than "prune_at"
decisions (default 40) and more than it did at the last check-in. A lane's own decision that only lapsed is the overseer's to apply
without asking (--apply-unasked, which lists them for the report); --restore puts a lapsed or
retired one back. --checked-in records that the owner was offered the check-in, so the next
is offered "checkin_days" days on, or when a card grows.`,
  decisions: `decisions [words…] [--for <id>] [--all]
Search decisions, or list the ones that apply to a unit.`,
  log: `log [--since 8h|2026-10-09] [--group G] [-n N]
What happened, in plain words.`,
  init: `init [--title "…"]
Make tracker/ in this directory.`,
  "add-group": `add-group <group> --title "…" [--host H] [--priority N] [--needs id,…] [--data k=v,…] [--ci s,…]
A new group. Higher priority runs first; the output says what it runs before. --data: the group's
big files live on the store and move by lease; k=v are the values its data paths use (store.paths).
--ci drill,publish: the group's CI steps, each defined in project.json ci.steps (\`ci --help\`).`,
  "edit-group": `edit-group <group> [--title "…"] [--host H|none] [--priority N] [--needs id,…] [--data k=v,…|none] [--ci s,…|none]
Change a group. With --priority, says what its units now run before. --data adds or changes values.
--ci sets its CI steps (keeping its CI history); none turns CI off.`,
  unclaim: `unclaim <id> [--unstarted] [--release-lease]
Give back a unit this session claimed. A session that did work on it (commits on its branch since
the claim, files changed in its tree, its group's data written) or picked it up after an earlier
attempt hands it back with that work kept: its record keeps its branch and session, and once the
session has ended (the loop's settle) it shows by its needs and resources (waiting, ready), not as
interrupted; whoever claims it next picks up after it. Until then the claim holds, and so does its
lease: the loop pushes the branch and settles the unit's data first, as for any unfinished unit. A session that did nothing gives it back
unstarted. If git can't say what the session did, it refuses, and says to note and stop instead.
--unstarted: loop.sh, before the session (no room for its data): given back as claimed, an earlier
attempt's work keeping it interrupted. A lease the claim took is released with it; --release-lease
releases this machine's lease of the group even if an earlier claim took it (unless another claim
here is working on it). A claim to check a unit in review puts it back in review.`,
  data: `data <group> | --unit <id> | --all   (JSON, for factory/store.sh)
Where a group's data lives: the store (FACTORY_STORE, else project.json store.remote), each data path
filled with the group's values, its priority, and the input parts a unit reads. Paths are directories.
--all: every group with data, and store.rebuilt.`,
  rebuilt: `rebuilt [add <glob> --why "…"]
project.json store.rebuilt: files a pipeline step rebuilds, as globs over <name>/<path> of a group's data
paths (\`*\` crosses folders, e.g. "out/*.lua"). A copy down doesn't set aside a file one matches
(unless a session worked on the copy). add: one more, with why (logged); it must start with a data
path's name or a wildcard, and can't be wildcards alone. Written on main, like every tracker write.`,
  leases: `leases [--json]
Which machine leases which group's data, and how fresh each lease's heartbeat is.`,
  overseer: `overseer [--json] | overseer take <id> [--machine <name>] [--json]
Which thread oversees the factory: its id, its machine and since when ("none" before the first).
take: this thread is the overseer now (\`fleet attach\` does it); the one before it learns so at its
next \`fleet wait --as <its id>\`. The newest to take it wins.`,
  "held-at": `held-at <host> <time> [--json]
The units whose sessions on <host> were open at <time> (to the minute: any moment in it), from the
log: a claim, to the last line its session wrote about the unit (to now if it's still claimed).
\`fleet summary\` asks it to tie an event that names no unit to the session it happened in.`,
  "lanes-stopped": `lanes-stopped [--failed "…"]
loop.sh, as the last lane on this machine stops: log that it tidied up (copied its leases back and ran
factory/tidy), with --failed naming what didn't work, before it lets the machine sleep. The overseer
reads it in \`just log\` instead of reaching the machine.`,
  lease: `lease holder <group> | mine | idle | beat [--force] | take <group> | release <group>… | --all [--force] [--why "…"]
Group data leases (normally the loop's business). holder: the live holder's host, or nothing.
mine: this machine's live leases. idle: this machine's leases with nothing left for it (none in progress
here, none it could take now). beat: refresh this machine's heartbeats, its leases' and its own while
the loop has claims or CI running here (writes only if the last is older than FACTORY_LEASE_BEAT,
default 600 s), and end the loop's CI runs here whose process is gone. take: lease a group here.
release: give leases back; --force releases another machine's (only when that machine is gone: its data
since its last copy back is lost). A lease with no heartbeat for FACTORY_LEASE_STALE seconds (default
1800) can be taken over; so can the loop's claims and CI on a machine whose heartbeat is that old.`,
  "add-unit": `add-unit <group>/<slug> --title "…" [--after <id>] [--gate] [unit flags]
A new unit. It lists the open units most like it (as \`find\` ranks them by its title), and warns when
one may already be the same work: then drop the new one and add a note to that one instead.
--uses must name resources in tracker/project.json, or heavy: built in, the machine's heavy-job slots
(a unit that runs heavy jobs; no lane is handed one while every slot there is held).
${UNIT_EXAMPLES}
${UNIT_FLAGS}`,
  edit: `edit <id> [unit flags] [--add-needs id,…]
Change a unit. With --priority, says what it now runs before. --needs replaces what it needs;
--add-needs adds to it.
${UNIT_EXAMPLES}
${UNIT_FLAGS}`,
  rename: `rename <id> <new-id>
Rename a unit (or move it to another group); every reference follows.`,
  add: `add <group> --template T [--title "…"] [--host H] [--set k=v …]
A group made from tracker/templates/<T>.json.`,
  sync: `sync <group>
Add the units a group's template now makes (e.g. once a data file it reads exists).`,
  where: `where <loop>
Print a loop's spec file (loop.sh uses it).`,
  settle: `settle <id> [--pushed]
After a loop session: run a computed unit's check, and mark a claim the session left open as interrupted.
--pushed: the loop pushed the unit's branch, so whoever claims it next carries on from it. It runs
no check (the loop's settle after the session does).`,
  "aside-set": `aside-set <id> <set> [--commit C] [--by S] [--mixed] | aside-set <id> --clear
store.sh, when it puts the store's copy back over an unfinished unit's outputs: the set in
work/.store/aside/ they went to on this machine, the commit its branch was on (they were built from
it) and the session; the unit's card says so. --mixed: the set holds other work too, so it's never
put back. --clear: they're back in work/, or the set is gone.`,
  state: `state <id> [--branch | --by | --host]
Print one unit's status key (ready, doing, interrupted, merging, done, …), for scripts.
--branch: the branch its record names instead (empty if none). --by: the session its record names.
--host: the machine it's pinned to, its own or its group's (empty if any).`,
  merged: `merged <id>… | --branch <branch>
loop.sh, after merging a unit's branch into main and pushing: the unit stops showing as merging,
and what needs it can start.`,
  "review-fix": `review-fix <branch> --findings "…"
loop.sh, when its review of a finished branch asks for fixes before it lands: the units waiting to
merge on it go back to ready with the findings on their card (and a note saying so), and the next
claim carries the branch on. The second time for a unit, it's stuck for the overseer instead;
\`reopen\` gives it two more rounds. A merge unit on the branch is done with it.`,
  landing: `landing [claim <branch>]
The loop, landing finished branches: any lane on the machine a unit was worked on (its outputs in
work/ are there) may land it once it's waiting to merge, one lane at a time. The lane that worked it
holds its landing while that lane lives; once it's gone, another takes it.
No subcommand: the branches this lane could land now, a line each (branch, its first unit and its
title, by tabs): only those pushed since they were recorded finished, so origin's copy is the
finished one.
claim <branch>: the landing is this lane's ($FACTORY_PID), unless another live lane holds it, a merge
unit settles the branch, or it was worked on another machine (exit 1, saying which).`,
  busy: `busy [--except <id>]
Print the groups (space-separated) with a unit worked on this machine whose outputs aren't on main
yet (in progress, interrupted, or finished with its branch still to land) or whose CI runs here,
besides this session's own unit and --except's (and, asked from a CI step, its own run). Lanes on one machine share work/, so those groups'
outputs there may be half-written or not in git yet: a check that looks at work/ skips them. The
loop passes them to \`just check\` as FACTORY_BUSY_GROUPS.
--live: only the groups a session here is working on now (a claim whose session is alive: its
loop's pid and start time, and not ended) or whose CI runs here. A guard that refuses to write a
group's outputs while another lane writes them uses this: a claim whose session ended (interrupted,
or ended by last call) holds nothing.`,
  dir: `dir
Print where the state's tracker/ folder is: .tracker/main/tracker when the repo has an origin
(the state is origin's main), else ./tracker.`,
  memory: `memory [--check]
Rebuild memory/MEMORY.md from the memory files' frontmatter: title (else the name), hook (else the
description), open: true for the Open section. --check only says whether it's current (lint does too).`,
  "merge-json": `merge-json <base> <ours> <theirs> [<path>]
git's merge driver for tracker JSON (.gitattributes: tracker/**/*.json merge=tracker-json; the tracker
sets merge.tracker-json.driver in each clone it runs in). Keeps both sides' entries; the same field
changed two ways is a clash, named on stderr, and git reports a conflict.`,
  lint: `lint [--broken]
Fail on broken data and on slips (bare IDs, over-long titles or notes, half-written
questions, memory/AGENTS.md bloat). --broken fails only on broken data, which is what a
loop refuses to start over, and prints slips as warnings.`,
  ci: `ci [<group>] [--json] [--since T]
Each group's CI (a step that verifies or ships a group's finished work, e.g. a drill or a publish):
passed; stale (something changed since it passed, a step's command in tracker/project.json too,
and the group still has work tonight); due
(changed, and nothing in the group can move tonight without the owner, or it has been stale
"ci_every" minutes: tracker/project.json, default 120, 0 = only the first); running; broken (the
last run failed: it's tried again once main moves and 6 hours pass, at once when its ci-fix is done,
and like a change when another unit of the group is done); known failing (broken again on the
same step after its ci-fix was done: it holds nothing, files nothing, and comes due as broken does,
but not for that ci-fix; the next pass clears it); off. Also the last passed commit and
time, and a run cut off since. Due CI with work left comes before the group's new units: \`next\`
skips them (not its ci-fix, nor one already started) until the CI has run. In last call a group
whose work is in flight waits for it instead.

--since T: what became of each group's CI since T (an ISO time, the night's start): passed (its
steps, the commit), failed (on which step, and how), cut off (where, and why), running, or never
started (and why it was needed); groups whose CI didn't need to run aren't listed. \`just fleet
summary\` prints it. --json: each group's state, why, steps, resources, last pass, secs (how
long its last run's steps took), and runs_here (this machine
runs it tonight: pinned here or nowhere, its steps' caps here, its data leased here or by no one).

Steps are defined in tracker/project.json ci.steps, each { "cmd": "just drill {group}" } plus,
optionally: "publish": true (it ships; skipped while publishing is off), "uses": [resources the
lane holds for it: the run takes every step's as it starts, once all are free (no run waits mid-way
for one), and keeps each until the last step that uses it], "caps": [what the machine must be able to do], "timeout" (minutes,
default 120), "retries" (default 1, 5 minutes apart), "on_fail": "unit" (file <group>/ci-fix for
the lanes; the default for steps that don't ship) or "owner" (raise it to the owner; the default for
steps that ship), "mem" (its share of the machine's memory budget, and its cap: 12G; default its
past peaks, uncapped). {group} and the group's params are filled into cmd. The loop runs due CI
before any unit (\`ci-next\`), each step a heavy job (\`just capped\`: it waits its turn in the
memory budget) on origin's main, and records the result and how long it took. A step's last line
is its evidence. A step that exits 79 didn't run (something it needs before it starts isn't so,
which its last line says): the run is given back, due again, nothing filed. Due CI waits while a
live session on this machine works on the group (or a unit on its data).

CI goes stale for work outside the group too. \`ci-touch <group> --why\` records a change elsewhere
that alters what its build makes, and the loop does it by itself with "affected" in project.json ci:
a command with {old} and {new} (two of main's code commits) that prints a line "<group>\\t<why>" per
group whose build that range of main changes, and exits 0 (\`ci-affected --help\`).

"land" in project.json ci, { "cmd": "factory/ci {group} land", "timeout": 15 }: a check the loop runs
before each unit lands, for its group and each other group whose data it wrote here (\`ci-land
--help\`), so a unit that left a group's copy ahead of git is caught by its own session, not by
the night's CI.`,
  "ci-touch": `ci-touch <group> --why "…" [--commit C]
Work outside the group changed what its build makes (shared code, a tool it runs): its CI goes stale
as if a unit of its own had finished since the pass (due by the same rules), the why shown with
C's first 8 characters, and broken CI is tried again as for a unit finished since it failed. The latest touch is
kept. One whose commit C the last run already tested isn't news. The loop's ci.affected hook does
this by itself.`,
  "ci-affected": `ci-affected [--json] | <new> --touches F
The ci.affected hook in tracker/project.json ci: a command with {old} and {new} filled with two of
main's code commits (the newest commit outside tracker/) that prints "<group>\\t<why>" for each group
whose build that range changes, nothing for none, and exits 0. The loop runs it whenever main's code
has moved past the last commit it covered: after a lane lands a unit, and before a lane picks work
(so merges made outside the lanes are seen too); one lane at a time per machine, under
FACTORY_CI_AFFECTED_TIMEOUT seconds (default 120). The first run only records main's code commit.
A run that fails or times out records nothing (an event says so once) and is tried again next time.
No arguments: the hook and the commit it covered (--json: {"cmd", "at"}).
<new> --touches F: the loop's record of a run, in one write: each group F names is touched
(ci-touch, with commit <new>; a group with no CI is skipped and said), and <new> is covered, unless
what's covered is already past it.`,
  "ci-land": `ci-land <id> [--json]
The checks the loop runs before a finished unit lands: "land" in tracker/project.json ci,
{ "cmd": "factory/ci {group} land", "timeout": 15 } (minutes, default 15), with {group} (and the
group's params) filled, first for the unit's group (or its data group when it has --data), then
for each other group whose data it wrote here: with a store, a group with data whose copy on this
machine has a file written since the unit's round began. Not a group another unit or CI run here
has at work, or one with outputs here waiting to land (the store's marks): what changed it may be
theirs; nor one with over 200,000 files here, too many to tell. None for a
group with no CI, whose CI stands failed (no pass since), or whose ci-fix is open: every unit
would be held for what the fix is for. The groups skipped are named, and the loop logs them. The
loop runs them in order in the lane's clone on the branch with main merged in, after \`just
check\` passes (and for a unit that committed nothing, on main), with FACTORY_UNIT (the unit) and
FACTORY_UNIT_SINCE (an ISO time: its first claim since it last landed or was reopened from done,
so a retry after a failed check still sees what the first attempt left). Exit 0 from each lands
it; exit 79: it couldn't check (a crash, something missing), so the branch waits for the next look,
not sent back nor counted towards stuck (the overseer hears, land-check-unrun, and again every two hours
while it's held); past its timeout it counts as passed and
the overseer hears (land-check-timeout); any other exit stops there and doesn't land it: the unit
goes back to ready on its branch with the output's last line as a note (\`land-fail\`). --json:
{"since", "checks": [{"group", "title", "cmd", "timeout", "own"}, …], "skipped": [{"group", "why"}, …]}, with
"why" when there's no ci.land.`,
  "land-fail": `land-fail <branch> --evidence "…"
loop.sh: the check before landing (ci-land) failed on this finished branch. The units waiting to
merge on it go back to ready on the branch (pushed), the evidence as a note, so the next session
carries the unit on; a merge unit among them is done with the branch. The third failure in a row
makes the unit stuck, for the overseer. Landing it, or a reopen, starts the count again.`,
  "ci-start": `ci-start <group> [--force]
Record that this session runs the group's CI now (refused unless it's due; --force runs it anyway).
Prints the steps. A run whose session dies reads as due again.`,
  "ci-pass": `ci-pass <group> --evidence "…" [--commit C] [--steps s,…] [--secs N]
The group's CI passed. Records main's newest commit outside tracker/ (or --commit), the steps run
(default: the ones it runs now) and which units were done, so later changes make it stale.
--secs: how long the run's steps took (ci-fail takes it too), for \`ci --json\`.`,
  "ci-fail": `ci-fail <group> --evidence "…" [--commit C] [--step S] [--log PATH]
The group's CI failed; the evidence says which step and how. It shows as broken until main moves and
6 hours pass, a unit of the group is done, or ci-retry. With --step, a step whose on_fail is "unit"
files <group>/ci-fix with the evidence (or reopens a dropped one); if that fix was done for a failure
of the same step, CI is known failing instead, with the fix's last note as the reason, and nothing
more is filed. A fix done for another step's failure, or before a pass, is reopened. A failure of the
same step on the same commit as another group's, within 30 minutes of it, joins that group's open
ci-fix instead (its "also" lists the groups in it, its card each one's rows): each comes due when
it's done, and ci-split takes a group out again.`,
  "ci-split": `ci-split <group>
The group's CI failure joined another group's ci-fix (the same step failing on the same commit) but
has a cause of its own: it leaves that fix and gets <group>/ci-fix, for its current failure.`,
  "ci-next": `ci-next [--claim] [--json] [--group G]
The due CI this lane can run now: right machine, its steps' caps, its group's data leased here (or
free to lease), the resources it takes as it starts free (every one its steps use; --json lists them
as start). Groups leased here first, then priority, order. --claim
records it running (as ci-start) and takes the group's lease, in one push. --json gives the steps
to run (cmd filled in, uses, timeout, retries, on_fail). Exit 1: none (wait: true if one is due here
but its resources are busy, with uses: the busy ones, which a unit that gets one as it frees gives
way to the CI for; and start: all it takes as it starts, which the loop starts no unit with
meanwhile; none for CI waiting only on a session here). With FACTORY_LAST_CALL=1 (the loop's last call) only a group's work in
flight is left tonight (the loop starts no more of its units), so every changed group is due once that lands; wait: true while it may still land, and
why names the units in flight it waits for.`,
  "ci-unclaim": `ci-unclaim <group> [--release-lease] [--cut "…" [--step S]]
Give back CI this session claimed (ci-next --claim) and couldn't start or finish; a lease the claim took goes
too (--release-lease: whoever took it).
--cut "why": the run had started and was cut off (paused asap, the lane stopped) at step S: kept
until a pass or a failure, for \`ci --since\` and the view.`,
  "ci-retry": `ci-retry <group>
Try broken CI again without waiting for main to move and 6 hours to pass.`,
  publish: `publish [on|off]
Whether CI runs the steps that ship (a step with "publish": true in project.json ci.steps, or named
publish). Off: CI passes without them; turned back on, groups whose last pass skipped one are stale.`,
  view: `view [--open]
Rebuild the owner's page (.tracker/view.html); --open opens it.`,
};
