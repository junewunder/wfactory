# wfactory

wfactory runs Claude Code unattended through a backlog of similar work, one
headless session per unit, and lets a check you trust decide when each unit
is done. It's an ordinary TypeScript program with no model in it: a
tracker, a loop and the checks. It installs as a Claude Code skill that
helps you set a factory up.

A night with it goes like this:

```
$ just fleet start --until 07:00
```

1. A lane claims the next unit from the tracker.
2. It starts one headless `claude -p` session on that unit, on its own
   branch, under a memory cap.
3. The tracker runs the unit's check. Where there's a check it can run,
   the check passing is what makes the unit done; the session saying so
   isn't.
4. With a git remote, a fresh read-only session reviews the branch, and
   the loop merges it into main.
5. When a session reaches a decision that's yours, it files a question
   with options and a default, and the lane moves on to other work.

In the morning, `just questions` shows what's waiting on you and `just
runs` shows every session with its result, cost and transcript.

It's early. I use it every day on my own projects, but few other people
have installed it yet.

## Why not write your own loop?

Writing code got cheap, but reviewing it did not. A loop like `while true;
do claude -p "$(cat PROMPT.md)"; done` and a test suite get you a long way,
and if you read every diff yourself, or the work is a handful of tasks,
that loop is enough.

It stops being enough when it runs for nights and nobody reads the diffs.
Competent programmers make mistakes, and so do agents, and every rule below
came from one that happened in my factories
([docs/lessons.md](docs/lessons.md) has the 37 incidents). In wfactory the
check always wins: over the prompt, over the agent, and over me.

Here is the tracker turning away a session that says it's finished before
the test passes (real output, trimmed):

```
$ just tracker done text/slugify --evidence "wrote it, looks right"
Turn titles into URL slugs (text/slugify) is done when its check passes
(`bash test/slugify.sh` passes). Make it pass, then `just recheck text/slugify`.
[exit 2]
  ... the session fixes src/slugify.sh ...
$ just tracker refresh
Turn titles into URL slugs (text/slugify): now done (exit 0)
  ... later, a change to shared code breaks it ...
