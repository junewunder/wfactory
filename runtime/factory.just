# Factory recipes, imported by the root justfile. Project recipes, including
# `check` (the oracle), live in the root justfile. The tracker's state is
# tracker/; its code is shared from the wfactory skill (factory/tracker).
# `just tracker --help` documents every command.

# Counts, what's waiting on the owner, what's next (just status <group> | --all).
[positional-arguments]
status *args:
    @factory/tracker status "$@"

# The unit to work, with its context (--claim to claim it).
[positional-arguments]
next *args:
    @factory/tracker next "$@"

# Claim a unit you were told to work.
[positional-arguments]
claim *args:
    @factory/tracker claim "$@"

# One unit, group, question (q/…) or decision (d/…).
[positional-arguments]
show *args:
    @factory/tracker show "$@"

# Units by words in their title or detail, best first (just find <words> [--open]).
[positional-arguments]
find *args:
    @factory/tracker find "$@"

# Questions and gates waiting on the owner, with options and what each changes.
[positional-arguments]
questions *args:
    @factory/tracker questions "$@"

# Run one computed unit's check and record the result.
[positional-arguments]
recheck *args:
    @factory/tracker check "$@"

# Rerun the checks whose inputs changed (--all for every one).
[positional-arguments]
refresh *args:
    @factory/tracker refresh "$@"

# Record a unit done: just done <id> --evidence "…" [--checker <tag>].
[positional-arguments]
done *args:
    @factory/tracker done "$@"

# Hand a unit to a second checker: just review <id> --evidence "…".
[positional-arguments]
review *args:
    @factory/tracker review "$@"

# A unit waits on a question (--on q/…) or is stuck (--why "…").
[positional-arguments]
block *args:
    @factory/tracker block "$@"

# Put a unit back to ready.
[positional-arguments]
reopen *args:
    @factory/tracker reopen "$@"

# Drop a unit: just drop <id> --why "…".
[positional-arguments]
drop *args:
    @factory/tracker drop "$@"

# A note for the next attempt at a unit (the last 3 are kept).
[positional-arguments]
note *args:
    @factory/tracker note "$@"

# Ask the owner: --title "…?" --context "…" --option "a | label | what it changes" … --default a --blocks <sel>.
# An option can end "| drops: <units>" and "| releases: <units>"; answering it then does exactly that.
[positional-arguments]
ask *args:
    @factory/tracker ask "$@"

# Record the owner's answer: just answer q/<slug> <key> [--note "…"].
[positional-arguments]
answer *args:
    @factory/tracker answer "$@"

# The owner passes a gate: just pass <gate> [--note "…"].
[positional-arguments]
pass *args:
    @factory/tracker pass "$@"

# Record a judgement call: just decide --title "…" --why "…" --scope <sel> ('*' for every unit).
[positional-arguments]
decide *args:
    @factory/tracker decide "$@"

# Search decisions (just decisions <words> | --for <id>).
[positional-arguments]
decisions *args:
    @factory/tracker decisions "$@"

# What happened, in plain words (just log --since 8h).
[positional-arguments]
log *args:
    @factory/tracker log "$@"

# Fail on malformed tracker data, bare IDs in text, and memory/AGENTS.md bloat (--broken: only on broken data).
[positional-arguments]
lint *args:
    @factory/tracker lint "$@"

# Rebuild memory/MEMORY.md from the memory files' frontmatter (--check: only say if it's current).
[positional-arguments]
memory *args:
    @factory/tracker memory "$@"

# Rebuild the viewer and open it.
view:
    @factory/tracker view --open

# Any other tracker command (add-unit, add-group, edit-group, add, sync, edit, rename, park, unpark, …).
[positional-arguments]
tracker *args:
    @factory/tracker "$@"

# Run the factory headless, one fresh claude session per unit (factory/loop.sh --help).
[positional-arguments]
loop *args:
    factory/loop.sh "$@"

