# Sweep

One of the two modes in which the owner works the factory by hand, with the
lanes off (SKILL.md, "Sweep and sprint"; the other is
[sprint.md](sprint.md)). The owner states a kind of work once ("sweep
shared work"), and this thread is the **foreman**: it keeps a full set of
workers on matching units, each in a git worktree of its own, reads and
merges every one's work itself, refills, and reports, until that work runs
out or the owner says stop.

A sweep spends usage the lanes can't: a lane is capped by its machine's
memory, heavy-job slots and one-at-a-time resources, and a sweep is wide
because its units stay off all three. There is no planning. The owner's
sentence is the whole brief, and the go-ahead to start workers, push their
branches and merge them; they're asked nothing that has a safe default.

It needs an origin (a worktree then reads the same tracker; a bare repo on
the same disk will do, [scaling-out.md](scaling-out.md)) and a harness that
runs a subagent in its own git worktree. Before the opening's gate is
passed, run the opening's queue instead ([opening.md](opening.md)).

## 1. Lanes off

`just fleet off --for "a sweep of <the owner's words>"` records on main
that the lanes are held off, with which were running and until when, and
asks each to stop after its unit (`--now` ends their sessions too). While
it holds, no lane starts on any machine. Go on to step 2 meanwhile.

Done when `just fleet off`, run again, exits 0: every lane has stopped. No
worker starts before that.

## 2. Pick

1. Read `AGENTS.md`, this machine's section of `docs/machines.md`, the
   spec's loop and oracle sections, and `factory/prompt.local.md` if there
   is one: they own the memory, resource, branch and check rules.
2. List what matches the owner's sentence: `just find <their words>
   --open`, `just status <group>`, and `just tracker queue` for the order
   the owner's priorities give.
3. Read each candidate's whole card (`just show <id> --full`): a tag or a
   `uses` can be wrong. Leave out, for the report:
   - what the tracker says can't start, and a card that waits on the
     owner's choice with no such choice in `just decisions <words>`;
   - a unit that `uses` a one-at-a-time resource, or whose work is hours
     of heavy jobs (or give the resource to one worker at a time, in its
     task);
   - a unit whose group's data another machine leases (`just tracker
     leases`). For data already here, `just tracker lease take <group>`
     leases it and copies nothing.
4. Order them: what other units wait on first, then the queue's order.
   Units that fix one thing share a worker and a branch. Units touching the
   same files can run side by side: warn their workers, and the conflicts
   are yours.

Done when you hold an ordered queue longer than your first batch (or all
that matches), every card in it read.

## 3. Brief

Workers follow the factory's own guide, `just worker-guide`: the worktree's
setup, the claim, shared resources, the finish. Your brief holds only this
run, in one file outside the repo that every worker's task points to:

- what the sweep is for, in the owner's words, and the decisions that bind
  it, by title;
- **what the worktrees share on this machine** (`work/`, an app's project
  folder, a device, a port, a build cache), each with who may write to it
  and how. List these first;
- what's off limits (a resource, publishing), and what already fails on
  main, by name.

The brief is **living**: a trap one worker hits goes in for the next, and
any running worker it can still hit is told.

Done when every shared thing has its rule in the brief, and a worker could
finish its unit from its card, `just worker-guide` and the brief alone.

## 4. Launch

Tell the owner in a few lines what you're starting, and start without
waiting for a reply: as many workers as the machine's memory allows
(`docs/machines.md`; `just heavy` shows what's available and the reserve
to keep free).

Each worker is a subagent in its own git worktree, run in the background
so its finish wakes this thread: in T3 Code, the `delegate_task` tool
(async, a worktree, an implementation role); elsewhere the harness's own
(in Claude Code, the Agent tool with `isolation: "worktree"`, in the
background). Its task: the unit's title and ID, any warning of its own, and
"Run `just worker-guide` and read `<the brief's path>` first, and follow
both."

Done when every slot is full or the queue is empty, and the owner has a
line per worker.

## 5. Merge

When a worker finishes, read its final message, then its diff. **Every
merge gets your own read, one at a time:**

- Does the diff do what the card's "done" asks, and does its evidence show
  the card's check ran?
- Do its claims about what's outside the diff hold: the API it calls
  exists, every caller of what it changed is updated, it agrees with the
  recorded decisions?
- Does it weaken the oracle, or clash with a running worker's files?

Then:

- **Clean:** merge it in the repo's merge style, `git pull`, then `just
  tracker merged --branch <its branch>`, which turns its unit from merging
  to done. If another merge of this sweep touched the same code, run those
  tests together on main.
- **Conflict:** yours to settle, in a scratch worktree: merge main in,
  keep both sides' intent, `just capped just check`, push.
- **Wrong or incomplete:** back to its worker, with what you found.
- **Nothing you can run proves it, and it changes something shared:** hold
  it, and bring the owner the options.
- **The worker failed or gave the unit back:** `just note <id> "…"` why,
  and see that the unit is ready again (`just reopen <id>` if not).

**What a sweep's merge has been checked by.** A lane's branch lands only
after `just check` passes on it merged with main, a fresh session reviews
it, and the project's check before landing (`ci.land`) passes. A sweep's
has its worker's `just check` on main as it was then, one reviewer, and
your read. Nothing has checked two merges together, or the part of a check
that needs a resource the sweep stayed off, and no group's CI has run:
drills, rebuilds and publishing wait for the lanes. So keep a list,
**merged but unproven**: each merge, and the unit or the group's CI that
still has to prove it.

Done, per worker, when its branch is merged, `just show <id>` says done,
and what the worker or its reviewer noticed is filed (`just find <words>
--open` first). A check that needs a resource or the owner's hands is a
unit of its own, raised above what merged on trust (`just tracker edit
<id> --priority`).

## 6. Refill, report, ask

Every merge frees a slot: fill it in the same turn, with a fresh follow-up
if it matches the owner's sentence and is worth more than the next in
line. When slots stay empty, find the limit: memory (`just heavy`: what
holds it?) or the heavy-job slots (the Heavy column of `docs/machines.md`
is the owner's to raise; start light units meanwhile).

After each merge, tell the owner in plain words what changed for the
project, what backs it, what it costs (a rebuild, CI now due) and what you
filed; then how many are merged and how many workers run. Titles first,
IDs after in parentheses.

Decide what a recorded decision covers, and say which you used. A call you
make in the owner's place is `just decide`. What has no safe default is
`just ask`, so it waits in the tracker while the sweep moves. Workers'
questions come to you, never to the owner.

Done, each turn, when no slot the queue could fill is empty and the owner
has heard of every merge.

## 7. Wind down

When the owner says stop, the matching work runs out, or usage runs low
(`just usage`; say so as soon as you see it):

1. Start nothing new. Offer to stop the newest and biggest workers; on a
   yes, stop each, read what it committed, and give its unit back with a
   note. Keep merging what the rest finish. (A pause for a usage reset
   isn't the end: refill when it rolls over.)
2. With no worker running and no branch of this sweep open, `just capped
   just check` on main, once, for all the merges together. A failure is
   the report's first line, and a unit.
3. `just fleet on` lets go of the hold and prints the lanes that were
   running, with the command that starts each machine's. Run that only if
   the owner said up front to start them afterwards; else it's their call.

Done when `just status all` counts no unit as merging and `just status`
has no "Lanes: held off" line. Then one report:

- how many merged, and what they add up to, by theme;
- **merged but unproven**, from your list (`just tracker ci` says which
  groups' CI is now due);
- decisions made in the owner's place, and what waits on them (`just
  questions`);
- what's left or was stopped, and why;
- **the lanes are off**, which ran before, and the command that starts
  them.

Last, move this run's traps from the brief into the project's docs or
`memory/`, and remove the merged worktrees and branches.
