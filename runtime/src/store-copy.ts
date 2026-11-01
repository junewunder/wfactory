// Copying a group's data down and back, and settling what the copy here owes the store.
import fs from "node:fs";
import path from "node:path";
import { event } from "./events.ts";
import { epoch, pwd, stamp } from "./sys.ts";
import { asideCounts, asideUnit, setGroup } from "./store-aside.ts";
import { here } from "./store-here.ts";
import { after, backoff, bytes, ciOwed, due, gf, glock, hasFiles, localStamp, markLive, marks, ownTorn, retryOf, setRetry, stamped, stampHere, unchanged, unmerged, used, workedOn } from "./store-local.ts";
import { code, copy, copyStamp, duh, gitShort, listed, remoteStamp, rsync, run } from "./store-remote.ts";
import { cat, count, dropEmpty, fields, filesFollowed, isDir, isFile, jqs, json, L, log, ls, MB, mkdirp, out, rebuilt, rm, rmrf, sameBytes, stat, timeName, touch, walk, who } from "./store-util.ts";
import { remoteOf } from "./store-local.ts";
import { data, heldHere, tr, ustate } from "./store-tracker.ts";

// With units, it puts the store's copy back over the copy here, current or not: what that
// replaces or deletes is those units' unmerged outputs, kept aside (kind "unmerged") until
// they're done or dropped. A data path the store doesn't have goes aside whole (all of them, with
// nothing on the store). A unit given as +<id> is finished (on main, or its branch waiting to
// land): its outputs are in the copy too and can't be told apart, so nothing rebuilds them, and
// the set is one to sort (kind "check", with a unit); so is a set with no unit named (a mark from
// an older store.sh), or one put back over a store with nothing on it (the copy may predate the
// store). prov: each unfinished unit's session and the commit its outputs were built from, from its
// mark (none for a lane killed). The group's lock is held. 0, or 2: failed.
export function copyDown(g: string, units: string[] = [], prov = new Map<string, [string, string]>()): number {
  const back: string[] = [], fin: string[] = [];
  for (const x of units) if (x.startsWith("+")) { fin.push(x.slice(1)); back.push(x.slice(1)); } else back.push(x);
  const d = data([g]);
  if (!d) return 2;
  const r = d.remote, rb = d.rebuilt ?? [];
  const rs = remoteStamp(r, g);
  if (rs === null) { log(`${g}: can't read the store`); return 2; }
  const ls = localStamp(g);
  let aside = "", kind = "unmerged";
  if (back.length) {
    const j = json(rs);
    if (j?.copying) event("store-torn", `${g} on the store is a copy back that didn't finish (${jqs(j.copying)} from ${jqs(j.host)}); put back over the copy on ${here.host} as it is`);
    // A copy back owed (.unsent: a finished unit's, failed or waiting, or this machine's own cut
    // short; .moved) means finished work is in the copy too. A CI run's alone doesn't: what it
    // wrote is main's, rebuilt from git.
    if (fin.length || (isFile(gf(g, "unsent")) && !ciOwed(g)) || !rs || back.includes("")) kind = "check";
    // Written first, so a put-back cut short leaves a set that says what it is.
    aside = `${pwd()}/${L}/aside/${g}-${timeName()}`;
    mkdirp(aside);
    fs.writeFileSync(`${aside}/.kind`, `${kind}\n`);
    fs.writeFileSync(`${aside}/.units`, back.map((x) => `${x}\n`).join(""));
    // Where each unfinished unit's outputs came from (restore() checks it): its session, and the
    // commit its branch is on, which they were built from.
    // And the copy they were made over (its stamp, before this put-back): they're only good over
    // that copy. Put back later, under a store that has moved on (another machine's work landed),
    // the copy here differs from it, and restore() refuses them.
    fs.writeFileSync(`${aside}/.base`, `${ls}\n`);
    fs.writeFileSync(`${aside}/.from`, back.filter((x) => x && !fin.includes(x)).map((x) => `${[x, ...(prov.get(x) ?? [out(tr(["state", x, "--by"], "ignore").stdout), ""]), here.host].join("\t")}\n`).join(""));
  } else {
    if (!rs) { log(`${g}: nothing on the store yet; the copy here is the first, copied back after the next unit`); touch(gf(g, "ready")); return 0; }
    if (rs === ls) { log(`${g}: the copy here is current`); touch(gf(g, "ready")); return 0; }
    // Copying that torn copy down would put the store's half over the whole here: copy back again.
    if (ownTorn(g, rs)) {
      const u = jqs(json(rs)?.copying);
      log(`${g}: the store has this machine's copy back of ${u} cut short; copying back again instead of down`);
      if (!heldHere(g)) { log(`${g}: not leased by ${here.host} (or origin can't say so); nothing copied`); return 2; }
      return send(g, u, "") === 0 ? 0 : 2;
    }
    const j = json(rs);
    if (j?.copying) event("store-torn", `${g} on the store is a copy back that didn't finish (${jqs(j.copying)} from ${jqs(j.host)}); copied down as it is`);
  }
  // Not proven to be on the store: keep what the copy down replaces. rsync makes the folder only
  // for a file it replaces or deletes, and a file the store has byte for byte is dropped from it;
  // a copy that only lacked files (a laptop that had just the mod folder, say) has nothing to
  // keep and raises nothing. Worked on here, a file's time says nothing: an older one can hold a
  // session's work.
  // A CI run's copy back alone, still owed, isn't work here: what it wrote is main's, and in the
  // copy's listing (ciMade), so a copy down over it (the store moved on) keeps nothing of it.
  const ciOnly = ciOwed(g) && !marks(g, "dirty").length && !marks(g, "unmerged").length;
  const worked = (workedOn(g) && !ciOnly) || back.length > 0;
  if (!aside && (worked || (hasFiles(d) && (!ls || !unchanged(g, d))))) aside = `${pwd()}/${L}/aside/${g}-${timeName()}`;
  let names = "";
  if (rs) {
    const x = rsync(["--list-only", "--protect-args", `${r}/groups/${g}/`], { err: "ignore" });
    if (code(x) !== 0 && code(x) !== 23) { log(`${g}: can't list it on the store`); return 2; }
    names = x.stdout;
  }
  // Each file as the copy here was last stamped (the store's copy then, or a CI run's since): one
  // still so wasn't changed here, only replaced or deleted on the store since.
  const was = stamped(g), mirror = isFile(gf(g, "mirror"));
  let nb = 0, ns = 0;
  for (const p of d.paths) {
    if (!listed(names, p.name)) {
      if (back.length && fs.existsSync(p.local)) { mkdirp(aside); if (code(run("mv", ["--", p.local, `${aside}/${p.name}`])) !== 0) return 2; }
      continue;
    }
    if (!copy("--delete", ...(aside ? ["--backup", `--backup-dir=${aside}/${p.name}`] : []), `${r}/groups/${g}/${p.name}/`, `${p.local}/`)) return 2;
    // A file that differed only in its time is backed up too: drop those, same bytes as the
    // store's. Unless a session worked on the copy here, drop what a pipeline step rebuilds too
    // (store.rebuilt), and each file still as the copy here was stamped: the store's own older
    // copy (or a CI run's, rebuilt from git), which a copy back since replaced or deleted.
    if (aside && isDir(`${aside}/${p.name}`)) {
      const files = [...walk(`${aside}/${p.name}`)].filter((e) => e.st.isFile()).map((e) => e.rel);
      const now = worked ? new Map<string, string>() : new Map(filesFollowed(`${aside}/${p.name}`, false).map((l) => { const i = l.indexOf("\t"); return [l.slice(0, i), l.slice(i + 1)] as const; }));
      for (const f of files) {
        if (sameBytes(`${aside}/${p.name}/${f}`, `${p.local}/${f}`)) rm(`${aside}/${p.name}/${f}`);
        else if (!worked && rebuilt(`${p.name}/${f}`, rb)) { rm(`${aside}/${p.name}/${f}`); nb++; }
        else if (!worked && now.has(f) && was.get(`${p.name}\t${f}`) === now.get(f)) { rm(`${aside}/${p.name}/${f}`); ns++; }
      }
      dropEmpty(aside);
    }
  }
  if (nb) log(`${g}: ${nb} files the copy down replaced or deleted are ones a pipeline step rebuilds (store.rebuilt); not kept`);
  if (ns) log(`${g}: ${ns} files the copy down replaced or deleted were as the copy here was last stamped (the store's older copy); not kept`);
  const set = `${L}/aside/${path.basename(aside)}`;
  if (back.length && ![...walk(aside)].some((e) => ![".kind", ".units", ".from", ".base"].includes(e.name))) {
    rmrf(aside); log(`${g}: put the store's copy back over the copy here; nothing here differed`);
  } else if (back.length && kind === "unmerged") {
    log(`${g}: put the store's copy back over the copy here; the outputs of ${(cat(`${aside}/.units`) ?? "").split("\n").join(" ")} (${duh(aside)}) are kept in ${set} until done or dropped`);
    tellAside(aside, set);
  } else if (back.length) {
    const unfinished = back.filter((x) => x !== "" && !fin.includes(x)).join(" ");
    const n = count(aside, (e) => !e.st.isDirectory() && ![".kind", ".units", ".from", ".base"].includes(e.name)), sz = duh(aside);
    tellAside(aside, set);
    const sorted = asideUnit(aside, g, d);
    event("store-aside", `${g}'s copy on ${here.host} had outputs of unfinished ${unfinished}${fin.length ? `, mixed with finished ${fin.map((x) => `${x} `).join("")}work nothing else rebuilds,` : ""}${rs ? "" : " and nothing on the store to put back"}; everything not on the store (${n} files, ${sz}) is kept in ${set}; ${sorted}`);
  } else if (aside && isDir(aside)) {
    // Older copies only: nothing worked on here, nothing deleted, every file replaced by a newer one.
    // Not with a mirror's listing: it vouched for each file as stamped, so what's left was
    // changed here, however old.
    const [newer, other, gone] = asideCounts(aside, d);
    if (!worked && !mirror && newer > 0 && other === 0 && gone === 0) {
      event("store-aside-old", `${g}'s copy on ${here.host} had no stamp or had changed; the copy down replaced ${count(aside, (e) => !e.st.isDirectory())} files (${duh(aside)}), each with a newer one from the store and none deleted: older copies only, deleted`);
      rmrf(aside);
    } else {
      fs.writeFileSync(`${aside}/.kind`, "check\n");
      const n = count(aside, (e) => !e.st.isDirectory() && e.name !== ".kind"), sz = duh(aside);
      const sorted = asideUnit(aside, g, d);
      event("store-aside", `${g}'s copy on ${here.host} wasn't all on the store${worked ? " (worked on here)" : ""}; the copy down replaced or deleted ${n} files (${sz}), kept in ${set}; ${sorted}`);
    }
  } else if (aside) {
    log(`${g}: the copy here had no stamp or had changed, but the copy down replaced nothing that differed; nothing set aside`);
  }
  // A mirror unless a path here wasn't on the store (copied down without --delete: not at all).
  if (rs) stampHere(g, d, rs, d.paths.every((p) => listed(names, p.name) || !fs.existsSync(p.local)));
  rm(...marks(g, "dirty"), ...marks(g, "unmerged"), gf(g, "unsent"), gf(g, "retry"), gf(g, "moved"));
  touch(gf(g, "ready"));
  if (back.length) return 0;
  log(`${g}: copied down (${who(rs)})`);
  return 0;
}

