// The loop's --help (factory/loop.sh --help): what it does, its options and its files.
export const HELP = `
loop.sh — run the factory unattended: one fresh headless Claude session per unit.

Each iteration claims the next unit from the tracker (\`factory/tracker next
--claim\`), then starts a new \`claude -p\` session on factory/prompt.md with
that unit's card (title, what done means, needs, decisions that apply, notes
from earlier attempts) appended to the system prompt. Both come in files in
its inbox, not on its command line (unless the inbox can't take them, which
the loop logs). The session works that
one unit, records it and exits. Context never carries over, so nothing rots,
and a unit worked by one iteration is checked by a different one. After the
session the loop runs \`tracker settle\`: a computed unit's check is run by the
loop, not taken on the session's word, and a claim the session left open
shows as interrupted.

Each session runs in a memory-capped systemd scope, so a runaway build or
checker gets OOM-killed inside the scope instead of taking down the desktop and
every other agent with it. Hitting the cap isn't by itself a stuck unit: the
loop writes what used the memory just before the kill (src/session.ts's
snapshot: pid, RSS, command line) to the session's .err, a note on the unit
and an \`oom-kill\` event; the unit shows as interrupted and the lane goes on.
A second kill of the unit by the same kind of process (or a third of any
kind) since it was last reopened blocks it, for the overseer. A session that posts its result but doesn't exit
(waiting on a child such as an editor) is stopped after a grace period
(FACTORY_RESULT_GRACE seconds, default 60; src/session.ts). A session that
writes nothing to its transcript for tracker/project.json "session_silence"
minutes (default 30; 0: never) while no tool call of its is open is ended: its
unit shows as interrupted, its work pushed, the lane goes on, and the
overseer hears (a \`silent\` event). A long Bash call keeps its tool call
open, so it's never ended for being quiet.

Branches. When the repo has an origin, each unit is worked on its own branch,
unit/<id>, made from origin's main in this lane's clone. The claim and every
tracker write go straight to origin's main (the tracker CLI pushes them), so
the branch never carries tracker/ changes. The session's last step merges the
latest main into its branch, settles any conflict and runs the checks. Then
the loop merges the branch into main and pushes (fetch, merge, check again
and retry if someone pushed first), and deletes the branch: finished branches
never leave the laptop. A branch the loop can't merge becomes a "Merge main
on <host> lane <n>" unit that only this lane takes, and the lane takes
nothing else until it's settled. A unit that stops unfinished (pause asap, a
session that died, a question for the owner) has its work committed to its branch
and pushed, so whoever claims it next, on either machine, carries on from it.
Without an origin, sessions commit on the checkout's branch as they are.

Review. Before landing a finished branch, once its check passes (so a red
main spends no review), the loop runs a review session (src/review.ts): a
fresh \`claude -p\` with read-only tools, given the branch's diff outside
tracker/, the unit's card and main's CODING_STANDARDS.md if there is one, its
words in files and on stdin, never on its command line. Its verdict is JSON:
"pass" lands the branch; "fix" doesn't, and the unit goes back to ready on
its branch, pushed, with the findings on its card (\`tracker review-fix\`), so
the next claim carries it on. A second "fix" makes it stuck, for the
overseer (a \`stuck\` event). A branch that changes nothing outside tracker/
isn't reviewed. A review that gives no verdict (the CLI fails, a usage limit,
a verdict that won't parse, over FACTORY_REVIEW_TIMEOUT seconds, default
1800) doesn't hold the branch: it lands, with a note on the unit and a
\`review-skipped\` event. One stopped by a pause or the stop time waits for
the next look. The reviewer's model is tracker/project.json "review_model",
else the lane's (--model). Its prompt and transcript are in runs/review/.
FACTORY_REVIEWER runs another command in place of the agent CLI for it (the
tests' fake reviewer).

Lanes. Every lane is the same: it takes any unit its machine can do
(docs/machines.md says whether this machine takes any unit or only units
pinned to it). Lanes on one machine run in their own checkouts
(factory/lane.sh) and share a lock folder: a lane holds its unit and the
resources the unit uses (tracker/project.json "resources", e.g. an editor)
for the session's life, and the other lanes take something else meanwhile.
They share work/ too, so \`just check\` gets FACTORY_BUSY_GROUPS (\`tracker busy\`):
the groups other units here have outputs there for that aren't on main yet (in
progress, interrupted, or waiting to land), which it skips. Main failing the
check while some are busy is checked again once none are.

Data. A group with data (tracker/project.json "store") keeps its big files on
the store, and one machine at a time leases it; the claim of a unit
takes its group's lease in the same push. The loop does all the copying
(factory/store.sh, rsync): down after taking a lease (unless the copy here is
current) along with the read-only inputs the unit reads, and back after each
unit whose work is on main (an unfinished unit's outputs never reach the
store: the store's copy is put back here instead) and after each CI run that
rebuilt some of it. Lanes prefer groups their
machine already leases. A lease with nothing left for this machine is released once its data is on the store, and so are
all of them when the last lane here stops ("stop now": only those whose last
finished unit is on the store). A heartbeat every few minutes keeps them
fresh; one silent for 30 minutes can be taken over. If a new lease would push
the cache past this machine's Cache (docs/machines.md), safe old groups are
deleted first; failing that, the lane skips units needing a new lease. A unit
with \`caps\` goes only to a machine whose "Can" lists them all.

Group CI. Before any unit, a lane runs due CI it can run here (\`tracker ci-next --claim\`:
the group's machine, its steps' caps, its data leased here or free, its resources free).
CI is due once a group is done for the night, or has been stale "ci_every" minutes
(tracker/project.json, default 120) with work left: then it comes before the group's new
units. The steps (tracker/project.json ci.steps) run as plain commands on origin's main, no
session, each as a heavy job (runtime/capped.sh): it waits its turn in the machine's memory
budget and a heavy-job slot, up to 8 minutes (FACTORY_CI_TURN_WAIT, seconds); still no room,
the run is given back and the lane takes other groups' work for --idle-wait minutes. Pass or fail goes to the tracker, with how long the
run took; it files <group>/ci-fix for a failure the lanes can fix. With data on the store,
what the run rebuilt is copied back as it ends, passed or failed (main's outputs, which the next
run anywhere would otherwise rebuild), stamped as the group's CI; a copy back that fails is
tried again at each look, as a unit's is. A run cut short (pause asap, the lane stopping) is
recorded as cut off; it, and a failure whose step was killed (out of time, its memory cap),
copy nothing back. A lease isn't released while its group's CI
is due here.
Work outside a group can change its build too (shared code): with "affected" in
tracker/project.json ci (a command given {old} and {new}, two of main's code commits, that prints
"<group><tab><why>" per group that range changes), the lane runs it whenever main's code has moved
past the last commit it covered, after landing a unit and before picking work (so the owner's
merges count too), one lane at a time here, under FACTORY_CI_AFFECTED_TIMEOUT seconds (default
120), and touches each group it names (\`tracker ci-touch\`): their CI goes stale as for a unit of
their own. A failed run records nothing and is tried again at the next look (a
\`ci-affected-failed\` event, once until it passes).
The check before landing. With "land" in tracker/project.json ci ({ "cmd": "factory/ci {group}
land", "timeout": 15 }), a finished branch is checked by that command before it lands
(\`tracker ci-land\`): after \`just check\` passes on the branch with main merged in, on that tree
in this lane's clone (for a unit that committed nothing, on main), with FACTORY_UNIT and
FACTORY_UNIT_SINCE (its first claim since it last landed or was reopened from done): for the unit's
group, then (with a store) each other group whose copy here has files written since then, in turn,
the first that fails stopping it. None for a group without CI, or whose CI is broken or
has its ci-fix open, nor for one another unit or CI run here has at work; the log line names those
skipped. Exit 0 lands it; any other exit doesn't: its branch is pushed and its unit
goes back to ready with the output's last line as a note (\`tracker land-fail\`; stuck the third
time in a row). Past its timeout (minutes) it lands and the overseer hears
(\`land-check-timeout\`). Exit 79 (couldn't check: a crash, something it needs missing) holds
the branch for the next look, not sent back nor counted towards stuck, and the overseer hears
(\`land-check-unrun\`) once, then every two hours while it's held, with how long; a tracker that can't say what to run holds it too.

Last call. Before the stop time (--hours, or an earlier one the overseer set with \`just
fleet stop-at\`) comes a last call: tracker/project.json "last_call" minutes (default 30; at
most half the run; 0 = none), or now with \`just fleet last-call\`. No time is added for CI: it
runs as it falls due through the night, and what hasn't run by the stop is named for the
morning. In last call the lane
starts no unit that would make CI here run again: none of a group whose CI runs on this machine
tonight (passed or not), or on its data, nor one using a resource CI still to run here needs.
Everything else keeps starting until the stop time (one that doesn't fit is ended at the
overrun, its work pushed). \`just fleet last-call\` ("wrap up and publish") starts no unit at
all, and none starts while main is red. Work in flight finishes and lands, and every group counts as done
for the night, so a group whose CI is stale comes due and runs. The lane waits while other
work is moving (work in flight may still make CI due here), and stops once nothing is left
that it may start. A stop
time only moves earlier. A last call outlives a restart until the lane stops at its end. A stop
with CI not passed (out of time, say) names those groups, for the overseer.
Before each unit the lane writes its last call to last-call in the lock folder (logging it when
it moves by more than 5 minutes: an earlier stop time), for the daemon bringing a lane back.
Before last call the lane takes no unit last call will hold back with too little time left
before it: the unit's --min-minutes, else the median of its past sessions (\`tracker next
--last-call-in\`), else tracker/project.json "min_unit_minutes" (default 45; 0 = none). It
takes another unit, or waits for last call, and the overseer's morning summary hears what was
held back (held-back).
CI must get the resources its steps use (an editor, say) at last call, not wait for a long unit
that holds one. A CI run takes every resource its steps use as it starts, and due CI goes first at
a resource: while one is busy, the lane takes other work (no unit using any resource that CI
takes, so a free one isn't taken from it), and the lane that sees it free runs the CI rather
than a unit that wants it. A session whose unit uses a resource CI here needs is told in
its prompt when that resource goes to CI (last call). When last call begins, it is told
through its inbox to commit what works, leave a note and end; "last_call_grace" minutes later
(default 15) the loop ends it like pause asap (its unit interrupted, its branch pushed) and goes
on to CI. Both reach the overseer as events (wrap-up, wrapped-up).

With nothing to do, a lane waits: it sleeps a few minutes (--idle-wait), fetches
and looks again, until its deadline. It stops when:
  - only the owner's questions and gates are left (nothing else can move), or
    nothing is left at all
  - \`just pause\` asked it to, after the current unit; or \`just oversee pause
    --now\` ended the current session (its unit shows as interrupted)
  - two iterations in a row record nothing and commit nothing
  - --max iterations or --hours (or the stop time) have run out
  - last call is over: nothing is left that it may start, and no CI is due here or coming
  - an iteration fails for a reason other than a usage limit or the memory cap
On a usage limit it sleeps (--limit-wait) and retries, until --hours runs out.
Under 8% of the 5-hour window left (factory/usage.sh, the profile's "pause
below") it pauses between units and resumes at the reset. Ahead of the week's
line (the share of the week gone by, less the profile's "keep back", 15%) it
pauses between units until the line reaches what's used (factory/usage.sh --help).
Restart. \`just fleet restart\` asks a lane to start again on the newest deployed copy of this
skill (runs/.restart): it does so as soon as the unit it's on ends, or at once if it's waiting
for work, and never waits for the machine's other lanes. It starts the new copy in place of
itself (the same service, leases and locks; none of a stop's steps), keeping the run's stop
time and the sessions it has run against --max. When every lane the restart asked has, the last
one logs a \`restarted\` event for the morning summary.
A session still running 20 minutes past the stop time (FACTORY_OVERRUN seconds) is ended
like pause asap, and the lane stops; \`just long wait\` tells it to wrap up 15 minutes before.
A session that runs 2 hours (FACTORY_SPLIT_AFTER seconds), twice a session's hour, is told once
through its inbox to write what it learned and split the unit, and the overseer hears (overlong).
Each session gets --add-dir for the real directory behind each top-level link out of the clone
(a lane's work/), so the CLI lets it write there.
A signal to the loop (systemd's stop, a kill) ends the running session, check or copy,
and the lane's long jobs with it, then runs the same exit steps. A session's long jobs
(factory/long.sh) are stopped when it ends.
When the last lane on this machine stops, factory/tidy (if the project has
one) shuts down what the lanes started: an editor, a headless desktop. Then it records
that on main (\`just log\`: "<machine>: the last lane stopped and tidied up") and only then
lets the machine sleep, so the overseer needn't reach it to know it tidied.
Inbox. A session reads its unit's card once, at its start; what changes while it works
reaches it through its inbox (factory/inbox.sh): a hook the loop gives every session passes
on, after its next tool call, notes someone else adds to its unit, decisions recorded since
its claim whose scope takes in its unit, and messages from the overseer (\`just fleet tell\`)
or from the loop.

What the overseer must hear about (a new question, a lane idle 30 minutes,
a usage pause or resume, a unit a session left stuck, CI, the lane stopping)
goes to runs/events.log, which \`just fleet wait\` watches. Which kinds wake the
overseer and which wait for the morning summary is fleet.sh's list (Events). A
question is logged by every lane that finds it new after its unit, whoever asked
it; the overseer hears it once, from the first (fleet.sh, Events).

Usage:
  factory/loop.sh [<loop>] [--max N] [--hours H] [--model M] [--effort E] [--mem SIZE]
                  [--limit-wait MIN] [--idle-wait MIN] [--last-call MIN] [--no-wait] [--no-awake] [--dry-run]

Examples:
  just loop                       # until done/gated/stuck, up to 8 hours
  just loop --max 1 --no-wait     # a single iteration, to watch one closely
  just loop --hours 10 --model sonnet
  just loop --dry-run             # show what would run, start nothing

Options:
  <loop>           A loop name from tracker/project.json "loops". Required when
                   the project defines loops.
  --max N          Stop after N sessions. Default: 50.
  --hours H        Wall-clock budget in hours, including waits. Default: 8.
  --model M        Model for each session: an alias (opus, sonnet, haiku) or
                   a full ID. Default: $FACTORY_MODEL, else the CLI default.
                   A unit with its own model (\`just tracker edit <id> --model sonnet\`) runs on that.
  --effort E       low | medium | high | xhigh | max. Default: $FACTORY_EFFORT, else the CLI default.
  --mem SIZE       MemoryMax for each session's scope (systemd size, e.g. 8G).
                   Default: $FACTORY_MEM, else 10G.
  --limit-wait MIN Minutes to sleep after hitting a usage limit. Default: 30.
  --idle-wait MIN  Minutes between looks when there's nothing to do. Default:
                   $FACTORY_IDLE_WAIT, else 4.
  --last-call MIN  Minutes of last call before the stop time. Default: tracker/project.json
                   "last_call", else 30. 0: none (\`just fleet last-call\` still starts one).
                   Its "last_call_grace" (default 15) minutes set the wrap-up at its start
                   (Last call, above).
  --no-wait        Stop when there's nothing to do instead of waiting.
  --no-awake       Don't keep the machine awake. By default the loop holds a
                   systemd-inhibit lock on sleep, idle and the lid switch while
                   it runs, so a laptop works on with its lid shut.
  --dry-run        Print the next unit and the claude command; run nothing.

Environment: FACTORY_LOCKS: the lock folder (default
$XDG_RUNTIME_DIR/factory-<project>). FACTORY_NOCAP=1 runs sessions without a
memory cap (tests). FACTORY_LAST_CALL_GRACE: last call's wrap-up time in seconds,
overriding "last_call_grace" (tests). FACTORY_LAST_CALL_AT: "<epoch> <stop time>", the
last call of the run a lane the daemon brought back carries on (it keeps it if earlier than its
own). FACTORY_RETRY_WAIT: seconds between tries of a tracker
write that must land (k times this before try k+1; default 3; tests). FACTORY_LOCK_WAIT:
seconds a tracker command waits for another to let go of its lock before it exits 75 (default
30; tests); the loop waits a busy lock out, saying so, rather than stopping. FACTORY_GIT_TIMEOUT:
seconds a git fetch or push to origin may take before it's given up as unreachable (default
180 for the tracker, 900 for branches and landing).

Output: runs/<timestamp>-<tag>.jsonl is each session's stream-json
transcript. runs/index.tsv gets one line per iteration (\`just runs\` shows it).
One loop runs at a time per checkout, so a second \`just loop\` here refuses to
start while one is running. \`just fleet\` runs every lane in its own clone
beside the checkout (factory/lane.sh), so the checkout itself stays on main
for the owner and the overseer; \`just loop\` by hand works in this checkout.
Sessions are saved as usual, so \`claude --resume <session id>\` reopens one.
factory/auto-mode.json, if present, is passed with --settings (standing OKs
for the auto-mode classifier, which isn't read from .claude/settings*.json), merged with
the inbox's hook (runs/inbox/<tag>/settings.json): only the last --settings counts.
Sessions take only the tools lanes use (Bash, Read, Edit, Write, Grep, Glob, Task,
SendMessage, TaskStop, WebFetch, WebSearch, ToolSearch: the rest, with the owner's
skills, would be in every turn) and no auto-memory. tracker/project.json's
"session_tools" adds to them, e.g. ["Skill"] for the owner's skills.
Sessions get the loop's environment without the owner's display: no DISPLAY or
XAUTHORITY, and WAYLAND_DISPLAY naming a socket that can't exist (unset, Wayland
apps would find the owner's), so a window opens only on a display the session
sets up itself; its long jobs get the same, and so do factory/pre-session,
the unit's check, refresh's probes and the landing checks. (What a session
starts through D-Bus, such as xdg-open, still gets the owner's: the spec's rule
keeps sessions from it.) "session_env" adds variables,
{clone} (the lane's clone) and {lane} (its number) filled in, e.g.
{"APP_CONFIG_DIR": "{clone}/runs/config"} to keep the project's app off the
owner's config, or the project's own private display; the variables the loop
sets itself win.
factory/prompt.local.md, if present, is appended to factory/prompt.md (the
project's own rules for sessions). factory/pre-session, if executable, runs
before each session with the unit's ID and its card on stdin (warm-ups).`;