$ just tracker refresh
Turn titles into URL slugs (text/slugify): BROKEN AGAIN, its check passed before (exit 1)
```

## The protections

Each line is what goes wrong without it, what wfactory does, and whether
code holds it (with its test) or only the prompt asks. They stop mistakes,
not cheating: a session runs as you and could get around them on purpose.

- An agent says a unit is done when it isn't. For a unit with a check the
  tracker can run (a command, or an output file it can test), the
  tracker runs it, records the result itself, and refuses `done` from a
  session. Code (`tracker/test/probes.test.ts`). Units without one are
  recorded with evidence, which the review weighs.
- An agent grades its own work too kindly. A unit only judgment can settle
  needs a different session to sign it off. Code
  (`tracker/test/units.test.ts`), but sessions name themselves and the
  tracker trusts the name.
- A change to shared code breaks finished units and nothing says so.
  Before every claim the tracker reruns the checks whose input files
  changed, and a unit broken again goes first. Code (`probes.test.ts`), but
  it sees only the inputs it was told about, by size and modification time.
- A session edits the tracker or the loop's scripts. A branch's edits to
  them are dropped when it lands. Code (`test/branches/landing.test.ts`),
  but with no git remote there are no branches.
- The check passes but the change is wrong where the check doesn't look.
  A fresh read-only session reviews each branch against its card before it
  lands and can send it back with findings; sent back twice, it waits for
  you. Code (`test/branches/review.test.ts`). It fails open: a review that
  times out or gives no verdict lets the branch land, and the overseer is
  told. In one factory it reviewed 593 branches and sent 45 back.
- Work piles onto a broken main. While main fails its check, finished
  branches wait and the lane that found it takes no new units.
  Code (`test/branches/broken-main.test.ts`).
- Two lanes work the same unit. Claims race through git and exactly one
  wins, across machines too. Code (`test/branches/claims.test.ts`).
- An agent guesses at your decision, or stalls waiting for you. It files a
  question, which must have two options or more and a default (a repeat is
  refused); only the units it blocks wait. Code
  (`tracker/test/questions.test.ts`).
- The factory scales up before its first cases are right. The next step's
  units need a gate you pass, and lanes never work one. Code
  (`questions.test.ts`), but the tracker doesn't check who runs `just
  pass`; the overseer's prompt says only to record your answer with it.
- A night uses up your week. Lanes pause when less than 8% of the 5-hour
  window is left, and pace the week keeping 15% back for you. Code
  (`test/loop/usage.test.ts`).
- One session's build takes the machine down, or a lane spins. Each
  session runs under a memory cap and is killed alone, and a second kill of
  the same kind blocks the unit; a lane that records and commits nothing
  twice in a row stops. Code
  (`test/loop/lane/oom.test.ts`, `test/loop/idle.test.ts`).
- An agent edits a test, golden file or baseline to go green. Changing one
  is a question for you. Prompt, and the review looks for it; nothing in
  the code stops the edit.
- The check passes on a stand-in while the real target is broken. The
  check runs on what people actually use. Prompt.
- A noisy check marks good work red. It gets a resampling rule first.
  Prompt.

The 3327 tests run real lanes against a fake `claude`, a local bare origin
and real systemd units, and pass at every commit ([AGENTS.md](AGENTS.md)).

None of this is a sandbox. Sessions run with `--permission-mode auto` and
can reach whatever your user account can, network and credentials
included, so use it only where you'd let an agent loose. `just fleet
pause` stops after the running units; `just fleet stop` stops everything now.

## Who it's for

Many units of the same kind of work, and a way to tell a good unit from a
bad one without looking yourself: a corpus to convert, a library to port, a
test suite to make pass one case at a time. One person, one machine or a
few that share only git, no server. Not a handful of one-off tasks, or work
nothing can check; the skill says so rather than build a factory that
produces confident junk overnight.

Lanes don't start on day one. The skill first works with you on the check
and a few trial units, then pilots two or three with you watching, then
widens a step at a time. After that it's gardening: a few days of running,
then a few days of looking at what came out, weeding, and fixing the check
or the rules.

[gbaa](https://github.com/junewunder/gbaa), a static recompiler from Game
Boy Advance games to native Rust, runs as a factory checked against the
emulator mGBA. Its tracker and
[factory spec](https://github.com/junewunder/gbaa/blob/main/docs/factory.md)
are public.

## Install

Tell Claude Code:

> install this for me: https://github.com/junewunder/wfactory

It follows [install.md](install.md): it checks what's missing, asks a few
questions with defaults, installs the skill, and runs a toy factory of five
units until they pass, in about 15 minutes. Then, in a project, say "start
a factory for <the work>".

It needs Linux with systemd or macOS 13+ on Apple silicon (not Windows);
bash, git, node, curl, jq, [just](https://github.com/casey/just) and the
[Claude Code](https://docs.claude.com/en/docs/claude-code) CLI, on a plan
with usage to spare. Start with one machine and one lane; more are opt-in
([docs/scaling-out.md](docs/scaling-out.md)).

## Read next

- [SKILL.md](SKILL.md): what the agent follows, and the best overview.
- [docs/in-practice.md](docs/in-practice.md): what it costs, what the run
  records show, and a unit's path through the code.
- [docs/design.md](docs/design.md): why it's built the way it is.
- [docs/lessons.md](docs/lessons.md): the incidents the rules came from.

## About

I'm june wunder, finishing a PhD in programming languages: type systems
that find bugs in concurrent code before it runs. wfactory asks the same
of agents' work, where the answer is usually a check rather than a proof.
More at [junewunder.com](https://junewunder.com).

I make the design calls and the rules; Claude writes the code. Claude wrote
this README from my notes and decisions.

MIT licensed. See [LICENSE](LICENSE).
