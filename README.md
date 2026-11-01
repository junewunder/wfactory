# wfactory

> **Early, and developed in the open.** I run this every day on my own
> projects, but few other people have installed it yet. Expect rough edges
> and breaking changes, and please open an issue when something goes wrong.
> I'm still bottling my own judgment into it.

wfactory is a Claude Code skill that sets up a software factory: agents
working through a backlog of similar units of work for hours, on your own
machines, while you're away. Each unit gets a fresh session, and a check
you trust (the skill calls it the oracle) decides whether it's done. Your
part is answering the questions the factory saves up for you.

## Who it's for

It fits when you have many units of the same kind of work and a way to
tell a good unit from a bad one without looking yourself: a corpus to
convert, a library to port, a few hundred rules to codify, a test suite to
make pass one case at a time.

It's built for one person with a few computers: a laptop, a desktop, a box
in the closet. Git is the only thing they share. There's no server, database
or container image to run and keep up, and everything a factory knows is in
the repo. The price is a lot of commits: a factory with lanes on two
machines makes 500 to 900 a night, about two thirds of them the tracker's.
It isn't meant for teams or companies, which hosted platforms serve.

It doesn't fit a handful of one-off tasks, or work nothing can check; the
skill says so and won't build a factory for it, since a factory without a
check produces confident junk overnight.

## How a night goes

You tell your agent "oversee until 8" and go to bed. A lane claims the next
unit, starts a headless session to work it, and moves on when the check
says it's done. When an agent reaches a decision that's yours, it asks a
question with options and a default, and works on something else while
the question waits. In the morning you get one message: what got done,
what broke, and the questions. Answering takes a few minutes.

Lanes don't start on day one. Setting up a factory begins with an opening,
worked with you: prior work, a probe that the target can be reached, the
check, and a few trial units. Then a pilot works two or three units with
you watching, and the factory widens a step at a time, at gates where you
look at what came out. Code shared between units waits for three unlike
cases that need it, not before. This pacing is what keeps Claude from
drowning in its own code; in my experience the projects that come out of it
stay maintainable.

## What "done" means

My background is programming languages, where a result is sound or it
isn't. With agents writing the code, soundness and verifiability have become
more of a spectrum, and most of the skill is rules for staying honest about
where on it each piece of work sits.

- **Done is computed, not claimed.** Where a check can decide, the tracker
  runs it and records the result, and agents can't mark the unit done.
- **Status is rechecked.** The tracker reruns a unit's check when what it
  reads changes, so a unit that passed yesterday and fails today shows up
  as broken again and goes to the front of the queue. Before this, a change
  to shared code could break finished units with nothing saying so.
- **The check checks the real target.** One factory checked its patches on
  its own patched harness; the stock program people actually run showed
  bugs the harness didn't.
- **Noise is settled before a red mark counts.** A check that samples or
  judges gets a resampling rule up front.
- **Never weaken the check to go green.** Editing a test, a golden file or
  a baseline is a question for you, never a way to finish a unit.
- **Judgment gets an independent check.** Agents grade their own work too
  kindly, so a unit only judgment can settle is verified by a session that
  didn't do the work.

How much each kind of check settles:

| The check | What it settles | What it can miss |
| --- | --- | --- |
| A test or probe on the real target | done, and broken again later | what the test doesn't cover |
| A diff against a golden file | the output is the one you approved | a golden that was wrong from the start |
| A sampled or judged score | a trend, once resampled | any single run |
| A second session's judgment | prose, faithfulness, a look in an editor | what both sessions miss |

What holds each rule, and where it can still slip:

| Rule | Held by | Where it can slip |
| --- | --- | --- |
| Done is computed | the tracker refuses `done` for a unit with a check (`tracker/test/probes.test.ts`, "computed can't be marked done"); with a git remote, a unit's branch can't carry tracker edits (`test/branches/landing.test.ts`) | on one machine without a remote, a session could edit the tracker's JSON by hand |
| Status is rechecked | the tracker reruns a check when its inputs change, and the loop refreshes before every claim (`tracker/test/probes.test.ts`, "and then catches it breaking") | a check sees only the inputs it's told about |
| Independent check | the tracker refuses `done` from the session that worked the unit (`tracker/test/units.test.ts`, "the session that worked it can't record it done") | sessions name themselves, and the tracker trusts the name |
| Real target, noise, never weaken | the spec and the prompt every session reads; with a remote, a fresh session reviews each branch before it lands, a weakened test among what it looks for | nothing in the code stops an agent from editing a test; the review, or you, has to catch it |

In one factory this October, the check each group of units runs after
merging (rebuild, test, publish) ran 295 times and failed 117, some of
those false alarms in the check itself. Each failure held back that
group's publish.

[docs/lessons.md](docs/lessons.md) has the thirty-three incidents the rules came
from: what happened, what it cost, and the rule it produced.
[docs/design.md](docs/design.md) has the reasoning behind the design.

## Built with it

