# __PROJECT__

<one line: what this factory produces.>

## Start here

- `docs/factory.md` is the spec: the unit, the oracle, when to stop, and the
  loop. "Continue" means work one unit by that loop; "oversee" means run
  the lanes detached on the machines the owner includes (`just fleet`) and
  supervise them (`just oversee-guide`).
- **Until the owner passes the opening's gate** (`opening/ready`), the work
  is the project's issues, run by the wfactory skill's
  `docs/opening.md`; "continue" and "oversee" mean that, not the loop.
- **The owner** is the person in the wfactory profile
  (`~/.config/wfactory/profile.md`, or `$WFACTORY_PROFILE`): their
  name, how to address them, where they read reports, and the usage limits.
- `tracker/` is the state, changed only through the tracker CLI (`just next`,
  `just done`, `just ask`, …; `just tracker --help`). Never edit its JSON by
  hand and never read it whole: ask `just status`, `just show <id>`,
  `just find <words>` (a unit whose ID you don't know), `just questions`. The owner reads `just view`, not the files.
- `docs/tools.md` says what's installed for images, video and audio, and
  the project's way to do each job. Check it before reaching for a tool.
- `memory/MEMORY.md` indexes what earlier sessions learned the hard way.
- `just --list` shows the commands. `just check` is the oracle; `just lint`
  keeps the tracker and memory readable.

## Ground rules

- **Don't stop to ask.** The owner is usually away while this runs. Make a
  sensible call, record it with `just decide`, and keep going. Questions that
  truly need the owner go through `just ask` (options, what each changes, a default),
  after `just decisions <words>` shows it isn't already answered.
- **Talk to the owner in titles, never bare IDs.** Say what a unit, question or gate
  is first, the ID after in parentheses: "String escapes in the lexer (lexer/string-escapes)".
  Blockers read "X can't start until Y, because Z". In tracker text, refer to
  units as `{unit:<id>}` so they show as titles.
- **Never weaken the oracle to finish a unit.** See `docs/factory.md`.
- **A difference from the reference is a bug** unless
  `docs/departures.md` lists it as the owner's call. Read that page before
  changing how the result behaves or looks; only the owner adds to it.
- **Work lives in git, or is rebuilt from it.** Anything written (code, specs,
  data tuned by hand) is committed; anything derived has a command that
  rebuilds it, hand fixes included. A unit isn't done while its work lives
  only in `work/`, the store or an editor. See "What must never be lost" in
  `docs/factory.md`.
- **Heavy commands run capped:** `just capped <cmd>`. Capped and long jobs
  take their share of the machine's memory budget and wait their turn for
  the CPU (`docs/machines.md`, Reserve and Heavy; `just heavy`); `--light`
  skips that for a command that barely uses either.
- **GUI work uses the tool `docs/factory.md` names** (Resources, GUI), on a
  machine `docs/machines.md` says may do it.
- **Machine facts live only in `docs/machines.md`:** accounts, what each
  machine can do, lanes. Point there; don't restate them. Anything the owner
  says about a machine goes in that file first.

## Where things go

Each fact lives in exactly one place.

- `tracker/`: state, questions and decisions, through the CLI. A note says
  what the next attempt must know, not how this one went.
- Decisions: `just decide` (agents) and `just answer` (the owner's answers).
- Commit messages: what changed.
- `memory/`: facts about the world that would cost real time to rediscover (a
  tool quirk, a measured number, a dead end and why). Not session scratch, not
  anything the code or `git log` already says.
- This file: only what every session needs. If it grows past a screen, move
  the detail to `docs/` or `memory/` and leave a pointer.

**Memory rules.** One file per topic, under 100 lines (`just lint` enforces
it), with frontmatter: `name`, `description`, `title` and `hook` (its line
in the index), plus `open: true` while it's an unsettled investigation.
`MEMORY.md` is made from them by `just memory`; never edit it by hand. A file
that records an investigation opens with its current verdict. When new evidence overturns a claim, edit the claim where it stands
and date it; don't append a correction below it. Delete what's no longer true.
