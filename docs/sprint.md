# Sprint

One of the two modes in which the owner works the factory by hand, with the
lanes off (SKILL.md, "Sweep and sprint"; the other is
[sweep.md](sweep.md)). A sprint is a **planned queue**: the owner's
decisions are settled up front, then one worker per unit carries it
through, each in a git worktree of its own, while this thread, the
**foreman**, merges their work and answers their small questions, until
the queue is done or a stop time. The owner may stay or leave.

It is for work that needs the owner's calls before it can be built: a
change of direction, shared code several groups wait on, what they found
using the result. Planning is one short exchange: one message from you,
one reply, at most one short follow-up.

It needs an origin (the tracker's state is then origin's, and a worktree
reads the same one; a bare repo on the same disk is enough,
[scaling-out.md](scaling-out.md)) and a harness that runs a subagent in a
git worktree of its own. Before the opening's gate is passed the work is
the opening's issues, and [opening.md](opening.md)'s "Running the queue"
runs them: use that.

## 1. Lanes off

`just fleet off --for "a sprint: <what>"`. It records on main that the
lanes are held off, with which were running and until when, and asks each
to stop after the unit it's on (`--now` ends their sessions). While it
holds no lane starts on any machine. Go on to step 2 while they finish.

Done when `just fleet off`, run again, exits 0 saying every lane has
stopped. No worker starts before that.

## 2. Read

- **Every item is a unit.** The units the owner named, with their cards
  (`just show <id> --full`). When the owner starts a sprint from a
  conversation, the conversation is the brief: record its decisions now
  (`just answer`, `just decide`), and file a unit for each piece of work it
  agreed on that has none (`just find <words> --open` first; `just tracker
  add-unit`, with `--needs` for what it waits on and `--uses` for every
  resource).
- `AGENTS.md`, this machine's section of `docs/machines.md`, the spec's
  loop and oracle sections, and `factory/prompt.local.md` if there is one.
- The code each unit touches, enough to know which collide, and what's in
  flight (`just status all`: in progress, merging).

Done when every item is a unit whose card you have read. The rest of the
backlog is not this step's.

## 3. Harden

While you read, a fresh subagent attacks each unit, given only its card,
the decisions that apply and `AGENTS.md`. It looks for assumptions the card
doesn't state ("the only way X happens"), vague words an agent will read
narrowly ("works", "relevant"), a check only the building agent can grade,
and a check that never exercises the change.

Fix the cards yourself (`just tracker edit <id> --detail "…"`). What turns
out to be a real decision goes in step 4's message.

Done when every unit's "done" is a check a command can decide, or says why
none can.

## 4. Cut, in one message

- **The queue**, worth-most first: which units run side by side (no shared
  files, no shared resource) and which wait on which. Record the waits as
  `--needs`, and split a unit one worker can't finish.
- **Out**, with one line of reason each. "Needs the owner" is no reason
  while the owner is here: it's a question below.
- **The stop time.** Ask whether the owner is leaving, and when the sprint
  should stop starting new units (default: when the queue is empty). The
  queue may be longer than fits, extras last. Give no size estimate.
- **The owner's decisions**: only those that change what gets built and
  have no safe default, each with its context, the options and what each
  changes, and your pick. Decide the rest yourself.
- **What they allow**, only where it applies: publishing, private data as
  test fixtures, a spend cap (you stop at 90% of it), and whether the
  lanes start again by themselves when the sprint ends.
- When the owner will pick the result up and use it, **the scenarios**:
  "what are the first three to five things you'll do with it?" Map each
  onto the queue and play the gaps back plainly; the owner says whether
  each gap is new scope or a known limit.

Done when the owner has answered or said go, and every answer is in the
tracker: `just answer` for a question it already holds, else `just decide
--title "…" --why "…" --scope <units>` (with `--until` when they name a
time).

## 5. Launch

1. If the owner is leaving: with the lanes off nothing keeps the machine
   awake, so see that it stays up; and try now, while they can fix it,
   anything a permission prompt may block (copying private data,
   publishing, a paid call).
