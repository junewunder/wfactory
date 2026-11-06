// What loop.sh and store.sh ask and record: settling a session, merges, giving claims back,
// where group data lives, leases, and the machine's busy groups.
import path from "node:path";
import { ctx, git } from "../ctx.ts";
import { applyProbe, probesFirst } from "../probes.ts";
import { load, loadCache, log, mutate, originLeases, readLog, saveCache, stateDir, touch } from "../store.ts";
import { procStart } from "../proc.ts";
import { NetError, die, list, now, parseArgs, plural, str } from "../text.ts";
import { MAX_NOTE, addNote, fixIds, groupTitle, name, resolve } from "../names.ts";
import { beatRecords, beatsHere, claimAlive, dataGroup, dropLease, groupData, newerIn, heldHere, landingMine, leaseAge, leaseOf, liveLease, lockHeld, takeLease } from "../machine.ts";
import { busyGroups, ciKeepsLease } from "../ci.ts";
import { derive, hostOk, sentence } from "../status.ts";
import { gaveBackLine } from "../sessions.ts";
import { C } from "./registry.ts";
import type { CiRun, Group, Note, Overseer, State, Unit, UnitRecord } from "../types.ts";

C.where = (a) => {
  const T = load();
  const l = (T.project.loops || {})[a[0]] || die(`no loop "${a[0]}"`);
  console.log(l.spec || "docs/factory.md");
  return 0;
};
// After a loop session: confirm a computed unit by its check; a claim the session
// left open is marked ended, so it shows as interrupted, not in progress. --pushed (the loop pushed
// the unit's branch) runs no check: the loop's settle after the session runs it, with memory
// reserved for it, and a leftover branch's code isn't the tree the check would run on (#117).
C.settle = (a) => {
  const o = parseArgs(a);
  const ref = o._[0];
  const probe = (u: Unit) => !o.pushed && u.check === "computed" && u.record?.state !== "dropped";
  const ran = probesFirst((T, cache, r) => { const u = resolve(T, ref); if (probe(u)) applyProbe(T, u, cache, true, r); });
  const out = mutate((T) => {
    const u = resolve(T, ref);
    const lines: string[] = [];
    if (probe(u)) { const cache = loadCache(); const l = applyProbe(T, u, cache, true, ran); saveCache(cache); if (l) lines.push(l); }
    // --pushed: the loop pushed the unit's branch, so whoever claims it next carries on from there;
    // the units waiting to merge on that branch too (it holds their work as it is now).
    if (o.pushed && u.record?.branch) for (const x of [u, ...waiting(T, u.record.branch)]) if (!x.record!.pushed) { x.record!.pushed = true; touch(T, x); }
    // A claim its session handed back with its work: its status stands; the claim just ends now
    // (it stayed live while the session ran, so no lane took the unit under it).
    // Its session gave it back having done nothing: notes it wrote after that push out none either.
    const gave = (readLog() ?? []).filter((l) => l.tag === ctx.TAG && l.id === u.id);
    const claimAt = gave.findLast((l) => l.cmd === "claim")?.at;
    if (claimAt && gave.some((l) => l.at >= claimAt && gaveBackLine(l))) { keepOlderNotes(u, claimAt); touch(T, u); }
    if (u.record?.state === "claimed" && u.record.by === ctx.TAG && u.record.handedBack && !u.record.ended) { u.record.ended = now(); touch(T, u); }
    else if (u.record?.state === "claimed" && u.record.by === ctx.TAG && !u.record.handedBack) {
      if (backToReview(u)) { lines.push(`${name(u)}: the session ended without a verdict; it's back in review`); log(T, "settle", u.id, `${u.title}: its check didn't finish; back in review`); }
      else { u.record.ended = now(); lines.push(`${name(u)}: the session ended without recording it; it shows as interrupted`); log(T, "settle", u.id, `${u.title}: session ended mid-unit`); }
      touch(T, u);
    }
    return lines;
  });
  if (out.length) console.log(out.join("\n"));
  return 0;
};
// A check claimed and given up (no verdict, nothing left on its branch): the unit is back in review.
function backToReview(u: Unit) {
  const r = u.record, rv = r?.reviewing;
  if (!rv || r!.pushed) return false;
  u.record = { state: "review", by: rv.by, at: rv.at!, evidence: rv.evidence };
  return true;
}
// After the loop merged a unit's branch into main and pushed: what needs it can go on.
C.merged = (a) => mutate((T) => {
  const o = parseArgs(a);
  const us = [...o._.map((ref) => resolve(T, ref)), ...(typeof o.branch === "string" ? [...T.byId.values()].filter((u) => u.record?.branch === o.branch) : [])];
  for (const u of us) {
    if (!u.record?.branch) continue;
    const was = derive(T, u).s;
    delete u.record.branch; delete u.record.pushed; delete u.record.landing;
    // Landed: what its review asked for is settled, and a later round starts its count afresh.
    delete u.review; delete u.landCheck; delete u.round;
    touch(T, u);
    if (was === "merging") log(T, "merged", u.id, `${u.title}: on main`);
  }
  return 0;
});
// Landing a finished branch: any lane on the machine it was worked on may (its outputs in work/
// are there), one at a time. The units waiting to merge on a branch share one landing claim, which
// the lane that worked them holds while it lives (landingOf).
// No subcommand: the branches a lane could land now, a line each (branch, its first unit and its
// title, by tabs): merging, worked here, pushed since it was recorded finished (so origin's copy is
// the finished one, not an earlier attempt's), nobody else's live claim on them, and no open merge
// unit settling them.
// claim <branch>: this lane's ($FACTORY_PID's) now, unless another live lane holds it (exit 1, saying
// who) or a merge unit settles it. A branch with nothing waiting to merge on it needs no claim.
const waiting = (T: State, b: string) => [...T.byId.values()].filter((u) => u.record?.branch === b && derive(T, u).s === "merging");
// (A merge unit recorded done is merging with the branch it settled: that's landed as any other.)
const mergeOpen = (T: State, b: string) => [...T.byId.values()].some((u) => T.groupOf.get(u.id)?.id === "merge" && u.branch === b && !["done", "dropped", "merging"].includes(derive(T, u).s));
const heldBy = (T: State, us: Unit[]) => us.map((u) => u.record!.landing).find((l) => !!l && claimAlive(T, l) && !landingMine(l));
C.landing = (a) => {
  const o = parseArgs(a), [sub, b] = o._;
  if (sub === undefined) {
    const T = load(), seen = new Set<string>();
    for (const u of T.byId.values()) {
      const br = u.record?.branch;
      if (!br || seen.has(br) || derive(T, u).s !== "merging") continue;
      seen.add(br);
      const us = waiting(T, br);
      // (Every one pushed since it was recorded: one recorded since the last push, a merge unit
      // say, has work origin's copy lacks.)
      if (us.some((x) => x.record!.host !== ctx.HOST || !x.record!.pushed)) continue;
      if (!heldBy(T, us) && !mergeOpen(T, br)) console.log(`${br}\t${us[0].id}\t${us[0].title}`);
    }
    return 0;
  }
  if (sub !== "claim" || !b) die("landing [claim <branch>]");
  return mutate((T) => {
    const us = waiting(T, b);
    if (!us.length) return 0;
    const l = heldBy(T, us);
    if (l) { console.log(`${b} is being landed by session ${l.by ?? "?"} on ${l.host ?? "?"}`); return 1; }
    if (mergeOpen(T, b)) { console.log(`${b} waits for its merge unit`); return 1; }
    const away = us.find((u) => u.record!.host && u.record!.host !== ctx.HOST);
    if (away) { console.log(`${b} was worked on ${away.record!.host}, where its outputs in work/ are`); return 1; }
    const pid = Number(ctx.env.FACTORY_PID) || undefined;
    if (us.every((u) => u.record!.landing && landingMine(u.record!.landing))) return 0;
    const mine = beatsHere(T, { at: now(), by: ctx.TAG, host: ctx.HOST, pid, start: pid ? procStart(pid) || undefined : undefined, lane: ctx.env.FACTORY_LANE || undefined });
    for (const u of us) { u.record!.landing = mine; touch(T, u); }
    log(T, "landing", us[0].id, `${us.map((u) => u.title).join(", ")}: landing taken over by ${ctx.HOST}`);
    return 0;
  });
};
// The loop's review of a finished branch asked for fixes before it lands. The units waiting to merge
// on it go back to ready, their branch kept on origin so the next claim carries it on, with the
// findings on their card and a note pointing there. The second time for a unit, it's blocked for the
// overseer instead, so the loop doesn't go round. A merge unit among them is done with the branch (its
// merge is on it): the unit whose work it is goes back, not the merge.
C["review-fix"] = (a) => {
  const o = parseArgs(a), b = o._[0];
  const findings = (str(o.findings) ?? "").trim().slice(0, 4000);
  if (!b || !findings) die('review-fix <branch> --findings "…"');
  return mutate((T) => {
    const us = waiting(T, b);
    if (!us.length) die(`nothing waits to merge on ${b}`);
    const merge = (u: Unit) => T.groupOf.get(u.id)?.id === "merge";
    const back = us.some((u) => !merge(u)) ? us.filter((u) => !merge(u)) : us;
    for (const u of us.filter((x) => !back.includes(x))) { delete u.record!.branch; delete u.record!.pushed; delete u.record!.landing; touch(T, u); }
    const text = fixIds(T, "the findings", findings);
    const first = text.replace(/\s+/g, " ");
    for (const u of back) {
      const fixes = (u.review?.fixes ?? 0) + 1;
      u.review = { fixes, at: now(), findings: text };
      if (fixes >= 2) {
        u.record = { state: "blocked", why: `the loop's review asked for fixes a second time, so it waits for the overseer rather than going round again: ${first.length > 300 ? first.slice(0, 299) + "…" : first}`, by: ctx.TAG, at: now() };
        log(T, "block", u.id, `${u.title}: stuck: the loop's review asked for fixes a second time`);
        console.log(`${name(u)} → stuck (the review asked for fixes a second time)`);
      } else {
        u.record = undefined;
        const pre = "The loop's review asked for fixes before landing (all on the card): ";
        addNote(T, u, pre + (pre.length + first.length > MAX_NOTE ? first.slice(0, MAX_NOTE - pre.length - 1) + "…" : first));
        log(T, "reopen", u.id, `${u.title}: back to ready: the loop's review asked for fixes`);
        console.log(`${name(u)} → ready, on its branch (the review asked for fixes)`);
      }
      touch(T, u);
    }
    return 0;
  });
};
// The project's check before a finished branch lands (project.json ci.land) failed: it found what
// git doesn't make (a hand fix in work/, output from code nobody committed). As with review-fix, the
// units waiting to merge on the branch go back to ready on it (pushed), with the check's last line
// as a note, so the next session carries on with the unit's context; a merge unit among them is done
// with the branch. The third failure in a row blocks the unit for the overseer, as merges do.
const LAND_TRIES = 3;
C["land-fail"] = (a) => {
  const o = parseArgs(a), b = o._[0];
  const ev = (str(o.evidence) ?? "").replace(/\s+/g, " ").trim();
  if (!b || !ev) die('land-fail <branch> --evidence "…"');
  return mutate((T) => {
    const us = waiting(T, b);
    if (!us.length) die(`nothing waits to merge on ${b}`);
    const merge = (u: Unit) => T.groupOf.get(u.id)?.id === "merge";
    const back = us.some((u) => !merge(u)) ? us.filter((u) => !merge(u)) : us;
    for (const u of us.filter((x) => !back.includes(x))) { delete u.record!.branch; delete u.record!.pushed; delete u.record!.landing; touch(T, u); }
    const text = fixIds(T, "the evidence", ev);
    const cut = (n: number) => (text.length > n ? text.slice(0, n - 1) + "…" : text);
    for (const u of back) {
      const fails = (u.landCheck?.fails ?? 0) + 1;
      u.landCheck = { fails, at: now(), evidence: text };
      if (fails >= LAND_TRIES) {
        u.record = { state: "blocked", why: `the check before landing failed ${LAND_TRIES} times in a row, so it waits for the overseer: ${cut(300)}`, by: ctx.TAG, at: now() };
        log(T, "block", u.id, `${u.title}: stuck: the check before landing failed ${LAND_TRIES} times in a row`);
        console.log(`${name(u)} → stuck (the check before landing failed ${LAND_TRIES} times in a row)`);
      } else {
        u.record = undefined;
        const pre = "The check before landing failed (fix what it found, then finish again): ";
        addNote(T, u, pre + cut(MAX_NOTE - pre.length));
        log(T, "reopen", u.id, `${u.title}: back to ready: the check before landing failed`);
        console.log(`${name(u)} → ready, on its branch (the check before landing failed)`);
      }
      touch(T, u);
    }
    return 0;
  });
};
// The last lane on this machine stopped and tidied up, just before it lets the machine sleep. The
// record is on main, so the overseer reads it (`just log`) without reaching a machine that's asleep.
C["lanes-stopped"] = (a) => mutate((T) => {
  const o = parseArgs(a);
  const failed = typeof o.failed === "string" ? o.failed : "";
  log(T, "lanes-stopped", null, `${ctx.HOST}: the last lane stopped and tidied up${failed ? `, except: ${failed}` : ""}; the machine may sleep now`);
  return 0;
});
// A claim given back. --unstarted: the loop claimed a unit it can't work after all, before its
// session (no room in the cache for its data, CI wants its resource). Else it's the session's own:
// one that did work (commits since the claim, changes in its tree or its group's data), or picked
// up an earlier attempt's, hands the unit back with that work kept, as a session that leaves a note
// and stops does: its record keeps its branch and session, it shows by its needs and resources
// (waiting, ready), not interrupted, and the loop's settle after the session leaves it so. The
// loop pushes the branch and settles the data as for any unfinished unit. One that did nothing
// gives the unit back unstarted.
// --release-lease: the lease goes too even if an earlier claim here took it (the loop found no room
// for a copy down under a lease this machine held without a current copy: nothing here is unsent).
C.unclaim = (a) => {
  const o = parseArgs(a);
  // What the session did is worked out once, before the write (it walks the data's folders, and a
  // write is retried when another machine's push comes first).
  const T0 = load(), u0 = resolve(T0, o._[0]), r0 = u0.record;
  const did0 = !o.unstarted && r0?.state === "claimed" && r0.by === ctx.TAG && !r0.handedBack ? sessionWork(T0, u0, r0) : "";
  return mutate((T) => unclaim(T, o, did0));
};
function unclaim(T: State, o: ReturnType<typeof parseArgs>, did0: string) {
  const u = resolve(T, o._[0]);
  const r = u.record;
  if (r?.state === "claimed" && r.by === ctx.TAG && r.handedBack) { console.log(`${name(u)}: handed back already: ${sentence(T, u)}`); return 0; }
  if (r?.state !== "claimed" || r.by !== ctx.TAG) die(`${name(u)} isn't claimed by this session (${ctx.TAG})`);
  const did = o.unstarted ? "" : did0;
  let kept = false;
  if (backToReview(u)) log(T, "unclaim", u.id, `${u.title}: given back, back in review`);
  else if (did || (!o.unstarted && (r!.resumed || r!.pushed))) {
    // The claim stays live until its session ends (the loop's settle ends it): no lane takes the
    // unit, nor CI its group, before the loop has pushed its branch and settled its data. Its lease
    // stays for that too (the loop lets it go once nothing here needs it).
    r!.handedBack = now(); kept = true;
    // (What it shows as once its session has ended.)
    r!.ended = r!.handedBack; T._memo = null;
    const st = sentence(T, u);
    delete r!.ended; T._memo = null;
    // (Its session did nothing itself: marked, for the loop, as below.)
    if (!did) keepOlderNotes(u, r!.at);
    log(T, "unclaim", u.id, `${u.title}: handed back by its session, its work kept (${did || "an earlier attempt's"}); ${st}`, did ? {} : { more: { unstarted: true } });
    console.log(`${name(u)}: handed back, its work kept (${did || "an earlier attempt's"}): ${st}. ${ctx.env.FACTORY_BRANCHES ? "The loop pushes its branch for the next session once you end this one" : "The next session carries on from what you left"}; \`just note ${u.id} "…"\` what it must know, then end the session.`);
  } else {
    // Work an earlier attempt left (a pushed branch, an interrupted claim) keeps the unit interrupted.
    keepOlderNotes(u, r!.at);
    if (r!.resumed || r!.pushed) r!.ended = now(); else u.record = undefined;
    // (Marked, for the loop: it doesn't offer the unit to this lane again this run.)
    log(T, "unclaim", u.id, `${u.title}: given back unstarted`, { more: { unstarted: true } });
  }
  touch(T, u);
  const g = dataGroup(T, u), l = g && leaseOf(T, g);
  const others = [...T.byId.values()].some((x) => x !== u && dataGroup(T, x) === g && x.record?.state === "claimed" && x.record.host === ctx.HOST && claimAlive(T, x.record));
  if (!kept && l && l.host === ctx.HOST && (l.by === ctx.TAG || o["release-lease"]) && !others) dropLease(T, g!, o["release-lease"] ? "no room here for its data" : "its unit was given back");
  return 0;
}

