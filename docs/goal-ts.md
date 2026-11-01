# Goal: the factory in TypeScript, run by a daemon

This file says what we're trying to do, why, how we'll know it worked, and
what was already decided. It doesn't prescribe the code: how to lay out
modules, name types or split files is yours to work out, as long as the
result meets everything here. Read it whole before starting a phase, and
again before calling one done.

Read these first: [design.md](design.md) (why things are the way they are),
[lessons.md](lessons.md) (the incidents behind the rules) and
[../AGENTS.md](../AGENTS.md) (tests and conventions). A change that undoes a
rule there has to answer the lesson behind it, and the port is no exception.

## What we're doing

Today the factory is about 3,000 lines of Node JavaScript (the tracker,
`tracker/tracker.mjs`) and about 3,500 lines of bash (the runtime,
`runtime/*.sh`, with `runtime/factory.just`). We're moving all of it to
TypeScript, and then putting one long-running process on each machine, the
**daemon**, in charge of the lanes.

## Why

1. **The bash has outgrown bash.** `runtime/loop.sh` is about 1,500 lines
   with landing, branches, leases and pauses interleaved, and design.md
   already names it as the open problem: bugs cluster where those meet.
   `store.sh` is about 950 lines. The loop calls the tracker 83 times as a
   separate process; in TypeScript those become function calls that share
   one loaded state and real types.
2. **Set and forget.** Today the lanes hang off the overseer's chat: the
   overseer starts them over ssh and watches them with `just fleet wait`. If
   that chat dies, nothing notices a stopped lane until the owner looks. The
   goal is the reliability of a process manager like pm2: one process per
   machine, restarted by the OS if it crashes, which keeps the lanes running
   whether or not anyone is watching.
3. **One place for the rules.** Much of `runtime/oversee.md` is mechanical
   (wait, sort events into wake-now and morning-summary, write the heartbeat
   line). Code is the better home for rules; the prompt keeps the judgement.

## Done when

The goal is met when all of these are true:

1. No logic is left outside TypeScript (the glue rule, below).
2. The four test suites pass at every commit, and they're TypeScript by the
   end (phase 4), each old check kept or replaced by one that's at least as
   strict.
   Done 2026-10-19 (phase 4): every suite is on `node:test`, and no bash
   suite is left.
3. Each machine that runs lanes has one daemon, kept alive by a systemd user
   service. Killing the daemon with `kill -9` leaves the lanes working, and
   the restarted daemon picks them back up. A test shows this.
4. "Oversee" in any new chat thread attaches to the running factory, catches
   up from the journal, and watches it. An older overseer thread still alive
   is told it's been replaced and stops. Tests show both.
5. Every existing factory keeps working through
   every commit of the port, with its `factory/` stubs, `just` recipes and
   `tracker/` data as they are, or migrated by a command that ships in the
   same commit as the change that needs it.
6. A real overnight run on a real factory, with two machines, goes as well
   as the bash version's nights did: no restarts by hand, no lost work, CI
   run at last call. The maintainer judges this one; arrange it with them
   before calling the goal done.

## Decided

These were settled with the maintainer. Don't reopen them; if one turns out
to be impossible, stop and bring it back with what you found.

- **Order:** the tracker first, then the runtime, then the daemon, then the
  test suites. SQLite is a later goal (see "Later").
- **No container.** A lane runs the factory's whole toolchain (an editor,
  Blender, a game's build tools), so an image would have to hold every
  factory's tools, or each factory would need its own image. The daemon runs
  on the host instead.
- **Linux only for this goal.** macOS isn't a target; nobody can verify it.
  (Since ported, after this goal: see "Later", macOS.)
  Keep the OS-specific parts in one place so a later port has one place to
  go, but don't build or guess at the macOS side.
- **systemd stays, behind one OS module.** The runtime uses systemd for four
  things: running a lane, the overseer or a long job so it outlives the shell
  that started it (`systemd-run --user --unit`); asking whether one is
  running (`systemctl --user is-active`, `show`); killing a whole process
  tree (`systemctl --user stop`); and memory caps (`systemd-run --scope -p
  MemoryMax=…`, read back by `just capped`). Plus `systemd-inhibit` to keep
  the machine awake, and the daemon's own service. All of it goes through one
  Linux module behind an interface that says what the runtime needs (run
  this detached under a name, is it running, stop it and everything it
  started, cap its memory, keep the machine awake), not how systemd does it,
  so a macOS port fills in the same interface (decided in phase 3).
