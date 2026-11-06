# __PROJECT__: the reference and its departures

What the oracle compares against, which of its behaviour this project
keeps, and where it differs on purpose. Every difference from the
reference is a bug unless this page says otherwise. Only the owner decides
a departure; each line here cites their decision (`d/<slug>`), and the
decision itself, with its why, is in the tracker (`just decisions
<words>`).

**The reference:** <fill: what the oracle compares against (a program, a
game, an earlier version, a dataset), or "none: nothing to match">

**Its kind:** <fill: one of
- *every difference is a bug*: a migration, a conversion to another
  language, a build that must match byte for byte. The rest of this page
  stays empty;
- *the reference with departures*: match it as the default, with
  departures the owner makes as they use the result;
- *raw material*: something to mine, not to match. Say what the oracle
  judges instead.>

## The floor

What must match the reference exactly, because everything else stands on
it: <fill: e.g. a CPU's behaviour, frame data, a file format; or "all of
it", for the first kind>

## The taste layer

Where the reference is a starting point, not the spec: <fill: e.g. the
controls, the feel, the defaults, how it looks>

**The default where there's no call yet:** <fill: what a unit builds on
the taste layer when this page has no line for the choice. Usually the
version that costs least to build and to change: the target's own
behaviour, or the reference's where that's the one already in hand. Not
the reference's exact version built to match, unless the owner asks for
that.>

**A choice with no line here** is a candidate departure. The unit takes
the default above and carries on, and files the choice for the owner,
first checking `just find <words> --open` in case it's filed already:
- a unit for applying the call, where `docs/factory.md` puts shared work,
  since a call covers every case alike: `just tracker add-unit
  <group>/<slug> --title "…" --detail "…" --tags taste --needs <your
  unit>`. The detail says what the choice is and where it shows; `--needs`
  keeps it from being offered before its question is asked, and lands it
  on top of the default your unit builds;
- a question that blocks only that unit, never yours: `just ask …
  --blocks <group>/<slug> --scope <group>/<slug>`. Its options are the
  reference's version and the default (and any other worth building),
  each saying what it changes, and its context says where to see the
  difference in real output. `ask` then tells you to carry on.

When the owner answers, that unit applies their call to every case it
covers and writes its line below, citing the decision.

## Departures

Each line: what this project does instead of the reference, the owner's
decision (`d/<slug>`), and the exceptions the checks take for it.

(none yet)

## Kept from the reference

On the taste layer, where the owner chose the reference's version over the
default. Each line cites their decision, like a departure.

(none yet)
