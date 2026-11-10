# Settle the design

The third step of setting up a factory (SKILL.md, "Setting up a factory"),
after the opening.

At the end of the opening, before the first units, settle these. **They are
yours to settle, not a list for the owner to approve.** The owner made
their calls during the opening (the goal's two lines, which differences
from the reference are bugs, gates, how the scope grows, machines, and what
they allow on their own copies and accounts: [opening.md](opening.md), "The owner's design calls");
the rest are mechanics that the trial units, the skill's rules and the
repo's own lessons answer. Write each answer into `docs/factory.md`, then
send the owner one short message saying how the factory is set up, the
choices they might not expect first, with "say if any of this is wrong"
rather than a question per item. A question goes to the owner only if it
changes what gets built and has no safe default; an owner who answers
"okay" to every item was asked too much. If one of their calls was missed
in the opening, ask it now, in that same message.

After the 14 questions come three sections for the factories they fit:
several deliverables in one repo, units that need a GUI, and product code
that calls a model.

1. **The unit.** What one tracker unit is, sized to fit one fresh session.
   "Patch one game", "promote one translator rule", "draft one rule card".
   Too big and sessions run out of context. Too small and every session pays
   the startup reading for a few minutes of work.
2. **The oracle.** What `just check` runs, and what else counts as evidence.
   It must check the real target, not a convenient stand-in: a check on a
   stand-in passes units that fail on the real thing. If the oracle is noisy
   (LLM judges, sampling), decide now how to resample, or the noise reads as
   regressions.
   **Against a reference,** the oracle counts every difference as a bug
   unless `docs/departures.md` says otherwise. It checks the floor
   exactly and the taste layer against the reference with the owner's
   departures applied. Each exception it takes cites the owner's decision,
   and it fails once that decision no longer stands
   ([opening.md](opening.md), "The reference, and which differences are
   bugs"). The kind and the two layers are the owner's call; how the check
   reads the page is yours.
   An oracle that reads the target's code, files or memory stays within
   what the owner allows on their own copies (the decision "What the owner
   allows on their own copies and accounts"; [opening.md](opening.md),
   step 1); without it, it reads only what the target offers on its own.
   **Build and test the oracle before any units** ([opening.md](opening.md), step 4).
3. **Independent check.** *mechanical* (the check passing is enough) or
   *independent* (a context that didn't do the work verifies it). Use
   independent when the oracle is partly judgment: prose, proofs, faithfulness.
4. **Done and kill criteria.** When the factory is finished, and when it should
   stop and report instead of spending more usage. "Done" is the goal's
   satisfied line, made checkable, not the far line
   ([opening.md](opening.md), "The goal's two lines"). Write down what metric
   should move and what "not worth it" looks like. Questions for the owner
   aren't a kill criterion (so not "three units in a row blocked"): a
   unit that needs them waits on its question and the loop takes the next
   one, until `just next` has nothing left.
5. **Gates.** Where the owner must look before the next phase (gate units). A
   gate holds back only the units that need it (and what needs those), so
   wire the first units after it to it; anything else keeps going.
6. **Status from a check.** Which units a probe can call done (a file the
   oracle writes, a per-unit check command). Those are `computed`: the
   tracker runs the probe and nobody marks them. The rest are `independent`
   or `recorded`. Computed status is what makes regressions visible.
7. **Commit policy.** The default is to commit after each unit, with the unit
   ID in the message. A factory that leaves work uncommitted loses it and
   buries the next session in someone else's diff. Without an origin (the
   one-machine default), sessions commit in the checkout and nothing is
   pushed. With one, each unit is worked on its own branch and the loop
   merges finished branches into main and pushes; sessions never push. This
   overrides any global "don't commit unless asked" for the repo, so write it
   into `docs/factory.md`.
8. **Resources.** Memory caps for heavy children and shared devices. `just
   capped` caps one command and its children, but a child that starts its own
   `systemd-run` scope escapes it, so cap that scope in place, per job.
   Anything only one unit may use at a time on a
   machine (an editor, a device, the screen) becomes a resource in
   `tracker/project.json`: lanes treat it as a lock. Jobs that may outlast a
   Bash call use `just long`. Capped and long jobs are heavy: they share the
   machine's memory budget (its memory less the Reserve and GPU figures in
   `docs/machines.md`), each reserving its measured share, and a machine
   runs only its "Heavy" count of the long ones at once (usually 1); the
   rest queue (`runtime/heavy.sh`; 12). `--light` skips the queue. An editor
   a job leaves running keeps its share with `just capped --hold`. A
   long-lived service started some other way (an editor the owner opens, a
   server the factory keeps up) holds memory no job counts, so jobs the
   budget lets start then run out: give it a standing reservation, `just
   heavy reserve <name> <size> --pid <pid>` (or `--unit <its systemd
   unit>`), kept until that process or unit goes or `just heavy release
   <name>`. Don't keep a `free -g` gate of the factory's own beside the
   budget: it refuses jobs the budget let start. A unit
   whose work runs heavy jobs says `--uses heavy` (built in: no lane takes
   it while every heavy-job slot on its machine is held), and a CI step that
   needs a set amount says `"mem"`.
   Whatever a lane starts and leaves running between units (an editor, a
   headless desktop) gets stopped by `factory/tidy`, which the last lane on a
   machine runs when it stops, so nothing keeps burning CPU after the run.
