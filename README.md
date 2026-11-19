# wfactory

wfactory helps you set up a factory for your own project, and then runs
it. A factory is a backlog of similar units of work that Claude Code works
through unattended, one headless session per unit, where a check you trust
decides when each unit is done. Porting a library is one example: each
function is a unit, and its tests passing is the check.

wfactory installs as a Claude Code skill, and setting up a factory is a
conversation with it. It works with you to find the check, split the work
into units and try the first few by hand. Everything underneath is already
built: the tracker, which records every unit and its state; the loop that
runs the sessions; review before merge; and memory caps. That part is an
ordinary TypeScript program; a model runs only in the sessions it starts.

Once a factory is set up, a run goes like this. Tell Claude Code
**"oversee"**, and a Claude session, the overseer, starts the lanes (a lane
runs one session at a time) and reports to you.

1. A lane claims the next unit from the tracker.
2. It starts one headless `claude -p` session on that unit, on its own
   branch, under a memory cap.
3. The tracker runs the unit's check. The check passing is what makes the
   unit done; the session saying so isn't.
4. A fresh read-only session reviews the branch and can send it back
   with findings. Once the review passes, the loop merges it into main.
5. When a session reaches a decision that needs your opinion, it files a question
   with options and a default, and the lane moves on to other work.

Questions for you all collect in one place (`just questions`), so it's easy
for you to work through decisions with an agent.

It's early: I use it every day, but few others have installed it yet.

## Example project

[gbaa](https://github.com/junewunder/gbaa), a static recompiler from Game
Boy Advance games to native Rust, runs as a factory checked against the
emulator mGBA. Its tracker and [factory spec](https://github.com/junewunder/gbaa/blob/main/docs/factory.md) are public.

## Install

Tell Claude Code:

> install this for me: https://github.com/junewunder/wfactory

It follows [install.md](install.md): it checks what's missing, asks a few
questions with defaults, installs the skill, and runs a toy factory of five
units until they pass, in about 15 minutes. Then, in a project, say "start
a factory for \<the work\>".

It needs Linux with systemd or macOS 13+ on Apple silicon (not Windows);
bash, git, node, curl, jq, [just](https://github.com/casey/just) and the
[Claude Code](https://docs.claude.com/en/docs/claude-code) CLI, on a plan
with usage to spare. Branches and review need the project to have a git
remote. Start with one machine and one lane; more are opt-in
([docs/scaling-out.md](docs/scaling-out.md)).

## What it enforces

wfactory's code enforces all of these, with tests, so none of them depends
on an agent following its prompt:

- A unit of work being "done" is decided by its check and a reviewing
  session, never by the session that did the work.
- When code that several units share changes, their checks rerun, so a
  finished unit that broke shows up.
- A session's edits to the tracker or the loop are dropped at merge, so it
  can't change its own record.
- Nothing merges while main fails its own check.
- Two lanes never claim the same unit, even across separate machines.
- Each session has a memory cap.

[docs/protections.md](docs/protections.md) goes into more depth: how each
one works and what it doesn't cover.

wfactory isn't a sandbox. Sessions run as you, with your network and credentials,
so use it only where you'd let an agent loose.

## When something goes wrong

Ask the overseer what happened; it reads the run records and transcripts
for you. To look yourself, `just runs` lists the last sessions (unit,
result, turns, cost, minutes) and where their transcripts are, `just
status` shows what's done, what's next and what's waiting on you, and
`just scorecard` says where a run's sessions and time went. `just fleet
pause` stops the lanes after their running units; `just fleet stop` stops
them now.

## Who it's for

It's for one person with a personal project, one Claude Max plan and a few
machines, who wants to find out what running a code factory is like without
building one first. The tracker, the loop, the review and the merging are
already there, and so is my judgment on how to run one: the skill answers
most of a factory's design questions itself, from what a unit is to how
often to commit, and tells you what it chose. Change what you disagree with.

With unlimited tokens, Claude can do a lot of this on its own. wfactory is
built for when you have one plan: a lane runs one session at a time, and
the check catches bad work before more gets built on it.

The work has to fit: many units of the same kind, with a way to tell a good
unit from a bad one without looking yourself (the check). A corpus to
convert, a library to port, a test suite to make pass one case at a time.
For a handful of one-off tasks, or work nothing can check, the skill says
so and won't build a factory that would produce confident junk.

## What setting one up looks like

Lanes don't start on day one. Here is how [gbaa](https://github.com/junewunder/gbaa)'s
setup would go today (it began on an earlier version of the skill).

1. You say "start a factory for a recompiler from GBA games to Rust". The
   skill lays down the factory and sends you one message with a proposed
   default for each thing it needs to know: the goal as two lines (how far
   it could go: every GBA game; where you'd be satisfied: Pokémon Emerald
   playing natively on a Steam Deck), what to check against (mGBA) and which
   differences from it count as bugs, and what the work may download or
   touch (your ROMs, read only). You correct what's wrong.
2. The opening: one-off work, filed as the project's GitHub issues and
   worked by agents in their own threads while one session oversees. A
   search for prior work. A probe that one game can be reached at all,
   with the result that would mean "stop" written down before it runs; you
   say go or stop. Then the check (does a recompiled frame match mGBA's?),
   a way for you to look at the output yourself, and two
   or three trial units, timed. gbaa's took 8 to 24 minutes, which set the
   unit's size.
3. The skill settles the rest of the design itself and sends one message
   saying how the factory is set up, asking only what has no safe default.
   Lanes can't start until you say the opening is over.
4. The first two or three units run with you watching, which is where the
   factory's spec, the rules its agents work from, gets fixed. Then the lanes widen a step at a time, and each step
   ends with you reading its results side by side before the next starts.

After that it's gardening: a few days of running, then a few days of
looking at what came out, weeding, and fixing the check or the spec.

## Read next

- [SKILL.md](SKILL.md): what the agent follows, and the best overview.
- [docs/protections.md](docs/protections.md): every protection, how it
  works and where it stops.
- [docs/in-practice.md](docs/in-practice.md): what it costs, what the run
  records show, and a unit's path through the code.
- [docs/design.md](docs/design.md): why it's built the way it is.
- [docs/lessons.md](docs/lessons.md): the incidents wfactory's own rules
  came from.

## About

I'm june wunder, finishing a PhD in programming languages: type systems
that find bugs in concurrent code before it runs. wfactory tries to do the same
for agents' work, usually with a check rather than a proof.
More at [junewunder.com](https://junewunder.com).

I make the design calls and write the rules; Claude writes the code. Claude wrote
this README from my notes and decisions.

MIT licensed. See [LICENSE](LICENSE).