// A unit given back unstarted, or with only an earlier attempt's work: what its session noted
// since its claim (at) pushes out none of the notes earlier attempts left; those come back from the
// log, and its own keep only the room left (a unit keeps 3), then notes of other sessions that gave
// it back the same way. 25 Oct, a lane near its stop claimed a unit 22 times, each session noting
// "not started" and giving it back, until those notes were all its card had.
function keepOlderNotes(u: Unit, at: string) {
  const mine = (u.notes || []).filter((n) => n.by === ctx.TAG && n.at >= at);
  if (!mine.length) return;
  const lines = readLog() ?? [];
  const gaveBack = new Set(lines.filter((l) => l.id === u.id && gaveBackLine(l)).map((l) => l.tag ?? ""));
  const others = (u.notes || []).filter((n) => !mine.includes(n));
  const real = others.filter((n) => !gaveBack.has(n.by));
  for (const l of lines.reverse()) {
    if (real.length >= 3) break;
    if (l.cmd !== "note" || l.id !== u.id || gaveBack.has(l.tag ?? "") || (l.tag === ctx.TAG && l.at >= at)) continue;
    const i = l.text.indexOf(": note: ");
    if (i < 0 || real.some((n) => n.at === l.at && n.by === (l.tag ?? ""))) continue;
    real.push({ at: l.at, by: l.tag ?? "", text: l.text.slice(i + 8) });
  }
  const newest = (xs: Note[]) => [...xs].sort((a, b) => b.at.localeCompare(a.at));
  u.notes = newest([...newest(real), ...mine, ...newest(others.filter((n) => gaveBack.has(n.by)))].slice(0, 3));
}

