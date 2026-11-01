# Design notes

Why the tracker, the loop and the fleet are built the way they are. How to
use them is in [SKILL.md](../SKILL.md).

## The tracker

### Principles

1. **The owner sees titles, never IDs.** Everything the CLI prints puts the
   title first and the ID in parentheses. Text that refers to a unit uses
   `{unit:<id>}`, which the CLI expands, so an agent can't write a bare ID
   into anything the owner reads.
2. **Agents query; they don't read.** No session reads the whole tracker.
   `next` returns one unit with its context, and done units cost nothing.
3. **Status is computed where a check can see it.** Agents record only what
   no check can see: claims, blockers, questions, decisions, drops and
   judgement calls.
4. **One way to write.** The JSON is changed only by the CLI, which validates
   every write. `lint` catches a hand edit.
5. **A question is asked once.** Decisions are stored with their scope, and
   `ask` looks them up before it accepts a new question.

### Files

```
tracker/
  project.json        settings, resources, store, CI steps, schema version
  templates/<name>.json
  groups/<group>.json a group and its units (recorded fields only)
  questions.json      open and answered questions
  decisions.json      every decision, the owner's and agents'
  leases.json         which machine holds which group's data
  log.jsonl           append-only events
.tracker/             gitignored: the computed cache, the viewer, the state clone
```

**One file per group,** not one per unit and not one in total. With 4,000
units, one file each would make `git status` and the viewer slow. A single
file would make every write conflict with every other. A group (one
module, one phase) is also the unit of ownership: a machine works one
group's data at a time.

The files are pretty-printed with a stable key order, so diffs read well.
Writes take a lock and go through a temporary file plus a rename. The data
carries a schema version, and the CLI refuses a tracker newer than it
understands rather than corrupting it.

### The state is origin's main

With an origin, the CLI never reads or writes the checkout's `tracker/`. It
keeps a blobless, sparse clone of origin's main in `.tracker/main` (only
`tracker/`), fetches it before each command (at most every 20 seconds), and
commits and pushes every write at once. If the push is refused because
someone else pushed first, the write is thrown away and done again on the
new state. For a claim that means picking again, so two lanes racing for one
unit can't both get it, and two lanes racing for different units both do.

This is what lets a unit live on its own branch while its claim, notes,
questions and done reach every lane within seconds. The branch never carries
`tracker/` changes (the loop drops any before merging). Without an origin,
the checkout's `tracker/` is the state.

The few merges that do meet tracker JSON go through a merge driver
(`tracker merge-json`): lists of things with an id merge by id, objects
merge key by key, and the same field changed two ways is a conflict that
names the field. `merge=union` breaks JSON, so it isn't used.

### Status

Status is derived each time. The first rule that matches wins:

| Status | Comes from |
|---|---|
| dropped | recorded |
| done | the probe passes, or a recorded done with evidence |
| broken again | the probe fails after having passed |
| waiting on you | a block on an open question or gate |
| waiting on a resource | the resource's `free` probe says busy |
| waiting on other work | its needs aren't done |
| interrupted | a claim whose session is gone |
| in progress | a live claim |
| in review | done, waiting for a second check |
| merging | done on a branch the loop hasn't merged yet; counts as not done for what needs it |
| ready | none of the above |

A claim is interrupted when its process is gone (same machine) or its
machine's heartbeat is over 30 minutes old (another machine). Probes
declare their `inputs`, and the cache keeps a fingerprint of them, so
`refresh` reruns only the probes whose inputs changed.

