# A worker's guide: one unit of a sweep or a sprint

You work ONE unit of this factory (or the few your task names, in order, on
one branch) in a git worktree of your own. A **foreman** thread started you.
It reads your work, merges it, and answers what you can't settle. Other
workers run beside you on this machine, each in its own worktree on another
unit. The lanes are off: start none, and run no group's CI (a CI step may
publish).

Your task names the unit and the foreman's brief, a file with this run's
rules. Where the brief and this guide differ, the brief wins.

The lanes' worker rules and the project's own follow this guide. They hold
for you too, with three differences: you claim your unit yourself (Start);
no loop reviews or lands your branch (Finishing); and nobody will answer a
question while you work, but the foreman reads the message your turn ends on.

## Start

1. `factory/lane.sh worktree`, before anything else. It gives this worktree
   what a lane's clone gets (`work/` and `.env` linked to the checkout's, the
   `just` recipes, the project's `factory/lane-setup`) and prints the
   checkout's path.
2. A branch for the unit, from origin's main as it is now:
   `git fetch -q origin && git checkout -b unit/<id> origin/main` (or the
   name your task gives). If origin already has that branch, an earlier
   attempt was cut short there: `git checkout -b unit/<id> origin/unit/<id>
   && git merge origin/main`, and read its commits before you build on them,
   since nothing checked them.
3. `just claim <id> --branch`, then `just show <id> --full`. A claim that's
   refused (in progress elsewhere, its data leased by another machine, a
   check that can't be judged yet), or a card that waits on the owner's
   choice with no such choice in `just decisions <words>`: give the unit
   back (`just tracker unclaim <id>`) and end your turn saying so. Never
   waive a gate.

## While you work

- **What the worktrees share.** `work/`, and whatever else the brief lists
  (an app's project folder, a device, a port, a build cache), is one copy
  for every worker. Read it freely. Write there only what your unit must,
  and in a scratch copy where the project has a way to make one. Before
  writing a group's outputs in place, `just tracker busy --live` names the
  groups another worker is mid-way through: leave those.
- **A resource one session at a time can drive** (your unit's `uses`;
  `docs/machines.md`) is yours only if your task says so. Otherwise do all
  that can be done without it, leave the rest to the unit that checks yours
  (file one if there is none: `--uses` the resource, `--needs` your unit),
  and say exactly what only that check can prove.
- **Heavy jobs** go through `just capped` or `just long start`, as a
  lane's do: every worker shares the machine's one memory budget and its
  heavy-job slots (`just heavy`). They queue behind other workers' jobs, so
  run a single quick test directly, and the full check once, at the end.
- **A build here may be behind main** (`just status` lists the CI that's
  due). A test that only passes after a rebuild: say so and prove it on a
  scratch copy. Never fit a test to a stale build.
- **The oracle stays as strong as it is.** A test's expectation changes only
  under a recorded decision that names the owner's call.
- **Questions.** Never ask the owner in chat. Where a safe default exists,
  take it, `just decide` it and carry on. A call that is the owner's alone:
  `just ask` (options, what each changes, a default), and stop that part.
  Anything else you can't settle: end your turn on the question, its context
  and your pick, and the foreman answers.

## Finishing (in place of the loop's landing)

1. Commit by path.
2. **Review before the long checks**, so they run once, on reviewed code.
   One fresh reviewer subagent, waited on, gets the diff (`git diff
   origin/main...HEAD`), the unit's card and `CODING_STANDARDS.md` if the
   project has one. Ask for real bugs only, and whether the evidence you'll
   cite shows the card's check ran. Fix what's real.
3. `git fetch -q origin && git merge origin/main`, settle conflicts keeping
   both sides' intent, then `just capped just check` passes, with the unit's
   own check. A failure in files you didn't touch: run it once more, then
   on main, before you call it yours or not yours.
4. Push the branch (`git push -u origin HEAD`) and open a pull request
   against main if origin takes them; otherwise the pushed branch is what
   the foreman reads. Title: the unit's title, its ID in parentheses. Body:
   what was wrong, what changed, how it was checked (with the numbers), what
   the review found, what's left and which unit holds it. Leave the merge
   to the foreman, and ask before any force-push.
5. Record the unit as the lanes' rules say for its kind (`just done <id>
   --evidence "…"` citing the check's output and the pull request, a
   verifier's `--checker` for an independent one, `just recheck <id>` for a
   computed one). It shows as merging until the foreman merges it. If you
   can't finish: `just note <id> "…"` with where your commits are, `just
   tracker unclaim <id>`, and say why.
6. Your final message: the pull request's URL (or the branch) and its head
   commit; each unit's status; and what the foreman must know: files another
   worker may clash on, units you filed, what this makes rebuild or makes
   due for CI, and **what is claimed but not proven** until a rebuild, a
   check on a resource you stayed off, or the factory's CI.
