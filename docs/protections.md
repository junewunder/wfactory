# The protections

What wfactory does about the ways unattended agent work goes wrong. The
README has the short list; this is the full one, with where each stops.

Each line is what goes wrong without it, what wfactory does, and whether
code holds it (with its test) or only the prompt asks. They're aimed at
mistakes: a session runs as you, and one that set out to cheat could get
around them.

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
  A fresh read-only session reviews each branch against the unit's
  description before it lands and can send it back with findings; sent
  back twice, it waits for you. Code (`test/branches/review.test.ts`). It fails open: a review that
  times out or gives no verdict lets the branch land, and the overseer is
  told. In one factory it reviewed 593 branches and sent 45 back.
- Work piles onto a broken main. While main fails its check, finished
  branches wait and a session is sent to fix what fails; if two can't, the
  lane that found it takes no new units.
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
- A run hits the usage limit. Lanes pause when less than 8% of the
  5-hour window is left, and resume when it resets. Code
  (`test/loop/usage.test.ts`). The week's usage is only shown (`just
  usage`): to keep some of it, give the lanes a stop time.
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

Besides unit tests of the tracker and the runtime, the suites run real
lanes against a fake `claude`, a local bare origin and real systemd units. They pass at every commit, on Linux; the
macOS path is less tested ([AGENTS.md](../AGENTS.md)).

None of this is a sandbox. Sessions run with `--permission-mode auto` and
can reach whatever your user account can, network and credentials
included, so use it only where you'd let an agent loose. `just fleet
pause` stops after the running units; `just fleet stop` stops everything now.
