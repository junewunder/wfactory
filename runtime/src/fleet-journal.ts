// What happened, from the lanes' events and the overseers' journals: attach, note, summary, events.
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { hm, ymdHm } from "./sys.ts";
import { beat } from "./fleet-beat.ts";
import { cat, chomp, dateHm, firstQuestions, lines, say } from "./fleet-util.ts";
import { EVENTS_OF_A_UNIT, EVENTS_PROBLEM } from "./fleet-help.ts";
import { JOURNAL } from "./fleet-scripts.ts";
import { checkFile, laneKey, type Checked } from "./fleet-wait.ts";
import type { Fleet } from "./fleet-ctx.ts";
import { summaryLines } from "./scorecard.ts";

// fleet attach [--as <id>]: this thread oversees the factory now, and what happened since the last one.
export function attach(f: Fleet, args: string[]): number {
  const { env, ME, NAMES, checkout, sh, note, onlyTier, allLanes, laneState, told, tell } = f;
  // This thread oversees the factory now: the record on main says so (the newest wins), and
  // the overseer before it is told at its next wait. Then what happened since that one's last
  // note, from every machine's journal it can reach.
  const id = args[0] === "--as" && /^[A-Za-z0-9._-]+$/.test(args[1] ?? "") ? args[1] : Math.random().toString(16).slice(2, 8);
  const t = spawnSync("factory/tracker", ["overseer", "take", id, "--machine", ME, "--json"], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (t.status !== 0) { console.error(`fleet: couldn't record this thread as the overseer: ${(t.stderr ?? "").trim()}`); return 2; }
  let was: { id: string; host: string; at: string } | null = null;
  try { was = JSON.parse(t.stdout).was; } catch {}
  if (was && was.id === id) was = null;
  say(`overseer: ${id} on ${ME}${was ? `, replacing ${was.id} on ${was.host} (its next wait tells it to stop)` : ""}`);
  say(`wait with: just fleet wait --as ${id} (on a timer's wake instead: just fleet wait --check --as ${id})`);
  // The journal: every lane's events and every machine's overseer notes.
  const evs: string[] = [], notes: string[] = [];
  // The first check counts from here: each lane's events as read now (a lane that couldn't be
  // read is left for the check's own first look).
  const first: Checked = { at: hm(), lanes: {} };
  for (const l of allLanes()) {
    const r = sh(l.m, l.d, "cat runs/events.log 2>/dev/null || true", { out: "capture", err: "ignore" });
    evs.push(...lines(r.out));
    if (r.status === 0) first.lanes[laneKey(l)] = { running: laneState(l.m, l.d) !== "stopped", count: r.out === "" ? 0 : r.out.split("\n").length - (r.out.endsWith("\n") ? 1 : 0) };
  }
  fs.mkdirSync("runs", { recursive: true });
  fs.writeFileSync(checkFile(id), JSON.stringify(first) + "\n");
  for (const m of NAMES) notes.push(...lines(sh(m, checkout(m), `cat ${JOURNAL} 2>/dev/null || true`, { out: "capture", err: "ignore" }).out).filter((l) => l.split("\t").length >= 4));
  // Since the last overseer's last note, else since it attached, else since this run started.
  const lastOf = was ? notes.filter((l) => l.split("\t")[2] === was!.id).map((l) => l.split("\t")[0]).sort().pop() : undefined;
  let start = ""; try { start = chomp(fs.readFileSync("runs/.fleet-start", "utf8")); } catch {}
  const since = lastOf ?? (was ? ymdHm(new Date(Date.parse(was.at))) : start || (dateHm("-24 hours") ?? ""));
  const fresh = (l: string) => l.split("\t")[0] >= since;
  // Each question once (every lane logs it: fleet-util.ts, firstQuestions), the first lane's line.
  // Every question the logs have counts as told from now on, so this overseer's waits don't wake
  // for a lane that logs one again.
  const toldQs = told(), seen = new Set<string>();
  const once = firstQuestions(evs.sort(), seen).filter(fresh).join("\n");
  for (const q of seen) toldQs.add(q);
  tell(toldQs);
  const wake = onlyTier("wake", once), summary = onlyTier("summary", once);
  const ns = notes.filter(fresh);
  say(`--- since ${since}${lastOf ? " (the last overseer's last note)" : was ? " (when the last overseer attached)" : ""}:`);
  const merged = [...wake.map((l) => { const f = l.split("\t"); return [f[0], [...f.slice(0, 2), ...f.slice(3, 5)].join(" · ")]; }),
    ...ns.slice(-30).map((l) => { const f = l.split("\t"); return [f[0], `${f[0]} · ${f[1]} · overseer ${f[2]}: ${f.slice(3).join(" ")}`]; })]
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, l]) => l);
  if (!merged.length) say("  nothing for the owner");
  for (const l of merged) say(l);
  if (summary.length) say(`(${summary.length} more for the morning summary: \`just fleet summary\`)`);
  say("--- now:");
  beat(f);
  note(id, `attached${was ? `, replacing ${was.id} on ${was.host}` : ""}`);
  return 0;
}