// What the session that holds u's claim did since its claim, in a few words ("" if nothing):
// commits on its branch not on main, changes left in its tree, files written in its group's data
// (by their times: what was there before the claim isn't its).
// Dies, naming what to run instead, if git can't say.
function sessionWork(T: State, u: Unit, r: UnitRecord) {
  const since = r.at, cut = Date.parse(since);
  const main = ctx.ORIGIN ? `refs/remotes/origin/${ctx.MAIN}` : null;
  const refuse = (why: string) => die(`couldn't tell whether this session changed anything for ${name(u)} (${why}), so it isn't given back: that would lose what it did. Leave a note for the next attempt (\`just note ${u.id} "…"\`) and end the session: the loop settles the unit after it.`);
  // A second unit the session works on its first one's branch: the branch and the tree hold that
  // one's work too, so only commits naming this unit count, and its data if the other works elsewhere.
  const mates = [...T.byId.values()].filter((x) => x !== u && x.record?.by === ctx.TAG && !!r.branch && x.record.branch === r.branch && ["claimed", "done", "review"].includes(x.record.state));
  const lg = git(["-C", ctx.ROOT, "rev-list", "--count", `--since=${since}`, ...(mates.length ? ["--fixed-strings", `--grep=${u.id}`] : []), "HEAD", ...(main && git(["-C", ctx.ROOT, "rev-parse", "-q", "--verify", main]).status === 0 ? ["--not", main] : []), "--", ".", ":(exclude)tracker"]);
  if (lg.status !== 0) refuse((lg.stderr || "git rev-list failed").trim().split("\n")[0]);
  const commits = Number(lg.stdout.trim()) || 0;
  const st = git(["-C", ctx.ROOT, "status", "--porcelain", "--", ".", ":(exclude)tracker"]);
  if (st.status !== 0) refuse((st.stderr || "git status failed").trim().split("\n")[0]);
  // Changes written since the claim (a lane's links to the checkout's work/ and .env aren't changes).
  const left = mates.length ? 0 : st.stdout.split("\n").filter((l) => l && !/^\?\? (work|\.env)\/?$/.test(l)).map((l) => l.slice(3).replace(/^.* -> /, "").replace(/^"(.*)"$/, "$1"))
    .filter((f) => newerIn(path.join(ctx.ROOT, f), cut)).length;
  const dg = dataGroup(T, u), g = dg ? T.groupById.get(dg) : undefined;
  const wrote = g?.data && T.project.store && !mates.some((x) => dataGroup(T, x) === dg) ? groupData(T, g).paths.some((p) => newerIn(p.local, cut)) : false;
  return [commits && `${plural(commits, "commit")} on its branch`, left && `${plural(left, "file")} changed in its tree`, wrote && `${groupTitle(T, dg!)}'s data changed`].filter(Boolean).join(", ");
}
// ---------------------------------------------------------------- data commands

