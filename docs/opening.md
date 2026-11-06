# The opening

The second step of setting up a factory (SKILL.md, "Setting up a factory"),
after the scaffold.

Most projects aren't a factory on day one. There's no code yet to cut into
units, or nothing judges the work but the code being built, or nobody knows
yet whether the target can be reached at all. The opening is the one-off
work that gets there: prior work, a probe, the harness, the oracle, the
owner's way of looking, trial units. The scaffold's `init.sh` filed one gate
in the tracker, **"The opening is over: ready for lanes"**
(`opening/ready`), and `just loop` and `just fleet start` refuse until the
owner passes it: lanes started before the ground is ready grind a whole
scope on a check that isn't the real one. A project that has its oracle and
its like units already (built by hand before the factory) goes through the
entry checks (step 6) with the owner now and skips the rest.

The opening's work is the project's **issues** on its forge, not tracker
units: one-offs, each unlike the last, with discussion the owner reads. The
tracker holds only the opening's gate, and the probe's review once it has
a result (step 3), until the factory starts. With no forge, a
checklist in the project's `docs/opening-queue.md` stands in for the
issues: one heading per item, worth-most first, and under each the issue
itself, its done line (what a check reads), what it owns (files, formats)
and what it waits on (other items, a shared thing). An item is done when a
line under its heading says `Done: <commit>` (or `Stopped: <why>`), so the
overseer and the owner read the queue's state from the file.

1. **The brief, in one message.** Propose a default for each, ask once, and
   if the owner is away take the defaults and list them:
   - **the goal, as two lines** (below): how far it could go, and where
     they'd be satisfied. Add the first few things the owner will do when
     they pick the result up;
   - **the reference, and which differences from it are bugs** (below):
     what the oracle will compare against, and whether the owner wants it
     matched everywhere;
   - what exists already: their own earlier work, tools, data. Check that
     each input they name is where they say it is. Anything else you come
     across that looks like earlier work (an old project, exports, an
     install) goes back to them as a question; don't fold it into the plan;
   - how deep into the technical choices they want to go. Never ask the
     owner to choose between options they can't judge: research the choice,
     recommend one, and say why;
   - what the work may download, install or touch: accounts, devices,
     private data, money. The owner's answer is consent for exactly what it
     names; anything it doesn't name waits for the owner. This one has no
     default to take: if they're away, nothing is consented to yet. Don't
     ask what the profile's Machines table already says; machines it
     doesn't settle are one of the owner's design calls (below).

   Step 2 doesn't wait for the answers: research that doesn't need
   them starts as the brief goes out.

   **The goal's two lines.** On day one the owner can't know where their
   line falls between what's possible and what they'd be happy with:
   nothing has been made yet. Asked for one goal, they give the loftiest
   ("exactly like the original"), and that becomes the oracle's bar until
   they see real output and find it isn't what they wanted. So ask
   for two, and write both into `docs/factory.md`'s Goal as provisional:
   - **the far line:** the loftiest version they can imagine this making,
     if everything worked. It sets the direction, not the finish;
   - **the satisfied line:** the least result they'd use and be glad of.
     This is "done", and the oracle's bar.

   Tease the satisfied line out with questions about use, not about
   quality in the abstract: what's the first thing you'd do with it? If it
   got this part right and not that one, would you still use it? Which
   differences from the original would you notice, and which would you
   mind? What would make you give up on it? Give your guess at each answer
   for them to correct.

   Then ask again **when there's output to look at**: at the probe (step
   3) and at the trial units (step 5), show results that sit near the line
   (this one matches exactly; this one differs here, in a way that costs a
   week to fix: would you mind it?). An answer about real output beats
   any answer about an imagined one. Write each change to the two lines
   into the Goal with what showed it.

   **The reference, and which differences are bugs.** Many factories
   have a reference: the program, game or dataset the oracle compares
   against. A check against it counts every difference as a bug, and an
   agent with nothing else written down copies it, so unless the owner
   says otherwise the factory rebuilds the reference. That's right only
   when every difference really is a bug: a migration, a conversion to
   another language, a build that must match byte for byte. More often
   the owner wants the reference with departures, most of which they
   can't name until they've used the result. Sometimes the reference is
   only raw material, to mine and not to match. Ask which of the three it
   is, with your guess. Don't say "port": to someone who plays games, a
   port is the same game on another machine, differences expected; to an
   agent it means the same behaviour. Say "every difference is a bug". If
   the owner picks that and the project isn't a migration, say back that
   most owners find differences they want once there's something to use,
   and name where people usually depart for this kind of project (the
   controls, the feel, the defaults, how it looks).

   For the reference with departures, propose two layers for them to
   correct:
   - **the floor:** what must match exactly, because everything else
     stands on it (a CPU's behaviour, frame data, a file format). Match it
     first: work here is rarely thrown away;
   - **the taste layer:** where the reference is a starting point, not the
     spec (the controls, the feel, the defaults, how it looks). The
     reference's version is one option here. Units build the one that
     costs least to make and to change (often the target's own
     behaviour), and each choice goes to the owner as a candidate
     departure, decided over real output.

   Don't build the reference's exact version of the taste layer before
   the owner asks for it. A factory that copies the whole reference first
   and departs later deletes much of what it built when the departures
   come, and a faithful copy the owner might want someday can be built
   then, as a goal of its own. If the owner still wants everything matched
   first, that's their call: make the departing a later phase they start
   (a gate), and say first what it costs.

   Write the kind, the two layers and the default into
   `docs/departures.md`, and each departure the owner makes as a line
   there that cites their decision. At the probe and the trials, ask over
   the same output which differences they'd keep: each one kept is a
   departure. The oracle reads the page (step 4).
2. **Prior work, first, and every kind of it.** A research issue before
   anything is built. It's done when what it has to fill in, below, is
   filled in, not after some length of time. Look for each kind, in a
   pass of its own:
   - tools that already do part of the job;
   - someone else's output of the same kind (a port, a translation, a
     dataset), to copy and to check against;
   - the target's own source, symbols, SDK, scripting interface or
     decompilation;
   - the vendor's own tooling, and any automation interface to it (an API,
     an MCP server);
   - the community's notes on the formats and the hard parts;
   - what could judge the output on the real target: an existing checker,
     a test mode, a log, a replay or recording format. It feeds the oracle
     (step 4).

   Write the first findings down, with a draft verdict and its risks and
   open questions, then make **a second sweep**:
   - anything the first pass says ships with or around the target
     (modules, plugins, a scripting interface, example projects, an
     importer, a debug or test mode) is searched again as the target's own
     code and tooling: what it exposes, whether it has symbols or source,
     what it can automate;
   - each risk and open question in the draft verdict gets a search for
     prior work that settles it, and what turned up is written beside it.

   The result says what to copy, what to check against, and what the
   oracle could be, and ends on a table: a row per kind above, what was
   searched (queries, sites, repos) and what turned up, or "none found". A
   blank row, or a risk with no search beside it, means the research isn't
   done. Prior work found mid-run costs everything built in its place.