// fleet note [--as <id>] <text…>: a line in this machine's overseer journal.
export function noteCmd(f: Fleet, args: string[]): number {
  const { note } = f;
  // The overseer's own journal: what it decided, told the owner, waits for (runs/oversee.log).
  let as = "", a = args;
  if (a[0] === "--as") { as = a[1] ?? ""; a = a.slice(2); }
  if (a[0] === "--") a = a.slice(1);
  if (!a.length) { console.error("usage: fleet note [--as <id>] <text…>"); return 2; }
  note(as, a.join(" "));
  return 0;
}

// fleet summary [--since T] [--done]: the morning summary.
export function summary(f: Fleet, args: string[]): number {
  const { env, sh, onlyTier, allLanes } = f;
  let since = "";
  try { since = chomp(fs.readFileSync("runs/.fleet-start", "utf8")); } catch { since = dateHm("-24 hours") ?? ""; }
  let done = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--done") { done = true; continue; }
    if (args[i] !== "--since") { console.error(`usage: fleet summary [--since T] [--done]`); return 2; }
    const t = dateHm(args[i + 1] ?? "");
    if (t === null) { console.error(`fleet: --since needs a time (got '${args[i + 1] ?? ""}')`); return 2; }
    since = t; i++;
  }
  if (done) {
    // The units done since then, each once (one done twice, after a reopen, counts once), as
    // the tracker's log has them.
    const r = spawnSync("factory/tracker", ["log", "--since", since.replace(" ", "T")], { env, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 1 << 28 });
    if (r.status !== 0) { console.error("fleet: the tracker's log couldn't be read"); return 2; }
    const units = new Set<string>();
    for (const l of lines(r.stdout ?? "")) {
      const m = /^\S+ \S+ [^:]*: (.*): done(?:, checked by .*)?$/.exec(l);
      if (m) units.add(m[1]);
    }
    say(`Done since ${since}: ${units.size} unit${units.size === 1 ? "" : "s"} (the list: \`just log --since "${since}" | grep ': done'\`)`);
    return 0;
  }
  say(`Morning summary since ${since}:`);
  // Each group's CI since then, whatever the events say: passed, failed (on what), cut off, or
  // never started, so a night where CI didn't run reads as that, not as no news. Split into the
  // bad (failed, cut off, never started: what follows the first "(<group id>): ") and the rest,
  // or why the tracker couldn't say.
  const ci = (): { bad: string[]; ok: string[]; why?: string } => {
    const t = new Date(since.replace(" ", "T"));
    if (Number.isNaN(t.getTime())) return { bad: [], ok: [], why: `Group CI: no time to look from (${since})` };
    const r = spawnSync("factory/tracker", ["ci", "--since", t.toISOString()], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (r.status !== 0) return { bad: [], ok: [], why: `Group CI: the tracker couldn't say (${chomp(r.stderr ?? "") || `exit ${r.status}`})` };
    const ls = lines(r.stdout ?? "").map((l) => l.startsWith("  ") ? l : `  ${l}`);
    const bad = ls.filter((l) => /^ {2}.*? \([^()\s]+\): (failed|cut off|never started)/.test(l));
    return { bad, ok: ls.filter((l) => !bad.includes(l)) };
  };
  // The check-in offer, when one is due: the decisions to prune, for the owner to keep, apply or
  // edit (tracker prune --due prints nothing otherwise).
  const checkin = () => {
    const r = spawnSync("factory/tracker", ["prune", "--due"], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 26 });
    if (r.status !== 0) { say(`Check-in: the tracker couldn't say (${chomp(r.stderr ?? "") || `exit ${r.status}`})`); return; }
    for (const l of lines(r.stdout ?? "")) say(l);
  };
  let all = "";
  for (const { m, d } of allLanes()) {
    const r = sh(m, d, "cat runs/events.log 2>/dev/null || true", { out: "capture" });
    all += r.out;
    if (r.status === 255) console.error(`(${m} is unreachable over ssh: its events aren't here)`);
  }
  // Each question once (every lane logs it: fleet-util.ts, firstQuestions), and only if its
  // first line is since then: a lane logging an older one again isn't tonight's.
  const fresh = firstQuestions(lines(all).sort()).filter((l) => l.split("\t")[0] >= since);
  const kind = (l: string) => l.split("\t")[3] ?? "";
  const outcome = unitOutcome(env);
  // Grouped by kind, so a night's republishes read as one list. With outcomes: under each event,
  // the unit it happened in and what became of it, so the report says what followed, not a guess.
  const byKind = (ls: string[], outcomes = false) => {
    for (const k of [...new Set(ls.map(kind))].sort()) {
      const of = ls.filter((l) => kind(l) === k);
      say(`  ${k} (${of.length}):`);
      for (const l of of) {
        const f = l.split("\t");
        say(`    ${[f[0], f[1], ...f.slice(4, 5)].join(" · ")}`);
        if (outcomes) for (const x of outcome(f)) say(`      ${x}`);
      }
    }
  };
  // The bad news first (the owner reads the top of the report): CI that didn't pass, the problem
  // events of either tier, the kernel's kills and low memory from this machine's overseer journal,
  // and what waits on the owner. Then the rest.
  const c = ci();
  const problems = fresh.filter((l) => EVENTS_PROBLEM.includes(kind(l))).sort();
  const journal = lines(cat(JOURNAL)).filter((l) => l.split("\t")[0] >= since && /^(oom|memory-low) on /.test(l.split("\t")[3] ?? ""));
  const q = lines(spawnSync("factory/tracker", ["questions"], { env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).stdout ?? "")
    .filter((l) => /^[0-9]+\. |^Gate: /.test(l)).length;
  say("What went wrong:");
  if (c.why) say(`  ${c.why}`);
  if (c.bad.length) { say("  Group CI that didn't pass:"); for (const l of c.bad) say(`  ${l}`); }
  byKind(problems, true);
  if (journal.length) { say(`  in the overseer's journal (${journal.length}):`); for (const l of journal) { const f = l.split("\t"); say(`    ${f[0]} · ${f[3]}`); } }
  if (q) say(`  waiting on the owner: ${q} question${q === 1 ? "" : "s"} or gate${q === 1 ? "" : "s"} (\`just questions\`)`);
  if (!c.why && !c.bad.length && !problems.length && !journal.length && !q) say("  nothing");
  const rest = onlyTier("summary", fresh.filter((l) => !EVENTS_PROBLEM.includes(kind(l))).join("\n")).sort();
  say("The rest:");
  if (!rest.length && !c.ok.length) say("  nothing");
  byKind(rest);
  if (c.ok.length) { say("  Group CI:"); for (const l of c.ok) say(`  ${l}`); }
  checkin();
  // Last, the scorecard's three worst lines since then and any prediction that came due (this
  // machine's lanes; scorecard.ts), so the end-of-run report carries them.
  for (const l of summaryLines(env, process.cwd(), since)) say(l);
  return 0;
}