C.data = (a) => {
  const o = parseArgs(a);
  const T = load();
  const st = T.project.store || die("no store in tracker/project.json (\"store\": remote, paths, inputs; see the tracker spec)");
  const remote = ctx.env.FACTORY_STORE || st.remote || die("tracker/project.json store has no remote (host:path)");
  if (o.all) { console.log(JSON.stringify({ remote, rebuilt: st.rebuilt || [], groups: T.groups.filter((g) => g.data).map((g) => groupData(T, g)) })); return 0; }
  let gid: string | null | undefined = o._[0], reads: unknown;
  if (typeof o.unit === "string") { const u = resolve(T, o.unit); gid = dataGroup(T, u); reads = u.reads; if (!gid) { console.log(JSON.stringify({ remote, group: null })); return 0; } }
  const g = T.groupById.get(gid!) || die(`no group "${gid ?? ""}"`);
  if (!g.data) die(`${g.title} (${g.id}) keeps no data on the store (edit-group ${g.id} --data k=v,…)`);
  console.log(JSON.stringify({ remote, rebuilt: st.rebuilt || [], ...groupData(T, g, reads) }));
  return 0;
};

// The files a pipeline step rebuilds (project.json store.rebuilt), so a copy down doesn't keep
// them: listed, or one more added with why (a set-aside sort's lane adds them; the state is
// main's, so a hand edit on a unit's branch would be dropped).
C.rebuilt = (a) => {
  const o = parseArgs(a);
  const [sub, glob] = o._, why = typeof o.why === "string" ? o.why.trim() : "";
  if (sub === undefined) { for (const g of (load().project.store?.rebuilt ?? [])) console.log(String(g)); return 0; }
  if (sub !== "add" || !glob || !why) die('usage: rebuilt [add <glob> --why "…"]');
  return mutate((T) => {
    const st = T.project.store || die("no store in tracker/project.json");
    const top = glob.split("/")[0];
    if (glob.startsWith("/") || glob.split("/").includes("..")) die(`rebuilt: "${glob}" isn't a path inside a data path`);
    if (!top.includes("*") && !Object.keys(st.paths ?? {}).includes(top)) die(`rebuilt: "${glob}" starts with "${top}", not a data path name (${Object.keys(st.paths ?? {}).join(", ")}) or *`);
    if (/^[*/]+$/.test(glob)) die(`rebuilt: "${glob}" would match every file`);
    const cur = (st.rebuilt ?? []).map(String);
    if (cur.includes(glob)) { console.log(`${glob}: already in store.rebuilt`); return 0; }
    st.rebuilt = [...cur, glob];
    T.dirty.add("project"); log(T, "rebuilt", null, `store.rebuilt += ${glob}: ${why}`);
    console.log(`store.rebuilt += ${glob}`);
    return 0;
  });
};

