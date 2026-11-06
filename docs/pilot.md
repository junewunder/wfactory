# Pilot, then widen

The last step of setting up a factory (SKILL.md, "Setting up a factory"),
after the design is settled and the units of the ramp's first step are
filed.

Work the first two or three units **interactively** ("continue" works one
unit by the loop procedure in `docs/factory.md`), with the owner watching if
possible. That's where the spec gets fixed: the unit is the wrong size, the
oracle misses something, a rule is missing.

**Widen only at the ramp's gates ([design question 12](design-questions.md)).** File the units of the current step
and its review gate; the next step's units need the gate, so the lanes can't
widen on their own. When the step's units are done, do the review with the
owner before they pass it: read the step's cases side by side and say what
repeats (code written twice, the same fix in two hooks, a table keyed by
case) and what each new case broke that the earlier ones didn't
([docs/pipelines/](pipelines/README.md) lists the signs). Then one of
two things, before the factory widens:
- **an abstraction:** what three or more unlike cases share (the **rule of
  three**: not before) becomes shared-code units (design question 10) the next step needs;
- **one more case:** if nothing shared shows yet, add the next most unlike
  case to this step and review again.

The review also asks the owner about the goal's two lines
([opening.md](opening.md)): with a step's worth of real cases to look at,
are they still satisfied where the satisfied line says, and is the far
line still where they want this to head? And which of the differences
from the reference they'd keep: the candidate departures waiting in the
`taste` group, shown over the step's cases. The owner learns what they want
as the factory learns what's possible, so expect the lines to move, and
write each move into `docs/factory.md`'s Goal, with its done criterion,
and each departure into `docs/departures.md`, before the next step's units
are filed.

The review also looks ahead: what will the next step's cases need that
nobody has found out yet (a format no case has used, a tool nobody has
run, a behaviour the docs don't cover)? File that as research units the
next step's units need, now, so the lanes find the step's ground already
mapped and no session has to stop mid-case to learn it.

**Prior work first,** in every review and every research unit. Before
designing shared code or working something out, search for who has done
it already: an existing tool, a library, an open-source project that did
the same port or conversion, a community's notes, a spec, a decompilation,
a reference implementation. Something to copy, or at least to check
against, is worth more than anything worked out from scratch: it saves the
work and it doubles as an oracle. Record what was found, and where, in the
research unit's result, and say in the review what prior work the next
step builds on (or that the search found none).

Then go unattended:

```bash
just loop                         # until done, gated or stuck; 8h budget
just loop --max 1                 # one iteration, to watch closely
just loop --model sonnet          # mechanical units don't need Opus
just runs                         # what each iteration did, turns, cost
```

Each iteration claims the next unit and starts a fresh headless session of
the profile's agent CLI (`claude -p`) in a memory-capped scope, with the
unit's card in its system prompt. The session works that unit and exits; the
loop then runs the unit's check itself if it has one. One running loop is a
**lane**. The runner:
- **commits each unit** in the checkout (with an origin: on its own branch,
  which the loop merges; see SKILL.md, "Scaling out");
- **waits when there's nothing to do** while other work is still moving (in
  progress elsewhere, a busy resource): it sleeps a few minutes and looks
  again, until its deadline;
- stops when only the owner's questions and gates are left, when nothing is
  left at all, after two iterations that record nothing, on `just pause`
  (after the current unit) or `just pause --now` (the running session ends
  and its unit shows as interrupted), or when time runs out;
- pauses between units with under the profile's "pause below" (8%) of the
  5-hour usage window left and resumes at the reset (`factory/usage.sh`
  reads the transcripts' `rate_limit_event` lines);
- sleeps through usage limits;
- gives each session an inbox (`runtime/inbox.sh`, a PostToolUse hook): after
  a tool call it passes on notes added to the session's unit, decisions
  scoped to it since its claim, and messages from `just fleet tell` or the
  loop, so a session that's been at it for hours hears what changed;
- keeps the machine awake (a `systemd-inhibit` lock, lid switch included);
- writes what the overseer must hear about (a new question, a lane idle 30
  minutes, a usage pause) to `runs/events.log`, where `just capped` and
  long jobs also note a kill over their memory cap (`oom-kill`);
- on a session killed over its memory cap, writes what used the memory just
  before (pid, RSS, command line, from a look every few seconds) to its
  `.err`, a note on the unit and an `oom-kill` event, and goes on: the unit
  is interrupted, and blocked only when the same kind of process is killed
  on it again (or at its third kill);
- runs `factory/tidy` when it's the last lane on its machine to stop, then records
  that on main (`just log`: "<machine>: the last lane stopped and tidied up")
  before it lets the machine sleep.

A job that outlasts one Bash call runs as `just long start <name> -- <cmd>`
(detached, memory-capped) and the session calls `just long wait <name>`
(about 9 minutes at most) until it's done; it never ends its turn on a
running job. The loop pre-approves `just long`. A job that would run over
about an hour, or past the lane's stop time, means the unit is too big:
sessions split it per item instead. Near the stop time `just long wait` says
"out of time", and the loop ends a session still running 20 minutes after it.

Transcripts go to `runs/`. Sessions persist, so `claude --resume <id>`
reopens one to see what it was thinking.

For a long unattended run, the owner says **"oversee"** instead of starting
`just loop` themselves (SKILL.md, "Oversee").

Interactive sessions and the headless loop use the same procedure, so the
owner can switch between them freely. **One loop per checkout:** without an
origin, the one lane runs in the checkout itself; a second lane needs an
origin (SKILL.md, "Scaling out"; a bare repo on the same disk is enough).

## Next: the factory runs

The pilot is done when the ramp's first step has had its review and the
loop runs unattended. From then on, the factory is worked by SKILL.md's
"Continue", "Oversee" and "Questions".
