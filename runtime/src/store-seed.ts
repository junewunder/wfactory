// adopt and seed: a group's data that starts outside the store's groups/, or already matches it.
import fs from "node:fs";
import { event } from "./events.ts";
import { lock, stamp } from "./sys.ts";
import { here } from "./store-here.ts";
import { gf, glock, hasFiles, stampHere, used } from "./store-local.ts";
import { code, copy, copyStamp, gitShort, listed, remoteStamp, rsync, run, storeSh } from "./store-remote.ts";

import { alt, anyFile, cat, json, L, log, MB, out, rm, rmrf, tmpdir, touch, type Data } from "./store-util.ts";
import { room } from "./store-cache.ts";
import { data, tr } from "./store-tracker.ts";

// The copy here is identical to the store's (every path, both ways): stamp it current.
export function adopt(g: string): number {
  const d = data([g]);
  if (!d) return 2;
  const rs = remoteStamp(d.remote, g);
  if (rs === null) return 2;
  if (!rs) { log(`${g}: nothing on the store to match`); return 1; }
  const x = rsync(["--list-only", "--protect-args", `${d.remote}/groups/${g}/`], { err: "ignore" });
  if (code(x) !== 0) { log(`${g}: can't list it on the store`); return 2; }
  for (const p of d.paths) {
    if (fs.existsSync(p.local)) {
      const o = rsync(["-a", "--dry-run", "--delete", "-i", "--protect-args", `${p.local}/`, `${d.remote}/groups/${g}/${p.name}/`], { err: "pipe" });
      if (code(o) !== 0) return 1;
      if (o.stdout + o.stderr !== "") { log(`${g}: ${p.name} differs from the store's`); return 1; }
    } else if (listed(x.stdout, p.name)) { log(`${g}: ${p.name} is on the store but not here`); return 1; }
  }
  glock(g); stampHere(g, d, rs, true); used(g);
  log(`${g}: the copy here is the store's; stamped current`);
  return 0;
}

// On the store: move each path of the group that has files from <from> into groups/<g>/, unless
// its stamp changed since it was read (its checksum: <want>) or the group's folder has files
// there already. A group folder with files but no stamp is a seed cut short. Says what it did,
// one line each.
export const SEED = `set -e
g=$1 from=$2 want=$3; shift 3
if [ -e "stamps/$g.json" ]; then have=$(cksum < "stamps/$g.json"); else have=none; fi
[ "$have" = "$want" ] || { echo stamp-changed; exit 0; }
files() { [ -n "$(find "$1" ! -type d 2>/dev/null | head -1)" ]; }
move=""
for p; do
  files "$from/$p" || continue
  ! files "groups/$g/$p" || { echo has-data; exit 0; }
  move="$move $p"
done
if [ -z "$move" ]; then
  files "groups/$g" && echo moved-before || { [ -d "$from" ] && echo no-paths || echo no-from; }
  files "groups/$g" || exit 0
else
  mkdir -p "groups/$g"
  for p in $move; do
    rm -rf -- "groups/$g/$p"   # folders only: no files, checked above
    mv -- "$from/$p" "groups/$g/$p"
  done
  rmdir -- "$from" 2>/dev/null || true
fi
# du -sbL's bytes; a BSD du has no -b (a store on a Mac): each file's own size, each file once.
size() { du -sbL "$1" 2>/dev/null | cut -f1 | grep . || find -L "$1" ! -type d -exec stat -L -f '%d:%i %z' {} + | awk '!s[$1]++ { n += $2 } END { print n + 0 }'; }
b=0; for p; do [ ! -e "groups/$g/$p" ] || b=$((b + $(size "groups/$g/$p"))); done
echo "moved $b"
for p; do [ ! -e "groups/$g/$p" ] || echo "has $p"; done
[ ! -d "$from" ] || ls -A -- "$from" | sed 's/^/left /'
`;