# Run the loop detached for an overseeing session: start | wait | pause | restart | last-call | stop-at | tell | state | stop (factory/oversee.sh --help).
[positional-arguments]
oversee *args:
    @factory/oversee.sh "$@"

# Finish the current unit, then stop the loop (--now: end the running session too; its unit waits for the next one).
[positional-arguments]
pause *args:
    @factory/oversee.sh pause "$@"

# Every machine's lanes from one session (docs/machines.md): start | wait | summary | beat | state | events | pause | pause-now | restart | last-call | stop-at | tell | stop | tidy | usage | run (factory/fleet.sh --help).
[positional-arguments]
fleet *args:
    @factory/fleet.sh "$@"

# Group data on the store (factory/store.sh --help): status shows what this machine has cached. The loop does the copying.
[positional-arguments]
store *args:
    @factory/store.sh "$@"

# A job longer than one Bash call, detached and memory-capped: just long start <name> -- <cmd…>, then just long wait <name> until it's done (factory/long.sh --help).
[positional-arguments]
[no-exit-message]
long *args:
    @factory/long.sh "$@"

# Wait up to <seconds> for a check to pass (rerun every 2 s), or just that long: just until 60 -- 'test -s out/a.txt'. A session's Bash refuses `sleep`.
[positional-arguments]
[no-exit-message]
until *args:
    @"${FACTORY_NODE:-node}" "{{source_directory()}}/main.mjs" until "$@"

# A smaller copy of an image to Read instead of it (runs/view/; default --max 1568 pixels): just view-image shots/a.png [--max 800].
[positional-arguments]
[no-exit-message]
view-image *args:
    @"${FACTORY_NODE:-node}" "{{source_directory()}}/main.mjs" view-image "$@"

# The overseer's card (the rules, and what to do at each wake), then this project's additions; --full for the whole guide (the skill's runtime/oversee.md).
[positional-arguments]
oversee-guide *args:
    @"${FACTORY_NODE:-node}" "{{source_directory()}}/main.mjs" oversee-guide "$@"

# The loop's worker prompt (the skill's runtime/prompt.md), then this project's own rules.
prompt:
    @"${FACTORY_NODE:-node}" "{{source_directory()}}/main.mjs" prompt

# Deploy the newest pushed wfactory skill on this machine (`just fleet start` does it on every machine it starts).
skill-deploy:
    @factory/deploy

# How much of the plan's usage is left: the 5-hour window and the week.
usage:
    @factory/usage.sh show

# The last loop iterations on this machine, its lanes' clones included: unit, result, turns, cost, minutes (just runs [n] [--tsv]; --tsv: tab-separated, for awk and cut).
[positional-arguments]
runs *args:
    @"${FACTORY_NODE:-node}" "{{source_directory()}}/main.mjs" runs "$@"

# Where a run's sessions and time went, from the records alone (just scorecard [--since <when>] [--json]; --names lists the figures; just scorecard expect <name> '<op> <value>' --by <date> --why "…" records a prediction, just scorecard settle <id> --note "…" closes one).
[positional-arguments]
[no-exit-message]
scorecard *args:
    @"${FACTORY_NODE:-node}" "{{source_directory()}}/main.mjs" scorecard "$@"

# Run a command in a memory-capped scope, with its share of the machine's memory budget (FACTORY_MEM=12G just capped … to say how much; else its past peaks), so a runaway child can't take the session down. A kill says so and reaches the overseer (the skill's runtime/capped.sh, beside this file).
[positional-arguments]
[no-exit-message]
capped *args:
    @"{{source_directory()}}/capped.sh" -- "$@"

# The machine's heavy jobs: what holds its memory budget and heavy-job slots, and what waits (just heavy), how a job ended (just heavy why <name>), or a standing reservation for a service like an editor (just heavy reserve <name> <size> --pid <pid> | --unit <unit>; just heavy release <name>).
[positional-arguments]
[no-exit-message]
heavy *args:
    @"{{source_directory()}}/heavy.sh" "$@"
