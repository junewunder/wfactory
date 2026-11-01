// store.sh --help: what the store keeps where, and its commands.
export const HELP = `
store.sh — copy a group's data between this machine and the store, for loop.sh.

A group with data (its \`data\` values in tracker/groups/<g>.json) keeps its big
files on the store (tracker/project.json "store": remote, paths, inputs), not
in git. One machine at a time leases a group (the tracker, on main); the loop
copies its data down after taking the lease and back after each unit whose
work is on main, and after each run of the group's CI that rebuilt any of it
(its steps run main's code, so what they write is main's: a run elsewhere
would otherwise rebuild it again). Only
the lease holder ever writes a group's folder on the store. Sessions never
copy data. Everything goes by rsync (over ssh for a host:path remote), never a
network mount. Any copy that fails fails loudly: nothing is stamped or
released on a copy that didn't finish, and a copy back is tried again at each
look (after 2, 4, 8, 16, then every 30 minutes) until it goes through. An empty
copy here is never copied back or stamped.

The store keeps only merged work. With branches (an origin), a unit's outputs
are copied back once its branch is on main. A unit whose branch waits to land
(main broken, a merge unit) has its outputs held here, and copied back when it
lands. An unfinished unit (handed back, interrupted, a question, a lane killed
mid-session) gets the store's copy put back over the copy here, and what that
replaces is kept in aside/ until the unit is done or dropped, and the unit's
card says where. When the same unit is claimed again on this machine, its set
goes back into the copy here before its session (restore), if the set holds
that unit's outputs alone, they were built from the commit its branch is on
now, the copy here is still the one they were made over, and nothing else in
it is waiting to reach the store (another lane's session or CI run, another
unit's outputs waiting to land, a copy back owed);
otherwise its next session rebuilds them from its branch, and is told so. Nothing is copied back or put back while
another session here is working on the group: the copy has its outputs too.

On the store:
  <remote>/groups/<g>/<name>/    each data path (project.json store.paths, by name)
  <remote>/stamps/<g>.json       the unit, commit and host that last wrote it ("ci": <g> instead
                                 of a unit when the group's CI run did; {"copying": …} while a
                                 copy back is under way)
  <remote>/inputs/<input>/…      read-only inputs (downloads, extracted archives); laptops copy down the parts a unit reads
On this machine (work/.store/, shared by the lanes):
  groups/<g>.json         the stamp of the copy here; equal to the store's = current
  groups/<g>.list         the files of the copy here when it was stamped (name, size, time), and
                          those a CI run here wrote since (clean --since)
  groups/<g>.mirror       that listing came from a copy that mirrored the store (each file in it
                          was on the store); only then does a copy down trust it file by file
  groups/<g>.cistart.<lane>  a CI run in that lane started on a copy as stamped ("clean") or not;
                          only a clean start's writes go into the listing
  groups/<g>.dirty.<lane> a session in that lane is working on it: its unit, and its loop's
                          pid and start time. One whose loop is gone (a lane killed) ended unmerged
  groups/<g>.unmerged.<u> the copy here has outputs of unit <u> (/ as +) that aren't on main yet
  groups/<g>.unsent       a copy back is due: one started and didn't finish, failed, or waits
  groups/<g>.retry        for a due copy back: its unit ("ci" for a CI run's), commit, failed tries
                          and the last one's time. A CI run's alone, once the store has moved on
                          since, is dropped, not set aside: what it wrote is main's
  groups/<g>.used         touched on every copy, for least-recently-used eviction
  groups/<g>.ready        a take under this machine's current lease finished: the copy here
                          is the store's or newer (gone when the lease is released)
  inputs/…                a marker per input part already copied down
  ran                     a session ran here since the last leave (the loop touches it as
                          each one ends): the next leave ends a run of the lanes, for the
                          kept sets below
  aside/<g>-<time>/       what a copy down replaced or deleted in a copy not proven to be
                          on the store, by path name, less what the store has byte for
                          byte and (unless worked on here) what store.rebuilt matches
                          and what's still as the copy here was last stamped (the store's
                          older copy, or a CI run's: groups/<g>.list).
                          Its .kind says "older" when the copy here wasn't worked on and
                          the copy down only replaced files with newer ones from the
                          store: deleted at once (event store-aside-old). Else "check":
                          a unit, aside/<g>-<host>-<time> pinned to this machine, sorts
                          it (event store-aside; .unit names the unit), in a group of its
                          own (aside): no gates or parks, at its data group's priority, and
                          filed too for a group that keeps no data any more. "unmerged": what putting
                          the store's copy back replaced, the outputs of the units in .units (.from:
                          each one's session and branch commit, as its lane knew them when it ended;
                          .base: the stamp of the copy they were made over);
                          deleted by \`aside sort\` once they're all done or dropped, or by restore.
                          One to sort ("check", with a unit) once a unit it holds is parked or
                          pinned to another machine, or at the end of the next run of the lanes here
                          (.night: marked at the end of the first) with its unit not claimed here since

Why a copy differs from the store's: it was there before the store (older outputs, an
older pipeline's layout), or something wrote the group's folders without its lease (a
unit whose data is none or another group, a folder two groups share, a command run by
hand outside the lanes). tracker/project.json store.rebuilt lists files a pipeline step
rebuilds, as globs over <name>/<path> (\`*\` crosses folders, e.g. "out/*",
"proj/Cache/*.bin"): their differences don't matter, so they aren't kept
(\`tracker rebuilt add <glob> --why "…"\` adds one).

A copy down happens when this machine takes a new lease, and not when the copy
here is current. A lease it already holds means the copy here is the newest
only once a take under that lease has finished (groups/<g>.ready): another
lane's copy down still running is waited for, and one that failed is done
again. If the copy here isn't proven to be on the store (no stamp, a
session worked on it, a copy back that didn't finish, files changed since its
stamp), whatever the copy down replaces or deletes goes to aside/ first.

The cache. Groups' data here stays under this machine's Cache in
docs/machines.md (inputs and aside/ aren't counted). Before a new lease's copy
down would go over it, the least recently used groups are deleted that this
machine doesn't lease and that are safe: nothing marks them worked on or
unsent, and either their stamp matches the store's and \`rsync --dry-run\` has
nothing to send, or the store has moved on from them (another machine
leased the group since) and their files are exactly as listed when they last
matched the store. Failing that, the lane skips units that need a new lease.

Usage:
  factory/store.sh take <group> --unit <id> [--new] [--mark <unit> <pid>]  a claimed unit's data (--mark:
                                   then mark it as worked on by that session, as \`dirty\`): with --new (the claim
                                   took a new lease) make room and copy down unless current; then
                                   the unit's inputs. Exit 1: no room; other non-zero: failed.
  factory/store.sh end <group> <unit> [<commit>]  the unit's session ended: copy back if its work is on
                                   main (or there are no branches), hold its outputs if its branch waits
                                   to land, put the store's copy back if it's unfinished. Exit 2: a copy
                                   back failed (it's tried again at each look)
  factory/store.sh restore <group> <unit>     the same unit claimed again, on its branch: put its own set
                                   back (see above). Prints a line for its session. Exit 0: put
                                   back; 1: no set of its; 3: its set refused (other units' outputs
                                   in it, built from another commit, the copy moved on, or other
                                   work here not on the store yet)
  factory/store.sh up <group> <unit> [<commit>]  copy back now (lease holder only) and stamp it
  factory/store.sh dirty <group> [<unit> <pid>]  a session in this lane (its loop's pid) is about to work on it
                                                 (unit "ci": a CI run, which writes it too: a live one
                                                 holds up a put-back and a copy back)
  factory/store.sh clean <group> [--since <epoch> [--up <commit>]]  this lane's CI run on it is over;
                                                 --since: when it started, so the files it wrote go into
                                                 the copy's stamp listing (CI runs main: they're rebuilt
                                                 from git); --up: then copy them back, as the group's CI
                                                 at <commit>, if the run started on the store's copy and
                                                 nothing else here is waiting to reach the store (else
                                                 nothing, or they go with the copy back owed). As \`up\`:
                                                 the lease holder only, only over the copy it came from;
                                                 a failure is owed, tried again at each look. Exit 2: failed
  factory/store.sh release-idle                  settle what each copy here owes the store (above), then
                                                 release leases with nothing left here, once safe
  factory/store.sh leave [--now]                 the last lane stopping: copy back and release
                                                 (--now, "stop now": release only what's already safe)
  factory/store.sh safe <group>                  exit 0 if the copy here may be deleted
  factory/store.sh adopt <group>                 (migrations) stamp the copy here current, only if rsync
                                                 shows it identical to the store's; exit 1 if it isn't
  factory/store.sh seed <group> --from <path>    a group whose data starts outside groups/ (a shared pool,
                                                 an import): on the store, move <path>/<name> (path names,
                                                 <path> relative to the store) into groups/<group>/ and
                                                 stamp it, in one go; then copy it down if this machine
                                                 holds the lease (else the next claim's copy down brings
                                                 it). Refuses (exit 1) if another machine leases the group,
                                                 the group has files on the store or a stamp other than an
                                                 empty copy's (bytes 0), or it's leased here and the copy
                                                 here has files. Run again after a failure, it carries on:
                                                 stamps a move cut short, or copies down a seeded group
  factory/store.sh status                        groups here: size, current, worked on, leased
  factory/store.sh aside                         list what's set aside here, and the unit sorting each
  factory/store.sh aside sort                    delete older-only sets, and file a unit for each other set
                                                 that has none (one without a kind too); release-idle and
                                                 leave run it, and so does each lane as it starts
  factory/store.sh aside audit <set>             each file in a set the store doesn't hold byte for byte:
                                                 store-newer (an older copy), aside-newer or not-on-store
  factory/store.sh aside drop <set>              delete a set once sorted (its unit's last step)
  factory/store.sh init                          once, for a new store: make its stamps/ folder. A store
                                                 without one (a dataset not mounted, a wrong path) is
                                                 an outage, never "nothing there yet"

Environment: FACTORY_HOST (else the hostname), FACTORY_STORE (the remote,
overriding project.json), FACTORY_CACHE (the limit, overriding the machines
file; e.g. 100G, or none), FACTORY_STORE_RETRY (minutes before a failed copy
back's second try, doubling up to 30; default 2).
`;