9. **Machines.** `init.sh` writes `docs/machines.md` from the profile's
   Machines table: this machine, one lane, any unit. That file is the only
   place machine facts live; every other doc points there. Ask only what the
   profile doesn't say: the account each app runs under, if that matters.
   More machines: SKILL.md, "Scaling out".
10. **Shared code and shared lists.** Where several units will need the
    same new code (a family of similar items: variants of one widget, ports of
    one format), that code is a unit of its own, and the units that use it
    need it. Otherwise two lanes design the same module twice. And where every unit adds an
    entry somewhere (a registry, an import list), prefer one file per entry,
    found by name, over one list every unit edits: two branches adding to a
    list conflict on merge, two new files never do.
11. **What must never be lost.** Everything the factory makes is either in
    git, or rebuilt by a command in git from inputs that can be fetched
    again. `work/`, an editor's project folder and the store are caches
    of CPU time, never the only copy of thought. The test for any file: if it
    vanished, would running the scripts bring it back with no judgement
    calls? If not, it's dev time and goes in git. File type doesn't decide
    it: a spec a session tuned by hand is dev time, and so is a binary
    asset someone fixed in an editor. List each kind of output with the
    owner and sort it:
    - **written** (code, specs, hand-entered data, configs, prompts): committed;
    - **derived**: rebuilt by a named command, and that rebuild must
      reproduce every later fix too, so "rerun, then patch by hand" doesn't
      count;
    - **a hand fix to something derived**: becomes a step of the pipeline,
      and isn't done until a rebuild reproduces it. In order of preference:
      fix the generator or its input; a script step that makes the change
      (editor Python, a small file of "set this property" lines applied by a
      script); last resort, a binary patch from the pipeline's output to the
      fixed file (xdelta or bsdiff, like a ROM hack's patch), committed with
      the step that applies it. A patch pins the exact output it was made
      from, so a pipeline change breaks it, and the drill (below) catches
      that.

    Two things prove it. **`just rebuildable`** lists the files on disk
    that have no source or copy in git (how many, which), and `just check`
    runs it, so nothing lands while one is missing. Lanes on one machine
    share `work/`, so any part of the check that looks there skips the
    groups in `$FACTORY_BUSY_GROUPS`, units another lane here is mid-way
    through (`factory/tracker busy`; the template's justfile shows how):
    their outputs aren't on main yet, and a half-written folder would fail another lane's check. **The rebuild drill** (`just drill <group>`) rebuilds one group from git and the inputs
    into a scratch folder and compares it with the current copy; a
    difference is a hand fix nobody wrote down. Time it. If one group takes
    under a minute, `just check` drills one group each time it runs, taking
    them in turn; otherwise make it a group CI step (SKILL.md, "Scaling out").
12. **How the scope grows.** Most owners won't raise this, so raise it
    yourself whenever a goal covers many cases ("all of them", "the whole
    list", "every format"). Scope grows as a **staged rollout**: one case
    first, then a few, then more, each step a small multiple of the last,
    with a review before the next step, never one jump from the first case
    to all of them. Pick each step's new cases by
    **maximum-variation sampling**: list the ways the cases differ (size,
    format, which features they use, what's odd about them) and take the
    case least like those already done, never the next easy one; a spread
    of unlike cases is what lets an abstraction fit the rest. Each review
    is a gate (question 5) the next step's units need ([pilot.md](pilot.md)). Write
    the steps and why each case is in its step into `docs/factory.md`'s
    "The ramp", and tell the owner the plan in plain words ("one first,
    then a different one, then a handful, and we look for what they share
    before doing the rest").
    **"I want it now"** is a ramp of one step, and the owner's to choose:
    every case at once, no review between. It suits an owner who checks
    every result themselves and needs them soon. Do it when they ask, but
    first say, if it's true, that it may not be the fastest way to all of
    them: with no review the same fix gets made once per case, and the
    shared code comes later as a rewrite.
13. **The pipeline's shape.** The code the units build on: pick its shape
    from [docs/pipelines/](pipelines/README.md), which also says when
    to write the shared code (not at the first case, and not after the
    tenth). Say in `docs/factory.md` which shape it is and where each
    kind's code lives.
14. **Is the build a function of the commit?** For each kind of derived
    output (question 11): does the commit, with the fetched inputs, decide
    it, or does it live in one folder per machine, written in place, that
    is at once the cache, the units' workspace and what gets published?
    In that folder units, side scripts and hand edits all write, the checks
    read what this machine happens to hold, one commit passes on one
    machine and fails on another, and most of CI's red is copies drifting
    apart, not broken work. A build tool that keys outputs by their inputs
    settles most of it; either way, write into `docs/factory.md`'s "The
    build (every session)":
    - **where derived files live**, apart from what's written;
    - **who writes them:** the build, and nothing else. A unit that wants
      a different output changes the code or an input and reruns the
      build; a hand fix is a pipeline step (question 11);
    - **what the checks read:** what the commit builds, never what this
      machine happens to hold;
    - **results derived from a build aren't committed** (a check's
      report, a listing made from the outputs): the build makes them
      again, so units don't all rewrite the same generated files.

    How to key outputs and check results, and what to do with a step that
    can't be made a function of its inputs: [docs/pipelines/](pipelines/README.md),
    "The build is a function of the commit".

## Several loops in one repo

Default to one loop per repo. Split into several loops, each with its own
tracker and spec, when **the repo holds separate deliverables that the owner
wants to move one at a time**: three chapters of a book, say, each with its
own rules to codify. The test is whether the owner ever says "just this one
today". If a single tracker covers them, every session reports on all of
them, and when the owner's decisions are the bottleneck that clutter
actively slows things down: they sit down to settle chapter A and are
reminded of B's and C's open questions as well. Don't split units that are
just phases of one deliverable (research → synthesis → mockups): those are
sections of one tracker, with gates between them.

How it works:
- `tracker/project.json` lists the loops: `"loops": {"docs": {"title":
  "Docs", "spec": "docs/docs-loop.md", "groups": ["docs-pages"]}}`. A loop is
  a set of groups. `LOOP=docs just status`, `LOOP=docs just next`,
  `just loop docs`. IDs are unique across the repo, so needs may name a unit
  in another loop.
- `just status` with no loop lists only the loop names; `just status all`
  shows everything, and is only for when the owner asks for the overview.
- With `$LOOP` set, `just questions` shows only questions that block that
  loop's units. A decision that spans loops is one question blocking units in
  each; don't copy it.
- One spec per loop. A shared part (the oracle, the commit policy) can live in
  one doc that each spec points to.
- `just loop` runs one loop at a time per repo, since loops share git.

**One-loop rule.** Put this in the repo's AGENTS.md: *Work on and report on only
the loop the owner names. Don't mention other loops' state, questions or
next steps unless they ask. If they don't name one, ask which.* That rule is
the point of the split. Without it a session still reads every tracker and
recaps them all.

## Computer use

A unit that needs a GUI (clicking through an app, reading the screen) uses
whatever desktop-control tool the spec names, on a machine whose "Can"
column says it may. The screen is shared state: with more than one lane on a
machine, make the desktop a resource units `--uses`, so lanes take it as a
lock. Check the final screenshot before trusting a `done`, and cite a result
outside the GUI (a file on disk, a log line) in the record where you can.
Write these rules into `docs/factory.md`'s loop procedure: the sessions
that work units read the spec, not this skill.

## LLM calls inside the product

When the factory's own code calls a model, wrap every call in one function. It should:
- cache responses by a hash of (model, prompt, sample), so a run can resume
  after a usage limit;
- log each call's cost to `work/llm-log.jsonl`;
- run `claude -p --tools "" --no-session-persistence` from a temp dir for
  subscription usage.

## Next: the first units and the pilot

The design is settled when every question above has an answer, written into
`docs/factory.md` where the question says so, and the owner has had the
message saying how it's set up. Don't wait for a go-ahead on it: add the
units of the ramp's first step (SKILL.md, "The tracker"), read
[pilot.md](pilot.md), all of it, and start the pilot's first unit. An
objection from the owner changes the spec when it comes.
