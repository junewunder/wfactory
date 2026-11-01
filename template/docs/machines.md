# Machines

The only place facts about this factory's machines live: which machines run
it, how many lanes each runs, the account each app runs under, and what each
machine can do. Every other doc points here instead of restating them. The
overseer reads this file at the start; each loop session gets its own
machine's section (`## <machine>`) in its prompt. When the owner says
anything about a machine or an account, it goes in here and is committed
before anything else happens.

`init.sh` wrote the table from the owner's profile (`scripts/profile.sh
machines` in the skill). One machine with one lane is the normal case; more
machines are opt-in (the skill's docs/scaling-out.md).

## Lanes

The scripts read this table by its column headers (`factory/machines.sh`), so
the columns can be in any order; keep their names. A missing column gives its
default, with a warning.

| Machine | ssh | Lanes | Takes | Checkout | Can | Cache | Heavy | Reserve | GPU |
|---|---|---|---|---|---|---|---|---|---|
__MACHINE_ROWS__

- **Machine:** its short hostname (`hostname -s`). A unit pinned with
  `--host <machine>` runs only there.
- **ssh:** the address `just fleet` reaches it at from the other machines.
- **Lanes:** how many loops run on it at once, each taking any unit the
  machine can do. Start at 1; raise it once there are tokens and CPU for
  more. 0 means the factory never runs there.
- **Takes:** `any` (every unit this machine can do) or `pinned` (only units
  pinned to it with `--host`, leaving the rest to the other machines).
- **Checkout:** the repo on that machine, where the owner and the overseer
  work; it stays on main. With an origin, each lane runs in a plain clone
  beside it (`<checkout>-lane1`, `-lane2`, …; never a worktree) whose
  `work/` links to the checkout's, so a machine keeps one `work/`. A project
  that needs more in a fresh clone (a virtualenv, generated stubs) does it in
  `factory/lane-setup`.
- **Can:** what only some machines can do, as short names separated by commas
  (e.g. `gpu`), or `—`. A unit that needs one (`just tracker edit <id>
  --caps gpu`) goes only to a machine whose Can lists it. This, not pins,
  is what ties work to a machine. Each name is explained in the machine's
  section below.
- **Cache:** how much the groups' data copied down from the store may take on
  this machine, e.g. `100G`, or `—` for no limit. Only matters with a store.
  Inputs aren't counted. Over it, the loop deletes the least recently used
  groups that are safe on the store before taking a new lease
  (`factory/store.sh`).
- **Heavy:** how many heavy jobs (`just capped`, `just long start`) run on
  it at once, across all its lanes; the rest wait their turn. Two lanes'
  renders plus an editor on one 8-core laptop ran about 4 times slower
  than one render alone, so it's 1 unless the machine has the cores for more.
  Blank means 1. These slots are for jobs expected to run long; one its past
  runs say is short (a few minutes) runs beside them when the memory budget
  has room. A command that barely uses the CPU skips the queue with
  `--light`.
- **Reserve:** memory kept back from the heavy jobs for the desktop and the
  sessions, e.g. `3G` (blank: 3G). The rest of the machine's memory is the
  budget the heavy jobs (`just capped`, `just long start`) reserve their
  shares from, across all its lanes; `just heavy` shows it. No heavy job
  starts while the memory available is under the reserve plus GPU.
- **GPU:** memory no job's cap counts that the machine needs anyway, measured,
  e.g. `6G` for an editor's GPU buffers (blank: 0).

__MACHINE_SECTIONS__
