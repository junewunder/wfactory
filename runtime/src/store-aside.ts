// What a copy down set aside (work/.store/aside/): the unit that sorts a set, and `aside`.
import fs from "node:fs";
import path from "node:path";
import { event } from "./events.ts";
import { tryLock, unlock } from "./sys.ts";
import { here } from "./store-here.ts";
import { code, duh, rsync } from "./store-remote.ts";
import { alt, cat, count, isDir, isFile, jqs, L, log, ls, nonEmpty, out, rebuilt, rm, rmrf, touch, walk, type Data } from "./store-util.ts";
import { glock } from "./store-local.ts";
import { setData, storeOnly, tr, ustate } from "./store-tracker.ts";
import { forgetAside, tellAside } from "./store-copy.ts";

// How what a copy down set aside compares with what replaced it: [replaced by newer, replaced
// by same-time or older or not a plain file, deleted]. Only the first means an older copy.
export function asideCounts(a: string, d: Data): [number, number, number] {
  let n = 0, o = 0, g = 0;
  for (const p of d.paths) {
    if (!isDir(`${a}/${p.name}`)) continue;
    for (const e of walk(`${a}/${p.name}`)) {
      if (e.st.isDirectory()) continue;
      if (!e.st.isFile()) { o++; continue; }   // a link's time says nothing about what it points to
      const here = `${p.local}/${e.rel}`;
      if (!fs.existsSync(here)) { g++; continue; }
      if (e.st.mtimeNs < fs.lstatSync(here, { bigint: true }).mtimeNs) n++; else o++;
    }
  }
  return [n, o, g];
}

export const setGroup = (b: string) => b.replace(/-[0-9]{8}-[0-9]{6}$/, "");

// The units that sort sets live in a group of their own, made when the first is filed: it has no
// needs, parks or gates, so sorting a set never waits on the owner (or on its data group's work).
export const SORTS = "aside";
const hostSlug = () => here.host.replace(/[A-Z]/g, (c) => c.toLowerCase()).replace(/[^a-z0-9\n]/g, "-");
export const sortId = (b: string) => `${SORTS}/${setGroup(b)}-${hostSlug()}-${b.slice(-15)}`;
// The unfinished units whose outputs a set holds (.from), which their next session rebuilds.
const unfinished = (a: string) => (cat(`${a}/.from`) ?? "").split("\n").map((l) => l.split("\t")[0]).filter(Boolean);