[gbaa](https://github.com/junewunder/gbaa) is a static recompiler that turns
Game Boy Advance games into native Rust programs. It runs as a factory:
each unit is a piece of the recompiler or a checkpoint in a game, and its
check is the emulator mGBA: gbaa's interpreter and the recompiled build both
have to draw the frame mGBA draws. Pokémon Emerald now plays recompiled,
its intro frame for frame the same as mGBA. Its tracker is in the repo (over
200 units so far, and about 20 questions to me and 60 decisions, each with
its history),
and [its factory spec](https://github.com/junewunder/gbaa/blob/main/docs/factory.md)
says what its check is and what counts as evidence, so you can see how the
rules above played out on real work.

## What it costs

From the run records of seven factories on one Max 20x plan in October
2026 (675 sessions):

- A session works one unit in a median of 9 minutes (35 at the 90th
  percentile) and costs a median of $1.30 in API-equivalent terms ($4.80 at
  the 90th percentile).
- A night of one lane worked about 30 units and used 4 to 9% of the week's
  usage. The 5-hour window peaked at 20 to 40%.

Those nights include some of my own use of the same account, so treat them
as rough. Scaled by each plan's share of Max 20x's usage, for units like
these:

| Plan | A week's usage covers | 300 units take |
| --- | --- | --- |
| Max 20x | 330 to 750 units | under a week |
| Max 5x | 80 to 190 units | 2 to 4 weeks |
| Pro | 15 to 35 units | 2 to 4 months |

Your units may be smaller or bigger than mine; the pilot's first few tell
you. The lanes read your usage as they go and pause below a share of the
5-hour window that you set (8% left by default). They don't act on the
week's limit, so on a smaller plan a night can use up a week you wanted for
other work: watch `just usage`, and give the lanes a stop time.

## Warning: it runs agents unattended

Every lane starts Claude Code sessions with `--permission-mode auto`. They
run commands, edit files and commit on your machine with nobody watching.
The guardrails are a memory cap per session, the check, the tracker's rules
and Claude Code's auto-mode classifier. None of these is a sandbox. Use it
only in a repo and on an account you'd let an agent loose in.

To stop a night early, tell your agent to stop, or run `just fleet pause`
(finish the running units) or `just fleet stop` (kill everything now).
Everything an agent did is a commit: in your checkout if there's no git
remote, or with one, on a branch per unit that the loop merges and pushes.
`just runs` lists each session with its result, cost and transcript.

## What's settled and what's moving

Used every day since early October 2026: one machine on Linux, the tracker,
the opening, lanes and the overseer, heavy builds under memory caps. Newer
and less tried: macOS (finished in late October, run on test factories so
far), lanes on several machines with a shared store, and units that drive a
GUI. The runtime is partway through a port from bash to TypeScript; the
commands you type stay the same.

## Install

Tell Claude Code:

> install this for me: https://github.com/junewunder/wfactory

It follows [install.md](install.md): it checks what's missing, asks you
about six questions in one message (each with a default), installs the
skill, and runs a toy factory of five small units until they all pass. It
takes about 15 minutes; the toy's five sessions cost $0.39 in API-equivalent
terms the last time I ran it.

Then, in a project, say "start a factory for <the work>".

**You need:** Linux with systemd, or macOS 13 or newer on Apple silicon
(not Intel Macs); bash, git, node, curl, jq,
[just](https://github.com/casey/just) and the
[Claude Code](https://docs.claude.com/en/docs/claude-code) CLI, on a plan
with usage to spare. Windows isn't supported; WSL2 with systemd turned on
should work. On a MacBook, lanes keep it awake only while it's on power,
and a factory must live outside ~/Documents, ~/Desktop and ~/Downloads,
which macOS closes to background jobs. One machine running one lane is the
normal setup; more lanes and machines are opt-in
([docs/scaling-out.md](docs/scaling-out.md)).

## Read next

- [SKILL.md](SKILL.md) is what the agent follows, and the best overview of
  how a factory works. Setting one up goes in four steps:
  [scaffold](docs/scaffold.md), [the opening](docs/opening.md),
  [the design questions](docs/design-questions.md) and
  [the pilot](docs/pilot.md).
- [docs/design.md](docs/design.md) is why it's built the way it is.
- [AGENTS.md](AGENTS.md) is the code's layout and how to run the tests.
  The suites run real lanes against a fake `claude`, a local bare origin
  and real systemd units, and they pass at every commit.

## About

I'm june wunder, finishing a PhD in programming languages. I build type
systems that catch bugs in reactive, asynchronous and concurrent code:
Willow for timing bugs across React renders, and graph types (POPL 2024)
for deadlocks in programs with futures. Both ask what a program's behavior
can be shown to be before it runs; this skill asks the same of agents'
work, where the answer is usually a check rather than a proof. More at
[junewunder.com](https://junewunder.com).

I make the design calls and the rules; Claude writes most of the code and
the text under my direction.

This README was written by Claude, from my notes, while I am busy writing my
thesis.

## License

MIT. See [LICENSE](LICENSE).
