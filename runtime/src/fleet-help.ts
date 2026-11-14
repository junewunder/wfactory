// fleet.sh --help, and the two tiers of events it describes.
export const HELP = `
fleet.sh — run and watch every machine's lanes from one overseeing session.

The machines and their lane counts come from docs/machines.md. Each lane is
\`factory/oversee.sh\` in that lane's own clone beside the machine's checkout
(\`<checkout>-lane<N>\`, made by factory/lane.sh), run locally for this machine
and over ssh for the others. Lanes meet on origin's main: claims and tracker
writes are pushed there at once, and each unit's branch is merged into it
when the unit is done (factory/loop.sh).

Nothing runs on a machine the owner hasn't included: \`start\` with no machine
starts this one only. \`start\` first deploys the newest pushed wfactory
skill on each machine it starts (factory/deploy), so every laptop's lanes
run the same tracker and loop code, and nothing has to be copied into the
factory. It also pulls the skill's checkout there (the one ~/.claude/skills
links to, which Claude reads), when that's clean and on its main. Each says
what it did, or why it couldn't. With FACTORY_SKILL set by hand, this
machine's lanes run that copy instead, and nothing is deployed here.

Usage:
  factory/fleet.sh start [<machine>…] [--lanes N] [loop.sh options…]
                                          start its lanes (default: this machine; --max defaults
                                          to 1000 sessions, so --hours decides). --until <time>:
                                          the --hours from now to <time> ("09:00", "9am",
                                          "tomorrow 9am"; a time of day already past is
                                          tomorrow's). --lanes N: N lanes on each machine named,
                                          for this run only; docs/machines.md keeps its count.
                                          Lane clones past N with no loop running and nothing
                                          origin lacks are deleted (a later start clones them
                                          again, with a cold target/)
  factory/fleet.sh attach [--as ID]       this thread oversees the factory now (the newest
                                          to attach wins): prints its ID, then what the lanes
                                          and the last overseer logged since that one's last
                                          note, from every machine's journal it can reach
  factory/fleet.sh wait [--minutes M] [--as ID]
                                          block until a lane stops, the lanes log a wake-now
                                          event (Events, below), a machine runs short of memory
                                          (below), or M minutes pass (default 30 while anything
                                          is at stake, 55 when nothing is: every machine
                                          answers, nothing waits on the owner, every running
                                          lane is busy, memory is above each reserve, and no lane
                                          is within the hour of its stop time). Each machine's
                                          daemon answers as soon as one of its lanes does
                                          (main.mjs daemon --help); a machine ssh can't reach
                                          is tried every FACTORY_WAIT_EVERY seconds (default
                                          60). What it found comes first; its last lines say
                                          why it woke ("woke: a lane stopped", "woke: news",
                                          "woke: time", and with --as, "woke: replaced by
                                          another overseer" once a newer one has attached),
                                          then the heartbeat. It exits 0 for each, so no wake
                                          reads as a failure, and refuses (exit 2) while
                                          another wait for the same overseer runs. Each wake
                                          is noted in the overseer's journal (runs/oversee.log)
  factory/fleet.sh note [--as ID] <text…> a line in the overseer's journal on this machine
                                          (what it decided, told the owner, waits for)
  factory/fleet.sh summary [--since T] [--done]
                                          what went wrong first: CI that failed, was cut off or never
                                          started, the problem events of either tier (EVENTS_PROBLEM),
                                          the journal's oom and memory-low, and what waits on the
                                          owner; under each event in a unit, that unit, its status
                                          now and its newest note (what became of it); then the rest of the morning-summary events and the
                                          CI that passed; since T ("09:00", "-24 hours"; default:
                                          since this checkout's last fleet start), then the check-in
                                          offer when one is due (tracker prune --due), and last the
                                          scorecard's three worst lines and any prediction that came
                                          due (just scorecard, this machine's lanes); with --done,
                                          how many units were done since then
  factory/fleet.sh beat                   one heartbeat line: lanes busy, waiting, stopped; what each
                                          busy one works on, for how long, and when its session's
                                          transcript was last written; each machine's memory
                                          available; and what's for you (questions; a wait for
                                          work in flight no lane lands)
  factory/fleet.sh state [<machine>…]     each lane's state and log tail
  factory/fleet.sh events [N]             the last N lines the owner may need to hear about (default 20)
  factory/fleet.sh pause [<machine>…]     find a good pausing spot: stop after the running unit
  factory/fleet.sh pause-now [<machine>…] pause asap: end the running sessions now
  factory/fleet.sh restart <machine> [--lane N]   onto a newly pushed skill: deploy it there, and each
                                          running lane (or lane N) restarts on it as soon as its
                                          own unit ends, without waiting for the others; one
                                          \`restarted\` event, for the morning summary, once all have
  factory/fleet.sh last-call [<machine>…] wrap up and publish: no new units; work in flight
                                          lands (a session holding what CI needs is told to
                                          wrap up, and ended after last_call_grace minutes),
                                          CI runs for every group with stale CI, then the
                                          lanes stop
  factory/fleet.sh stop-at <time> [<machine>…]  the lanes stop at <time> ("09:00", "9am",
                                          "tomorrow 9am"), with last call before it (loop.sh --help)
  factory/fleet.sh tell <machine>[/<lane>] | <unit id> <text…>
                                          a message for a running session, which reads it after
                                          its next tool call (factory/inbox.sh): every lane on a
                                          machine, one lane, or whichever lane works the unit
  factory/fleet.sh stop [<machine>…]      stop now: kill the lanes, sessions and long jobs
  factory/fleet.sh tidy [<machine>…]      on machines with no lane running: stop leftover
                                          sessions and long jobs, run factory/tidy (the editor,
                                          a headless desktop), and remove lane clones past
                                          docs/machines.md's count that hold nothing origin
                                          lacks. The overseer's last step.
  factory/fleet.sh usage                  how much of the plan is left, where the week's line is
                                          and until when the lanes pause for it, as each
                                          machine's transcripts last saw it; trust the newest
  factory/fleet.sh run <machine> <command…>   run a command in that machine's checkout

Examples:
  just fleet start --hours 10          # this machine's lanes
  just fleet start --until 09:00       # this machine's lanes, until 9 tomorrow morning
  just fleet start laptop2 --hours 10  # add laptop2
  just fleet start laptop2 --lanes 2 --hours 10  # two lanes there, for this run only
  just fleet wait                      # in the background; wakes the overseer
  just fleet run laptop2 just status

Events. The lanes log what the overseer may need to hear to runs/events.log, one line
per event with its kind (loop.sh, store.sh, capped.sh). Each kind is in one of two tiers:
  wake now:        \`fleet wait\` returns for it (EVENTS_WAKE in src/fleet.ts)
  morning summary: collected for \`fleet summary\` and the end-of-run report (EVENTS_SUMMARY)
A kind in neither list wakes the overseer, so a new kind is never missed. A project moves a
kind or adds its own in tracker/project.json: "events": {"wake": [...], "summary": [...]}.
A \`question\` is logged by every lane that finds it open after its unit and not before (the
questions are main's, so one asked anywhere is new to each lane), and told once: \`fleet wait\`
wakes for the first lane's line and drops the rest (runs/.fleet-questions has the ones told,
and \`fleet attach\` adds every one the lanes' logs have); attach and summary list each once.

Memory. \`fleet wait\` also asks each machine's daemon about its memory: an \`oom\` event for
each process the kernel killed for want of memory (the machine out of it, or a unit at its own
cap; the lanes' own sessions and jobs at their caps are their \`oom-kill\` events instead),
and a \`memory-low\` event when the memory available falls under the machine's
reserve (its Reserve and GPU in docs/machines.md, as \`just heavy\` reads them),
told once until it's back above it. The beat shows each machine's memory
available and what holds its budget of heavy jobs (\`just heavy\` there).

Without a machine, pause, pause-now, stop and state act on every machine in
docs/machines.md. A machine ssh can't reach shows as "unreachable", never as
stopped. With several loops in tracker/project.json, put \`--loop <name>\` first:
\`factory/fleet.sh --loop docs start --hours 6\`. Remote commands get the
machine's desktop session (display, bus) and the usual tool folders, which a
non-login ssh shell lacks.`;

