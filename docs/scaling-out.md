# Scaling out

Everything in [SKILL.md](../SKILL.md) and its step files runs on one machine
with one lane. These are opt-in, in the order a factory usually needs them.
Read the part you need when the factory needs it.

## More lanes, or more machines

Lanes are the factory's parallelism: raise a machine's lane count in
`docs/machines.md` once the owner sees the tokens and CPU are there.
Inside a session, parallelize only work that's actually independent: for
read-only fan-out over many items (reviewing pages, probing files), use
subagents from one session, in batches of about 10 on a cheaper model, each
writing JSON, merged by a script. Shared hardware gets a lock: `flock
/tmp/<device>.lock <cmd>` inside the recipe that uses it.

**A second lane, or a second machine, needs an origin** (any git remote both
can push to; on one machine, a bare repo on the same disk). Then:
- **The state is origin's main.** The tracker CLI reads `tracker/` from a
  small clone of origin's main (`.tracker/main`, fetched before each command)
  and pushes every write there at once. If another lane pushed first, the
  write is done again on the new state, so of two lanes claiming one unit
  exactly one gets it and the other picks again. A unit's branch never
  carries `tracker/` changes, a question reaches the overseer within
  seconds, and nobody commits `tracker/` by hand. A unit done on a branch
  shows as **merging** (not done for what needs it) until the loop has merged
  it. Tracker JSON has a merge driver that keeps both sides' entries
  (`.gitattributes`: `tracker/**/*.json merge=tracker-json`), for the rare
  merge that still meets it.
- **Each unit is worked on its own branch** (`unit/<id>`). The session's
  last step merges the latest main into it, settles conflicts and reruns the
  checks (the unit's own check too, unless it's tagged `slow-check`); the
  loop runs `just check` once more, then merges the branch into main, pushes
  (merging and checking again if someone pushed first) and deletes it.
  A finished branch that couldn't land yet is pushed, and any lane on its
  machine lands it once the lane that worked it is gone. A branch the loop can't merge
  becomes a "Merge main on <machine> lane <n>" unit that only that lane
  takes, before anything else it can take, once it fits before the stop
  (with nothing to go by it needs `"min_unit_minutes"`, 45 by default: it
  runs the project's check) and unless a session of that lane gave it back
  this run. Until then the lane takes what fits, or stops, and the next run
  takes the merge first. An unfinished unit (pause asap, a session
  that died, a question for the owner) is pushed as its branch, and whoever
  claims it next, on any machine, carries on from it.
- **Every lane runs in its own plain clone** beside the checkout
  (`<checkout>-lane<N>`, made by `factory/lane.sh` when `just fleet` starts
  it), never a worktree, with `work/` linked to the machine's one `work/`;
  the checkout itself stays on main for the owner and the overseer. The loop
  resets its clone to origin's main between units, so `just loop` by hand in
  the checkout refuses to start over changes, untracked files or unpushed
  commits. Lanes on a machine share a lock folder, so they never take the
  same unit or the same resource; lanes on different machines meet on
  origin's main.
- **More machines:** add rows to the profile's Machines table and to the
  factory's `docs/machines.md` (hostname, ssh address, lanes, Heavy, Can,
  Cache, Reserve, GPU, and the checkout, at the same path on each). Every machine needs
  the skill installed (install.md) and ssh access from the others. What a
  machine alone can do is a **capability** in its "Can" column, and a unit
  that needs it says `--caps`; that, not pinning units to a host (`--host`),
  is what ties work to a machine. Don't assume which machine is the owner's
  everyday one: ask. `just fleet start` deploys the newest pushed skill on
  every machine it starts and pulls its skill checkout; the overseer starts
  on its own machine and asks "Want <the others> too?" without waiting, and
  adds a machine only when the owner says.
- A heartbeat keeps each machine's claims fresh: a machine asleep or offline
  for 30 minutes loses its units and CI to the others (its unpushed work is
  lost to them).

## Group data on a store

