// What a copy down set aside (work/.store/aside/): the rule that settles a set, and `aside`.
import fs from "node:fs";
import path from "node:path";
import { event } from "./events.ts";
import { tryLock, unlock } from "./sys.ts";
import { here } from "./store-here.ts";
import { code, duh, rsync } from "./store-remote.ts";
import { cat, count, isDir, isFile, L, log, ls, out, rebuilt, rm, rmrf, touch, walk, type Data } from "./store-util.ts";
import { glock } from "./store-local.ts";
import { landed, setData, storeOnly, tr, uname, ustate } from "./store-tracker.ts";
import { forgetAside } from "./store-copy.ts";

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

// A set's own files (the rest is what was set aside), and a set's name: <group>-<date>-<time>.
export const MARKS = [".kind", ".units", ".from", ".base", ".night", ".unit", ".unfiled"];
const SET = /-[0-9]{8}-[0-9]{6}$/;
const filesIn = (a: string) => count(a, (e) => !e.st.isDirectory() && !MARKS.includes(e.name));
// The units a set names, as written (.units, a line each; an empty line is a mark that named none).
const unitsOf = (a: string) => { try { return fs.readFileSync(`${a}/.units`, "utf8").split("\n").slice(0, -1); } catch { return []; } };

// The rule that settles a set, with no session and no question. A set the store made for the units
// it names (kind "unmerged": their unfinished outputs, which putting the store's copy back replaced;
// "units": those and finished units' that hadn't reached the store, which can't be told apart) holds
// nothing anyone needs once every one of them is dropped, or done with its branch landed on main by
// the tracker's own record of the landing (state --landed): main builds those outputs again. Short
// of that it stays: a unit recorded done with no landing (by hand, or reopened and done again), one
// still merging, in review or parked, one the tracker doesn't know; a set of any other kind (nothing
// says whose work all of it is); and one without the store's own record (.kind, .units, .from, its
// name). null: the tracker can't say what a unit is now, so the next look asks again.
// (why is asked only when it's said: it names units by title, a tracker call each. waits: the
// rule will remove it, once its units get there; else only a person does.)
export type Verdict = { go: true; units: string[] } | { go: false; waits: boolean; why: () => string };
export function verdict(a: string): Verdict | null {
  const k = (cat(`${a}/.kind`) ?? "").trim(), units = unitsOf(a);
  if (k !== "unmerged" && k !== "units") return { go: false, waits: false, why: () => {
    const named = units.filter(Boolean).map(uname).join(", ");
    return named ? `it holds outputs of ${named} and other work, and nothing recorded whose that is` : "nothing recorded whose work it holds";
  } };
  if (!SET.test(path.basename(a)) || !units.length || units.includes("") || !isFile(`${a}/.from`)) return { go: false, waits: false, why: () => "its record of whose outputs it holds is incomplete" };
  const wait: [string, string][] = [];
  for (const u of units) {
    const s = ustate(u);
    if (s === "unknown") return null;
    if (s === "dropped") continue;
    if (s === "done") {
      const l = landed(u);
      if (l === null) return null;
      if (!l) wait.push([u, "recorded done with no landing of its branch on main (done by hand?)"]);
    } else wait.push([u, s === "gone" ? "which the tracker doesn't have any more" : s === "merging" ? "done but not on main yet" : `not on main (${WORDS[s] ?? s})`]);
  }
  if (wait.length) return { go: false, waits: true, why: () => `it holds the outputs of ${wait.map(([u, w]) => `${uname(u)}, ${w}`).join("; ")}, and stays until ${units.length > 1 ? "each of its units" : "that"} has landed or is dropped` };
  return { go: true, units };
}
// A unit's state (the tracker's key), in words.
const WORDS: Record<string, string> = { ready: "ready", doing: "in progress", interrupted: "interrupted", review: "in review", you: "waiting on the owner", stuck: "stuck",
  waiting: "waiting on other work", resource: "waiting on a resource", parked: "parked", broken: "broken again" };

// How long ago a set was made (its name has the local time).
function age(b: string): string {
  const m = /-(\d{4})(\d\d)(\d\d)-(\d\d)(\d\d)(\d\d)$/.exec(b);
  const days = m ? Math.floor((Date.now() - new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime()) / 86400e3) : NaN;
  return Number.isNaN(days) ? "at a time its name doesn't say" : days <= 0 ? "today" : days === 1 ? "a day ago" : `${days} days ago`;
}
// A set the rule settles is removed, with a line for the morning summary.
function remove(a: string, units: string[]) {
  const b = path.basename(a), n = filesIn(a), sz = duh(a), names = units.map(uname).join(", ");
  forgetAside(a);
  rmrf(a);
  log(`${b}: deleted (${sz}, outputs of ${units.join(" ")}, now landed or dropped)`);
  event("store-aside-removed", `${setGroup(b)}'s set-aside copy on ${here.host} (${n} files, ${sz}, set aside ${age(b)}) was removed: it held the outputs of ${names}, ${units.length > 1 ? "each landed on main or dropped since" : "which has landed on main or been dropped since"}`);
}