// A unit's session and the commit its branch is on (its outputs were built from it), as the
// tracker and this clone know them; "" each when they can't say. Asked as its session ends, in the
// lane it ran in (end), and kept in its mark: a put-back later, from another lane or process, can't
// tell from that clone's branch, which may be an older attempt's.
function provenance(u: string): [string, string] {
  const by = out(tr(["state", u, "--by"], "ignore").stdout);
  const b = out(tr(["state", u, "--branch"], "ignore").stdout);
  const head = (ref: string) => { const r = run("git", ["rev-parse", "-q", "--verify", `${ref}^{commit}`], { err: "ignore" }); return code(r) === 0 ? out(r.stdout) : ""; };
  return [by, b ? head(`refs/heads/${b}`) || head(`refs/remotes/origin/${b}`) : ""];
}
// The unfinished units' cards say where their outputs went (tracker aside-set); --mixed for a set
// restore() never puts back (other units' outputs in it too, or one to sort).
export function tellAside(aside: string, set: string) {
  const units = (cat(`${aside}/.units`) ?? "").split("\n").filter(Boolean);
  const mixed = (cat(`${aside}/.kind`) ?? "") !== "unmerged" || units.length !== 1;
  for (const l of (cat(`${aside}/.from`) ?? "").split("\n").filter(Boolean)) {
    const [u, by, c] = l.split("\t");
    if (code(tr(["aside-set", u, set, ...(c ? ["--commit", c] : []), ...(by ? ["--by", by] : []), ...(mixed ? ["--mixed"] : [])], "ignore")) !== 0) log(`${u}: couldn't tell the tracker where its outputs went (${set})`);
  }
}
// A set going (restored, sorted, dropped): its units' cards stop naming it.
export function forgetAside(aside: string) {
  for (const l of (cat(`${aside}/.from`) ?? "").split("\n").filter(Boolean)) tr(["aside-set", l.split("\t")[0], "--clear"], "ignore");
}

