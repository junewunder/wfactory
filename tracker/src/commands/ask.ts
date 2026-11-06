// Questions for the owner, their answers, gates, and decisions.
import { ctx } from "../ctx.ts";
import { load, log, mutate, touch } from "../store.ts";
import { die, keySlug, list, now, overlap, parseArgs, plural, slugify, str, strs, type Args } from "../text.ts";
import { checkText, findD, findQ, isOpen, matches, name, resolve, selected } from "../names.ts";
import { canWait, decisionText, effectOn, EFFECTS, hasEffects, waitingOn } from "../cards.ts";
import { derive, SETTLED } from "../status.ts";
import { decisionParks, freedText, inForce, parseUntil, runEnd, when } from "../decisions.ts";
import { postponedBy } from "../postpone.ts";
import { C } from "./registry.ts";
import type { Decision, Option, Question, Unit } from "../types.ts";

C.ask = (a) => {
  const o = parseArgs(a, ["option", "blocks", "scope", "parks"]);
  return mutate((T) => {
    const title = typeof o.title === "string" ? o.title.trim() : die('ask needs --title "…?": the question, in plain words');
    if (!title.endsWith("?")) die("the title is the question itself and ends with ?");
    checkText(T, "--title", title);
    const context = typeof o.context === "string" ? checkText(T, "--context", o.context) : die('ask needs --context "…": what it is about, and why it matters (refer to units as {unit:<id>})');
    checkText(T, "--example", o.example);
    const options: Option[] = strs(o.option).map((s) => {
      const parts = String(s).split("|").map((x) => x.trim()), fx: { drops?: string[]; releases?: string[] } = {};
      for (let m; parts.length > 3 && (m = parts.at(-1)!.match(/^(drops|releases):\s*(.*)$/i)); parts.pop()) {
        const k = m[1].toLowerCase() as "drops" | "releases";
        if (fx[k]) die(`--option "${s}": say ${k}: once, with every unit in it`);
        fx[k] = list(m[2]).map((x) => {
          if (x.includes(":") || x.includes("*")) { if (!selected(T, [x]).length) die(`--option "${s}": ${k}: ${x} matches no unit`); return x; }
          return (resolve(T, x, { soft: true }) || die(`--option "${s}": ${k}: no such unit ${x}`)).id;
        });
        if (!fx[k]!.length) die(`--option "${s}": ${k}: names no unit`);
      }
      const [key, label, ...rest] = parts;
      if (/^(drops|releases):/i.test(rest[0] || "")) die(`--option "${s}": say what the option changes before its drops: or releases: field`);
      if (!key || !label || !rest.join("|")) die(`--option "${s}": write it as "key | label | what this option changes", optionally followed by "| drops: <units>" and "| releases: <units>"`);
      checkText(T, `--option ${key}`, parts.join(" | "));
      const both = selected(T, fx.drops || []).filter((u) => selected(T, fx.releases || []).includes(u));
      if (both.length) die(`--option ${key} both drops and releases ${both.map((u) => name(u)).join(", ")}`);
      return { key, label, changes: rest.join(" | "), ...fx };
    });
    if (options.length < 2) die("give at least two --option, each saying what it changes");
    // --parks <key>: that option puts the work off ("not yet", "leave it for later"). Answered so,
    // what the question blocks is parked rather than released, and stays so (postpone.ts).
    for (const k of strs(o.parks).flatMap(list)) {
      const op = options.find((x) => x.key === k) || die(`--parks ${k} isn't one of the options (${options.map((x) => x.key).join(", ")})`);
      op.parks = true;
    }
    const dflt = typeof o.default === "string" ? o.default : die("ask needs --default <key>: what agents assume if the owner says take the defaults");
    if (!options.some((x) => x.key === dflt)) die(`--default ${dflt} isn't one of the options (${options.map((x) => x.key).join(", ")})`);
    const blocks = strs(o.blocks).flatMap(list);
    if (!blocks.length) die("ask needs --blocks <unit or selector>: what can't go on until the owner answers");
    for (const b of blocks) if (!b.includes(":") && !b.includes("*") && !resolve(T, b, { soft: true })) die(`--blocks ${b}: no such unit`);
    const waiting = selected(T, blocks).filter((u) => canWait(T, u));
    for (const op of options) for (const k of EFFECTS) for (const x of op[k] || []) if (!x.includes(":") && !x.includes("*") && !waiting.includes(T.byId.get(x)!)) die(`--option ${op.key} ${k} ${name(T.byId.get(x))}, which the question doesn't block: add it to --blocks`);
    for (const op of options.filter((x) => hasEffects(x) && !x.parks)) {
      const has = new Set(EFFECTS.flatMap((k) => selected(T, op[k] || [])));
      const miss = waiting.filter((u) => !has.has(u));
      if (miss.length) die(`--option ${op.key} drops or releases units, so it has to say which for every unit the question blocks; it leaves out ${miss.slice(0, 6).map((u) => name(u)).join(", ")}${miss.length > 6 ? ` and ${miss.length - 6} more` : ""}`);
    }
    const scope = strs(o.scope).flatMap(list);
    // The owner already put this unit off: asking again (with --force too) only asks them twice.
    // (The units it names by ID, and the one this session holds: a selector that takes in a put-off
    // unit doesn't stop a question about the rest.)
    const named = [...new Set([...blocks.filter((b) => !b.includes(":") && !b.includes("*")).map((b) => resolve(T, b)),
      ...selected(T, blocks).filter((u) => u.record?.state === "claimed" && u.record.by === ctx.TAG)])];
    const off = named.map((u) => [u, postponedBy(T, u)] as const).filter(([, d]) => d);
    if (off.length) die(`${off.map(([u, d]) => `  ${name(u)}: ${decisionText(T, d!)}`).join("\n")}\nThe owner put this off, above, so nothing was asked. Hand the unit back (\`just unclaim <id>\`) and stop: it stays parked until the owner unparks it.`);
    if (!o.force) {
      const hitD = T.decisions.filter((d) => inForce(T, d) && overlap(d.title + " " + (d.question ? findQ(T, d.question)?.title || "" : ""), title) >= 0.5);
      if (hitD.length) die(`${hitD.map((d) => "  " + decisionText(T, d)).join("\n")}\nA decision above may already answer this, so nothing was asked. If it does, follow it; if it really doesn't, ask again with --force.`);
      const hitQ = T.questions.filter((q) => isOpen(q) && overlap(q.title, title) >= 0.5);
      if (hitQ.length) die(`${hitQ.map((q) => "  " + name(q)).join("\n")}\nThe owner already has a question like this, above, so nothing was asked. Add your unit to it instead (just block <unit> --on ${hitQ[0].id}), or ask again with --force if it's really different.`);
    }
    let id = typeof o.id === "string" ? "q/" + slugify(o.id.replace(/^q\//, ""), 48) : "q/" + keySlug(title);
    for (let n = 2; T.questions.some((q) => q.id === id); n++) id = id.replace(/-\d+$/, "") + "-" + n;
    // The unit the asking session holds, so the answer is tied to it even once --blocks no longer matches it.
    const mine = selected(T, blocks).find((u) => u.record?.state === "claimed" && u.record.by === ctx.TAG);
    const q: Question = { id, title, context, example: str(o.example), options, default: dflt, scope: scope.length ? scope : undefined, blocks, asked: { at: now(), by: ctx.TAG, host: ctx.HOST, ...(mine ? { unit: mine.id } : {}) }, answer: null };
    T.questions.push(q);
    T.dirty.add("questions");
    for (const u of selected(T, blocks)) if (u.record?.state === "claimed" && u.record.by === ctx.TAG) { u.record = { state: "blocked", on: id, by: ctx.TAG, at: now() }; touch(T, u); }
    log(T, "ask", null, `asked the owner: ${title}`, { more: { q: id } });
    console.log(`asked: ${name(q)}\nIt blocks ${plural(selected(T, blocks).length, "unit")}. The loop moves on to other work; stop this unit here.`);
    return 0;
  });
};

// --until T or --for-run: when a decision stops holding (a day, a night, a run the owner named).
function untilOf(o: Args) {
  if (o["for-run"] && o.until !== undefined) die("--until and --for-run both say when it ends: give one");
  if (o["for-run"]) return runEnd(ctx.env);
  return o.until === undefined ? undefined : parseUntil(str(o.until) || die("--until needs a date or time: 2026-10-29, 2026-10-29T18:00 or 18:00"));
}

C.answer = (a) => {
  const o = parseArgs(a);
  return mutate((T) => {
    const q = findQ(T, o._[0] || die("usage: answer <q> <key> [--note …]"));
    const key = o._[1] || die(`which answer? ${(q.options || []).map((x) => `${x.key}) ${x.label}`).join("; ")}; or "other" with --note`);
    if (q.withdrawn) die(`${name(q)} was withdrawn (${q.withdrawn.why})`);
    if (q.answer) die(`${name(q)} was already answered (${q.answer.key}). To change it, \`just decide --replaces ${q.answer.decision} …\`.`);
    const op = (q.options || []).find((x) => x.key === key);
    if (!op && key !== "other") die(`"${key}" isn't an option (${(q.options || []).map((x) => x.key).join(", ")}, or other --note "…")`);
    if (key === "other" && (!o.note || o.note === true)) die('"other" needs --note "…" saying what the owner wants');
    checkText(T, "--note", o.note);
    const note = str(o.note);
    const via = str(o.via) ?? ctx.TAG;
    const until = untilOf(o);
    let did = q.id.replace(/^q\//, "d/");
    for (let n = 2; T.decisions.some((d) => d.id === did); n++) did = did.replace(/-\d+$/, "") + "-" + n;
    const d: Decision = { id: did, title: str(o.title) ?? `${q.title.replace(/\?$/, "")}: ${op ? op.label : note}`, why: note || (op ? op.changes : ""), by: "owner", at: now(), question: q.id, scope: q.scope, via, ...(until ? { until } : {}), ...(op?.parks ? { postpones: true as const } : {}) };
    const waiting = waitingOn(T, q);
    T.decisions.push(d);
    q.answer = { key, note, by: "owner", via, at: now(), decision: did };
    T.dirty.add("questions"); T.dirty.add("decisions");
    const released: Unit[] = [], dropped: Unit[] = [], held: Unit[] = [], parked: Unit[] = [];
    // Put off: parked while the decision holds (an unpark, or the decision ending, brings them back).
    const park = (u: Unit) => { u.record = { state: "parked", why: `put off by the owner's answer to {q:${q.id.replace(/^q\//, "")}}: ${op!.label}`, decision: did, by: ctx.TAG, at: now() }; touch(T, u); parked.push(u); };
    // What a "later" parks: the asking unit, and those the question blocks by a selector other than
    // '*' (one answer never parks everything). The rest waiting on it are released.
    const parkable = (u: Unit) => u.id === q.asked?.unit || (u.record?.state === "blocked" && u.record.on === q.id) || (q.blocks || []).some((b) => b !== "*" && matches(T, b, u));
    const release = (u: Unit) => { if (u.record?.state === "blocked" && u.record.on === q.id) { u.record = undefined; touch(T, u); } released.push(u); };
    if (op?.parks && !hasEffects(op)) for (const u of waiting) { if (parkable(u)) park(u); else release(u); }
    else if (!hasEffects(op)) {
      for (const u of T.byId.values()) if (u.record?.state === "blocked" && u.record.on === q.id) { u.record = undefined; touch(T, u); released.push(u); }
      for (const u of selected(T, q.blocks || [])) if (!released.includes(u)) released.push(u);
    } else {
      // The chosen option says what happens; nothing else is released.
      const drops = effectOn(T, q, op!, "drops", waiting), rel = effectOn(T, q, op!, "releases", waiting);
      const why = `the owner's answer to "${q.title}": ${op!.label}`;
      for (const u of drops) { u.record = { state: "dropped", why, by: ctx.TAG, at: now() }; touch(T, u); dropped.push(u); }
      for (const u of rel) { if (u.record?.state === "blocked" && u.record.on === q.id) { u.record = undefined; touch(T, u); } released.push(u); }
      for (const u of waiting.filter((x) => !drops.includes(x) && !rel.includes(x))) {
        if (op!.parks) { if (parkable(u)) park(u); else release(u); continue; }
        u.record = { state: "blocked", why: `${why}, which doesn't say what happens to this unit: reopen or drop it`, by: ctx.TAG, at: now() };
        touch(T, u); held.push(u);
      }
    }
    // Exactly what it put off, for postpone.ts: never worked out again from selectors.
    if (op?.parks) d.parked = parked.map((u) => u.id);
    log(T, "answer", null, `the owner answered "${q.title}": ${op ? op.label : note}`, { actor: "owner", more: { q: q.id, d: did, via } });
    T._memo = null;
    const freed = released.filter((u) => ["ready", "waiting", "resource"].includes(derive(T, u).s));
    const few = (us: Unit[]) => (us.length ? ": " + us.slice(0, 6).map((u) => name(u)).join(", ") + (us.length > 6 ? ` and ${us.length - 6} more` : "") : "");
    console.log(`recorded: ${until ? decisionText(T, d) : name(d)}\nReleased ${plural(freed.length, "unit")}${few(freed)}`);
    if (parked.length) console.log(`Parked, as the owner put ${parked.length === 1 ? "it" : "them"} off: ${plural(parked.length, "unit")}${few(parked)}; \`just tracker unpark <id>\` brings one back`);
    if (dropped.length) console.log(`Dropped ${plural(dropped.length, "unit")}${few(dropped)}`);
    if (held.length) console.log(`Stuck, because the answer doesn't say what happens to them: ${plural(held.length, "unit")}${few(held)}`);
    return 0;
  });
};

C.withdraw = (a) => {
  const o = parseArgs(a);
  return mutate((T) => {
    const q = findQ(T, o._[0] || die('usage: withdraw <q> --why "…"'));
    if (!isOpen(q)) die(`${name(q)} is already closed`);
    const why = typeof o.why === "string" ? checkText(T, "--why", o.why) : die('withdraw needs --why "…" (e.g. "re-asked as q/…")');
    q.withdrawn = { at: now(), by: ctx.TAG, why };
    T.dirty.add("questions");
    for (const u of T.byId.values()) if (u.record?.state === "blocked" && u.record.on === q.id) {
      const to = why.match(/\bq\/[\w-]+/)?.[0];
      u.record = to && T.questions.some((x) => x.id === to && isOpen(x)) ? { ...u.record, on: to } : undefined;
      touch(T, u);
    }
    log(T, "withdraw", null, `withdrew the question "${q.title}": ${why}`, { more: { q: q.id } });
    console.log(`withdrew ${name(q)}`);
    return 0;
  });
};

C.pass = (a) => {
  const o = parseArgs(a);
  return mutate((T) => {
    const u = resolve(T, o._[0]);
    if (u.kind !== "gate") die(`${name(u)} isn't a gate`);
    checkText(T, "--note", o.note);
    // A gate passed before what it needs is done leaves those waiting on the owner forever, with
    // the gate counted as over (the opening's gate before the probe's review). Gates that need
    // every unit of their group (a review) show to the owner only once those are done.
    const open = [...(T.groupOf.get(u.id)?.needs || []).filter((n) => n !== u.id), ...(u.needs || [])]
      .map((n) => T.byId.get(n) || n).filter((x) => typeof x === "string" || !SETTLED.has(derive(T, x).s));
    if (open.length) {
      const which = open.map((x) => typeof x === "string" ? `  ${x}: no such unit` : `  ${name(x)}: ${derive(T, x).why || derive(T, x).s}`).join("\n");
      if (!o.force) die(`${which}\n${name(u)} needs ${open.length > 1 ? `these ${open.length}, above, which aren't` : "the unit above, which isn't"} done; nothing was passed. Pass, finish or drop ${open.length > 1 ? "them" : "it"} first, or pass with --force to leave ${open.length > 1 ? "them" : "it"} open.`);
      console.error(`${which}\nwarning: passed with --force while ${plural(open.length, "unit")} it needs ${open.length > 1 ? "aren't" : "isn't"} done, above.`);
    }
    u.record = { state: "done", by: "owner", via: ctx.TAG, at: now(), evidence: str(o.note) };
    touch(T, u); log(T, "pass", u.id, `the owner passed the gate ${u.title}${o.note ? ": " + o.note : ""}`, { actor: "owner" });
    T._memo = null;
    const after = [...T.byId.values()].filter((x) => (x.needs || []).includes(u.id) && derive(T, x).s === "ready");
    console.log(`${name(u)} → passed. Now ready: ${after.length ? after.map((x) => name(x)).join(", ") : "nothing new"}`);
    return 0;
  });
};

C.decide = (a) => {
  const o = parseArgs(a, ["scope"]);
  return mutate((T) => {
    const title = typeof o.title === "string" ? o.title : die('decide needs --title "…": the decision as a statement');
    const why = typeof o.why === "string" ? o.why : die('decide needs --why "…"');
    checkText(T, "--title", title); checkText(T, "--why", why);
    if (o.replaces && !findD(T, String(o.replaces))) die(`no decision ${o.replaces}`);
    let id = "d/" + slugify(title, 48);
    for (let n = 2; T.decisions.some((d) => d.id === id); n++) id = id.replace(/-\d+$/, "") + "-" + n;
    // A decision without a scope reaches no unit's card (only `decisions <words>` finds it), which
    // nobody recording one expects: say which units it's for.
    // A replacement keeps the scope of what it replaces unless given its own.
    const replaces = str(o.replaces);
    let scope = strs(o.scope).filter((x): x is string => typeof x === "string").flatMap(list);
    if (!scope.length && replaces) scope = findD(T, replaces)!.scope || [];
    if (!scope.length) die(`decide needs --scope: the units it applies to (a unit ID, a glob, group:<g>, tag:<t>), or --scope '*' for every unit. A decision shows on the cards of the units in its scope, and reaches the sessions working them; one without a scope reaches none.`);
    // --until (or --for-run): it holds until then, then leaves the cards.
    const until = untilOf(o);
    const parks = decisionParks(T);
    const d: Decision = { id, title, why, by: o.by === "owner" ? "owner" : ctx.TAG, at: now(), scope, replaces: replaces ? findD(T, replaces)!.id : undefined, until };
    T.decisions.push(d); T.dirty.add("decisions");
    log(T, "decide", null, `decided: ${title}`, { more: { d: id } });
    console.log(`recorded: ${decisionText(T, d)}`);
    // --park: the units in its scope are set aside while it holds ("no uploads today"), and come
    // back by themselves when it lapses, is replaced or retired. One in progress gets it in its
    // inbox instead; done, dropped and already parked ones are left as they are.
    if (o.park) {
      T._memo = null;
      // Only units with no record of their own: a park would overwrite a block's why, a
      // regression, a question's link or kept work, and they'd come back without it.
      const us = selected(T, scope).filter((u) => u.kind !== "gate" && !["done", "dropped", "merging", "parked", "review"].includes(derive(T, u).s));
      // (A park whose decision ended is no record: it has already lifted.)
      const own = (u: Unit) => !!u.record && !(u.record.state === "parked" && u.record.decision);
      const busy = us.filter(own);
      const park = us.filter((u) => !own(u));
      for (const u of park) { u.record = { state: "parked", why: `while ${title}`, decision: id, by: d.by, at: now() }; touch(T, u); }
      if (park.length) log(T, "park", null, `parked ${plural(park.length, "unit")} while ${title}`, { more: { d: id } });
      console.log(`Parked ${plural(park.length, "unit")}${park.length ? ": " + park.slice(0, 6).map((u) => name(u)).join(", ") + (park.length > 6 ? ` and ${park.length - 6} more` : "") : ""}; ${park.length === 1 ? "it comes" : "they come"} back when the decision ${until ? `lapses (${when(until)}) or ` : ""}is replaced or retired.`);
      if (busy.length) console.log(`Not parked, as each is in progress, interrupted, broken, stuck or waiting on a question (the decision is on their cards, and reaches a session at work): ${busy.map((u) => `${name(u)}: ${derive(T, u).s}`).join(", ")}`);
    }
    const freed = freedText(T, parks);
    if (freed) console.log(freed);
    return 0;
  });
};

C.decisions = (a) => {
  const o = parseArgs(a);
  const T = load();
  let ds = T.decisions.filter((d) => o.all || inForce(T, d));
  // --for narrows the list above to the unit's scope, so --all still keeps the replaced ones.
  if (o.for) { const u = resolve(T, String(o.for)); ds = ds.filter((d) => (d.scope || []).some((s) => matches(T, s, u))); }
  const q = o._.join(" ");
  if (q) ds = ds.map((d) => [d, overlap(q, `${d.title} ${d.why} ${d.question ? T.questions.find((x) => x.id === d.question)?.title || "" : ""}`)] as const).filter(([, s]) => s > 0).sort((x, y) => y[1] - x[1]).map(([d]) => d);
  if (!ds.length) { console.log(q ? `No decision matches "${q}".` : "No decisions yet."); return 0; }
  // With words, ds is best match first: print the best 40. Without, it's in recording order: the newest 40, newest first.
  for (const d of q ? ds.slice(0, 40) : ds.slice(-40).reverse()) console.log("- " + decisionText(T, d, !!q || !!o.for));
  return 0;
};
