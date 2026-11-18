# wfactory

wfactory helps you set up a factory for your own project, and then runs
it. A factory is a backlog of similar units of work that Claude Code works
through unattended, one headless session per unit, where a check you trust
decides when each unit is done.

Setting up is a conversation with your agent. It works with you to find the
check, split the work into units and try the first few by hand. Everything
underneath is already built: the tracker, the loop that runs the sessions,
review before merge, and the usage and memory limits. That part is an
ordinary TypeScript program with no model in it, installed as a Claude Code
skill.

Once a factory is set up, a run goes like this. Tell your agent
**"oversee"**, and a Claude session, the overseer, starts the lanes (a lane
runs one session at a time) and reports to you.

1. A lane claims the next unit from the tracker.
2. It starts one headless `claude -p` session on that unit, on its own
   branch, under a memory cap.
3. The tracker runs the unit's check. The check passing is what makes the
   unit done; the session saying so isn't.
4. With a git remote, a fresh read-only session reviews the branch, and
   the loop merges it into main.
5. When a session reaches a decision that's yours, it files a question
   with options and a default, and the lane moves on to other work.

`just questions` shows what's waiting on you, and `just runs` lists every
session with its result, cost and transcript. In one factory, a finished
unit cost a median of $1.68 in API-equivalent terms over 489 units
([docs/in-practice.md](docs/in-practice.md)).

It's early: I use it every day, but few others have installed it yet.

## Why not write your own loop?

`while true; do claude -p "$(cat PROMPT.md)"; done` and a test suite are
enough if you read every diff. wfactory is for when you don't. Writing code
got cheap and reviewing it did not, so here the check always wins: over the
prompt, over the agent, and over me.

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

## What it enforces

All of these are code, with tests:

- The tracker runs each unit's check and refuses "done" from the session
  that did the work.
- When shared code changes, the checks it touches rerun, and a unit that
  broke goes first.
- A fresh session reviews each branch before it merges. In one factory it
  reviewed 593 and sent 45 back.
- A session's edits to the tracker or the loop are dropped at merge.
- Nothing merges onto a broken main.
- Two lanes never take the same unit, across machines too.
- A question for you has to come with options and a default, and only the
  units it blocks wait.
- Lanes pause before they use up your plan, and keep 15% of the week back
  for you.
- Each session has a memory cap, and a lane that does nothing twice stops.

[docs/protections.md](docs/protections.md) says how each one works and
where it stops. More than 3,000 tests run real lanes against a fake
`claude`.

It isn't a sandbox. Sessions run as you, with your network and credentials,
so use it only where you'd let an agent loose. `just fleet stop` stops
everything now.

## Who it's for

It fits many units of the same kind of work, with a way to tell a good unit
from a bad one without looking yourself: a corpus to convert, a library to
port, a test suite to make pass one case at a time. It's for one person
with one machine, or a few that share only git; there's no server. For a
handful of one-off tasks, or work nothing can check, the skill says so and
won't build a factory that would produce confident junk.

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
- [docs/protections.md](docs/protections.md): every protection, how it
  works and where it stops.
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