// The same unit claimed again: its own outputs from its last, unfinished session, set aside when
// the store's copy was put back (a set of kind "unmerged" holding that unit's alone), go back into
// the copy here, but only if they were built from the commit this clone is on now (the unit's
// branch, checked out). A set with other units' outputs in it, or built from another commit, stays
// where it is (\`aside sort\` deletes it once the unit is done or dropped). Prints one line for
// the session; 0: restored, 1: nothing to restore, 3: a set refused (stale or shared), 2: failed.
export function restore(g: string, u: string): number {
  glock(g);
  const d = data([g]);
  if (!d) return 2;
  const sets = ls(`${L}/aside`).filter((n) => /-[0-9]{8}-[0-9]{6}$/.test(n) && setGroup(n) === g).reverse();
  const r = run("git", ["rev-parse", "HEAD"], { err: "ignore" }), now = code(r) === 0 ? out(r.stdout) : "";
  // Its unit came back here: every set holding its outputs waits again for it to be done (overnight).
  for (const b of sets) if ((cat(`${L}/aside/${b}/.units`) ?? "").split("\n").includes(u)) rm(`${L}/aside/${b}/.night`);
  for (const b of sets) {
    const a = `${L}/aside/${b}`, set = `${L}/aside/${b}`;
    const units = (cat(`${a}/.units`) ?? "").split("\n").filter((x) => x !== "");
    if (!units.includes(u)) continue;
    const from = (cat(`${a}/.from`) ?? "").split("\n").map((l) => l.split("\t")).find((x) => x[0] === u);
    // The newest set holding its outputs is the one that counts: an older one is older work.
    if ((cat(`${a}/.kind`) ?? "") !== "unmerged" || units.length !== 1 || !from) {
      console.log(`Its last attempt's outputs are in ${set} on ${here.host}, mixed with other work${from ? "" : " or with no record of where they came from"}: not put back. Rebuild them before trusting earlier notes about what's in work/.`);
      log(`${g}: ${set} holds ${u}'s outputs with ${units.length > 1 ? `others' (${units.join(" ")})` : "no record of their commit"}; not put back`);
      return 3;
    }
    const c = from[2] ?? "";
    // Over the copy they were made over, only: since then another unit may have
    // landed, and its outputs are in the copy here now.
    const base = cat(`${a}/.base`) ?? "";
    if (!base || base !== (localStamp(g) ?? "")) {
      console.log(`Its last attempt's outputs, set aside in ${set} on ${here.host}, were made over a copy of the group's data that has moved on since (other work landed): they were not put back. Rebuild them before trusting earlier notes about what's in work/.`);
      log(`${g}: ${set} (${u}'s outputs) was made over a copy that has moved on since; not put back`);
      return 3;
    }
    // Nor over work in the copy here that isn't on the store yet: another lane's session or CI
    // run on the group, another unit's outputs waiting to land, a copy back owed.
    const own = gf(g, `dirty.${here.lid}`);
    const busy = [
      ...marks(g, "dirty").filter((f) => f !== own && markLive(f)).map((f) => `a session in ${f.slice(f.lastIndexOf(".dirty.") + 7)}`),
      ...marks(g, "unmerged").map((f) => fields(f)?.[0] ?? "").filter((x) => x !== u).map((x) => `${x || "a unit"}'s outputs, waiting to land`),
      ...(isFile(gf(g, "unsent")) || isFile(gf(g, "moved")) ? ["a copy back still owed"] : []),
    ];
    if (busy.length) {
      console.log(`Its last attempt's outputs, set aside in ${set} on ${here.host}, weren't put back: the copy here has other work in it that isn't on the store yet (${busy.join("; ")}). Rebuild them before trusting earlier notes about what's in work/.`);
      log(`${g}: ${set} (${u}'s outputs) not put back over other work here (${busy.join("; ")})`);
      return 3;
    }
    if (!c || !now || c !== now) {
      console.log(`Its last attempt's outputs, set aside in ${set} on ${here.host}, were built from commit ${c ? c.slice(0, 8) : "(unknown)"}, but your branch is at ${now.slice(0, 8)}: they were not put back. Rebuild them before trusting earlier notes about what's in work/.`);
      log(`${g}: ${set} (${u}'s outputs) was built from ${c.slice(0, 8) || "an unknown commit"}, this clone is at ${now.slice(0, 8)}; not put back`);
      return 3;
    }
    // A file of the set where the copy here has a folder (or the other way round) would stop the
    // copy partway: refused before anything is copied.
    const clash = d.paths.filter((p) => isDir(`${a}/${p.name}`)).flatMap((p) => [...walk(`${a}/${p.name}`)].filter((e) => {
      const t = stat(`${p.local}/${e.rel}`);
      return t && (t.isDirectory() !== e.st.isDirectory());
    }).map((e) => `${p.name}/${e.rel}`));
    if (clash.length) {
      console.log(`Its last attempt's outputs, set aside in ${set} on ${here.host}, weren't put back: ${clash.slice(0, 3).join(", ")} is a file in one and a folder in the other. Rebuild them before trusting earlier notes about what's in work/.`);
      log(`${g}: ${set} (${u}'s outputs) not put back: ${clash.length} paths a file in one and a folder in the other`);
      return 3;
    }
    for (const p of d.paths) {
      if (!isDir(`${a}/${p.name}`)) continue;
      mkdirp(p.local);
      if (code(run("cp", ["-a", "--", `${a}/${p.name}/.`, `${p.local}/`])) !== 0) {
        console.log(`Its last attempt's outputs, set aside in ${set} on ${here.host}, were only partly put back (copying into ${p.local} failed): rebuild them before trusting what's in work/ or earlier notes about it.`);
        log(`${g}: couldn't put ${set} back into ${p.local}; partly put back, the set kept`);
        return 2;
      }
    }
    forgetAside(a);
    rmrf(a);
    console.log(`Its last attempt's outputs (set aside in ${set} when it ended unfinished, built from the commit your branch is on) are back in work/: carry on from them.`);
    log(`${g}: put ${u}'s outputs from its last attempt back (${set}, built from ${c.slice(0, 8)})`);
    return 0;
  }
  return 1;
}

// Copy back now (lease holder only) and stamp it. all: clear every lane's mark (the lanes have stopped).
export function up(g: string, unit: string, commit: string, all = false): number {
  glock(g);
  // Only over the copy this one came from (see tend), and only by the lease holder.
  const rs = remoteOf(g);
  if (rs === null) { log(`${g}: can't read the store`); due(g, unit, commit); return 2; }
  if (rs && rs !== localStamp(g) && !ownTorn(g, rs)) {
    log(`${g}: the store has moved on since the copy here was current; nothing copied back (the next copy down sets it aside)`); return 3;
  }
  if (!heldHere(g)) {
    log(`${g}: not leased by ${here.host} (or origin can't say so); nothing copied back`);
    event("lost-lease", `${g}'s lease isn't ${here.host}'s any more, or origin couldn't confirm it, after ${unit}; the copy here is kept and not copied back`);
    return 3;
  }
  return send(g, unit, commit, all);
}

// The copy back itself; the group's lock is held, and the lease is this machine's. 0, or 2: failed.
export function send(g: string, unit: string, commit: string, all = false): number {
  const d = data([g]);
  if (!d) return 2;
  const r = d.remote;
  const dropMarks = () => rm(...(all ? marks(g, "dirty") : [gf(g, `dirty.${here.lid}`)]));
  // An empty copy here is never copied back or stamped: over a store with no folder for the group
  // (its data not seeded yet, or kept elsewhere on the store) a stamp would make it look seeded, and
  // over one with files it would delete them.
  if (!hasFiles(d)) {
    const x = rsync(["-r", "--list-only", "--protect-args", `${r}/groups/${g}/`], { err: "ignore" });
    if (code(x) !== 0 && code(x) !== 23) { log(`${g}: can't list it on the store`); return 2; }
    if (x.stdout.split("\n").some((l) => /^[^d]/.test(l))) event("store-empty", `${g}'s copy on ${here.host} has no files, but the store's has; not copied back over them (was its data put on the store without a copy down here?)`);
    else log(`${g}: no files here and none on the store (its data not seeded yet?); nothing copied back or stamped`);
    dropMarks();
    rm(gf(g, "unsent"), gf(g, "retry"));
    return 0;
  }
  touch(gf(g, "unsent"));
  // Anyone reading the store mid-copy sees a stamp that matches no copy.
  fs.writeFileSync(gf(g, "up"), `{"copying":"${unit}","host":"${here.host}"}\n`);
  if (!copyStamp(gf(g, "up"), `${r}/stamps/${g}.json`)) return 2;
  for (const p of d.paths) {
    if (!fs.existsSync(p.local)) continue;
    if (!copy("--delete", `${p.local}/`, `${r}/groups/${g}/${p.name}/`)) return 2;
  }
  const n = bytes(d);
  // A CI run's (unit "ci"): the group's CI, not a unit, wrote it.
  const st = JSON.stringify({ ...(unit === "ci" ? { ci: g } : { unit }), commit, host: here.host, at: stamp(), bytes: n });
  fs.writeFileSync(gf(g, "up"), `${st}\n`);
  if (!copyStamp(gf(g, "up"), `${r}/stamps/${g}.json`)) return 2;
  rm(gf(g, "up"));
  stampHere(g, d, st, true);
  dropMarks();
  rm(gf(g, "unsent"), gf(g, "retry"), gf(g, "moved"));
  touch(gf(g, "ready"));
  used(g);
  log(`${g}: copied back after ${after(g, unit)} (${MB(n)} MB)`);
  return 0;
}

// Settle what the copy here owes the store (see HELP); the group's lock is held. A session mark
// whose loop is gone is a unit that ended without its loop seeing it (a lane killed). Each unit's
// unmerged outputs, by its state now: on main, a copy back is due; its branch waiting to land,
// held; unfinished, the store's copy is put back, once no session here is working on the group. A
// due copy back goes once nothing here is unmerged or being worked on, at its next try (force:
// now). stopped: the lanes here have stopped, so no session mark is live. True if a copy back was
// tried and failed.
export function tend(g: string, force = false, stopped = false): boolean {
  let live = false, reading = false, unk = false;
  const back: string[] = [], all: string[] = [], fin: string[] = [];
  const prov = new Map<string, [string, string]>();
  for (const f of marks(g, "dirty")) {
    // A live CI run writes the copy too (it rebuilds main's outputs): it holds up a put-back and a
    // copy back, which would send its outputs half-written. Its own copy back comes as it ends.
    if (!stopped && markLive(f)) { if ((fields(f)?.[0] ?? "") === "ci") reading = true; else live = true; continue; }
    const u = fields(f)?.[0] ?? "";
    if (u === "ci") { /* a CI run's: what it wrote is main's, nothing for the store to keep */ }
    else if (here.branches) unmerged(g, u, "");
    else due(g, u || "a session that ended", "");
    rm(f);
    log(`${g}: the session in ${f.slice(f.lastIndexOf(".dirty.") + 7)}${u ? ` on ${u}` : ""} ended without its loop seeing it end (a lane killed?)`);
  }
  for (const f of marks(g, "unmerged")) {
    const [u = "", c = "", by = "", built = ""] = fields(f) ?? [];
    if (u && built) prov.set(u, [by, built]);
    const st = u ? ustate(u) : "gone";
    if (st === "done" || st === "review" || st === "broken") { rm(f); due(g, u, c); fin.push(`+${u}`); log(`${g}: ${u} is on main now; its outputs go back to the store`); }
    else if (st === "merging") { all.push(u); fin.push(`+${u}`); }
    else if (st === "unknown") { all.push(u); unk = true; }
    else { all.push(u); back.push(u); }
  }
  // Finished outputs can't be told apart from unfinished ones in the copy here: they go aside together.
  if (back.length) {
    if (live || reading) log(`${g}: putting the store's copy back (for ${back.join(" ")}) waits for the session or CI here working on it`);
    else if (unk) log(`${g}: putting the store's copy back (for ${back.join(" ")}) waits for the tracker to say what ${all.join(" ")} are`);
    else if (copyDown(g, [...back, ...fin], prov) !== 0) log(`${g}: couldn't put the store's copy back; tried again at the next look`);
    return false;
  }
  if (!isFile(gf(g, "unsent"))) return false;
  if (all.length) { log(`${g}: its copy back waits for ${all.join(" ")} to land`); return false; }
  if (live) { log(`${g}: its copy back waits for the session here working on it`); return false; }
  if (reading) { log(`${g}: its copy back waits for the CI run here, which writes the copy too`); return false; }
  const rf = retryOf(g);
  const u = rf.unit || jqs(json(cat(gf(g, "up")))?.copying ?? "") || "a copy back tried again", w = after(g, u);
  const c = rf.commit || gitShort();
  const a = Number(rf.tries || 0), t = Number(rf.at || 0);
  const now = epoch();
  if (!force && a !== 0 && now < t + backoff(a)) return false;
  // Only over the copy this one came from: if the store has moved on (another machine's copy back,
  // once this machine's lease lapsed), sending would put an older copy over it. Kept marked, so the
  // next copy down here sets it aside to sort.
  let why: "copy" | "lease";
  const rs = remoteOf(g);
  if (rs === null) why = "copy";
  else if (rs && rs !== localStamp(g) && !ownTorn(g, rs)) {
    // A CI run's alone: what it wrote is main's, and the store's newer copy is what counts. Nothing
    // to keep: its files are in the copy's listing (ciMade), so the next copy down replaces them.
    if (u === "ci") { log(`${g}: the store has moved on since ${w} (${who(rs)}); its copy back isn't needed`); rm(gf(g, "unsent"), gf(g, "retry"), gf(g, "up")); return false; }
    if (!isFile(gf(g, "moved"))) event("store-moved", `${g}'s copy on ${here.host} owes the store a copy back after ${w}, but the store has moved on since (${who(rs)}); not copied back. The next copy down here sets it aside, with a unit to sort it`);
    touch(gf(g, "moved"));
    return false;
  } else if (!heldHere(g)) why = "lease";
  else if (send(g, u, c) === 0) {
    if (a !== 0) event("store-up-retried", `${g}'s copy back from ${here.host} after ${w} went through on try ${a + 1}`);
    return false;
  } else why = "copy";
  const tries = a + 1;
  setRetry(g, { unit: u, commit: c, tries: String(tries), at: String(now) });
  touch(gf(g, "unsent"));
  if (tries > 1) log(`${g}: copy back try ${tries} failed (${why === "lease" ? "lease not confirmed" : "the copy failed"}); next in ${Math.floor(backoff(tries) / 60)} min`);
  else if (why === "lease") event("lost-lease", `${g}'s lease isn't ${here.host}'s any more, or origin couldn't confirm it, after ${w}; the copy here is kept, and its copy back tried again at each look`);
  else event("store-up", `couldn't copy ${g}'s data back from ${here.host} after ${w}; it's kept here, and tried again at each look until it goes through`);
  return true;
}

// A unit's session ended: its mark goes, and its outputs are settled by its state (tend).
export function end(g: string, u: string, c: string): number {
  glock(g);
  rm(gf(g, `dirty.${here.lid}`));
  if (here.branches) unmerged(g, u, c, ...provenance(u)); else due(g, u, c);
  return tend(g, true) ? 2 : 0;
}