// Which thread oversees the factory: factory-wide, on main like the leases, so an overseer on
// any machine sees when a newer one has attached (fleet attach, fleet wait --as).
C.overseer = (a) => {
  const o = parseArgs(a);
  const [sub, id] = o._;
  const show = (v: Overseer | null) => v ? `${v.id} on ${v.host}, since ${v.at}` : "none";
  if (sub === undefined) {
    const v = load().overseer;
    console.log(o.json ? JSON.stringify(v) : show(v));
    return 0;
  }
  if (sub !== "take" || !id || !/^[A-Za-z0-9._-]+$/.test(id)) die("overseer [--json] | overseer take <id> [--machine <name>] [--json]");
  const host = typeof o.machine === "string" ? o.machine : ctx.HOST;
  const was = mutate((T) => {
    const w = T.overseer;
    T.overseer = { id, host, at: now() };
    T.dirty.add("leases");
    log(T, "overseer", null, `overseer ${id} on ${host} attached${w && w.id !== id ? `, replacing ${w.id} on ${w.host}` : ""}`);
    return w;
  });
  if (o.json) console.log(JSON.stringify({ now: { id, host }, was }));
  else console.log(`overseer: ${id} on ${host}${was && was.id !== id ? ` (replacing ${show(was)})` : ""}`);
  return 0;
};

