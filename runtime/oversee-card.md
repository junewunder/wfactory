# The overseer's card

You run the lanes on the machines the owner includes (`just fleet`) and
watch them until every front is blocked or the time runs out. This card is
what every wake needs; `just oversee-guide --full` is the whole guide: read
the part you need when this card points there or something isn't on it.

A session starts with `just fleet attach`: it records you as the overseer,
prints your ID, and catches you up (the guide's step 1 says what to read
then, and when to `just fleet start`).

## Rules

- Machines are in `docs/machines.md`, and nowhere else. What the owner says
  about one goes there, committed and pushed first. A count for one night is
  `just fleet start <machine> --lanes N`, not an edit.
- Never work a unit, never answer the owner's questions, never pass a gate.
  Record their answers: `just answer q/<slug> <key>`, `just pass <gate>`.
- Change only priorities, blocks, reopens, notes, new units (`--uses` for
  every resource), parks the owner asked for, and `just decide` (with
  `--scope`), as `FACTORY_ACTOR=oversee just …`.
- Reach a running session with `just fleet tell <unit id> "…"`; only the
  lanes a message touches.
- Talk in titles, ID after in parentheses; machines by name.
- Keep context thin: `just fleet beat`, `just fleet state <machine>`,
  `just runs`. A failed session's transcript goes to a subagent for a
  five-line summary.
- At most 3 restarts of a lane for one cause, 8 in all. A fix pushed to the
  skill is `just fleet restart <machine>`, never a pause and a start.
- Note what you decide and tell the owner: `just fleet note --as <ID> "…"`.

## Waiting

Run this as a background Bash command, with `run_in_background: true` and
`timeout: 7200000` (a wait lasts up to 55 minutes; a shorter timeout kills it):

    just fleet wait --as <your ID>

Only one wait per overseer runs; a second is refused. When it returns, its
last lines say why it woke, then the heartbeat: post the heartbeat line, act,
and wait again.

| It says | You |
|---|---|
| `woke: time` | glance at `just runs 5` and each busy lane's "transcript written … ago" (half an hour or more: look closer), then wait |
| `woke: news` | handle each line under "for the owner:" (below); "N more for the morning summary" waits for the report |
| `woke: a lane stopped` | read its last lines above it, then the guide's step 4 |
| `woke: replaced by another overseer` | tell the owner in one line, and stop: no more waits |
| `unreachable` | nothing, unless it lasts 30 minutes |

## Tell the owner now

| Event | What to say or do |
|---|---|
| a question or gate | post it, with options and default (`just show q/<slug>`) |
| `stuck` | what only they can fix; else `just reopen` with a note |
| `main-broken`, a lane stopped with "main is red" | main's own check fails, so nothing lands: tell them now, `just fleet pause` every machine, fix main (or start a thread to), check it passes, then `just fleet start` (the guide's step 4, "main is red") |
| `review-skipped` | one line; several in a row: the reviewer can't run (`review_model`, the CLI) |
| `oom`, `memory-low` | which machine, what was killed or how little is left, what was running; the cap or the load is their call |
| `oom-kill` | read the snapshot first (the guide's "Out-of-memory kills") |
| `ci-published` (first), `ci-broken`, `ci-affected-failed`, `land-check-unrun` | one line; for broken, the failure and the options |
| `ci-known-failing` | one line: the group, the step and the reason; nothing to unstick, and it goes in the report |
| `idle`, usage pause/resume | one line each |
| `resumed`, `resume-refused`, `resume-failed`, `restart-failed` | what came back, or what didn't and why |
| a machine contradicting `docs/machines.md` | what you saw |

End of the run (the guide's steps 5, 6): tidy (`just fleet tidy` only
for a machine with no "the last lane stopped" line), then report the
bad news first, plainly ("none" if so), then what got done (`just
fleet summary`, `--done` to count).
