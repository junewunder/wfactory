# wfactory in practice

What the run records say about cost and about the checks, and a unit's
path through the code. The README points here for the detail.

## A unit's path through the code

1. A lane's loop (`runtime/src/loop.ts`) asks what to take next
   (`loop-claim.ts`): its own unfinished merge, then group checks that are
   due, then the next workable unit, claimed through the tracker. The
   tracker's probes are refreshed before every claim.
2. It starts one headless Claude Code session on the unit, on its own
   branch (`loop-unit.ts`, `session.ts`), under a memory cap.
3. The tracker (`tracker/`) runs the unit's check and records the result.
4. With a git remote, the landing check runs if the project has one, then a
   fresh read-only session reviews the branch (`review.ts`), and the loop
   merges it into main and pushes (`landing.ts`).

## What each kind of check settles

| The check | What it settles | What it can miss |
| --- | --- | --- |
| A test or probe on the real target | done, and broken again later | what the test doesn't cover |
| A diff against a golden file | the output is the one you approved | a golden that was wrong from the start |
| A sampled or judged score | a trend, once resampled | any single run |
| A second session's judgment | prose, faithfulness, a look in an editor | what both sessions miss |

## What the records show

`just scorecard` reads these figures from a factory's own records.

In one factory (the mod factory in [lessons.md](lessons.md)), a fresh
session reviewed 593 finished branches from one machine's lanes before they
landed, everything recorded up to 17 November 2026. It sent 45 back for
fixes, 6 of them a second time. None landed without a review. (At the
time, a review that timed out or couldn't answer let the branch land, and
none did; now such a branch waits and is reviewed again.)

In the same factory, a finished unit cost a median of $1.68 in
API-equivalent terms, $1193.60 for 489 units, from one machine's lanes.

In the same factory in October 2026, the check each group of units runs
after merging (rebuild, test, publish) failed 125 of the 351 times it
finished, some of those false alarms in the check itself. Each failure held
back that group's publish.

## What it costs

From the run records of seven factories on one Max 20x plan in October
2026 (675 sessions):

- A session works one unit in a median of 9 minutes (35 at the 90th
  percentile) and costs a median of $1.30 in API-equivalent terms ($4.80 at
  the 90th percentile).
- A night of one lane worked about 30 units and used 4 to 9% of the week's
  usage. The 5-hour window peaked at 20 to 40%.

Those nights include some of my own use of the same account, so treat them
as rough. I've only measured Max 20x. Max 5x and Pro have a smaller share
of usage, so the same units take longer in proportion.

The lanes read your usage as they go and pause below a share of the 5-hour
window that you set (8% left by default). They don't act on the week's
usage, so a night can use up a week you wanted for other work: watch `just
usage`, and give the lanes a stop time.
