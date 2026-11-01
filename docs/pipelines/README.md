# Pipelines: when to abstract, and what shape

The pipeline is the code a factory's units build on: what turns the inputs
into the outputs the oracle judges. Read this when designing a factory
([design question 13](../design-questions.md)), at every ramp review, whenever the code starts
to repeat itself, when a problem found on one case might be every case's,
and when a shared fix has to reach the cases already done.

## When to write the shared code

Too early, and the abstraction fits the one case it was drawn from and gets
in the way of the second. Too late, and every case has its own copy, so a
fix gets made once per case and the shared code arrives as a rewrite of all
of them. Both happen; the second costs more, because it grows with every
case done.

**Signs it's too early:** there's only one case, or only cases that are
alike; the abstraction has parameters nobody varies yet; you're guessing
what the next case will need.

**Signs it's time (or past it):** three or more unlike cases work (the
**rule of three**); the same code has been copied into two places; the
same fix has been made in two cases; shared code asks which case it has
(`if kind == "x"`, a table keyed by case); a new case takes about as long
as the first did.

**When the source already draws the line.** Some sources split their own
code into what's common and what's per case: a game's common fighter code
beside each fighter's, a library's core beside its plugins, a format's base
beside its extensions. Then that split is the line from the first case: what
the source does in its common code is shared code here, and what it does per
case is the case's. The rule of three is for when nothing tells you.

At a ramp review, look for these on purpose: read the cases side by side.
Before designing the shared code, look for prior work: a tool, library or
project that already solved the same problem is something to copy or model
on, and to check against. When it's time, the shared code is a unit of its
own that the next step's units need (design question 10), written against all the
unlike cases so far, and each existing case is moved onto it, checked by
rebuilding it before and after and comparing the outputs.

## A problem found on one case

Most shared problems turn up on one case, in the hands of whoever is working
it. Before filing the fix in that case's group, ask: would this be wrong for
every case that does the same thing? When the source keeps it in its common
code, or another case shows it too, the fix is a shared unit, and the case
keeps only its own check of it, which `--needs` the shared unit. A case
whose group grows well past its siblings' is the sign this was missed: read
its units for the ones that belong to every case.

## Rolling out a shared fix

A shared fix reaches the cases already done in one of two ways, filed
differently:

- **A re-run:** each case's outputs only need building again on the new
  code (a stage run again, a file regenerated). The build does this: one
  that reruns what's stale by content (the rebuild contract, below) and
  group CI that builds each group from main (SKILL.md, "Scaling out") reach
  every case at its next run. The shared unit proves the fix on two or three
  unlike cases, its judges run in every group's CI, and no unit is filed per
  case. A judge that only a per-case unit would have run goes into CI first.
- **A port:** each case needs judgement of its own (reading its own source,
  choosing its own values). That is a unit per case, filed at the ramp's
  pace; the shared unit did only the shared part.

A per-case unit whose whole text is "rerun X on the new code" is a re-run
filed as a port ([lesson 33](../lessons.md)).

## One layer of polymorphism

One base type (a class, a trait, an interface, or a table of functions) and
one implementation per kind of case, **no deeper**. Two similar kinds share
by calling the same plain function, never by one inheriting from the other.
What's the same for every kind belongs to the framework and never varies
per kind. A kind changes what the pipeline does through three doors only:

- **attributes:** facts the shared code asks about, in place of a table
  keyed by kind;
- **methods:** work that is wholly the kind's own;
- **hooks:** fixes, before or after a step, or per item of a list. A hand
  fix to an output becomes a hook, so every rebuild makes it again.

Each kind's code lives in its own file or folder, found by name, so two
lanes on two kinds never touch the same file.

## Shapes

Most pipelines are one of these, or a few nested (a staged plan per case,
with files as the boundary between stages, and pinned inputs at the edge).
Each skeleton in `skeletons/` runs as it is; copy one into the factory and
then own it. It's a starting point, not a dependency: a rebuild must never
need code outside the factory's git (design question 11).

| Shape | Fits | The one layer | Skeleton |
|---|---|---|---|
| **Staged plan:** a fixed list of typed stages runs over one case at a time | a family of similar cases through the same steps, differing in details, with heavy tools in the middle | the case's class, with hooks | `staged_plan.py` |
| **File graph:** rules that each declare a command, the files it reads and the files it writes; a tool reruns what's stale | many files through mixed tools, where a case's difference is config | none in code: one config file per case | `file_graph.py` |
| **Pin and patch:** an upstream file pinned by its hash, plus a committed recipe of changes | fixing third-party files you can't regenerate (binaries, documents, game data) | the kind of change, one function per op | `pin_and_patch.mjs` |
| **Records:** many small records through a chain of modules that produce, filter or report | thousands of small, uniform items | the module kind; one record's quirk is an override file | `records.py` |
| **Passes:** the input lowered into an intermediate form, passes rewrite it, the last emits | translators, compilers, converters where meaning matters | the pass, with the pass list as data | `passes.rs` |

## The rebuild contract

`just rebuildable` and the drill (design question 11) need the same three things
from every shape:

1. **What made each output:** a stamp, a run record, a declared target, or
   a provenance field, so a file nothing claims shows up.
2. **A command that builds one group into a given folder,** from git and
   the fetched inputs, reading nothing from the old outputs.
3. **What may differ between two builds** (timestamps, generated IDs) and
   how to mask it; everything else matches byte for byte.

Decide what's stale by content (a hash of the inputs and of the step's
command or code), never by file times: a copy or a checkout changes times
without changing a byte.

## Libraries to learn from

Libraries come and go, so search for the current ones in the factory's
language rather than trusting a list. These kinds have solved the problems
above, and their extension points are worth copying even when the factory
uses none of them:

- **build systems** (declared inputs and outputs, content hashes, rebuilding
  only what's stale): for the file graph and the rebuild contract;
- **workflow and data-pipeline tools** (tasks or assets with typed inputs
  and outputs, caching keyed by code and inputs): for the staged plan;
- **asset import pipelines in game engines** (a fixed import with
  pre- and post-processing hooks per asset type): for the staged plan's
  hooks;
- **event-processing frameworks** (modules of a few kinds over a stream of
  records, provenance on every product): for records;
- **compiler pass managers and incremental-computation libraries**: for
  passes;
- **package builders and binary-patch tools** (a pinned source plus a patch
  series): for pin and patch.

Prefer a small library that does one of these things and stays out of the
way. Skip anything that brings its own scheduler, server or UI: the factory
already has its loop. And a library is worth it only when the factory's own
version would be longer than learning the library; the structure is the
point, not the engine.