3. **Can it be done at all?** The smallest probe that shows the target can
   be reached (one case end to end, by hand if need be), with the result
   that would mean "stop" written down before it runs. A no here costs a
   day; a no found a week in costs the week.

   **The probe waits for the owner** when it needs an install, an account,
   a device or money that their answer to the brief didn't name. Ask before
   it runs, saying what it needs and what it costs (the size, the price,
   what it touches); this is one of the stops, like a gate.

   **Its review is a gate in the tracker:** the owner says go or stop. File
   it when there's a result to look at, not before, so `just status` shows
   it waiting on the owner only once there's something to see. Title it in
   plain words; its detail says what go and stop are and where the result
   is. Then the opening's gate needs it too (`--add-needs` keeps what it
   needed already):

   ```bash
   just tracker add-unit opening/probe --gate --title "The probe's result: go or stop" \
     --detail "Go if <the result that means go>. Stop if <the stop result, written down before it ran>. The result: <where to look>."
   just tracker edit opening/ready --add-needs opening/probe
   ```

   Go is `just pass opening/probe`. Stop is the owner's call, recorded by
   parking, never dropping: first the opening's gate, `just tracker park
   opening/ready --why "…"` (what the probe showed, and what would make it
   worth another look), then the probe's, `just tracker park opening/probe
   --why "the owner said stop"`, so nothing is left waiting on them. A
   dropped gate makes `just loop` suggest reopening it, which reads as a
   mistake to undo, not a decision.
4. **The bootstrap queue.** The issues the factory will stand on:
   - the harness;
   - **the oracle, outside the code being built and run on the real
     target.** A check against your own formulas, your own interpreter or a
     patched copy of the target grades its own homework. Anything a model
     decides (matching, routing, "is this relevant") gets a bench another
     context writes and labels before the code exists, frozen once written.
     Against a reference with departures, every exception the oracle takes
     from it (a row it accepts, a golden it skips, a tolerance it widens)
     cites the owner's decision on `docs/departures.md`, and the check
     fails when that decision no longer stands or was never the owner's
     (`just decisions --all --json` says both, for every decision at
     once). A difference the owner chose is then expected, and no lane
     "fixes" it back. Adding such an exception applies the owner's call;
     it isn't weakening the oracle, which stays the owner's question;
   - the owner's way of looking at the output: a viewer, a play script, a
     page;
   - the first recipe that makes one unit without hand work;
   - research issues for the leads step 2 turned up.
5. **Trial units.** Two or three candidate units of different sizes, made
   with the recipe and timed. Pick the unit's size from the numbers; the
   trials also show the pipeline's shape (design question 13).
6. **The entry checks,** in `docs/factory.md`'s "The opening": the oracle
   has judged a trial unit; there's a pile of like units and a recipe for
   them; the unit's size is measured; the owner can look at the output
   themselves; the machine's limits are set; the goal's two lines have
   been asked again over trial output; the reference's kind and its two
   layers are written down; and the owner has made their
   design calls (below). Go through them with the owner, and they pass the
   gate. Then read [design-questions.md](design-questions.md), all of it,
   and settle the rest of the design, which is yours to do.

**The owner's design calls happen here, not after the gate.** Of the
design questions, only a few are the owner's: the goal's two lines (with
done and kill, question 4), which differences from the reference are bugs
(the kind and its two layers, question 2), where they want to look (gates, question 5),
how the scope grows (question 12), and machines or lanes the profile
doesn't settle (question 9). Ask them in the brief or as the trials answer
them, so that passing the gate means the factory is ready to start, and
not that a design round comes next. The rest of the questions are
mechanics the trials and the skill answer; the owner hears how they were
settled, not a question about each.

**The entry checks are the finish line, from the first day.** Fill in what
each check needs as soon as the scaffold is down, and count against them
in every report the opening makes: a finished issue, a sprint's end, "are
we ready?". Say how many hold, and for each that doesn't, what makes it
hold and which issue is doing that. Until a check holds, its fill-in in
`docs/factory.md` is replaced by a status form, "needs X (the queue item
doing it)", not evidence that doesn't exist yet; once it holds, the evidence
replaces that. A check nothing in the queue will make hold gets an issue
filed now. Never say "one more round" without naming
the checks the round makes hold; a readiness answer that moves from one
report to the next means the checks weren't written down. An opening run
by another workflow (a sprint skill, threads started by hand) still starts
from the scaffold, so its gate and checks are there to report against.

During the opening, "continue" works the next issue in the queue, and
"oversee" runs the queue as below.

## Running the queue

One session oversees; the issues are worked by threads (or subagents), one
per issue, each in its own git worktree (but see research issues below).
With no origin, a thread's branch merges into the local main.

- **Harden first.** Before an issue starts, a fresh subagent, given only
  the issue, the decisions so far and AGENTS.md, looks for assumptions it
  doesn't state, vague words an agent will read narrowly ("works",
  "relevant"), and checks only the building agent can grade or that never
  exercise the change. Fix the issue until a command can decide it's done,
  or it says why nothing can. This is where done-checks turn up that pass
  with nothing done, so every issue that changes code, data or shared
  state gets it.
- **Research issues skip hardening and worktrees.** An issue that only
  writes a new file of its own, that nothing else reads or changes yet (a
  research doc), runs as a subagent in the main checkout, with no
  hardening pass. Its done line still names what a check reads ("the doc
  exists, with a verdict and a source per claim").
- **Cut in one message:** the queue, worth-most first; which issues can run
  side by side (disjoint files, no shared thing) and which wait on which,
  with the order each shared thing's holders take it in; when to stop
  starting new ones; and only the decisions that change what gets built
  and have no safe default, each with its options, what each changes, and
  your pick. Record each answer on its issue.
- **Each thread's brief:** its issue, the decisions that bind it, and the
  files other threads own. Its questions come to the overseer, not the
  owner: where a default is safe it takes it and records it on the issue.
  It merges only when every check in the issue passes, never force-pushes,
  and merges main in rather than rebasing.
- **Oversee.** One heavy job at a time (a build, an emulator), under a
  memory cap, and one holder at a time of each shared thing (a device, an
  editor, the desktop). An issue that needs a shared thing names it in its
  brief and waits for it whatever worktree it's in: the thing's state
  lives outside git (an editor's project folder, a device's storage), so
  a worktree neither copies nor isolates it. Anything a holder made inside
  it is dumped into git and committed before the next holder starts,
  since that one may overwrite it. The probe was the first holder: what
  it made by hand in a shared thing is often the only proof the target
  can be reached, so it is dumped and committed before any issue touches
  that thing, and each issue that takes it after checks that the dump is
  in. After each merge, check main yourself (read the diff, run the
  checks) before starting what depends on it, and tell the running
  threads to merge main. Answer small questions with a safe default; send
  the owner the real ones in a batch, each with its context and your pick.
  Give the owner a line per running thread at least every half hour.
- **Finish** with one report: what merged, what's left and why, decisions
  taken in the owner's place, what's waiting on them, the entry checks
  (how many hold, and what each of the others is waiting on), and a short
  list of things to try, setup first.

## Next: settle the design

The opening is done when the owner passes its gate, "The opening is over:
ready for lanes" (`opening/ready`). Then read
[design-questions.md](design-questions.md), all of it, and settle the
design.