C.leases = (a) => {
  const o = parseArgs(a);
  const T = load();
  if (o.json) { console.log(JSON.stringify(T.leases.map((l) => ({ ...l, stale: leaseAge(l) >= ctx.STALE_MS })))); return 0; }
  if (!T.leases.length) { console.log("no leases"); return 0; }
  const ago = (t: string) => { const m = Math.round((Date.now() - Date.parse(t)) / 60000); return m < 90 ? `${m} min ago` : `${Math.round(m / 60)} h ago`; };
  for (const l of T.leases) console.log(`${groupTitle(T, l.id)} (${l.id}): ${l.host}, taken ${ago(l.at)}, heartbeat ${ago(l.beat || l.at)}${leaseAge(l) >= ctx.STALE_MS ? " (stale: another machine may take it over)" : ""}`);
  return 0;
};

C.lease = (a) => {
  const o = parseArgs(a);
  const { HOST, STALE_MS, BEAT_MS } = ctx;
  const [sub, ...gs] = o._;
  const T = load();
  const known = (g: string) => T.groupById.get(g)?.data ? g : die(`no group with data "${g}"`);
  switch (sub) {
    case "holder": {
      const g = known(gs[0] || die("lease holder <group> [--fresh]"));
      // --fresh: only an answer from origin as it is now (store.sh before writing the store).
      const fresh = o.fresh ? originLeases() : null;
      if (fresh) { const l = fresh.find((x) => x.id === g && leaseAge(x) < STALE_MS); console.log(l ? l.host : ""); return 0; }
      const l = liveLease(T, g); console.log(l ? l.host : ""); return 0;
    }
    case "mine": for (const l of T.leases) if (l.host === HOST && (o.all || leaseAge(l) < STALE_MS)) console.log(l.id); return 0;
    case "idle": {
      // This machine's leases with nothing left for it here: no unit of the group in progress on this
      // machine, and none it could take now. The loop releases them once their data is on the store.
      // CI running here, or due and runnable here, keeps it too: CI runs before the lease goes.
      const out = T.leases.filter((l) => l.host === HOST && leaseAge(l) < STALE_MS).map((l) => l.id).filter((g) => !(T.groupById.get(g) && ciKeepsLease(T, T.groupById.get(g)!))).filter((g) => ![...T.byId.values()].some((u) => {
        if (dataGroup(T, u) !== g || u.kind === "gate") return false;
        const s = derive(T, u).s;
        if (s === "doing" && u.record!.host === HOST) return true;
        return ["ready", "interrupted", "broken", "review"].includes(s) && hostOk(T, u);
      }));
      for (const g of out) console.log(g);
      return 0;
    }
    case "beat": {
      // This machine's leases, and the machine itself while the loop has claims or CI running here.
      // The loop's CI run here whose process is gone is ended, so every machine sees it due at once. A
      // dead lane's unit claim isn't: its work may be only here, for this machine's lanes to resume.
      const recs = beatRecords(T), live = recs.some(([r]) => claimAlive(T, r));
      const deadCi = (T_: State, rs: [UnitRecord | CiRun, Unit | Group][]) => rs.filter(([r, x]) => "units" in x && !claimAlive(T_, r)) as [CiRun, Group][];
      const dead = deadCi(T, recs);
      const due = (t: string | undefined) => o.force || !t || Date.now() - Date.parse(t) >= BEAT_MS;
      if (!dead.length && !T.leases.some((l) => l.host === HOST && due(l.beat || l.at)) && !(live && due(T.hosts[HOST]))) return 0;
      // Only a heartbeat that reaches origin counts: one kept offline would make a lease look live here alone.
      try {
        return mutate((T2) => {
          const t = now(), recs2 = beatRecords(T2);
          for (const l of T2.leases) if (l.host === HOST) { l.beat = t; T2.dirty.add("leases"); }
          for (const [r, g] of deadCi(T2, recs2)) { r.ended = t; T2.dirty.add("group:" + g.id); log(T2, "ci-lost", null, `${g.title}: CI's lane on ${HOST} is gone (session ${r.by})`); }
          if (recs2.some(([r]) => claimAlive(T2, r))) { T2.hosts[HOST] = t; T2.dirty.add("leases"); }
          return 0;
        }, { strict: true });
      } catch (e) { if (e instanceof NetError) return 0; throw e; }
    }
    case "take": {
      const g = known(gs[0] || die("lease take <group>"));
      return mutate((T2) => { const l = liveLease(T2, g); if (l && l.host !== HOST) die(`${groupTitle(T2, g)} is leased by ${l.host}`); if (!l) takeLease(T2, g); console.log(`${groupTitle(T2, g)}: leased by ${HOST}`); return 0; }, { strict: true });
    }
    case "release": {
      const ids = o.all ? T.leases.filter((l) => l.host === HOST).map((l) => l.id) : gs.map(known);
      if (!ids.length) return 0;
      // Strict: a release that didn't reach origin hasn't happened (store.sh says so, and the lease goes stale).
      try { return mutate((T2) => {
        for (const g of ids) {
          const l = leaseOf(T2, g);
          if (!l) continue;
          if (l.host !== HOST && !o.force) die(`${groupTitle(T2, g)} is ${l.host}'s lease; --force releases another machine's (only when it's gone for good: its data since the last copy back is lost)`);
          dropLease(T2, g, typeof o.why === "string" ? o.why : "");
        }
        return 0;
      }, { strict: true }); } catch (e) { if (!(e instanceof NetError)) throw e; console.error(e.message.replace(/\b(a|the) claim\b/, "the release")); return 1; }
    }
    default: return die("lease holder|mine|idle|beat|take|release (`just tracker lease --help`)");
  }
};
C.dir = () => { console.log(stateDir()); return 0; };
// Lanes on one machine share work/, so a unit worked here leaves outputs there that aren't on
// main yet: in progress, interrupted, or finished with its branch still to land. A check that
// looks at work/ skips those groups.
// --live: only what a session or CI here is working on now (claims whose session is alive), for a
// guard that keeps a lane from writing a group another lane is mid-way through.
C.busy = (a) => {
  const o = parseArgs(a), T = load(), gs = new Set<string | undefined>(), except = typeof o.except === "string" ? o.except : null;
  if (o.live) for (const [g, us] of heldHere(T)) { if (us.some((u) => u.id !== except)) gs.add(g); }
  else for (const g of busyGroups(T, except)) gs.add(g);
  gs.delete(undefined);
  console.log([...gs].sort().join(" "));
  return 0;
};
// One unit's status key (ready, doing, merging, done, …), for scripts.
// --host: the machine it's pinned to, its own or its group's ("" for any).
C.state = (a) => { const o = parseArgs(a); const T = load(); const u = resolve(T, o._[0]); console.log(o.branch ? u.record?.branch || "" : o.by ? u.record?.by || "" : o.host ? u.host || T.groupOf.get(u.id)?.host || "" : derive(T, u).s); return 0; };
// store.sh: where a unit's outputs went when its session ended unfinished (the store's copy put back
// over them), for its card; --clear once they're back in work/ (restored) or gone.
C["aside-set"] = (a) => mutate((T) => {
  const o = parseArgs(a);
  const u = resolve(T, o._[0]);
  if (o.clear) { if (u.aside) { delete u.aside; touch(T, u); } return 0; }
  const p = str(o._[1]) ?? die("usage: aside-set <id> <set> [--commit C] [--by S] [--mixed] | aside-set <id> --clear");
  u.aside = { path: p, host: ctx.HOST, at: now(), ...(str(o.commit) ? { commit: str(o.commit) } : {}), ...(str(o.by) ? { by: str(o.by) } : {}), ...(o.mixed ? { mixed: true } : {}) };
  touch(T, u); log(T, "aside-set", u.id, `${u.title}: its unfinished outputs set aside on ${ctx.HOST} in ${p}`);
  return 0;
});