**A check waits for the fixes it covers.** A check unit (one that judges
other units' fixes in the built thing; which units are checks is the
project's `checks.units`) waits for the open fixes of its group that name
it, or that its detail names, as if it needed them (`checks.ts`). Its
status, `next` and the card all see them; nothing is written into its
needs, so a fix that lands or is dropped lets it go with no edit. The link
is the `{unit:…}` reference the tracker already asks for: a fix filed from
a check's look names the check it came from ("look in {unit:x-check}"), and
a note saying a check waits on a fix names it too. Shared tags or moves
would need a field nobody fills in, and a whole group's open fixes would
hold every look behind unrelated work. A fix that needs the check, even
through other units, is left out, so this makes no cycle. A covered fix that's
stuck holds the check too: the look would show its defect. Only a parked
one doesn't. A check's card
also lists the open fixes its group's other checks found, not waited for:
a look sees the whole built thing, and whether one shows in this look is the
session's call before the look.

**A check needs its reference.** Whether a check has what it needs to be
judged (the original's frames of the same move, a reference render) is the project's
knowledge, so it's a hook (`checks.ready`), run before `next` or `claim`
hands a check out. Not ready, the check waits on the unit the hook names,
filed by the hook's `file` line if it doesn't exist; naming none it could
use, the check is stuck with the hook's reason, for the overseer. The hook
runs outside the lock, and what it found is recorded only if the check is
still unclaimed (another lane's hook may have passed meanwhile). Exit 75
(it couldn't tell here) hands the check out as before. One `next` runs the
hook at most eight times; past that, checks it hasn't vetted are passed
over until the next `next`, never handed out unvetted. Lesson 32.

**Claiming a unit in review is checking it.** The claim keeps who worked it
and their evidence, so the checker can record it done, and a check that ends
without a verdict puts it back in review.

### Questions and decisions

A question has a title in plain words, context, at least two options that
each say what they change, a default, a `scope` (which future units the
answer applies to) and `blocks` (selectors such as `tag:multi-hit`, so units
created later are blocked too). Answering writes a decision, links it,
unblocks every matching unit, and logs who answered and through what.
Agents record their own judgement calls as decisions too. A reversal is a
new decision that `replaces` the old one, which is then shown as replaced.

### The viewer

`just view` opens one self-contained HTML file, rebuilt on every write, with
the data embedded so it opens without a server. It has no editing: answers
go through a command, so there's one write path. No separate channel for
answering away from the computer, either: questions go to wherever the
owner reads the overseer (the profile's "Reports").

## The loop and the fleet

**Not built, on purpose:** pull requests or a merger agent (the session that
wrote the code settles its own conflicts, and the loop merges); Git LFS;
network mounts for data; an overseer that works units.

**Lanes.** Every lane takes any unit its machine can do. A resource (an
editor, a device) is a lock a unit takes, and a lane whose unit's lock is
busy takes something else. Each lane works in its own plain clone, never a
worktree, because a lane switches branches, merges and commits without
touching anyone else's index. Its `work/` links to the machine's one
`work/`.

**Branches.** The loop merges a finished branch into main from the lane
that worked it. One it couldn't land yet (origin unreachable, main red) is
pushed, and once that lane is gone any lane on that machine (where the
unit's outputs in `work/` are) may land it, one at a time: the tracker's
landing claim, held by the lane that worked the unit while it lives, says
whose it is. Never an earlier attempt's copy: another lane lands only a
copy pushed after the unit was finished. An unfinished unit's branch (pause asap, a dead
session, a question) is pushed, so either machine can carry on from it. A
branch the loop can't merge becomes a "Merge main" unit that only that lane
takes, before anything else; while it can't move (it waits on the owner,
say) the lane takes other work meanwhile. After three failures it's stuck,
for the overseer.
When main itself fails `just check`, no merge unit is filed: finished
branches wait, pushed, and the lane that found it stops taking units, since
nothing it worked could land. The overseer hears at once, stops the other
lanes, fixes main, and starts them again once it passes; a lane started
checks main again (it may have been fixed outside its code).

**Capabilities, not pins.** What ties a unit to a machine is a capability it
needs (`caps`) and the machine's "Can" column, not a hostname. Code shared
by a family of units is its own unit rather than a reason to keep them on
one machine.

**Usage.** The lanes read the plan's own numbers: every headless session's
transcript carries `rate_limit_event` lines with the share used and the
reset time, for the 5-hour window and the week. Under the profile's "pause
below" of the 5-hour window, every lane pauses between units and resumes at
the reset. Nothing acts on the week's figure: a fixed floor under it
(stop with 15% left) ended weeks early and left their last share unused,
and its replacement isn't settled yet. Each
machine only knows what its own last session saw, so readings carry their
time, and `just fleet usage` points at the newest.

**The session's shell.** A session's Bash runs `runtime/lane-bash.sh`
(through `CLAUDE_CODE_SHELL`, which Claude Code reads for its Bash tool and
not for hooks): plain `/bin/bash` whatever the owner's shell is, stdin from
`/dev/null`, and `unalias -a` appended to the setup snapshot the CLI takes
by sourcing `~/.bashrc`. Commands see `SHELL=/bin/bash`, so what they start
keeps its stdin. The PATH stays the owner's: the snapshot ends by exporting
the PATH the owner's own shell sets up interactively (`FACTORY_OWNER_SHELL`,
from the loop's `SHELL`), then the rest of the session's. Bash's rc files
don't build it (rustup's cargo, a pinned Java, pnpm came from `~/.zshrc` in
one factory), and a lane starts with systemd's bare PATH. The sessions also take the CLI's Grep and Glob tools:
without them the CLI puts its own ugrep and bfs in place of `grep` and
`find`. The owner's own sessions are untouched. The snapshot can't be
skipped (there's no setting for it), hence the strip after it. Before this,
sessions ran the owner's shell setup: commands failed on aliased tools'
flags, and a command that read the CLI's never-ending stdin sat out the
whole time limit.

**A job longer than the night.** A "hold" state that freed a lane while a
long job ran was designed and dropped. It touched claims, leases, busy
groups, CI and the data copy-back, and the job would have needed a checkout
of its own. A unit whose job runs past the stop time is too big; split it.

**The daemon.** One per machine, serving every factory on it, so that the
lanes don't hang off the overseer's chat. Lanes stay jobs of their own
(systemd units, or on macOS the skill's own supervisor) rather than the
daemon's children: a service's children die with it when
it crashes or restarts, and the way round that (`KillMode=process`) leaves a
restarted daemon unable to wait on them. So killing the daemon costs the
lanes nothing, and a restarted one picks them up from its records.
`oversee.sh start` writes a record of each lane; the daemon drops it when the
lane ends, and exits once it has none and nobody waits on it. Its service is
enabled at login, and a record from another run of the service manager is a
lane the machine's going down cut off (a reboot, a crash, a logout): it's
brought back with what's left of its time, unless the stop time has passed,
the owner's last call had begun, or the machine went down within half an hour
of the last two resumes (then it stays down, and the overseer hears). A timed
last call is working time, so a lane cut off in it comes back into it, by the
last call its factory's lanes on the machine last wrote to their lock folder
(after a reboot, which empties it, by "last_call" alone). It restarts on
failure, never after a clean exit, and a deploy restarts it onto the new copy.
It answers `fleet wait` for its machine over a socket, which other machines
reach by ssh, with no network port. Everything it and the runtime ask of the
OS goes through `runtime/src/os.ts`, in the runtime's terms: systemd and
cgroups in `os/linux.ts`, macOS in `os/darwin.ts`.

**macOS without launchd.** launchd takes an agent only into a session at
the screen, and only root can put one in the background session, so an
account reached over ssh alone (the usual way a Mac in a closet is run)
can't start one. A job on macOS is instead a supervisor of the skill's own
(`os/darwin-job.ts`), started detached: it runs the command in its own
process group, records how it ended, stops everything it started, and runs
its end step, as a systemd unit would. The daemon's service is such a job,
started by the user's crontab at boot and checked by it every minute. There
are no cgroups either, so a memory cap is a watch (`os/darwin-cap.ts`) that
adds up the footprint of every process in the run once a second and, over
the cap, kills the biggest and then, unless the run carries on, the rest,
as Linux's kernel and systemd do. It isn't the kernel's limit: a run that grows fast passes its cap until
the next look.

**The overseer attaches.** Which thread oversees is factory-wide, so it's
kept with the leases on main: the newest `fleet attach` wins, and the old
thread's next `fleet wait --as <id>` says it was replaced. The journal is the
lanes' `runs/events.log` and each machine's `runs/oversee.log` (every wake,
and the overseer's own notes), kept outside git; attaching catches up from
it since the last overseer's last note.

## Group data on a store

- The store holds the true copy of each group's big files. One machine at a
  time leases a group; only the holder writes its folder.
- A claim of a group's first unit on a machine takes the lease in the same
  push, so ties have one winner. A heartbeat keeps it; 30 minutes of silence
  and the next claim takes it over.
- The loop copies the data down with a new lease (only when the stamps
  differ) and back after every unit, finished or not, and after every CI
  run that rebuilt some of it (lesson 31): CI runs main's code, so what it
  writes is merged work, and a laptop taking the group over from the
  store's older copy redid the whole rebuild every time. Inputs (read-only
  data such as downloads or extracted archives) are copied down part by part, once per machine.
- **Safe to delete** means the stamp matches the store's and `rsync
  --dry-run` has nothing to send, or the store has moved on (a finished copy
  back newer than this one, never a torn or older one) and every file is
  exactly as listed when the copy last matched the store. The first rule
  alone would never free a copy another machine has superseded.
- A copy down over a copy not proven to be on the store moves what it
  replaces into `work/.store/aside/`. That's how a migration deletes nothing
  locally.
- A store without its `stamps/` folder (a dataset not mounted, a wrong path)
  is an outage, never "nothing there yet".
- Every rsync has an I/O timeout, and ssh a keepalive and BatchMode, so a
  laptop asleep or a wifi change can't hang a lane.
- History comes from the store's own snapshots (on ZFS: hourly kept 2 days,
  daily kept 2 weeks), which gives an undo without keeping every version.

## Group CI

A step that verifies or ships a group's finished work isn't a unit, so
nobody reopens it or chains "republish" units. The tracker works out the
state:

- **stale:** a unit finished, was reopened or was added since the last pass
  (a unit of another group that works on this group's data counts);
- **due:** stale, and the group is done for the night (nothing in progress,
  interrupted, merging, in review, broken or ready), or it has been stale
  `ci_every` minutes (default 120). Due CI comes before the group's new units,
  and each step takes its turn in the machine's memory budget like any heavy
  job, so CI runs through the night rather than all at once at last call,
  where every group's heavy steps at once can run the machine out of memory;
- **broken:** failed since the last pass. It's tried again once main has
  moved and 6 hours have passed, when a unit of the group is done, or after
  `ci-retry`;
- **known failing:** broken again on the same step after its `<group>/ci-fix`
  was done. A failure a fix didn't cure isn't the end of the world, and
  sticking the fix only left the group for the overseer to get moving, so
  the fix stays done and the failure is marked known, with the step and the
  fix's last note as the reason. Like broken it holds nothing and files
  nothing more; it comes due when a unit of the group is done after the mark,
  or once main has moved and 6 hours have passed (a shared cause may be cured
  on main). `status`, the overseer's wake (`ci-known-failing`, once) and the
  morning summary give the reason; the next pass clears it. Another step
  failing after the fix starts a new cycle: the fix is reopened for it. A
  fix done after the failing run started wasn't in that run, so it says
  nothing of the fix: CI is tried again at once.

One cause can break several groups' CI at once (a file they all read), and
filing a fix per group had several sessions make the same fix. So a step
failing on the same tested commit within 30 minutes of another group's
failure on that step joins that group's open `ci-fix` instead: the fix
lists the groups that joined (`also`), its card gets each one's failing
rows, and each group's CI comes due again when it's done (and is known
failing if the fix didn't cure it). The fix stays the first group's: its
`uses` and data lease, since the session works on the shared code. Only the
same commit counts: a group tested after main moved files its own, which
misses some shared causes but never joins two failures of different code.
A session that finds two failures only look alike splits one off with
`ci-split <group>`, which files that group a fix of its own. A pass settles
a shared fix only once every group in it has passed (one group's pass says
nothing of the others' failures), and reopening a shared fix that was done
for a new cycle first retries the groups it was done for. A group in a
shared fix that fails another step leaves it (the step the fix is for
passed, or wasn't reached there) and is judged on its own.

A group's build can change without any unit of it finishing: shared code
or a tool landing in another group (effects roll-outs, a fix to a shared
module) left every group's CI "passed" overnight, and nothing was
republished. Units naming the groups they affect, or groups declaring the
paths they read, would each copy into the tracker what only the project
knows (its import graph, its build keys), and miss merges made outside the
lanes. So the project gives one command (`ci.affected`) that maps a range
of main to the groups it changes, and the loop runs it whenever main's code
moves past the last commit it covered, recording each as a touch on the
group (`ci-touch`): stale like a finished unit, and a retry for broken CI.
The covered commit lives in the tracker, so every machine shares it, and a
failed run records nothing, so no range is skipped.

Night CI finds a unit that left the group's copy ahead of git hours later,
as a `ci-fix` a session with no context has to untangle (14 groups at one
last call). The check before landing (`ci.land`) runs the project's quick
check on the merged tree in the lane that worked the unit, where its copy
in `work/` is, and sends a failure back to the same unit with the check's
last line, not to a new fix. It's skipped while the group's CI stands failed
or its fix is open (or every unit of a group that already fails would be
held), and a timeout lands the unit: the lane mustn't be held by a queue
for a heavy-job slot, and night CI still covers it.

A pass records the steps that ran, the commit tested, the start of the
run and how long it took, so a unit finished during the run makes CI stale
again. A run cut short is recorded as cut off, so the morning summary can
tell "cut off" from "never started". Steps that ship default to `on_fail: owner` (raise
it, file nothing); other steps default to `on_fail: unit`, which files a
`<group>/ci-fix` unit for the lanes.

Last call (default 30 minutes before the stop) holds back only what would
make CI here run again: units of a
group whose CI the machine runs tonight, or on its data, passed or not, and
units using a resource that CI still needs. Everything else keeps starting
until the stop time, and a unit that doesn't fit is ended at the overrun,
its work pushed: a factory with no CI used to lose its last hour every night,
and sessions see the stop time and split what won't fit. A lane in last call
stops the way it does at any other time, once nothing is left it may start.
`just fleet last-call` ("wrap up and publish") is the owner ending the night
now, so it starts no unit at all.

One queue at a resource, CI first. A CI run takes every resource its steps
use as it starts and keeps each to the last step that uses it, and due CI
waiting for a resource gets it before a unit that wants it; while it waits
on one, no unit starts with any of its others, or a run needing two could
wait behind units forever. Taking each as
its step came had a run wait up to an hour mid-way at its publish step for
the editor while its lane did nothing; it now waits before its first step,
and its lane works other units meanwhile. An hour's reserve before last
call, when no unit using what CI needs could start, used to keep the
editor free for CI (14 Oct: a unit resumed 7 minutes before last call held
the editor 40 minutes past it, and 18 groups' CI never ran). The wrap-up
alone caps that case (`last_call_grace`), and the reserve idled the editor
for most of the last two hours every night, so it went. A session using a
resource CI needs is told in its prompt when that resource goes to CI.

No CI reserve either (#159). Last call used to come early by as long as the
CI still to run here took last time, plus the wrap-up. One night (28 Oct)
that estimate swung between half an hour and three hours as the other
laptop's merges made groups due again, so last call jumped about under
claimed units, came over three and a half hours early, and the lane spent
those hours rebuilding the same groups. CI already runs whenever it falls
due through the night and goes first at a resource, so the reserve wasn't
what got it run. Last call is `last_call` minutes again, and what CI hasn't
run by the stop is named for the morning.

A unit is claimed only if it fits. Sessions that claimed an editor unit 40
minutes before last call read its card, saw it couldn't fit, and gave it
back: five in five minutes that night. Before last call the loop now passes
over a unit last call will hold back when the time left before it is less
than the least a unit like it needs (its `--min-minutes`, the median of
past sessions like it, or `min_unit_minutes`, 45 by default), and the lane
takes another unit or waits for last call.

## Deploying

The loop's code lives only in this repo. Each machine deploys a commit
that's been pushed (`scripts/deploy.sh`) into its own folder and points
`current` at it, so an edit in progress never reaches running lanes. A
running loop keeps the version it started with (`FACTORY_SKILL`,
inherited), so a deploy mid-run never mixes versions, and a replaced
version is kept for two days or while a process still runs it. A factory's
`factory/` holds stubs that run the deployed copy, and `just` reads the
recipes through a link the stubs keep. The stubs set
`allow-duplicate-recipes`, so a recipe the factory defines too is the
factory's: a recipe added here later can never break a factory's `just`.

## Landing, apart from the loop

`runtime/loop.sh` grew past 1,000 lines of bash, with landing, branches,
leases and pauses interleaved, and the bugs clustered where they met. In
the TypeScript loop, branches and landing are their own module
(`runtime/src/landing.ts`), which the loop hands what it needs (the
tracker, the check, its log and events), with unit tests of their own
(`runtime/test/landing.test.ts`) beside the lanes racing in
`test/branches/`. (The store suite's ssh-backed case, the other
candidate this section named, is in: a fake ssh that refuses or stalls.)

### The review before a branch lands

24 Oct: one project's lanes landed 31 units and one was reviewed; bugs
from the rest surfaced in later units and on the device. Its spec asked
for a review in a section lanes never get, and `prompt.md` asked for a
verifier only for `independent` units. So the loop reviews every finished
branch itself (`runtime/src/review.ts`): the reviewer gets a diff and
needs no exploring, while the session that did the work is the one short
of context, which makes review the cheap place for a project's standards
(`CODING_STANDARDS.md`).

- **After the check, not before.** A branch that fails, or a red main,
  spends no review; and the review runs once per landing, however often
  main moves under the push.
- **A fix goes back to the unit, on its branch.** Its findings go on the
  card, and the next claim carries the branch on. A second fix makes it
  stuck: two rounds the reviewer and the lanes can't settle are the
  overseer's, not a loop.
- **No verdict lands.** A reviewer that can't run (a wrong model, the CLI
  failing, a usage limit, a verdict that won't parse) would otherwise hold
  every branch all night, the stall the audit found landing could cause.
  The check, the hard gate, has passed; the unit gets a note and the
  overseer a `review-skipped` event.
- **Not a turn in the memory budget.** The lane runs the review in place
  of a session, never beside one, and sessions take no turn either; a
  turn would reserve 4G for a process a fraction of that (#116).
