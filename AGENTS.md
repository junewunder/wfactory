# Contributing to wfactory

Visibility: public (github.com/junewunder/wfactory). Standing OK to push as needed: no need to ask before each push.

This repo is a Claude Code skill. `SKILL.md` is what an agent follows inside
a factory (setting one up is four steps, each in its own file:
`docs/scaffold.md`, `docs/opening.md`, `docs/design-questions.md`,
`docs/pilot.md`), `install.md` is what it follows to install the skill, and
everything else is the code those two run.

## Layout

- `runtime/`: the loop, lanes, fleet, long jobs, heavy-job slots, memory
  caps, the store, usage, the profile reader, the recipes (`factory.just`),
  and the two prompts (`prompt.md` for worker sessions, `oversee.md` for the
  overseer, with `oversee-card.md` its short card, what `just oversee-guide`
  prints). Each machine runs a deployed copy (`scripts/deploy.sh`). The
  port to TypeScript is under way: `main.ts` runs the ported commands
  (`src/`: machines, profile, usage, inbox, heavy, capped, long, lane, store,
  oversee, fleet, loop, and the machine's daemon in `src/daemon.ts`;
  everything they ask of the OS goes through
  `src/os.ts`, which says it in the runtime's terms, with systemd in
  `src/os/linux.ts`). The loop is `src/loop.ts`, with one session in
  `src/session.ts`, branches and landing in `src/landing.ts`, and the
  tracker run in the loop's own process (`src/tr.ts`). The loop, the store
  and the fleet keep their parts in modules beside them (`loop-*.ts`,
  `store-*.ts`, `fleet-*.ts`), one job each; each one's header comment
  lists where its parts are. Each ported script
  that something runs by path keeps its `.sh` as a one-line launcher that
  runs its command through `main.mjs`, which finds Node 26 (`launch.mjs`,
  shared with `tracker/tracker.mjs`). `machines.sh` and `session.sh` stay as
  sourced shims (`factory/machines.sh` brings in the first, a test the
  second); `profile.sh` is gone (scripts call `main.mjs profile`).
  The scripts in `scripts/` other than `deploy.sh` are
  launchers too (`src/init.ts`, `src/stubs.ts`, `src/smoke.ts`, and
  `src/profile.ts` for `scripts/profile.sh`), and the recipes that did more
  than run one command run `main.mjs runs`, `prompt` or `oversee-guide`
  (`src/recipes.ts`). `deploy.sh` and the `factory/` stubs that pick a copy
  stay bash: the bootstrap (docs/goal-ts.md, "Decided").
  `runtime/test/` has unit tests of single modules, on `node:test`.
- `tracker/`: the tracker CLI, in TypeScript that Node 26 runs as it is (no
  build, no dependencies). `main.ts` is the CLI, `src/index.ts` the same as a
  function (`run`), `src/store.ts` the only module that knows the state is
  JSON files, `src/commands/` the commands. `tracker.mjs` runs `main.ts` for
  factories whose stubs still run the system's `node`. `test/` is its suite, on
  `node:test`, a file per area.
- `template/`: what `scripts/init.sh` lays down in a factory. `factory/`
  there holds stubs only; the code stays in `runtime/`.
- `scripts/`: init, deploy, the profile, the smoke test and the stub
  conversion tools. The suites are all under `test/`.
- `test/` at the repo root: `lib/`, what the suites on `node:test` share (a
  temp repo, running a command, the tracker in-process, a machine to run
  the skill's scripts and recipes on, a factory on a local bare origin with
  lane clones, the branches suite's fake `claude`, systemd
  reads), `scripts/`, the suite for `scripts/` and the recipes, `branches/`,
  lanes racing on one origin, `store/`, group data on a local store moved by
  lease between laptops, and `loop/`, the loop, lanes, fleet, long jobs and
  the daemon, each a file per area. In `loop/`, `factory.ts` has the loop's
  fake `claude` and its factory; the files beside it run the loop in the
  test's own process on a mocked clock (`inproc.ts`), for the checks that
  hang on the time; `lane/` runs the real `factory/loop.sh` in a lane of
  each file's own; `fleet/` runs real systemd units and a daemon per file.
- `package.json` and `tsconfig.json`: the type check, dev-only. Nothing
  from npm is shipped; `runtime/node.txt` pins the Node the lanes run.
- `docs/design.md` is why things are built the way they are.
  `docs/lessons.md` has the incidents behind the rules, with the factories
  named by what they did; `private/LESSONS.md` (gitignored, since it names
  projects; `.ignore` keeps it searchable) is the same with their names,
  numbered alike. A new lesson goes in both. A change that undoes a rule
  needs to answer the lesson behind it.
- `docs/pipelines/` is when to write shared code and the pipeline shapes a
  factory picks from (design question 13), with a skeleton per shape in
  `skeletons/` that runs as it is. Run a skeleton after changing it. Like
  the rest of what a factory reads, it names no particular project.
- `docs/opening.md` is the opening, the second step of setting up a factory,
  and how its queue of issues is run; `private/opening-analysis.md` is the
  working note it came from, with project names.
- `rehearsals/` (gitignored, since it names projects; `.ignore` keeps it
  searchable) holds replays of a real project's opening on a new version of
  the skill: an answer key, the owner's day-one persona, and how the replay
  was run. Each folder's README says how to run the next one.
- The other step files (`docs/scaffold.md`, `docs/design-questions.md`,
  `docs/pilot.md`) and `docs/scaling-out.md` are SKILL.md moved out, read
  only when an agent reaches that step, so SKILL.md holds what every mode
  needs. Each file says where it sits among the steps and ends on when its
  step is done and which file comes next; keep both current when moving
  text between them.
- `docs/goal-ts.md` is the goal for the port to TypeScript and the daemon.
  Read it before working on the port.

## Tests

```bash
node --test test/ tracker/test/ runtime/test/   # every suite, side by side, about a minute
npm run typecheck               # tsc --noEmit, seconds (npm install first, once)
```

Or one suite at a time:

```bash
node --test tracker/test/       # the tracker CLI, about 13 seconds
node --test test/scripts/       # init, the profile, factory-diff, to-stubs, the recipes, about 6 seconds
node --test test/branches/      # lanes racing on a local bare origin, about 12 seconds
node --test test/store/         # group data on a local store, moved by lease, about 24 seconds
node --test test/loop/          # the loop, lanes, fleet, long jobs, the daemon, with a fake claude, about 38 seconds
node --test runtime/test/       # unit tests of single modules (landing, session), about 4 seconds
```

The suites and the type check must pass at every commit. They need Linux
with a systemd user session. They run side by side, and they passed with
every core kept busy by other processes: the loop's time-based checks run
on a mocked clock, and the others wait for what they check, not for a
process to be done in some fixed time. Kills over a memory cap
are faked unless `FACTORY_TEST_OOM=1`, which makes them real (each one pops
Plasma's "Memory Shortage Avoided" notification).

**Never weaken a test to make it pass.** If a test's expectation is wrong,
say why in the commit message. A fix comes with a test that fails on the
code before it.

## Conventions

- Bash scripts start with a comment block that is their `--help` (`sed -n
  '2,/^set -e/p'` prints it). Keep it current.
- Anything a factory's owner or an agent reads (messages, help text, the
  prompts) uses titles before IDs, and plain words.
- Nothing personal: no names, hostnames or paths of a particular setup.
  Those belong in the user's profile (`scripts/profile.template.md`).
- Always pass `-A` with `pkill -f` and `pgrep -f`, so they don't match the
  calling shell.
