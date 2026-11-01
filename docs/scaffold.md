# Scaffold

The first step of setting up a factory (SKILL.md, "Setting up a factory").

```bash
bash ${CLAUDE_SKILL_DIR}/scripts/init.sh <name> [--dir <parent>]
bash ${CLAUDE_SKILL_DIR}/scripts/init.sh .          # retrofit the current repo
```

Other harnesses: use this skill folder's real path, `scripts/init.sh`.

It refuses until the profile is complete, and never overwrites anything. In
an existing repo it appends a section to AGENTS.md, adds an `import` line to
the justfile and fills in what's missing. What it lays down:

| File | Holds |
|---|---|
| `AGENTS.md` (+ `CLAUDE.md` = `@AGENTS.md`) | Where things go, ground rules, the memory rules. Lean on purpose. |
| `docs/factory.md` | The spec: goal, unit, oracle, done/kill, gates, **the loop procedure**, resources. Rules only, each a line with a pointer; how a tool works goes in `docs/tools/<tool>.md`. `lint` caps it at 4,000 words and 1,000-character lines. |
| `docs/machines.md` | The machines (from the profile): lanes per machine (a table the scripts read), accounts, what each can do. The only place machine facts live. |
| `docs/tools.md` | What's installed for images, video and audio, and the project's way to do each job (`just view-image` to look at an image). Lane sessions read it before reaching for a tool. Fill it from what's on the machines. |
| `tracker/` | State as JSON, changed only by the tracker CLI: groups of units, questions for the owner, decisions, a log. See SKILL.md, "The tracker". A new one holds only the opening's gate. |
| `memory/MEMORY.md` | The index, made from the memory files' frontmatter by `just memory` (so two branches adding memories never clash), with an `## Open` section. Starts empty: memory is earned, not scaffolded. |
| `justfile` → `factory/factory.just` | `check` (yours to wire), the tracker's commands (`status`, `next`, `done`, `ask`, `view`, …), `loop`, `oversee`, `pause`, `runs`, `capped`. |
| `factory/` | Stubs that run this skill's deployed code (the loop, the tracker, long jobs, usage, fleet, store), so nothing is copied into the factory. See "The loop's code lives in this skill", below. |
| `factory/tidy`, `factory/lane-setup`, `factory/pre-session` (yours, optional) | What to stop when the last lane on a machine stops; what a new lane's clone needs (a virtualenv); warm-ups before each session. |

As the opening goes, fill the spec and wire `check` and `rebuildable`
([design question 11](design-questions.md) says what they must prove; read
that question when you wire them). Once its gate is passed and the design is
settled, add the units (SKILL.md, "The tracker"). `just loop` refuses to
start until the opening's gate is passed, while the spec, the machines file or the profile still has
`<fill: …>` placeholders, or while `check` is the placeholder.

**The loop's code lives in this skill,** never in a factory. The code is
`runtime/` (loop, fleet, store, long jobs, prompt, overseer's guide, the
recipes in `factory.just`) and `tracker/`. A factory's `factory/` holds only
the stubs from `template/factory/`, which run a deployed copy. Each machine
deploys under `~/.local/share/wfactory`: `scripts/deploy.sh` fetches
this repo's main from where it was installed from, extracts that commit into
its own folder and points `current` at it, so only pushed commits reach
lanes, never an edit in progress. The first stub run on a machine deploys;
`just skill-deploy` updates. A running loop keeps the version it started with
(FACTORY_SKILL, inherited), so a deploy mid-run never mixes versions; `just
fleet restart <machine>` moves running lanes onto a new one, each as soon as
its unit ends. `just`
reads the recipes through `.tracker/skill`, a link `factory/skill` keeps.
Set FACTORY_SKILL to a checkout to try a change before it's pushed. The loop
drops a session's edits to the stubs at merge time (they stay in the
branch's history, and a `factory-edits` event says where) unless the unit
is tagged `factory`. The `.local.md` files, `tidy`, `lane-setup`,
`pre-session` and `auto-mode.json` are the project's own (the template's
`auto-mode.json` is a start: the classifier's standing OK for `just store seed`).
`scripts/factory-diff.sh <repo>` (read-only) says whether a factory's stubs
are current, and `scripts/to-stubs.sh <repo>` converts one that still carries
copies of the scripts.

## Left out on purpose

- **No copy of house rules in the factory.** Copies drift. Rules live in
  AGENTS.md and the spec, and only project-specific ones.
- **No hooks or `.claude/settings.json` by default.** Add a PreToolUse hook
  that blocks edits to tests, goldens or holdout scenarios when the oracle is
  gameable and an agent has been caught gaming it, not before.
- **No recipe nobody runs.** Delete scaffolded recipes the project doesn't
  use; a stale one is worse than none.

## Next: the opening

The scaffold is done when `init.sh` has run and `just status` shows the
opening's gate waiting on the owner.
Then read [opening.md](opening.md), all of it, and run the opening.