// The unit an event happened in, and what became of it, as the tracker has it now: lines to print
// under the event. The unit is the line's own (its sixth field, events.ts), else one its message
// names in parentheses that the tracker knows ("Title (group/unit)"), else, for a kill in a job
// (an older line, from before events named their unit), the one session the tracker's log shows
// open on that host then. Found none: "unit: unknown" for a kind that happens in a unit, nothing
// for the rest (a group's CI, a machine's store).
function unitOutcome(env: NodeJS.ProcessEnv) {
  const shown = new Map<string, { id: string; title: string; label: string; notes: { text: string }[] } | null>();
  const show = (id: string) => {
    if (!shown.has(id)) {
      const r = spawnSync("factory/tracker", ["show", id, "--json"], { env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      let u = null; try { if (r.status === 0) u = JSON.parse(r.stdout); } catch {}
      shown.set(id, u);
    }
    return shown.get(id)!;
  };
  // "2026-11-05 03:12" (local, as events.log has it) as the tracker reads a time.
  const iso = (t: string) => { const d = new Date(t.replace(" ", "T")); return Number.isNaN(d.getTime()) ? "" : d.toISOString(); };
  const heldAt = (host: string, t: string) => {
    if (!iso(t)) return [];
    const r = spawnSync("factory/tracker", ["held-at", host, iso(t), "--json"], { env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    try { return r.status === 0 ? JSON.parse(r.stdout) as { id: string }[] : []; } catch { return []; }
  };
  return (f: string[]): string[] => {
    const [at, host, , k, msg = "", own = ""] = f;
    let u = own ? show(own) : null;
    for (const m of own ? [] : msg.matchAll(/\(([^()\s]+\/[^()\s]+)\)/g)) if ((u = show(m[1]))) break;
    if (!u && !own && k === "oom-kill") { const h = heldAt(host, at); if (h.length === 1) u = show(h[0].id); }
    if (!u) return own ? [`unit: ${own} (the tracker has no such unit now)`] : EVENTS_OF_A_UNIT.includes(k) ? ["unit: unknown"] : [];
    const note = u.notes[0]?.text;
    return [`unit: ${u.title} (${u.id}): ${u.label}`, ...(note ? [`last note: ${note}`] : [])];
  };
}

// fleet events [N]: the last N events from every lane.
export function events(f: Fleet, args: string[]): number {
  const { sh, allLanes } = f;
  const n = args[0] || "20";
  let all: string[] = [];
  for (const { m, d } of allLanes()) all.push(...lines(sh(m, d, `tail -n ${n} runs/events.log 2>/dev/null`, { out: "capture" }).out));
  all = all.sort().slice(-Number(n) || all.length);
  for (const l of all) { const f = l.split("\t"); say([...f.slice(0, 2), ...f.slice(3, 5)].join(" · ")); }
  return 0;
}