export function seed(args: string[]): number {
  const usage = () => { console.error("store: seed <group> --from <store path>"); return 2; };
  const g = args[0] ?? "";
  let from = "";
  for (let i = 1; i < args.length;) { if (args[i] === "--from") { from = args[i + 1] ?? ""; i += 2; } else return usage(); }
  if (!g || !from) return usage();
  if (from.endsWith("/")) from = from.slice(0, -1);
  const w = `/${from}/`;
  if (w.startsWith("/-") || w.startsWith("//") || w.includes("/../") || w.includes("/./") || /^\/(groups|stamps|inputs)\//.test(w)) {
    console.error(`store: seed: --from is a folder on the store, relative to it, outside groups/, stamps/ and inputs/ (got "${from}")`);
    return 2;
  }
  const d = data([g]);
  if (!d) return 2;
  const r = d.remote, names = d.paths.map((p) => p.name);
  if (!names.length) { log(`${g}: no data paths`); return 2; }
  // The cache lock before the group's, as take has them: a copy down may follow.
  lock(`${L}/lock`);
  glock(g);
  // Leased here: copy it down too. By nobody: the next claim's copy down brings it. By another
  // machine: its copy there (empty, and marked ready) would never be copied down over, so seed it there.
  const hr = tr(["lease", "holder", g, "--fresh"], "ignore");
  if (code(hr) !== 0) { log(`${g}: origin can't say who leases it; nothing seeded`); return 2; }
  const holder = out(hr.stdout);
  if (holder && holder !== here.host) { log(`${g}: leased by ${holder}; seed it there (or once the lease is released)`); return 1; }
  const held = holder === here.host;
  // With the lease here, the copy here must be empty, or the store's byte for byte (a copy down cut
  // short): anything else would be mixed with the seeded data.
  if (held && hasFiles(d) && !fromStore(g, d)) {
    log(`${g}: leased here, and the copy here already has files the store doesn't; not seeding over them (look at them first)`); return 1;
  }
  // The store's stamp, read once: what it says, and its bytes' checksum for the store to check that
  // nothing wrote it meanwhile. Only an empty copy's (bytes 0, a finished copy back) may be there.
  const t = tmpdir();
  let rs = "", x = "", rc: number;
  try {
    rc = code(rsync(["-q", "--protect-args", `${r}/stamps/${g}.json`, `${t}/s`], { err: "ignore" }));
    if (rc === 0) { rs = cat(`${t}/s`) ?? ""; x = out(run("cksum", [], { input: fs.readFileSync(`${t}/s`) }).stdout); }
    else if (rc === 23) { x = "none"; if (code(rsync(["-q", "--list-only", "--protect-args", `${r}/stamps/`], { err: "ignore" })) !== 0) rc = 2; }
  } finally { rmrf(t); }
  if (rc !== 0 && rc !== 23) { log(`${g}: can't read the store`); return 2; }
  if (rs) {
    const j = json(rs);
    if (!(j && j.copying == null && j.bytes === 0)) {
      // Seeded already: with the lease here and nothing here but the store's (a seed whose copy down
      // failed), copy it down.
      if (held && j && j.copying == null && Number(alt(j.bytes, 0)) > 0) {
        const sd = seedDown(g, d, rs);
        if (sd === 0) { log(`${g}: already seeded on the store; leased here with no files here, so copied down`); return 0; }
        if (sd !== 3) { seedFailed(g, sd); return sd === 4 ? 1 : 2; }
      }
      log(`${g}: the store has a stamp for it (${rs}); not seeding (already seeded?)`); return 1;
    }
  }
  // On the store, in one script. Only paths with files count, in <path> and in the group's folder. A
  // path in both is refused. A group folder with files but no stamp is a seed cut short (partway
  // through the move, or before its stamp): what's left in <path> is moved, and it's stamped.
  const sr = storeSh(r, [g, from, x, ...names], SEED);
  if (code(sr) !== 0) { log(`${g}: couldn't run the move on the store (run seed again: it carries on where it stopped)`); return 2; }
  // (Read by line: anything else the store prints, a login banner, is ignored.)
  const state = out(sr.stdout), lines = state.split("\n");
  if (lines.includes("stamp-changed")) { log(`${g}: its stamp on the store changed meanwhile; nothing moved`); return 1; }
  if (lines.includes("has-data")) { log(`${g}: groups/${g} on the store already has files; nothing moved (already seeded?)`); return 1; }
  if (lines.includes("no-from")) { log(`${g}: ${from} isn't on the store; nothing moved`); return 1; }
  if (lines.includes("no-paths")) { log(`${g}: ${from} on the store has none of the group's paths (${names.join(" ")}); nothing moved`); return 1; }
  const moved = lines.find((l) => /^moved [0-9]+$/.test(l));
  if (!moved) { log(`${g}: unexpected answer from the store: ${state}`); return 2; }
  const n = Number(moved.slice(6));
  if (lines.includes("moved-before")) log(`${g}: groups/${g} on the store has its data and no stamp, and ${from} none of its paths (a seed cut short?); stamping it`);
  else log(`${g}: moved ${lines.filter((l) => l.startsWith("has ")).map((l) => l.slice(4)).join(" ")} from ${from} to groups/${g} on the store (${MB(n)} MB)`);
  const left = lines.filter((l) => l.startsWith("left ")).map((l) => l.slice(5));
  if (left.length) log(`${g}: left in ${from} (not the group's paths): ${left.join(" ")}`);
  // The stamp, written by rsync as a copy back's is (never a remote shell write).
  const st = JSON.stringify({ unit: `${g}/seed`, commit: gitShort(), host: here.host, at: stamp(), bytes: n, from });
  const td = tmpdir();
  try {
    fs.writeFileSync(`${td}/stamp`, `${st}\n`); fs.chmodSync(`${td}/stamp`, 0o644);
    if (!copyStamp(`${td}/stamp`, `${r}/stamps/${g}.json`)) { log(`${g}: moved on the store, but its stamp couldn't be written; run seed again to stamp it`); return 2; }
  } finally { rmrf(td); }
  event("store-seeded", `${g}'s data moved on the store from ${from} to groups/${g} (${MB(n)} MB) by ${here.host}, and stamped`);
  if (!held) { log(`${g}: not leased; the next claim's copy down brings it`); return 0; }
  const sd = seedDown(g, d, st);
  if (sd !== 0) { seedFailed(g, sd); return sd === 4 ? 1 : 2; }
  log(`${g}: leased here, so copied down too; the copy back after this unit sends it back as it is`);
  return 0;
}
// Nothing here is the store's yet (seedDown's exit: 4 no room, else failed).
export function seedFailed(g: string, rc: number) {
  rm(gf(g, "ready"));
  if (rc === 4) log(`${g}: seeded on the store, but there's no room for it here; run seed again once there is`);
  else log(`${g}: seeded on the store, but the copy down failed; run seed again to copy it down`);
}
// Is every file here the store's, byte for byte (as rsync sees it: size and time)? Then nothing here
// is lost by a copy down over it: what a copy down cut short leaves.
export function fromStore(g: string, d: Data): boolean {
  for (const p of d.paths) {
    if (!anyFile(p.local, false)) continue;
    const o = rsync(["-a", "-n", "-i", "--protect-args", `${p.local}/`, `${d.remote}/groups/${g}/${p.name}/`], { err: "ignore" });
    if (code(o) !== 0 || o.stdout.split("\n").some((l) => /^.[fLDS]/.test(l))) return false;
  }
  return true;
}
// Copy a seeded group down into the copy here (empty, or the store's from a copy down cut short) and
// stamp it current; the locks are held. Through a path that's a link, as copyDown does. Session marks
// stay: the session that ran seed works on this copy next. 3: the store has no files for it; 4: no
// room here; 2: failed.
export function seedDown(g: string, d: Data, rs: string): number {
  const x = rsync(["-r", "--list-only", "--protect-args", `${d.remote}/groups/${g}/`], { err: "ignore" });
  if (code(x) === 23) return 3;
  if (code(x) !== 0) return 2;
  if (!x.stdout.split("\n").some((l) => /^[^d]/.test(l))) return 3;
  const rr = room(g);
  if (rr === 1) return 4;
  if (rr !== 0) return 2;
  for (const p of d.paths) {
    if (!listed(x.stdout, p.name)) continue;
    if (!copy(`${d.remote}/groups/${g}/${p.name}/`, `${p.local}/`)) return 2;
  }
  stampHere(g, d, rs);
  touch(gf(g, "ready")); used(g);
  return 0;
}