// File the unit that sorts a "check" set, pinned to this machine, once (.unit names it), at its data
// group's priority. d null: the group keeps no data on the store any more. Says what happened, for
// the event. A tracker that can't be written leaves it for `aside sort`.
export function asideUnit(a: string, g: string, d: Data | null): string {
  if (nonEmpty(`${a}/.unit`)) return `being sorted by ${cat(`${a}/.unit`)}`;
  const b = path.basename(a);
  const id = sortId(b);
  let t = `Sort ${jqs(alt(d?.title, g))}'s set-aside copy on ${here.host}`;
  if ([...t].length > 60) t = `Sort a set-aside copy on ${here.host}`;
  if ([...t].length > 60) t = "Sort a set-aside copy";
  const n = count(a, (e) => e.st.isFile() && ![".kind", ".unit", ".units", ".from", ".base", ".unfiled", ".night"].includes(e.name)), sz = duh(a);
  const theirs = unfinished(a);
  const det = (d
    ? `A copy down on ${here.host} set aside ${n} files (${sz}) of this group's data that weren't on the store, in ${L}/aside/${b}. On ${here.host}, \`just store aside audit ${b}\` lists each file the store doesn't hold byte for byte. store-newer is an older copy: nothing lost.`
    : `A copy down on ${here.host} set aside ${n} files (${sz}) of group ${g}'s data, in ${L}/aside/${b}, and the tracker keeps no data on the store for ${g} any more (its data was set to none, or the group is gone). On ${here.host}, \`just store aside audit ${b}\` lists each file the store doesn't hold byte for byte under groups/${g}/. store-newer is an older copy: nothing lost.`)
    + (theirs.length ? ` It holds outputs of ${theirs.map((x) => `{unit:${x}}`).join(", ")}, unfinished when they were set aside: their next session rebuilds those, so they aren't lost.` : "")
    + ` For each aside-newer or not-on-store file, find what rebuilds it (git, a pipeline step, a pushed branch); put anything nothing rebuilds into git or a step, and add files a step rebuilds, whose differences don't matter, with \`just tracker rebuilt add <glob> --why "…"\` (never by editing tracker/project.json). Say why the copy differed, and if something keeps writing the group's folders outside a lane, fix that at its source. This unit holds no lease: don't write the group's folders. Then \`just store aside drop ${b}\` and record done with the audit's summary.`;
  let err = "";
  let filed = code(tr(["state", id], "ignore")) === 0;
  if (!filed) {
    const add = () => tr(["add-unit", id, "--title", t, "--detail", det, "--check", "recorded", "--host", here.host, "--data", "none", ...(d?.priority ? ["--priority", String(d.priority)] : [])], "pipe");
    let r = add();
    if (code(r) !== 0 && (r.stderr ?? "").includes(`no group "${SORTS}"`)) {
      tr(["add-group", SORTS, "--title", "Set-aside copies to sort"], "ignore");
      r = add();
    }
    filed = code(r) === 0;
    // (The tracker's reason is its last line: a refused text comes first, rewritten.)
    err = (r.stderr ?? "").trim().split("\n").pop() ?? "";
  }
  if (filed) { fs.writeFileSync(`${a}/.unit`, `${id}\n`); rm(`${a}/.unfiled`); return `a unit sorts it: ${t}`; }
  // Said once, as an event: a refusal that repeats every idle look would otherwise go unseen.
  if (!fs.existsSync(`${a}/.unfiled`)) { touch(`${a}/.unfiled`); event("store-aside-unfiled", `${b} on ${here.host} has no unit to sort it: ${err}`); }
  return `no unit filed yet (${err}); the next \`store.sh aside sort\` tries again`;
}

// A kept set (unmerged) its units won't come back for becomes one to sort (their cards say it isn't
// put back); the next aside sort files its unit. why: for the log.
export function toSort(a: string, why: string) {
  if ((cat(`${a}/.kind`) ?? "").trim() !== "unmerged") return;
  fs.writeFileSync(`${a}/.kind`, "check\n");
  tellAside(a, `${L}/aside/${path.basename(a)}`);
  log(`${path.basename(a)}: kept for ${unfinished(a).join(" ") || "its units"}, but ${why}: one to sort now`);
}
// The units a kept set waits for: those not yet done or dropped (aside sort deletes it once there
// are none: their next sessions rebuilt what it holds).
const SETTLED = ["done", "review", "broken", "dropped", "gone"];
const waitsFor = (a: string) => (cat(`${a}/.units`) ?? "").split("\n").filter(Boolean).filter((u) => !SETTLED.includes(ustate(u)));
// Why a kept set's units won't come back for it here: one is parked, or pinned to another machine
// (restore looks only at sets on the machine it runs on). "" if none. (A question or a block is
// usually answered, and the unit claimed here again: a blocked unit's set waits out the run, below;
// one waiting on a question waits as long as the question does.)
function keptInVain(a: string): string {
  for (const u of (cat(`${a}/.units`) ?? "").split("\n").filter(Boolean)) {
    const s = ustate(u);
    if (SETTLED.includes(s)) continue;
    if (s === "parked") return `${u} is parked`;
    const h = out(tr(["state", u, "--host"], "ignore").stdout);
    if (h && h !== here.host) return `${u} is pinned to ${h}`;
  }
  return "";
}
// A kept set lasts one more run of the lanes here after the one it was made in: one still kept,
// still waiting for a unit that wasn't claimed here again meanwhile (restore clears the mark), when
// they stop a second time becomes one to sort, unless a unit it waits for asks the owner a question
// (a run: a session ran here, the loop says, and then
// the first leave after). leave runs this twice:
// first (mark false) for the sets it marked last time, then (mark true) to mark the rest, those
// made since included.
export function overnight(mark: boolean) {
  for (const name of ls(`${L}/aside`)) {
    const a = `${L}/aside/${name}`;
    if (!isDir(a) || (cat(`${a}/.kind`) ?? "").trim() !== "unmerged") continue;
    const fd = tryLock(`${L}/lock-${setGroup(name)}`);
    if (fd === null) continue;
    try {
      if (mark) { if (!isFile(`${a}/.night`)) touch(`${a}/.night`); }
      else if (isFile(`${a}/.night`)) {
        // A unit waiting on the owner's answer keeps its set however many runs go by: answered,
        // it's claimed here again.
        const w = waitsFor(a);
        if (w.length && !w.some((u) => ustate(u) === "you")) toSort(a, "a whole run of the lanes here went by without it being put back");
      }
    } finally { unlock(fd); }
  }
}