2. Write the brief, one file outside the repo (your scratch folder) that
   every worker's task points to. Workers follow the factory's own guide,
   which `just worker-guide` prints (the worktree's setup, the claim, the
   shared resources, the finish), so the brief holds only this run: the
   owner's decisions that bind it, by title; **what the worktrees share on
   this machine**, with a rule each on who may write to it and how; what's
   off limits; what's known to fail on main today; and the queue, with
   which worker owns which files. Keep the queue's state there, changed at
   every merge, and read it again after a compaction.
3. Each worker is a subagent in a git worktree of its own, run in the
   background so that its finish wakes this thread: in T3 Code, its
   `delegate_task` tool (async, a worktree, an implementation role);
   elsewhere the harness's own (in Claude Code, the Agent tool with
   `isolation: "worktree"`, in the background). Its task: the unit's title
   and ID, the decisions that bind it, the files other workers own, and
   "Run `just worker-guide` and read `<the brief's path>` first, and follow
   both. When I say main moved, merge it into your branch."
4. Start what can run now. One worker at a time holds a resource only one
   session can drive, and memory decides how many run (`just heavy`).

Done when every unit that can start has a worker, and the owner has a line
per worker saying what runs and what waits on what.

## 6. Oversee

Each time a worker ends its turn, or half an hour passes, act on what
moved, then give the owner one plain sentence per running worker.

- **A question.** Answer it where a default is safe, and `just decide` it.
  A real one goes to the owner, batched, with its context and your pick.
  If they're away, `just ask` it, so it waits in the tracker, and point
  that worker at something else or stop it.
- **A finished unit.** Read its final message, then its diff, yourself:
  does it do what the card's "done" asks, does its evidence show the
  card's check ran, do its claims about what's outside the diff hold, does
  it weaken the oracle or clash with a running worker's files? Clean:
  merge it in the repo's merge style, `git pull`, `just tracker merged
  --branch <its branch>` (which turns its unit from merging to done), and
  `just capped just check` on main before starting anything that needs it.
  Tell the running workers that main moved, then start the queue's next
  unit. A conflict is yours to settle in a scratch worktree, keeping both
  sides' intent. Wrong or incomplete goes back to its worker.
- **A stall or a miss.** Read the worker's thread, then nudge it, narrow
  it, or stop it: `just note <id> "…"` with where it got to, and see that
  the unit is ready again (`just reopen <id>` if it isn't).
- **Past the stop time, or spend at 90% of the cap.** Start nothing new,
  and let the running workers reach a clean stop.

**What a sprint's merge has been checked by, and what it hasn't.** A lane's
branch lands only after `just check` passes on it merged with main, a fresh
session reviews it, and the project's check before landing (`ci.land`)
passes. A sprint's has the worker's `just check`, one reviewer, your read,
and your check of main. The part of a unit's check that needs a resource
the workers stayed off has not run, and no group's CI has: drills, rebuilds
and publishing wait for the lanes. Keep a list as you merge, **merged but
unproven**: each merge, what still has to prove it, and the unit or the
group's CI that will.

Done when no worker runs and nothing in the queue can start.

## 7. Finish

1. Walk each scenario from step 4 on the real build, as far as you can
   alone: works, doesn't, or can't be checked without the owner.
2. Give back what you took: leases (`just tracker lease release <group>`),
   build daemons, merged worktrees and branches.
3. `just fleet on`. It lets go of the hold and prints the lanes that were
   running, with the command that starts each machine's again. Run that
   command only if the owner said in step 4 that the lanes start again by
   themselves; otherwise starting them is their call.

Done when `just status all` counts no unit as merging and `just status`
has no "Lanes: held off" line. Then one report:

- what merged: the unit in plain words, its pull request, one line;
- **merged but unproven**, from your list, and where each is filed (`just
  tracker ci` says which groups' CI is now due);
- what's left in the queue, and why;
- decisions made in the owner's place, and what waits on them (`just
  questions`);
- what you filed, any spend, and test data to delete;
- a short list of things to try, setup first;
- **the lanes are off**, which were running before, and the command that
  starts them.
