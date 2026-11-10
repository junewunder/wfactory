# wfactory profile

One per user, read by every factory on this machine. Prose is for agents;
the two tables are for the scripts (`scripts/profile.sh`). Nothing runs
while a fill-in placeholder is left.

## You

- **Name:** <fill: your name, as it appears in reports>
- **Address me as:** <fill: what agents call you in messages, e.g. your first name>
- **Reports:** <fill: where you read the overseer's reports and answer its
  questions, e.g. "this terminal", "the Claude Code thread, from my phone">
- **Preferences:** <fill: anything else agents should know about how you
  work, e.g. "short messages; ask before spending more than an hour of usage",
  or "none">

## Settings

The scripts read this table. Keep its columns.

| Setting | Value |
|---|---|
| agent | claude |
| pause below | 8 |
| keep back | 15 |
| store | none |

- **agent:** the agent CLI the loop starts, one session per unit. It has to
  accept Claude Code's flags (`-p` with the prompt on stdin, `--output-format
  stream-json`, `--append-system-prompt-file`), so this is `claude` or a
  wrapper around it.
- **pause below:** the lanes pause between units when less than this
  percentage of the 5-hour usage window is left, and resume when it resets.
  Use 0 to never pause.
- **keep back:** the percentage of the week's usage kept for your own use.
  The lanes pace themselves through the week: they may have used the share
  of the week that has gone by, less this, and pause between units while
  they're ahead of that. 0 keeps nothing back (the lanes may use the whole
  week, evenly); `off` means the week's usage is never acted on.
- **store:** where big group data lives when several machines share a
  factory, as an rsync-over-ssh target (`nas:/tank/factory`). `none` is
  right for one machine. See "Scaling out" in SKILL.md.

**Usage limits:** <fill: your plan and how much of it the factory may use,
e.g. "Claude Max; I use it by day too, so leave the morning's window alone",
or "API key, no plan limits; stop and ask past $20 a night">

## Machines

The machines a factory may run on. `init.sh` copies this table into each
new factory's `docs/machines.md`. One machine is the normal case.

| Machine | ssh | Lanes | Heavy | Can | Cache |
|---|---|---|---|---|---|
| <fill: hostname> | <fill: ssh address> | 1 | 1 | — | — |

- **Machine:** its short hostname (`hostname -s`).
- **ssh:** how the other machines reach it (an address or an ssh alias).
  For this machine alone, its hostname is fine; nothing uses ssh then.
- **Lanes:** how many loops it runs at once. Start at 1.
- **Heavy:** how many heavy jobs (builds, renders) run at once across its
  lanes. 1 unless it has the cores for more.
- **Can:** short names for what only this machine can do (`gpu`,
  `steam-login`), comma-separated, or `—`. Units that need one go only here.
- **Cache:** how much group data copied from the store may take here
  (`100G`), or `—` for no limit. Only matters with a store.
