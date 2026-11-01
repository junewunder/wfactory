// Group CI's commands: what's due, and the loop's records of runs (see ../ci.ts).
import fs from "node:fs";
import { ctx, git } from "../ctx.ts";
import { codeHead, load, log, mutate } from "../store.ts";
import { NetError, die, list, now, parseArgs, str } from "../text.ts";
import { autoIds, checkText, resolve } from "../names.ts";
import { capsOk, claimAlive, dataGroup, dropLease, leaseOf, liveLease, takeLease } from "../machine.ts";
import { ciCmds, ciData, ciFixPassed, ciFixUnit, ciLand, ciSplit, ciOutcome, ciPick, ciPlan, ciRunRecord, ciStartUses, ciState, ciSteps, ciText, ciTouch, ciUnits, publishing, short, type CiPick } from "../ci.ts";
import { derive, scopeGroups } from "../status.ts";
import { C } from "./registry.ts";
import type { Group, State } from "../types.ts";

const ciGroup = (T: State, id: string | undefined): Group => {
  const g = T.groupById.get(id!) || die(`no group "${id ?? ""}" (${T.groups.map((x) => x.id).join(", ")})`);
  if (!g.ci) die(`${g.title} (${g.id}) has no CI (\`just tracker edit-group ${g.id} --ci <step>,…\` turns it on)`);
  return g;
};
// How long a group's last run took (seconds), or null.
// (The longer of its last pass and last failure: a failure can end at the first step.)
const lastSecs = (g: Group) => {
  const t = [g.ci!.passed?.secs, g.ci!.failed?.secs].filter((x): x is number => typeof x === "number");
  return t.length ? Math.max(...t) : null;
};
// Whether this machine runs g's CI tonight, as last call plans for it: pinned here (or to no
// machine), its steps' caps here, and its data (if it's on the store) leased here or by no one.
// (A group another machine leases the data of is that machine's to run.)
const runsHere = (T: State, g: Group) => {
  if (g.host ? g.host !== ctx.HOST : ctx.env.FACTORY_HOST_ONLY) return false;
  if (!ciPlan(T, g).every((p) => capsOk(p))) return false;
  const dg = ciData(T, g), l = dg ? liveLease(T, dg) : null;
  return !l || l.host === ctx.HOST;
};
C.ci = (a) => {
  const o = parseArgs(a);
  const T = load();
  const groups = scopeGroups(T).filter((g) => !o._[0] || g.id === o._[0]);
  if (o._[0] && !groups.length) die(`no group "${o._[0]}"`);
  if (o.json) {
    console.log(JSON.stringify(groups.filter((g) => g.ci).map((g) => { const c = ciState(T, g); return { group: g.id, state: c.s, why: ("why" in c && c.why) || null, steps: ciSteps(T, g), uses: [...new Set(ciPlan(T, g).flatMap((p) => p.uses))], here: g.host ? g.host === ctx.HOST : !ctx.env.FACTORY_HOST_ONLY, runs_here: runsHere(T, g), passed: g.ci!.passed ? { commit: g.ci!.passed.commit, at: g.ci!.passed.at } : null, secs: lastSecs(g), title: g.title }; })));
    return 0;
  }
  // --since T: what became of each group's CI since then (the morning summary's per-group lines).
  if (o.since !== undefined) {
    const t = typeof o.since === "string" ? Date.parse(o.since) : NaN;
    if (Number.isNaN(t)) die(`--since needs a time (got ${typeof o.since === "string" ? `'${o.since}'` : "nothing"})`);
    const rows = groups.map((g) => [g, ciOutcome(T, g, t)] as const).filter(([, x]) => x);
    const ORDER = ["failed", "cut", "never", "running", "passed"];
    rows.sort((x, y) => ORDER.indexOf(x[1]!.s) - ORDER.indexOf(y[1]!.s));
    if (!rows.length) console.log("no group's CI needed to run");
    for (const [g, x] of rows) console.log(`  ${g.title} (${g.id}): ${x!.text}`);
    return 0;
  }
  console.log(`Publishing: ${publishing(T) ? "on" : "off"}`);
  for (const g of groups.filter((x) => x.ci)) console.log(`  ${g.title} (${g.id}): ${ciText(T, g)}`);
  const none = groups.filter((x) => !x.ci);
  if (none.length) console.log(`No CI: ${none.map((g) => g.title).join(", ")}`);
  return 0;
};
// The commit a run tested: --commit, else what main was when it started, else main now.
const ciCommit = (T: State, g: Group, o: ReturnType<typeof parseArgs>) => (typeof o.commit === "string" ? o.commit : (g.ci!.running?.by === ctx.TAG && claimAlive(T, g.ci!.running) && g.ci!.running.commit) || codeHead({ fresh: true }) || undefined);
C["ci-start"] = (a) => {
  const o = parseArgs(a);
  return mutate((T) => {
    const g = ciGroup(T, o._[0]);
    const c = ciState(T, g);
    if (c.s === "running") die(`${g.title}'s CI is running already (session ${c.run.by}${c.run.host ? " on " + c.run.host : ""})`);
    if (c.s !== "due" && !o.force) die(`${g.title}'s CI isn't due: ${ciText(T, g, c)}. --force runs it anyway.`);
    ciRunRecord(T, g);
    console.log(`${g.title}: CI running. Steps: ${ciSteps(T, g).map((s) => `${s}${T.project.ci?.steps?.[s]?.cmd ? ` (${T.project.ci.steps[s].cmd})` : ""}`).join("; ")}`);
    return 0;
  }, { strict: true });
};
// --secs N: how long the run's steps took (the loop says), kept for when last call has to begin.
const secsOf = (o: ReturnType<typeof parseArgs>) => {
  if (o.secs === undefined) return {};
  const n = Number(o.secs);
  if (typeof o.secs !== "string" || !Number.isInteger(n) || n < 0) die(`--secs needs a whole number of seconds (got ${typeof o.secs === "string" ? `'${o.secs}'` : "nothing"})`);
  return { secs: n };
};
C["ci-pass"] = (a) => {
  const o = parseArgs(a);
  return mutate((T) => {
    const g = ciGroup(T, o._[0]);
    if (typeof o.evidence !== "string") die(`ci-pass needs --evidence "…": what shows it passed (the drill's report, the published version)`);
    const evidence = ctx.env.FACTORY_CI_EVIDENCE === "loop" ? autoIds(T, o.evidence as string) : checkText(T, "--evidence", o.evidence as string);
    const units = ciUnits(T, g);
    // A run covers what was done when it started: a unit finished during it makes CI stale again.
    const run = g.ci!.running?.by === ctx.TAG && claimAlive(T, g.ci!.running) ? g.ci!.running : null;
    const at = run?.at || now();
    const steps = typeof o.steps === "string" ? list(o.steps) : ciSteps(T, g);
    for (const s of steps) if (!(g.ci!.steps || []).includes(s)) die(`--steps ${s}: ${g.title}'s CI has no such step (${(g.ci!.steps || []).join(", ")})`);
    const fixed = ciFixPassed(T, g, at, steps);
    const done = units.filter((u) => derive(T, u).s === "done" && (!run || !(u.record!.at > run.at))).map((u) => u.id);
    const open = units.filter((u) => !done.includes(u.id) && u.record?.state !== "dropped").map((u) => u.id);
    g.ci!.passed = { commit: ciCommit(T, g, o), at, by: ctx.TAG, evidence, steps, done, open, cmds: ciCmds(T, g, steps), ...secsOf(o) };
    delete g.ci!.failed; delete g.ci!.running; delete g.ci!.cut;
    T.dirty.add("group:" + g.id); log(T, "ci-pass", null, `${g.title}: CI passed (${g.ci!.passed.steps.join(", ")})`);
    console.log(`${g.title}: CI passed at ${short(g.ci!.passed.commit)}${fixed ? `. ${fixed}` : ""}`);
    return 0;
  });
};
C["ci-fail"] = (a) => {
  const o = parseArgs(a);
  return mutate((T) => {
    const g = ciGroup(T, o._[0]);
    if (typeof o.evidence !== "string") die(`ci-fail needs --evidence "…": which step failed and how`);
    const evidence = ctx.env.FACTORY_CI_EVIDENCE === "loop" ? autoIds(T, o.evidence as string) : checkText(T, "--evidence", o.evidence as string);
    const step = str(o.step) ?? null;
    if (step && !(g.ci!.steps || []).includes(step)) die(`--step ${step}: ${g.title}'s CI has no such step (${(g.ci!.steps || []).join(", ")})`);
    const commit = ciCommit(T, g, o);
    const was = g.ci!.failed;   // the failure a done ci-fix was for
    const ran = g.ci!.running?.at;   // when this run started
    g.ci!.failed = { commit, at: now(), by: ctx.TAG, step: step || undefined, evidence, cmds: ciCmds(T, g, ciSteps(T, g)), ...(str(o.log) ? { log: str(o.log), host: ctx.HOST } : {}), ...secsOf(o) };
    delete g.ci!.running; delete g.ci!.cut;
    T.dirty.add("group:" + g.id); log(T, "ci-fail", null, `${g.title}: CI failed: ${evidence}`);
    const fix = step ? ciFixUnit(T, g, step, commit, evidence, str(o.log) ?? null, was, ran) : "";
    console.log(`${g.title}: CI broken. ${fix || "It's tried again once main moves and 6 hours pass, or now with `just tracker ci-retry " + g.id + "`."}`);
    return 0;
  });
};
// The due CI this lane runs next (the loop calls it before \`next\`, so CI comes first).
// --claim records it running and takes its group's lease, in one push.
C["ci-next"] = (a) => {
  const o = parseArgs(a);
  const group = o.group as string | undefined;   // as given: a bare --group matches no group
  const out = (T: State, p: CiPick, lease = false) => {
    if (p.code !== 0) { if (o.json) console.log(JSON.stringify({ code: p.code, why: p.why, wait: p.wait, uses: p.uses, start: p.start })); else console.error(p.why); return p.code; }
    const g = T.groupById.get(p.group.id)!, plan = ciPlan(T, g);
    if (o.json) console.log(JSON.stringify({ code: 0, group: g.id, title: g.title, data: ciData(T, g), new_lease: lease, start: ciStartUses(T, g, plan), steps: plan }));
    else console.log(`${g.title} (${g.id}): CI ${o.claim ? "running" : "due"}. Steps: ${plan.map((x) => `${x.step} (${x.cmd})`).join("; ")}`);
    return 0;
  };
  if (!o.claim) { const T = load(); return out(T, ciPick(T, group)); }
  let lease = false, q: CiPick;
  try {
    q = mutate((T) => {
      lease = false;
      const p = ciPick(T, group);
      if (p.code !== 0) return p;
      ciRunRecord(T, p.group);
      const dg = ciData(T, p.group);
      if (dg && !liveLease(T, dg)) { takeLease(T, dg); lease = true; }
      return p;
    }, { strict: true });
  } catch (e) {
    if (!(e instanceof NetError)) throw e;
    if (o.json) console.log(JSON.stringify({ code: 1, why: e.message, wait: true })); else console.error(e.message);
    return 1;
  }
  return out(load(), q, lease);
};
// The loop claimed CI it couldn't start (no room for the data, a lock, pause asap): it isn't
// running after all, and a lease the claim took goes back too (--release-lease: one taken earlier).
// --cut "<why>" [--step s]: the run had started and was cut off (pause asap, the lane stopping):
// kept, so the morning summary and the view can say so; due again as before.
C["ci-unclaim"] = (a) => mutate((T) => {
  const o = parseArgs(a);
  const g = ciGroup(T, o._[0]);
  const r = g.ci!.running;
  if (!r || r.by !== ctx.TAG) die(`${g.title}'s CI isn't running in this session (${ctx.TAG})`);
  delete g.ci!.running;
  const cut = str(o.cut);
  if (o.cut !== undefined && !cut) die(`--cut needs a reason ("paused asap", "the lane stopped")`);
  const step = str(o.step);
  if (step && !(g.ci!.steps || []).includes(step)) die(`--step ${step}: ${g.title}'s CI has no such step (${(g.ci!.steps || []).join(", ")})`);
  if (cut) g.ci!.cut = { at: r!.at, by: r!.by, host: r!.host, ...(step ? { step } : {}), why: cut };
  T.dirty.add("group:" + g.id); log(T, "ci-unclaim", null, cut ? `${g.title}: CI cut off${step ? ` at ${step}` : ""}: ${cut}` : `${g.title}: CI given back unstarted`);
  const dg = ciData(T, g), l = dg && leaseOf(T, dg);
  const others = [...T.byId.values()].some((x) => dataGroup(T, x) === dg && x.record?.state === "claimed" && x.record.host === ctx.HOST && claimAlive(T, x.record));
  if (l && l.host === ctx.HOST && (l.by === ctx.TAG || o["release-lease"]) && !others) dropLease(T, dg!, o["release-lease"] ? "no room here for its data" : "its CI was given back");
  return 0;
});
C["ci-retry"] = (a) => mutate((T) => {
  const g = ciGroup(T, a[0]);
  if (!g.ci!.failed) die(`${g.title}'s CI isn't broken (${ciText(T, g)})`);
  g.ci!.failed!.retry = g.ci!.failed!.at;
  T.dirty.add("group:" + g.id); log(T, "ci-retry", null, `${g.title}: CI to be tried again`);
  T._memo = null;
  console.log(`${g.title}: ${ciText(T, g)}`);
  return 0;
});
// A group in another group's shared ci-fix whose failure has another cause leaves it for a fix of its own.
C["ci-split"] = (a) => mutate((T) => {
  const g = ciGroup(T, a[0]);
  const out = ciSplit(T, g);
  if (!out) die(`${g.title}'s CI failure isn't in another group's open ci-fix (${ciText(T, g)})`);
  T.dirty.add("group:" + g.id); T._memo = null;
  console.log(`${g.title}: split off. ${out}`);
  return 0;
});
C.publish = (a) => {
  const v = a[0];
  if (!v) { console.log(`publishing is ${publishing(load()) ? "on" : "off"}`); return 0; }
  if (!["on", "off"].includes(v)) die("usage: publish [on|off]");
  return mutate((T) => {
    T.project.publish = v;
    T.dirty.add("project"); log(T, "publish", null, `publishing ${v}`);
    console.log(`publishing ${v}${v === "off" ? ": CI skips steps that ship" : ": groups whose last pass skipped a step that ships are stale again"}`);
    return 0;
  });
};
// Work outside a group changed what its build makes (shared code, a tool): its CI goes stale as for
// a unit of its own finishing, with the why shown. The latest touch is kept.
// (The loop's evidence is a command's output, so bare IDs in it are written as {unit:…}.)
const whyText = (T: State, why: string) => (ctx.env.FACTORY_CI_EVIDENCE === "loop" ? autoIds(T, why) : checkText(T, "--why", why));
C["ci-touch"] = (a) => {
  const o = parseArgs(a);
  return mutate((T) => {
    const g = ciGroup(T, o._[0]);
    const why = str(o.why)?.trim() || die(`ci-touch needs --why "…": what changed outside the group (shared code changed: src/x.py)`);
    ciTouch(T, g, whyText(T, why), str(o.commit));
    console.log(`${g.title}: ${ciText(T, g)}`);
    return 0;
  });
};
// The ci.affected hook's bookkeeping (the loop's). No arguments: --json gives the hook's command and
// the last code commit it covered. <new> --touches F: one write that touches each group F names (a
// line "<group>\t<why>"; one with no CI, or no such group, is skipped and said) and records <new>
// as covered, unless what's recorded is already past it (another machine got further).
C["ci-affected"] = (a) => {
  const o = parseArgs(a), nw = o._[0];
  if (!nw) {
    const T = load(), cmd = T.project.ci?.affected || null, at = T.project.ci_affected_at || null;
    if (o.json) console.log(JSON.stringify({ cmd, at }));
    else console.log(cmd ? `ci.affected: ${cmd}\ncovered up to: ${at ? short(at) : "nothing yet (the first run records main's code commit)"}` : "no ci.affected in tracker/project.json");
    return 0;
  }
  const f = str(o.touches);
  const lines = f ? fs.readFileSync(f, "utf8").split("\n").map((l) => l.replace(/\r$/, "")).filter((l) => l.trim()) : [];
  return mutate((T) => {
    const out: string[] = [], skipped: string[] = [], byWhy = new Map<string, string[]>();
    for (const l of lines) {
      const [id, ...rest] = l.split("\t"), why = whyText(T, rest.join(" ").trim() || "a change outside the group");
      const g = T.groupById.get(id.trim());
      if (!g?.ci) { skipped.push(`${id.trim()} (${g ? "no CI" : "no such group"})`); continue; }
      ciTouch(T, g, why, nw, true);
      out.push(g.title);
      byWhy.set(why, [...(byWhy.get(why) || []), g.title]);
    }
    for (const [why, titles] of byWhy) log(T, "ci-touch", null, `${titles.join(", ")}: CI touched: ${why}`);
    const cur = T.project.ci_affected_at;
    const behind = cur && cur !== nw && git(["-C", ctx.SDIR, "merge-base", "--is-ancestor", nw, cur]).status === 0;
    if (!behind) { T.project.ci_affected_at = nw; T.dirty.add("project"); }
    console.log(`${out.length ? `CI touched: ${out.join(", ")}` : "no group's CI touched"}${skipped.length ? `; skipped: ${skipped.join(", ")}` : ""}${behind ? `; covered already up to ${short(cur)}` : `; covered up to ${short(nw)}`}`);
    return 0;
  });
};
// The checks before a unit lands (project.json ci.land), for the loop: --json gives each command
// with {group} filled in and its timeout (minutes), in the order they run, the groups skipped and
// why, and when the unit's round began; or why there's none.
C["ci-land"] = (a) => {
  const o = parseArgs(a);
  const T = load(), u = resolve(T, o._[0]), p = ciLand(T, u);
  if (o.json) { console.log(JSON.stringify(p)); return 0; }
  const skips = p.skipped.map((x) => x.why).join("; ");
  for (const c of p.checks) console.log(`${c.cmd} (${c.timeout} min; FACTORY_UNIT=${u.id} FACTORY_UNIT_SINCE=${p.since})`);
  if (!p.checks.length) console.log(`none: ${p.why ?? skips}`);
  else if (skips) console.log(`skipped: ${skips}`);
  return 0;
};