// A set that outlasts a whole run of the lanes here gets a line in the morning summary at the end
// of each one: what it holds, how old it is, and why the rule leaves it. leave runs this twice:
// first (mark false) for the sets it marked last time, then (mark true) to mark the rest, those made
// since included (a set made in this run has its own event already, or none: its unit is expected
// back). restore clears the mark when a set's unit is claimed here again.
export function overnight(mark: boolean) {
  for (const name of ls(`${L}/aside`)) {
    const a = `${L}/aside/${name}`;
    if (!isDir(a) || (cat(`${a}/.kind`) ?? "").trim() === "older") continue;
    const fd = tryLock(`${L}/lock-${setGroup(name)}`);
    if (fd === null) continue;
    try {
      if (mark) { if (!isFile(`${a}/.night`)) touch(`${a}/.night`); }
      else if (isFile(`${a}/.night`)) {
        const v = verdict(a);
        if (v && !v.go) event("store-aside-kept", `${setGroup(name)}'s set-aside copy on ${here.host} is still there (${filesIn(a)} files, ${duh(a)}, set aside ${age(name)}, in ${L}/aside/${name}): ${v.why()}. It costs no session, and nobody has to act on it${v.waits ? "" : `; \`just store aside drop ${name}\` there removes it`}`);
      }
    } finally { unlock(fd); }
  }
}

// The units an older version filed to sort sets (a set's .unit names its own): dropped, here and
// in the tracker (aside-retire: this machine's, and any a set here names), since no session sorts a
// set any more. One a session is working now is left for the next look, and so is a tracker that
// can't be written.
function retire() {
  const sets = ls(`${L}/aside`).map((n) => `${L}/aside/${n}`).filter(isDir);
  const r = tr(["aside-retire", ...sets.map((a) => cat(`${a}/.unit`) ?? "").filter(Boolean)], "ignore");
  if (code(r) !== 0) return;
  const busy = out(r.stdout).split("\n");
  for (const a of sets) if (!busy.includes(cat(`${a}/.unit`) ?? "")) rm(`${a}/.unit`, `${a}/.unfiled`);
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
  // Each set: its size and what the rule says of it. sort (and clear, its old name) applies the
  // rule: it deletes the older-only and each set whose units have all landed or are dropped, and
  // tags a set without a kind (from before kinds were kept, or a copy down that failed partway) as
  // one nothing accounts for, never judging it by times. Every other set stays where it is.
  // A set whose group's lock is held may be a copy down still under way: left for the next look.
  const act = sub !== "";
  if (act) retire();
  for (const name of ls(`${L}/aside`)) {
    const a = `${L}/aside/${name}`, g = setGroup(name);
    if (!isDir(a)) continue;
    let fd: number | null = null;
    if (act) {
      fd = tryLock(`${L}/lock-${g}`);
      if (fd === null) { log(`${name}: its group is busy here; looked at again at the next look`); continue; }
    }
    try {
      if (!isDir(a)) continue;
      let k = (cat(`${a}/.kind`) ?? "").trim();
      const sz = duh(a);
      // (A set for units without its .units, a put-back cut short, can't say whose outputs it holds.)
      if (!k || ((k === "unmerged" || k === "units") && !isFile(`${a}/.units`))) { k = "check"; if (act) fs.writeFileSync(`${a}/.kind`, "check\n"); }
      let line = "";
      if (k === "older") {
        if (act) { rmrf(a); log(`${name}: deleted (${sz}, older copies only)`); }
        else line = "older copies only, safe to delete (aside sort deletes it)";
      } else {
        const v = verdict(a);
        if (v === null) line = "the tracker can't say what its units are now; looked at again at the next look";
        else if (!v.go) line = print ? `stays: ${v.why()}` : "";
        else if (act) remove(a, v.units);
        else line = `the outputs of ${v.units.join(" ")}, each landed or dropped since: nobody needs it (aside sort removes it)`;
      }
      if (line && print) console.log(`${name}\t${sz}\t${line}`);
    } finally { if (fd !== null) unlock(fd); }
  }
  return 0;
}