If units make data too big for git that later units of the same group need
(rips, exports, an editor's project folder) and more than one machine runs
the factory, the data lives on a **store** (a NAS or any machine reachable
by ssh; the profile's `store`) and moves by lease. A group declares `--data
k=v,…` (`just tracker add-group` / `edit-group`): the values its data paths
are filled with. `tracker/project.json` says where the store is and what a
group's data is:

```json
"store": {
  "remote": "nas:/tank/factory/<project>",
  "paths": { "out": "work/out/{group}", "proj": "~/Studio/Projects/{proj}" },
  "inputs": { "rip": { "local": "work/rip", "parts": { "common": "common", "own": "sets/{group}" } } },
  "reads": ["rip:common", "rip:own"]
}
```

Set `remote` once, by hand: usually the profile's `store` plus the
project's name (`scripts/profile.sh get store`). Once per new store,
`factory/store.sh init` makes its `stamps/` folder: a store without one (a
dataset not mounted, a wrong path) is an outage, never "nothing there yet".

Paths are directories, relative to the checkout or under `~`; a path naming a
value the group lacks is skipped. Inputs are read-only (downloads, extracted archives) and
copied down part by part, once per machine; a unit's `reads` overrides the
default `reads` (`none` for none). A unit's `data` names another group whose
data it works on, or `none` for a code-only unit in a group with data.

One machine at a time **leases** a group (`tracker/leases.json`, on main):
the claim of the group's first unit there takes the lease in the same push,
so a tie has one winner. The loop copies the data down (unless the copy
there is current: its stamp matches the store's); a second lane there waits
for that copy, or makes it if it failed. It copies the data back after every
unit whose work is on main, and releases the lease when that machine has no
more units for the group, or when its last lane stops. The store keeps only
merged work: a unit that ends unfinished (handed back, interrupted, a
question, a lane killed mid-session) has the store's copy put back over the
copy there, its outputs kept in `work/.store/aside/` until it's done or
dropped, and its card says where. They're kept for one more run of the lanes
there: a set still kept at the end of the next run, its unit not claimed
there since, becomes one to sort (below), and so does one whose unit is
parked or pinned to another machine. When the same unit is claimed again on
that machine, the loop puts that set back before its session if it holds
that unit's outputs alone, they were built from the commit its branch is on
now, the copy there is still the one they were made over, and nothing else
in it is waiting to reach the store (another lane's session or CI run,
another unit's outputs waiting to land, a copy back owed) (`store.sh restore`); otherwise its session is told to rebuild them before
trusting earlier notes about `work/`. A different unit never gets them. A finished unit
whose branch waits to land has its outputs held there, and copied back when
it lands. Neither happens while another session there is working on the
group; if a finished unit's outputs are in the copy when an unfinished one's
are put back, they can't be told apart, so both go aside as a set to sort. A
copy back is sent only over the copy it came from (`store-moved` if the store
has moved on since). A copy back that fails is tried again at each look
(after 2, 4, 8, 16, then every 30 minutes) until it goes through (event
`store-up-retried`), and an empty copy is never copied back or stamped
(`store-empty` if the store's has files). Only the holder writes a group's folder
on the store. A group whose data starts outside `groups/` on the store (a
shared pool, an import) is seeded with `just store seed <group> --from
<path>`: one script on the store moves the folder's data paths into
`groups/<group>/`, then a stamp is written by rsync, and the data is copied
down if this machine holds the lease (else the next claim's copy down brings
it). It refuses when another machine leases the group, or the group has files
on the store or a stamp other than an empty copy's (`bytes: 0`); run again
after a failure, it carries on where it stopped. Its first unit runs it, so a
lane never needs a shell write on the store. At equal priority, lanes prefer
groups their machine already leases; a unit of higher priority goes first
wherever its data is. A heartbeat
keeps a lease fresh; one silent for 30 minutes can be taken over. Each
machine's cache stays under its "Cache" in `docs/machines.md`: before a new
lease would go over, the least recently used groups that are safe on the
store are deleted; failing that, the lane takes only units needing no new
lease for half an hour. "Safe" is defined in [design.md](design.md). A copy down
over a copy not proven to be on the store moves what it replaces into
`work/.store/aside/`, less files the store has byte for byte and, unless a
lane worked on the copy, files matching `store.rebuilt` in
`tracker/project.json` (globs over `<name>/<path>` of files a pipeline step
rebuilds, whose differences don't matter, e.g. `"rebuilt": ["out/*",
"proj/Cache/*.bin"]`; `just tracker rebuilt add <glob> --why "…"` adds one)
and files still as the copy was last stamped (the store's own older copy,
replaced or deleted on the store since). A CI run writes the copy too, but
it runs main's code, so the files it wrote go into the stamp's listing when
it ends (`store.sh clean --since`), and it copies them back to the store,
stamped as the group's CI (`--up`), so a run or unit on another machine
doesn't rebuild them again. That's after a pass or a failure, not after a run
cut short or a step killed mid-way (out of time, its memory cap), and only when the run started on the store's copy with nothing
else here waiting to reach the store; a copy back that fails is owed and tried
again like a unit's, and one still owed when the store has moved on is
dropped (nothing in it is lost: it's main's). When nobody worked on the copy and every file
left is older than the store's, the set is deleted at once (event
`store-aside-old`). Any other set gets a unit, pinned to that machine, that
audits it (`just store aside audit <set>`), keeps anything
nothing rebuilds, and deletes it (`just store aside drop <set>`); the
template's `auto-mode.json` lets a lane run those. These units are filed in
a group of their own (`aside`, which every loop sees), at their data group's
priority but with none of its needs or parks, so sorting a set never waits
on the owner; a set whose group keeps no data any more gets one too. Sets appear
when a copy predates the store (once per group per machine, from before the
stamp listing) or when something wrote a group's folders
without its lease: a unit whose data is `none` or another group's, a folder
two groups share, a command run by hand outside the lanes. Give such a unit
the group as its data. `just store aside` lists the sets; `just store aside
sort` (run with every idle look, as each lane starts and as the lanes stop)
files any missing unit, also for a set
without a kind (from an older store.sh or a copy down cut short). A copy
that fails fails loudly: nothing is stamped or released on it. Sessions never copy data.
`factory/store.sh` does the copying (rsync over ssh, never a network
mount; rsync 3 or later on every machine, which on a Mac is Homebrew's,
since macOS's own is openrsync); `just tracker leases` and `just store status` show the state.

## Group CI

A step that verifies or ships a group's finished work (a reproducibility
drill, a publish) isn't a unit: it's the group's **CI**, which the tracker
works out from the group's units, so nobody reopens it or chains republish
units. Steps are defined once in `project.json` (`"ci": { "steps": {
"drill": { "cmd": "…" }, "publish": { "cmd": "…" } } }`) and a group opts in
with `just tracker edit-group <g> --ci drill,publish` (or its template's
`"ci": { "steps": [...] }`). CI is **stale** when a unit finished, was
reopened or was added since the last pass, and **due** when it's stale and
either the group is done for the night (nothing in it in progress,
interrupted, merging, in review, broken or ready; a unit in another group
that works on this group's data, `--data <group>`, counts as one of its
units here) or it has been stale `"ci_every"` minutes (`tracker/project.json`,
default 120; 0 = only once the group is done for the night). Due CI with
work left comes before the group's new units: `next` skips them (not its
`ci-fix`, nor one already started) until the CI has run, so a fault shows
while there's time to fix it. `just tracker ci` lists every group's state
and last pass; `status` shows what's due, running or broken. Broken CI is
tried again at once when its `ci-fix` is done, once main has moved and 6
hours have passed, or with `ci-retry`. Failing again on the same step after
its `ci-fix` was done, it's **known failing** (`just status` gives the
reason): the fix stays done, nothing more is filed, and it comes due again
when a unit of the group is done or main moves and 6 hours pass. One cause
breaking several groups' CI files one fix: a step failing on the same tested
commit within 30 minutes of another group's failure on that step joins that
group's open `ci-fix` (its `also` lists the groups in it, its card each
one's rows), and each comes due again when it's done; `ci-split <group>`
gives a group whose failure only looked alike a fix of its own. `just tracker publish off` holds back
every step that ships.

**The lanes run CI first.** At every look, before `next`, a lane asks for due
CI it can run (the group's machine, every step's `caps`, the group's data
leased here or free to lease, and the `uses` of every step free). Due CI goes
first at a resource: while one it needs is busy the lane takes other work,
but no unit using any of the run's resources (one free now would be taken
from it), and a lane that finds it free runs the CI rather than a unit that
wants it. The loop runs the
steps itself, no session: on origin's main, one at a time, each step's `cmd`
with `{group}` and the group's params filled in, exit 0 = passed, under its
`timeout` (minutes, default 120), tried again `retries` times (default 1).
Each step is a heavy job (`just capped`): it takes its share of the
machine's memory budget (its `mem`, which is also its cap, else its past
peaks, and 4G before it has any: give a big step its `mem`) and a heavy-job
slot, so it runs in the next turn the budget allows, and a `just capped`
inside it counts against its share. No turn within 8 minutes: the run is
given back, due again, and the lane takes other work meanwhile.
The run takes every resource its steps use as it starts and gives each back
after the last step that uses it, so it never waits mid-way: a publish's
editor is held while the drill runs, rather than the run sitting idle at
the publish step while a unit holds the editor.
A step that can't run yet, because something it needs before it starts
isn't so (say the group's outputs in `work/` belong to a session in another
lane), exits **79** with its last line saying what: the run is given back,
due again, with nothing filed, and the lane takes other work for a while (as
with no turn in the memory budget, which is exit 75 from `just capped`;
don't use 75 for this). The loop logs that line as the reason. The tracker
itself already holds a group's CI while a live session on this machine is
working on it (`just tracker busy --live` names those groups).
The output's last line per step is the pass's evidence, and a failure's
headline, before the lines that came ahead of it; the whole log is in
`runs/ci-*.log`. A failed step whose `on_fail` is `unit` (the default for
steps that don't ship) files `<group>/ci-fix` for the lanes; one whose
`on_fail` is `owner` (the default for steps that ship) files nothing and is
raised to the owner. A failure that holds back a publish is a `ci-broken`
event, any other a `ci-broken-noship`; the first one known failing is also a
`ci-known-failing`, and each after it is only a `ci-known-failing-again`; both name the group's units that
aren't done, with their state, since a step can fail for want of a stuck
unit's work. A pass that ran a step that ships is `ci-published` the first
time and `ci-republished` after.

**Work outside the group.** A change landing elsewhere (shared code, a
tool, an effects roll-out) can change what a group's build makes without
any unit of the group finishing. `just tracker ci-touch <group> --why "…"`
records one by hand, and the loop does it by itself once the project gives
`"affected"` in `tracker/project.json` `ci`: a command with `{old}` and
`{new}` (two of main's code commits, the newest outside `tracker/`) that
prints a line `<group><tab><why>` for each group whose build that range
changes (nothing for none) and exits 0. The project knows what each group's
build reads (an import graph, content-hashed build keys); the skill only
runs it. The lanes run it whenever main's code has moved past the last
commit it covered (the tracker keeps that commit, so it syncs like the
rest): after landing a unit, and at each look before picking work, so the
owner's own merges count too. One lane at a time on a machine; two machines
running it at once only touch a group twice. The first run records where
main is and touches nothing. A touched group's CI is stale as if a unit of
its own had finished (due by the same `ci_every` and night rules, the why
shown with the commit), and broken CI touched since its failure is tried
again as for a unit finished since. A run that fails or passes
`FACTORY_CI_AFFECTED_TIMEOUT` seconds (default 120) records nothing and is
tried again at the next look; the overseer gets one `ci-affected-failed`
event until it passes. `just tracker ci-affected` shows the hook and how far
it has got.

**The check before landing.** Night CI finds a unit that left the group's
copy ahead of git (a hand fix in `work/`, output from code nobody
committed) hours later, as a `ci-fix` for a session with no context. A
project can check each unit as it lands instead, with `"land"` in
`tracker/project.json` `ci`: `{ "cmd": "factory/ci {group} land",
"timeout": 15 }` (minutes, default 15). `{group}` is the unit's group, or its
data group when it has `--data`; a group with no CI gets no check. The loop
runs it in the lane's clone, on the lane's machine (which holds the lease
and the copy in `work/`), on the branch with main merged in once `just
check` passes there (a unit that committed nothing is checked on main),
before the review and before anything is copied back to the store, with
`FACTORY_UNIT` (the unit) and `FACTORY_UNIT_SINCE` (an ISO time: the first claim of its current round,
since it last landed or was reopened from done, so a retry after a failed
check still sees what the first attempt left) in its environment. Exit 0 lands it. Any other
exit doesn't: its branch is pushed and the unit goes back to ready on it,
with the output's last line as a note, so the next session carries it on
with the unit's context (`just tracker land-fail`); the third failure in a
row makes it stuck, for the overseer. Past its timeout it lands anyway and
night CI checks it (a `land-check-timeout` event for the summary). Exit 79
means it couldn't check (a crash, something it needs missing): that isn't
the unit's fault, so it isn't sent back or counted towards stuck; the
branch waits and is checked again at the next look, and the overseer hears
(`land-check-unrun`) once, then every two hours while it stays held, with
how long landings have been held, until a check runs again. So does a tracker that
can't say what to run. It's
skipped while the group's CI stands failed or its `ci-fix` is open, so a
group that already fails doesn't hold back every unit. Give the command's
heavy parts `just capped`; its time limit counts the wait for a turn. `just
tracker ci-land <unit>` shows what it would run. It checks the unit's group
(or its data group), then, with a store, each other group whose copy on
that machine has files written since the unit's round began, one after
another; the first that fails stops it. A group another unit or CI run on
that machine has at work is skipped (what changed it may be theirs), and
said in the log line, as is a group with no CI: what a unit leaves there is
found by that group's own CI, not sent back to the unit.

**Last call.** CI that changed since its last run, near the end, still has
to run before the lanes stop. So before the stop time (the lanes'
`--hours`, or an earlier one the overseer sets with `just fleet stop-at
09:00`) comes a last call: `"last_call"` minutes in `tracker/project.json`
(default 30, for the work in flight to land; at most half the run; 0 =
none). No time is added for CI: it runs as it falls due through the night,
and what hasn't run by the stop is named in the morning. Or now with `just
fleet last-call` ("wrap up and publish"). In last call a lane starts no unit that
would make CI on the machine run again: none of a group whose CI it runs
tonight, passed or not, or on that group's data (`tracker next
--skip-groups`), nor one using a resource that CI still needs. Other units
keep starting until the stop time (`just fleet last-call`, the owner ending
the night, starts none at all). The units in flight finish and land, and
every group whose CI is stale runs it; a lane stops once nothing is left it
may start. A lane that stops on time with CI not passed names those groups in its
stop reason, for the overseer's report. CI's steps get the resources they
use (an editor): a session whose unit uses one CI here needs tonight is
told in its prompt when it goes to CI (last call), so it can split what
won't fit, and when last call
begins it is told through its inbox to commit
what works, leave a note and end; `"last_call_grace"` minutes later (default
15) the loop ends it like pause asap and goes on to CI. Before last call, a
unit last call will hold back isn't claimed with less time left before it
than the least a unit like it needs: its `--min-minutes`, else the median of
past sessions like it, else `"min_unit_minutes"` (default 45; 0 = none).
The lane takes another unit or waits, and the morning summary says what was
held back.

**The morning summary** (`just fleet summary`) ends with each group's CI
since the run started: passed, failed (on which step, and how), cut off
(where, and why: pause asap, a lane stopped, a machine that went down), or
never started (and why it was due). The owner's page (`just tracker view`)
shows the same per group.

**Heavy units.** A unit whose work runs heavy jobs (a build, a render)
says `--uses heavy`: a built-in resource, the machine's heavy-job slots. No
lane is handed one while every slot on its machine is held (by another
lane's job, a long job, a CI step), so it doesn't spend its session queued
behind them.