// aside [sort | audit <set> | drop <set>]. print false: say nothing on stdout (release-idle's sort).
export function aside(args: string[], print = true): number {
  const sub = args[0] ?? "";
  let b = "";
  if (sub === "audit" || sub === "drop") {
    b = args[1] ?? "";
    if (!b || b.includes("/") || b === "." || b === ".." || !isDir(`${L}/aside/${b}`)) {
      console.error(`store: aside ${sub} <set>: no set "${b}" in ${L}/aside/ (${ls(`${L}/aside`).join(" ")})`); return 2;
    }
  } else if (!["", "sort", "clear"].includes(sub)) { console.error("store: aside [sort | audit <set> | drop <set>]"); return 2; }
  if (sub === "drop") {
    glock(setGroup(b));
    const sz = duh(`${L}/aside/${b}`);
    forgetAside(`${L}/aside/${b}`);
    rmrf(`${L}/aside/${b}`); log(`${b}: deleted (${sz})`);
    return 0;
  }
  if (sub === "audit") {
    // By content, both ways: every difference, then the ones not newer on the store (--update
    // skips a file newer on the receiver); the rest are older copies.
    // (A group that lost its data is audited against what the store still holds for it.)
    const a = `${L}/aside/${b}`, g = setGroup(b), sd = setData(g), d = sd === "lost" ? storeOnly() : sd;
    if (!d) { console.error(`store: aside audit: the tracker can't say where ${g}'s data lives now`); return 2; }
    const rb = d.rebuilt ?? [];
    let same = 0, newer = 0, ahead = 0, gone = 0;
    for (const name of ls(a)) {
      const x = `${a}/${name}/`;
      if (!isDir(x)) continue;
      const diff = (...more: string[]) => rsync(["-n", "-c", "-i", "-r", ...more, "--protect-args", "--out-format=%i %n", x, `${d.remote}/groups/${g}/${name}/`]);
      const all = diff(), upd = diff("--update");
      if (code(all) !== 0 || code(upd) !== 0) return 2;
      const updated = upd.stdout.split("\n");
      const total = count(x, (e) => e.st.isFile());
      let n = 0;
      for (const line of all.stdout.split("\n")) {
        if (line.endsWith("/")) continue;
        const sp = line.indexOf(" ");
        const flags = sp < 0 ? line : line.slice(0, sp), f = sp < 0 ? line : line.slice(sp + 1);
        let st: string;
        if (/^[<>]f\+{9}$/.test(flags)) { st = "not-on-store"; gone++; }
        else if (/^[<>]f/.test(flags)) { if (updated.includes(line)) { st = "aside-newer"; ahead++; } else { st = "store-newer"; newer++; } }
        else continue;
        n++;
        console.log(`${name}/${f}\t${fs.lstatSync(x + f).size}\t${st}${rebuilt(`${name}/${f}`, rb) ? " (store.rebuilt)" : ""}`);
      }
      same += total - n;
    }
    console.log(`# ${b} same=${same} store-newer=${newer} aside-newer=${ahead} not-on-store=${gone}`);
    return 0;
  }
  // Each set: its size, its kind (written as it was set aside) and its unit. sort (and clear, its
  // old name) deletes the older-only, tags a set without a kind (from before kinds were kept, or
  // a copy down that failed partway) as one to sort, never judging it by times, and files a unit
  // for each set to sort without one, or reopens one recorded done while its set is still here.
  // A set whose group's lock is held may be a copy down still under way: left for the next look.
  const act = sub !== "";
  const gd = new Map<string, Data | "lost" | null>();   // each group's data, asked once
  for (const name of ls(`${L}/aside`)) {
    const a = `${L}/aside/${name}`, g = setGroup(name);
    if (!isDir(a)) continue;
    let fd: number | null = null;
    if (act) {
      fd = tryLock(`${L}/lock-${g}`);
      if (fd === null) { log(`${name}: its group is busy here; sorted at the next look`); continue; }
    }
    try {
      if (!isDir(a)) continue;
      let k = cat(`${a}/.kind`) ?? "";
      const sz = duh(a);
      if (!gd.has(g)) gd.set(g, setData(g));
      const d = gd.get(g) ?? null;
      // (An unmerged set without its .units, a put-back cut short, can't say whose outputs it holds.)
      if (!k || (k === "unmerged" && !isFile(`${a}/.units`))) { k = "check"; if (act) fs.writeFileSync(`${a}/.kind`, "check\n"); }
      // Kept for units that won't come back for it here: one to sort now.
      if (k === "unmerged" && act) { const w = keptInVain(a); if (w) { toSort(a, w); k = "check"; } }
      let line = "";
      if (k === "older") {
        if (act) { rmrf(a); log(`${name}: deleted (${sz}, older copies only)`); }
        else line = "older copies only, safe to delete (aside sort deletes it)";
      } else if (k === "unmerged") {
        // Outputs of units that weren't on main: kept until each is done (its next session rebuilt
        // them) or dropped.
        const units = fs.readFileSync(`${a}/.units`, "utf8").split("\n").slice(0, -1);
        const open = waitsFor(a);
        if (open.length) line = `the outputs of ${open.join(" ")}, not on main; kept until done or dropped`;
        else if (act) { forgetAside(a); rmrf(a); log(`${name}: deleted (${sz}, outputs of ${units.join(" ")}, now done or dropped)`); }
        else line = "outputs of units now done or dropped, safe to delete (aside sort deletes it)";
      } else if (d === null) line = `the tracker can't say where ${g}'s data lives now; sorted at the next look`;
      else if (act) {
        // A unit settled (done or dropped) while its set is still here goes back to ready; one gone
        // from the tracker is filed again. One filed in its data group, from before sorting had a
        // group of its own, took that group's gates and parks: dropped and filed again, unless
        // its session is sorting it now, it's landing, or it asks the owner a question.
        // (Dropped first, so a drop that fails leaves .unit naming it, for the next look.)
        const u = cat(`${a}/.unit`) ?? "";
        if (u) {
          const s = ustate(u);
          if (!u.startsWith(`${SORTS}/`)) {
            if (s === "done" || s === "dropped" || s === "gone") rm(`${a}/.unit`);
            else if (!["doing", "merging", "you", "unknown"].includes(s) && code(tr(["drop", u, "--why", `Sorting a set-aside copy has a group of its own now, with no gates or parks: filed again in it as ${sortId(name).split("/")[1]}`], "ignore")) === 0) rm(`${a}/.unit`);
          } else if (s === "done" || s === "dropped") tr(["reopen", u, "--note", `Settled, but its set is still in ${L}/aside/ on ${here.host}: audit it, then drop it.`], "ignore");
          else if (s === "gone") rm(`${a}/.unit`);
        }
        line = asideUnit(a, g, d === "lost" ? null : d);
      } else if (nonEmpty(`${a}/.unit`)) {
        const u = cat(`${a}/.unit`) ?? "", r = tr(["state", u], "ignore");
        line = `being sorted by ${u} (${code(r) === 0 ? out(r.stdout) : "not in the tracker"})`;
      } else line = `to sort: no unit yet (aside sort files one)${d === "lost" ? `; ${g} keeps no data on the store any more` : ""}`;
      if (line && print) console.log(`${name}\t${sz}\t${line}`);
    } finally { if (fd !== null) unlock(fd); }
  }
  return 0;
}