- **Node 26, pinned and shipped.** `scripts/deploy.sh` (or its TypeScript
  replacement) downloads the official Node 26 build for the machine's
  architecture, checks it against the published checksums, and keeps it
  beside the deployed version. Every stub runs that Node, never the system's:
  Debian 12 ships Node 18 and Debian 13 ships Node 20, both too old. Node 26
  runs `.ts` files directly (type stripping) and has SQLite built in, so
  there's no build step and the runtime has no npm dependencies. Type
  stripping only removes types: no `enum`, no `namespace`, no constructor
  parameter properties, and imports name the `.ts` file.
- **The glue rule: no logic outside TypeScript.** The only files that aren't
  TypeScript are: the `factory/` stubs, each of which runs exactly one
  TypeScript command with its arguments; the `just` recipes, each of which
  does the same; the systemd unit file for the daemon; and the prompts.
  No `if`, no loop, no pipe in any of them. Anything that needs one belongs
  in TypeScript. This deliberately leaves no "small glue" category to grow.
- **The overseer stays a chat thread.** The maintainer likes the one-thread
  overseer: it keeps itself awake and its prompt cache warm by waking at
  least every 30 minutes, and the threads don't get too long. That stays.
  What changes is that the thread is no longer what keeps the factory
  running; the daemon is (phase 3). The 30-minute wake only keeps the cache
  warm because these sessions use a 1-hour prompt cache; keep the wake
  interval under whatever the cache's lifetime is.
- **The journal isn't committed.** What the daemon logs and what the
  overseer notes stay on the machines, outside git (see phase 3). The
  tracker's own `tracker/log.jsonl` stays in git as it is.
- **Type checking.** `typescript` is the one dev-only dependency, never
  shipped to machines, with `@types/node` (its types for Node's own
  modules, without which nothing that imports `node:fs` type-checks).
  `tsc --noEmit` passing is a fifth check that must pass at every commit,
  like the four suites.
- **One daemon per machine,** serving every factory on it, because heavy-job
  turns and the memory budget (#7) are per machine.
- **One bash exception: `runtime/capped-step.sh`.** The step
  `just capped` runs inside the memory-capped scope, around the command,
  reads the kernel's counts (the cap reached, kills of any kind) and the
  peak before the scope disappears. Whatever runs there counts against the
  job's cap: Node needs about 15 MB of it (the suite's 20 MB caps killed
  it), bash almost none, and it must still work when the scope is full. So
  that step stays bash and the rest of `capped` is TypeScript. Reviewed
  after the rewrite (#22): the memory budget (#7) still reads these numbers
  in the scope, so the step stays; no other bash logic joins it. A long
  job's wrapper in its service (`main.mjs long run`, which also waits its
  turn there) is Node, about 15 MB of its cap.
- **The lane's shell is bash: `runtime/lane-bash.sh`.** Claude Code runs it
  for every command a session runs (`CLAUDE_CODE_SHELL`; the path must name
  bash or zsh), so it is the shell itself, and Node's start-up on every call
  would buy nothing. It stays short: stdin, `SHELL`, the alias strip, the owner's PATH.