// The two tiers of events (Events, above). Wake now: what the owner must hear, or the overseer must
// act on, before the morning. Summary: what only the end-of-run report needs.
export const EVENTS_WAKE = `question ci-published ci-broken ci-known-failing ci-unrecorded ci-affected-failed land-check-unrun oom-kill stuck idle usage-pause usage-resume
  main-broken review-skipped stuck-merge stuck-merging stuck-branch inbox-unread silent restart-failed lost-lease lease-kept store-up store-down store-torn store-aside-unfiled gone-lane-left
  resumed resume-refused resume-failed oom memory-low`.split(/\s+/);
// The bad news, whichever tier it's in: what \`fleet summary\` and the report put first.
export const EVENTS_PROBLEM = `ci-broken ci-known-failing ci-unrecorded ci-affected-failed land-check-unrun oom-kill stuck main-broken review-skipped
  stuck-merge stuck-merging stuck-branch inbox-unread silent restart-failed lost-lease store-down store-torn store-aside-unfiled gone-lane-left resume-refused
  resume-failed oom memory-low ci-broken-noship ci-known-failing-again store-aside-old resume-skipped land-check-timeout idle`.split(/\s+/);
// The problem kinds that happen in a unit's session or landing: \`fleet summary\` says under each
// which unit, and what became of it (or "unit: unknown"). Other kinds get that line only when
// their line names a unit.
export const EVENTS_OF_A_UNIT = `oom-kill stuck review-skipped stuck-merge stuck-merging stuck-branch inbox-unread silent land-check-unrun
  land-check-timeout resume-refused resume-failed resume-skipped`.split(/\s+/);
export const EVENTS_SUMMARY = "ci-republished ci-broken-noship ci-known-failing-again store-aside store-aside-old lane-stop held-back restarted wrap-up wrapped-up factory-edits tracker-edits resume-skipped land-check-timeout gone-lane-merged".split(" ");