// held-at <host> <time> [--json]: the units whose sessions on host were open at that time, from
// the log (a claim, to the last line its tag wrote about that unit; to now if still claimed). For
// the morning summary, to tie an event that names no unit (an older long job's kill) to the
// session it happened in. The time is to the minute, as events.log has it: the minute it names.
C["held-at"] = (a) => {
  const o = parseArgs(a);
  const [host, at] = o._;
  if (!host || !at) die("usage: held-at <host> <time> [--json]");
  const t = Date.parse(at);
  if (Number.isNaN(t)) die(`held-at: not a time: ${at}`);
  const T = load();
  const open = new Map<string, { id: string; tag: string; from: number; to: number }>(), all: { id: string; tag: string; from: number; to: number }[] = [];
  for (const l of readLog() ?? []) {
    if (!l.tag || !l.id) continue;
    const k = `${l.tag} ${l.id}`, lt = Date.parse(l.at);
    if (l.cmd === "claim") { if (l.host !== host) { open.delete(k); continue; } const s = { id: l.id, tag: l.tag, from: lt, to: lt }; open.set(k, s); all.push(s); continue; }
    const s = open.get(k);
    if (s && !["merged", "lease", "release"].includes(l.cmd)) s.to = lt;
  }
  for (const s of all) { const r = T.byId.get(s.id)?.record; if (r?.state === "claimed" && r.by === s.tag && claimAlive(T, r)) s.to = Date.now(); }
  const seen = new Set<string>();
  const us = all.filter((s) => s.from < t + 60e3 && s.to >= t && !seen.has(s.id) && (seen.add(s.id), true)).map((s) => ({ id: s.id, title: T.byId.get(s.id)?.title ?? s.id, tag: s.tag }));
  if (o.json) console.log(JSON.stringify(us));
  else for (const u of us) console.log(`${u.title} (${u.id}), session ${u.tag}`);
  return 0;
};