- **The bootstrap stays bash, for now: `scripts/deploy.sh` and the
  `factory/` stubs that pick a copy (`factory/skill`, `factory/deploy`,
  `factory/tracker`).** Something has to choose which copy of the skill runs
  and on which Node, and bring Node 26 onto a machine that has only the
  system's, before any TypeScript can start; the suites also source
  `factory/skill` directly. The maintainer decided (#21) to keep these in
  bash rather than move the first download into `launch.mjs` as plain
  JavaScript. Every other stub runs one command, and every recipe in
  `factory.just` runs one command. Review it with #22, once the daemon exists.
- **No lingering, for now.** A systemd user service only runs while the
  user has a session (a desktop or ssh login) unless lingering is on
  (`loginctl enable-linger`). The maintainer isn't ready to turn that on, so
  the daemon relies on the machine being logged in, as the lanes do today: it
  starts with the user's session and stops with the last one. Don't run
  `enable-linger`; a later goal may. When the daemon starts and lingering is
  off, it says once that it stops if the user logs out.
- **Lanes stay systemd units (phase 3).** The daemon doesn't make lanes,
  long jobs or capped jobs its own child processes. A service's children die
  with it when it crashes, restarts or stops (systemd's default), and the
  only way round that (`KillMode=process`) leaves a restarted daemon unable
  to wait on them and lumps their memory into its own. So lanes keep running
  as their own units, named as today, and the daemon finds them again by
  name and by its records after any restart.
- **The daemon runs only while the factory is on (phase 3).** `fleet start`
  writes a record for each lane it starts; the lane's orderly end (stop,
  pause, last call, out of time, `fleet stop`) removes it. The daemon exits
  once it has no records and no one waiting on it. Its service is enabled at
  login, so after a reboot, a crash or a logout it starts again, and if
  records say lanes were cut off it brings them back. It restarts on failure
  (`Restart=on-failure`), not on a clean exit, with systemd's start limit
  against a crash loop. Lanes are brought back only if the deadline hasn't
  passed and the owner's last call hadn't started (since #100: a timed last
  call is working time, and the lane comes back into it), and not again once the machine has
  gone down twice soon after bringing them back: then it leaves an event
  for the overseer and the owner.
- **A deploy restarts the daemon onto the new copy at once (phase 3).** The
  lanes are units, so they don't notice; each keeps the copy it started
  with. The daemon runs the newest deployed copy and reads records and units
  written by older ones, so its record format stays readable by the next.
- **No push notifications or other new channels** to reach the owner when no
  overseer is watching. The owner is asleep; questions wait in the tracker
  under their defaults, as they already do.

## The phases

Each phase ends with all four suites passing and a commit. Commit as you go
inside a phase too: one piece of behaviour at a time, each with the suites
passing. Never a long-lived half-ported state.

### Phase 1: the tracker in TypeScript, still on JSON

Split `tracker/tracker.mjs` into TypeScript modules with real types for the
tracker's data (project, group, unit, question, decision, lease, log entry).
Behaviour, output text, exit codes, file formats and key order stay exactly
the same. `tracker/test.sh` passes unchanged, and so do the other three,
which call the tracker too.

The data layer is the part a later goal swaps for SQLite, so keep reading
and writing the state behind one module with a narrow interface. Don't add
an abstraction for a second backend that doesn't exist yet; just don't let
JSON details leak out of that module.

`factory/tracker` (the stub) runs the TypeScript entry point with the pinned
Node. `FACTORY_TRACKER` still overrides which file runs.

### Phase 2: the runtime in TypeScript, same architecture

Port every script in `runtime/` and the recipes' logic in `factory.just` to
TypeScript, and `scripts/deploy.sh`, `init.sh`, `profile.sh` and the other
scripts the stubs or recipes run. **Same architecture:** lanes are still
systemd units with the same names, the fleet still reaches other machines
over ssh, events still go to the same files in the same line format. The
suites pass unchanged; that's how we know the port is faithful. They look at
systemd unit names (`factory-$P.*`) and shim `systemctl` for the
out-of-memory test, so the names and calls those rely on are part of the
contract in this phase.

The loop calls the tracker in-process instead of spawning it. Each
`factory/` stub keeps its name and flags, so a factory's `just` recipes and
the prompts don't change.

A good order is from the leaves in: `machines`, `profile`, `usage`,
`inbox`, `heavy`, `capped`, `long`, `session`, `lane`, `store`, `fleet`,
`oversee`, and `loop` last. Run the whole suite set after each.

The scripts' `--help` text (the comment block AGENTS.md describes) becomes
each command's help in TypeScript, kept current the same way.

### Phase 3: the daemon

One daemon per machine, run by a systemd user service that is enabled at
login and runs while the factory is on (Decided). Lanes, long jobs and
capped jobs stay systemd units, as in phase 2 (Decided); the daemon keeps a
record of each lane that should be running, and supervises through the OS
module. Memory caps still use a systemd scope on Linux, because that's what
makes the kill exact.

What it must do:

- **Outlive its own crashes.** Killing the daemon leaves the lanes running
  (they're units of their own), and a restarted daemon picks them back up
  from its records and their units, rather than losing or duplicating them.
- **Bring the lanes back after the machine went down** (Decided: a reboot, a
  crash, a logout), with the protections there.
- **Keep versions straight across deploys.** A running lane keeps the
  version it started with (LESSONS 20). A daemon restarted onto a new deploy
  leaves old lanes on their version until their unit ends, which is what
  `fleet restart` does today.
- **Know what `just fleet` does.** Start, pause, pause-now, stop, restart,
  last-call, stop-at, tell and tidy still act on each machine through
  `oversee.sh` there, over ssh to other machines, since the lanes are still
  units; the records tell the daemon which lanes should be running. Don't
  open a network port: the daemon listens on a socket in the user's runtime
  folder, and other machines reach it by ssh.
- **Do the waiting.** `just fleet wait` keeps its output and exit codes but
  asks the daemons instead of polling lane files itself. The sorting of
  events into wake-now and morning-summary stays one list.
- **Keep the machine awake** while lanes run, and let it sleep once the last
  lane has tidied up (LESSONS 13). Each loop holds its own inhibitor until it
  exits, after its tidy, as in phase 2; with lanes still units, that stays
  the exact moment, so the daemon doesn't hold another.

**The overseer attaches; it doesn't own anything.** "Oversee" in a thread
means: if no lanes are running, start them (today's step 2); either way,
read the journal since the last overseer stopped, give the owner one
catch-up message, and start the background wait. If the thread dies, the
daemons and lanes carry on, and the next "oversee" picks up from the
journal.

- **The journal** is two things, both kept on the machines and outside git:
  the events the lanes and daemons log (`runs/events.log` today), and the
  overseer's own notes: what it decided, what it told the owner, what it's
  waiting for (today's `runs/oversee.log`, which becomes required). An
  overseer writes its notes on the machine it runs on. Catching up reads
  every machine's journal it can reach, merged by time, the way `fleet
  events` already reaches every machine.
- **One overseer at a time.** Which thread is overseeing is factory-wide
  state, so it goes where the tracker's state goes (origin's main, like
  `leases.json`): a small record of the overseer's session and machine. The
  newest "oversee" wins. The old thread's next wait returns "replaced by
  another overseer" (a new first line, exit 0), and `oversee.md` tells it to
  stop.
- **What moves out of `oversee.md`:** only the waiting and lane supervision.
  The judgement in its procedure (what each stop means, what to tell the
  owner, when to restart after a failure) stays in the prompt for this goal.
  Rewrite steps 1 to 3 of its procedure for attaching, and leave the rest's
  meaning alone.

**Tests in this phase.** Phase 3 changes what some checks in
`scripts/test-loop.sh` look at: they read systemd units that are now the
daemon's children. Change those checks to look at the same behaviour through
the daemon, one at a time, and say in the commit message for each why the
old expectation no longer applies and what now checks the same thing. A
check about behaviour (a lane stops, a job is killed over its cap, a stuck
unit wakes the overseer) is never removed, only pointed at the new
mechanism. New tests: the daemon killed and restarted with lanes running;
a deploy while lanes run; two overseers attaching; catch-up from the journal
after a gap.

### Phase 4: the test suites in TypeScript

Port the four suites to TypeScript on `node:test`, check for check. Keep
them black-box: they drive the commands and read files and output, as now,
so they stay a check on behaviour and not on the code's insides. Unit tests
of single modules are welcome alongside, not instead.

Before deleting a bash suite, prove its replacement catches what it caught:
take a few of the fixes in `git log` that came with a test (AGENTS.md
requires that), put each bug back, and confirm the TypeScript suite fails
on it where the bash one did.

**Decided with the maintainer, 2026-10-19:**

- **Behaviour, regrouped.** Every bash check is kept or replaced by one at
  least as strict. A check on bash mechanics (a process title, a grep of a
  script, a `pgrep` pattern) is rewritten to check what the owner, an agent
  or a lane sees. Tests are grouped into files by area, so `node --test`
  runs them in parallel; each file makes its own temp factory and names its
  systemd units after itself, as the bash suites do per run.
- **Time is mocked in-process, with node:test's `mock.timers`.** The loop
  gets the time from `Date.now()` and waits with `setTimeout`, so a test
  that runs the loop's code in its own process can move time forward with
  `mock.timers.tick()` instead of waiting real minutes. The stop time, last
  call, the wrap-up, a session past the stop time, usage pauses and lease
  staleness are tested this way, with the fake `claude` still a real child
  process: exact moments, and no failures under load. A few end-to-end runs
  keep real time and real processes (systemd units, the daemon, the fleet)
  to show the wiring, with short windows or held sessions (`hold.<unit>`,
  `go.<unit>`) rather than fixed sleeps. No clock file or env var in the
  runtime: if the loop resists running in-process, ask before adding one.
  This is the one place the suites look past the commands, and only at the
  loop's entry point (`loopCli`), not its insides.
- **The tracker in-process for setup.** A test's own setup (adding units,
  marking them done) calls the tracker's `run()`; what a check is about
  still goes through the real command (`factory/tracker` and the stubs), so
  the stubs and exit codes stay covered.
- **Order:** the tracker suite, then scripts, branches, store, and the loop
  last. Each is a commit with every check passing; a bash suite is deleted
  in the commit that proves its replacement (the bugs put back above), and
  AGENTS.md's test list changes with it.
- **Run in one thread with the maintainer**, piece by piece, with subagents
  doing the porting so the thread keeps the overview.

**Done, 2026-10-19.** The five bash suites are gone. Their checks are on
`node:test` in `tracker/test/` and, under `test/`, `scripts/`, `branches/`,
`store/` and `loop/`, beside the unit tests in `runtime/test/`; AGENTS.md's
Tests section says how to run them.

## Parity: how we know nothing was lost

The four suites are the definition of current behaviour, and through phases
1 and 2 they don't change. That's only as good as what they cover, so:

- **Before porting a script, read the coverage notes below for it.** Where
  intricate behaviour has no test, write the test against the bash version
  first, see it pass, commit it, then port. That's the same rule as a fix:
  the test has to fail if the behaviour goes missing.
- **Output text is behaviour.** Agents and the owner read it, and the
  prompts quote it. Keep wording, titles-before-IDs, exit codes and event
  line formats the same unless a phase says otherwise.
- **design.md "Landing, apart from the loop"**: done in phase 2 (#20), where
  the structure was being rebuilt anyway; landing has its own module and unit
  tests.

## What must stay true

From lessons.md and design.md. The suites cover most of these; the ones they
can't (marked) need care and a note in the commit.

- Everything the owner or an agent reads puts the title first and the ID in
  parentheses, and the CLI refuses a bare ID in text (LESSONS 5).
- Tracker state is written only by the CLI, validated, with a lock and an
  atomic rename. With an origin, the state is origin's main: every write is
  pushed at once and redone on the new state if the push is refused, so two
  lanes racing for a unit can't both get it (design.md, "The state is
  origin's main").
- A unit's branch never carries `tracker/` changes.
- Status is computed from probes where a probe can decide it; a unit that
  passed and now fails is broken again (LESSONS 3).
- A question needs options that each say what they change, a default and
  what it blocks; answering releases what it blocked (LESSONS 6).
- A lane with nothing to do waits and looks again until its deadline
  (LESSONS 10). A loop refuses to start only over broken tracker data.
- Work is never lost: an interrupted unit's work is committed to its branch
  and pushed (LESSONS 18). Sessions never copy data; the loop does, by
  lease. The store's rules in design.md ("Group data on a store") hold
  exactly, including compare-by-contents and the aside folder (LESSONS 8).
- Lanes on one machine share `work/`, and checks skip busy groups
  (LESSONS 9).
- Heavy jobs take turns per machine (LESSONS 12).
- Whatever a lane starts, a lane stops; the last lane runs `factory/tidy`
  (LESSONS 13).
- Last call and CI work as design.md "Group CI" says (LESSONS 15).
- The code lives only in this repo and is deployed by pushed commit; a
  running loop keeps its version; a factory's `factory/` holds stubs, and a
  recipe added here can never break a factory's `just` (LESSONS 20).
- Every rsync has an I/O timeout, every ssh a keepalive and BatchMode, so a
  sleeping machine can't hang a lane. *(Not testable without real ssh.)*
- Usage: lanes pause under the 5-hour threshold, from the transcripts' own
  numbers. *(Not testable without a real
  plan.)*
- `pkill -f` and `pgrep -f` take `-A`; in TypeScript, never match the
  calling process when finding processes by command line.

## Later, not this goal

- **SQLite for the tracker.** Notes from the discussion, for that goal:
  commit a snapshot made with `VACUUM INTO` or the backup API, never the
  live database, so a viewer holding it open can't leave a half-written
  file or `-wal`/`-journal` files in git. Probably one database per group
  plus one shared one, so a fetch doesn't download everything. A `diff`
  textconv (`sqlite3 .dump`) gives readable `git log -p`. Replaying 400
  real tracker commits packed to 1.6 MB as SQLite against 785 KB as JSON.
  Once there's a daemon, whether tracker state still needs to travel through
  git at all is an open question for that goal.
- **macOS.** Ported since, in #150 (the shared store there needs
  Homebrew's rsync 3): `os/darwin.ts` fills in the same
  interface, with a supervisor of its own in place of launchd (which takes
  no agent over ssh), a crontab entry for the daemon's service, and a
  memory watch in place of cgroups.
- **The web UI** (#3) and the other open GitHub issues. They're easier on
  the TypeScript code, so they come after it. Don't fold them into the port.

## How the work is run

- **Phases 1 and 2** are cut into GitHub issues on the repo named in
  AGENTS.md, each a piece that touches its own files, and worked through
  with the triage skill's threads. The tracking issue is #13; the pieces are
  #14 (Node 26 and the type check) and #15 (the tracker) for phase 1, and
  #16 to #21 (small scripts, long jobs and lanes, the store, the fleet, the
  loop, the scripts and recipes) for phase 2. Each lists its coverage gaps
  and what it waits on. Each issue adds the tests its coverage gaps need
  (below) before porting. Threads share one checkout (no worktrees). (Then,
  `test-loop.sh` wanted a quiet machine, so two threads' test-loop runs
  didn't go at once; the node:test suites that replaced it, `node --test
  test/`, don't need one.)
- **Phase 3** is done with the maintainer around, since it's design work: the
  design calls were settled with them (Decided), and the work goes piece by
  piece in one thread, each piece a commit with every check passing.
- **Phase 4**: see its section ("Decided with the maintainer").

## Known gaps in the suites

An audit on 2026-10-15 grepped the four suites for every command, flag,
recipe and event kind. Line numbers are from that day's code. Before porting
a script, check its entries here and add tests for what you'll rely on (see
"Parity"). Re-check the list against the code as it stands then; it will
drift.

**No test at all**

- Tracker: `where <loop>`
  (no suite defines `loops` in project.json); `decide --by owner`,
  `decisions --for`, `questions --all`, `status --all`, `refresh --group`,
  `log --since`, `log --group`, `answer --via`; `add --set k=v` (template
  parameters); `add-group --host`, `edit-group --needs`; the unit flags
  `--inputs` and `--model`; `data --all`, `lease --all`, `lease --force/--why`;
  `unclaim --release-lease`; `memory --check`.
- Recipes: `runs` (factory.just:181) has its own logic, merging the lanes'
  `index.tsv` files, and no test. `usage`, `oversee-guide`, `skill-deploy`,
  `view` and `pause` aren't called as recipes. Most tests call the
  `factory/*` scripts directly.

**Intricate, tested lightly**

- `merge-json`, the git merge driver for tracker JSON (tracker.mjs:2574):
  one direct case.
- `rename` updating every reference: three cases.
- Probe caching by input globs (tracker.mjs:1024): `--inputs` is never set,
  so the fingerprinting is untested.
- `init`: one shallow check.

**Can't be tested here** (port these by reading closely; say so in the
commit)

- Real ssh to another machine. The store's ssh goes through a fake that
  runs locally (it checks the options the store gives ssh, and that a
  refusal or a stall fails a copy within the I/O timeout); the fleet's
  remote path is only checked as "unreachable".
- Real `claude`: the suites use a fake, so the real stream-json shape and
  real rate-limit messages aren't checked.
- Real out-of-memory kills (faked unless `FACTORY_TEST_OOM=1`), real usage
  windows, sleep inhibition and the lid switch, `view --open`, a project's
  `factory/tidy`.
- Several machines: simulated as clones of one local bare origin on one
  host.
- `deploy.sh` against the real published repo: the tests point it at a
  local one.
