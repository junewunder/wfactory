// The rule that settles a set-aside copy, with no unit filed and no session spent: a set whose
// units have all landed on main (by the tracker's record of the landing) or are dropped is removed,
// with a line for the morning summary; one that is only nearly so stays (done but not landed, done
// by hand, reopened since, one unit of two landed, a unit the tracker doesn't have, a tracker that
// can't say, a set without the store's own record of whose it is); a set nothing accounts for stays
// and is reported at the end of each run of the lanes it outlasts, never filed as a unit; and the
// units an older version filed to sort sets are dropped. Run: node --test test/store/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { has, hasnt, readOr, cmd, chomp, ROOT } from "../lib/index.ts";
import { storeFactory } from "./factory.ts";
import { EVENTS_SUMMARY, EVENTS_WAKE } from "../../runtime/src/fleet-help.ts";

const f = storeFactory(["a"]);
const { add, store, asides, group, write } = f;
const [a] = f.lanes;
const ok = (args: string[], env: NodeJS.ProcessEnv = {}) => { const r = store(a, args, env); assert.equal(r.code, 0, `store.sh ${args.join(" ")}: ${r.stderr}`); return r; };
const git = (...args: string[]) => cmd("git", args, { cwd: a.dir, env: a.envWith() });
const G = (x: string) => a.at(`work/.store/groups/${x}`);
const state = (id: string) => chomp(a.run("factory/tracker", ["state", id]).stdout);
const card = (id: string) => a.run("factory/tracker", ["show", id]).stdout;
// The set holding a unit's outputs ("" if none), and its kind.
const setOf = (u: string) => asides(a, u.split("/")[0]).find((x) => readOr(path.join(x, ".units")).split("\n").includes(u)) ?? "";
const kind = (u: string) => chomp(readOr(path.join(setOf(u), ".kind")));
// The events of one kind about a group's copy.
const events = (k: string, g: string) => a.events().split("\n").filter((l) => l.split("\t")[3] === k && (l.split("\t")[4] ?? "").startsWith(`${g}'s `));
const pid = String(process.pid);

// A group of its own for each case (two sets of one group made in the same second would share a
// folder), with data on the store from a merged unit first.
const GROUPS = ["r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8", "r9", "r10", "r11", "r12", "r13"];
for (const g of GROUPS) { group(g); add(`${g}/r0`, "--reads", "none"); }
a.loop(["--max", String(GROUPS.length), "--hours", "0.1"]);
const B = (g: string) => ({ FACTORY_BRANCHES: "1", FACTORY_TAG: `s-${g}` });
// A unit claimed by a lane's session here, on its branch, its outputs written into the copy.
function claimed(u: string, lane = "") {
  const g = u.split("/")[0];
  add(u, "--reads", "none");
  if (!fs.existsSync(G(`${g}.ready`))) { a.run("factory/tracker", ["lease", "take", g]); ok(["take", g]); }
  a.setup(["claim", u], { ...B(g), FACTORY_TAG: `s-${u.replace("/", "-")}` });
  git("branch", "-f", `unit/${u}`, "HEAD");
  ok(["dirty", g, u, pid]);
  if (lane) fs.renameSync(G(`${g}.dirty.a-lane1`), G(`${g}.dirty.${lane}`));
  fs.appendFileSync(a.at(`work/out/${g}/log.txt`), `${u} on a\n`);
}
const tag = (u: string) => ({ FACTORY_BRANCHES: "1", FACTORY_TAG: `s-${u.replace("/", "-")}` });
// u's session ends unfinished: the store's copy is put back over its outputs.
const unfinished = (u: string) => { claimed(u); ok(["end", u.split("/")[0], u, "c"]); };
// u recorded done on its branch (merging), and its branch landed on main, as the loop records it.
const recordDone = (u: string) => a.setup(["done", u, "--evidence", "test"], tag(u));
const land = (u: string) => { if (state(u) !== "merging") recordDone(u); a.setup(["merged", "--branch", `unit/${u}`]); };
const sort = () => ok(["aside", "sort"]);
// A run of the lanes here, as the store sees one: a session ran, the lanes' looks, then their stop.
const run = () => { fs.writeFileSync(a.at("work/.store/ran"), ""); ok(["release-idle"]); ok(["leave"]); };

describe("a set whose units have landed or are dropped is removed", () => {
  test("an unfinished unit's outputs are set aside, for it", () => {
    unfinished("r1/u");
    assert.equal(kind("r1/u"), "unmerged");
  });
  test("  while it's unfinished, the set stays", () => { sort(); assert.notEqual(setOf("r1/u"), ""); });
  test("  no event says so before a run has gone by", () => { assert.deepEqual(events("store-aside-kept", "r1"), []); });
  test("  its branch landed on main: the next look removes the set", () => {
    land("r1/u");
    assert.equal(state("r1/u"), "done");
    sort();
    assert.equal(setOf("r1/u"), "");
  });
  test("  with a line for the morning summary saying whose outputs it held", () => {
    const [l = ""] = events("store-aside-removed", "r1");
    has(l, "it held the outputs of Unit u of r1 (r1/u), which has landed on main or been dropped since");
  });
  test("    how much, and how old", () => { assert.match(events("store-aside-removed", "r1")[0] ?? "", /\(1 files, \S+, set aside today\) was removed/); });
  test("a unit dropped: its set is removed too", () => {
    unfinished("r2/d");
    f.drop("r2/d");
    sort();
    assert.equal(`${setOf("r2/d")}|${events("store-aside-removed", "r2").length}`, "|1");
  });
  test("  and its card stops naming the set", () => { hasnt(card("r2/d"), "Set aside:"); });
});

describe("a set that is only nearly settled stays", () => {
  test("its unit recorded done, its branch not on main yet (merging)", () => {
    unfinished("r3/m");
    recordDone("r3/m");
    sort();
    assert.equal(`${state("r3/m")} ${kind("r3/m")}`, "merging unmerged");
  });
  test("  `store.sh aside` says what it waits for", () => { has(ok(["aside"]).stdout, "stays: it holds the outputs of Unit m of r3 (r3/m), done but not on main yet"); });
  test("  landed: removed", () => { land("r3/m"); sort(); assert.equal(setOf("r3/m"), ""); });
  test("its unit done by hand, with no branch landed", () => {
    unfinished("r4/h");
    a.setup(["reopen", "r4/h"]); a.setup(["done", "r4/h", "--evidence", "by hand"]);
    sort();
    assert.equal(`${state("r4/h")} ${kind("r4/h")}`, "done unmerged");
  });
  test("  saying so", () => { has(ok(["aside"]).stdout, "recorded done with no landing of its branch on main"); });
  test("its unit landed, then reopened since", () => {
    unfinished("r5/o");
    land("r5/o");
    a.setup(["reopen", "r5/o"]);
    sort();
    assert.equal(`${state("r5/o")} ${kind("r5/o")}`, "ready unmerged");
  });
  test("  and done again by hand: still not a landing", () => {
    a.setup(["done", "r5/o", "--evidence", "by hand"]);
    sort();
    assert.equal(`${state("r5/o")} ${kind("r5/o")}`, "done unmerged");
  });
  test("one unit of two landed", () => {
    // Two lanes' sessions on the group, both ending unfinished: the put-back takes both.
    claimed("r6/x", "a-lane2"); claimed("r6/y");
    ok(["end", "r6", "r6/y", "c"]);
    fs.renameSync(G("r6.dirty.a-lane2"), G("r6.dirty.a-lane1")); ok(["end", "r6", "r6/x", "c"]);
    assert.equal(chomp(readOr(path.join(setOf("r6/x"), ".units"))).split("\n").sort().join(" "), "r6/x r6/y");
    land("r6/x");
    sort();
    assert.equal(kind("r6/y"), "unmerged");
  });
  test("  the other landed too: removed, the line naming both", () => {
    land("r6/y");
    sort();
    assert.equal(setOf("r6/y"), "");
    has(events("store-aside-removed", "r6")[0] ?? "", "Unit x of r6 (r6/x)");
    has(events("store-aside-removed", "r6")[0] ?? "", "Unit y of r6 (r6/y), each landed on main or dropped since");
  });
  // Sets written by hand, as the store writes them, their unit landed: each lacks one thing.
  const X = (set: string, p: string) => a.at(`work/.store/aside/${set}/${p}`);
  const made = (set: string, k: string | null, units: string | null, from: string | null) => {
    write(X(set, "out/m.txt"), "mine\n");
    if (k !== null) write(X(set, ".kind"), `${k}\n`);
    if (units !== null) write(X(set, ".units"), units);
    if (from !== null) write(X(set, ".from"), from);
  };
  test("(a unit that landed, for the sets below)", () => {
    add("r7/l", "--reads", "none"); a.run("factory/tracker", ["lease", "take", "r7"]); a.setup(["claim", "r7/l"], tag("r7/l")); land("r7/l");
    assert.notEqual(chomp(a.run("factory/tracker", ["state", "r7/l", "--landed"]).stdout), "");
  });
  test("a set as the store makes one, its unit landed: removed (so the ones below differ only in what they lack)", () => {
    made("r7-20260101-000000", "unmerged", "r7/l\n", "r7/l\ts\tc\ta\n");
    sort();
    assert.ok(!fs.existsSync(X("r7-20260101-000000", "")));
  });
  test("a unit the tracker doesn't have", () => {
    made("r7-20260102-000000", "unmerged", "r7/nope\n", "r7/nope\ts\tc\ta\n");
    sort();
    assert.ok(fs.existsSync(X("r7-20260102-000000", "out/m.txt")));
  });
  test("a set with no record of where its outputs came from (.from)", () => {
    made("r7-20260103-000000", "unmerged", "r7/l\n", null);
    sort();
    assert.ok(fs.existsSync(X("r7-20260103-000000", "out/m.txt")));
  });
  test("one that names a unit and a mark with no unit", () => {
    made("r7-20260104-000000", "unmerged", "r7/l\n\n", "r7/l\ts\tc\ta\n");
    sort();
    assert.ok(fs.existsSync(X("r7-20260104-000000", "out/m.txt")));
  });
  test("one of a kind no rule removes (an older version's set to sort), though the unit it names landed", () => {
    made("r7-20260105-000000", "check", "r7/l\n", "r7/l\ts\tc\ta\n");
    sort();
    assert.ok(fs.existsSync(X("r7-20260105-000000", "out/m.txt")));
  });
  test("one without a kind", () => {
    made("r7-20260106-000000", null, "r7/l\n", "r7/l\ts\tc\ta\n");
    sort();
    assert.equal(`${fs.existsSync(X("r7-20260106-000000", "out/m.txt"))} ${chomp(readOr(X("r7-20260106-000000", ".kind")))}`, "true check");
  });
  test("a folder whose name isn't a set's", () => {
    made("r7-keep", "unmerged", "r7/l\n", "r7/l\ts\tc\ta\n");
    sort();
    assert.ok(fs.existsSync(X("r7-keep", "out/m.txt")));
  });
  test("a tracker that can't say what a unit is now", () => {
    const nostate = f.w.at("tracker-nostate.mjs");
    fs.writeFileSync(nostate, `if (process.argv[2] === "state") { console.error("tracker: can't reach origin"); process.exit(1); }\nawait import(${JSON.stringify(path.join(ROOT, "tracker/tracker.mjs"))});\n`);
    made("r7-20260107-000000", "unmerged", "r7/l\n", "r7/l\ts\tc\ta\n");
    ok(["aside", "sort"], { FACTORY_TRACKER: nostate });
    assert.ok(fs.existsSync(X("r7-20260107-000000", "out/m.txt")));
  });
  test("  and one that can't say whether it landed", () => {
    const noland = f.w.at("tracker-noland.mjs");
    fs.writeFileSync(noland, `if (process.argv[2] === "state" && process.argv.includes("--landed")) { console.error("tracker: can't reach origin"); process.exit(1); }\nawait import(${JSON.stringify(path.join(ROOT, "tracker/tracker.mjs"))});\n`);
    ok(["aside", "sort"], { FACTORY_TRACKER: noland });
    assert.ok(fs.existsSync(X("r7-20260107-000000", "out/m.txt")));
  });
  test("none of those raised an event at a look", () => { assert.deepEqual(events("store-aside-kept", "r7"), []); });
});

// Finished outputs in the copy when an unfinished unit's are put back can't be told apart: one set,
// never put back, removed once every unit it names has landed or is dropped.
describe("unfinished outputs mixed with a finished unit's", () => {
  test("a unit waiting to land and an unfinished one: one set, naming both", () => {
    claimed("r8/fin", "a-lane2"); recordDone("r8/fin");
    claimed("r8/un");
    ok(["end", "r8", "r8/un", "c"]);
    fs.renameSync(G("r8.dirty.a-lane2"), G("r8.dirty.a-lane1")); ok(["end", "r8", "r8/fin", "c"]);
    assert.equal(`${kind("r8/un")} ${chomp(readOr(path.join(setOf("r8/un"), ".units"))).split("\n").sort().join(" ")}`, "units r8/fin r8/un");
  });
  test("  its event says what becomes of it, and files no unit", () => {
    const [l = ""] = events("store-aside", "r8");
    has(l, "mixed with finished r8/fin work that hadn't reached the store");
    has(l, "removed once each of those units has landed or is dropped");
    hasnt(l, "a unit sorts it");
  });
  test("  the unfinished unit's card says its outputs aren't put back", () => { has(card("r8/un"), "They aren't put back: rebuild them"); });
  test("  the finished one landed, the other not: it stays", () => { land("r8/fin"); sort(); assert.equal(kind("r8/un"), "units"); });
  test("  both landed: removed", () => { land("r8/un"); sort(); assert.equal(setOf("r8/un"), ""); });
  test("a copy back already owed when the put-back comes: nothing accounts for all of it, so no rule removes it", () => {
    claimed("r9/un");
    fs.writeFileSync(G("r9.unsent"), ""); fs.writeFileSync(G("r9.retry"), "r9/r0\tc\t1\t0\n");
    ok(["end", "r9", "r9/un", "c"]);
    f.drop("r9/un");
    sort();
    assert.equal(kind("r9/un"), "check");
  });
});

// A copy down over a copy that wasn't all on the store: nothing says whose work it is.
describe("a set nothing accounts for is reported, never filed as a unit", () => {
  let set = "";
  test("a copy down over files the store doesn't have sets them aside", () => {
    a.run("factory/tracker", ["lease", "release", "r10"]);
    for (const x of ["json", "list", "mirror", "ready"]) fs.rmSync(G(`r10.${x}`), { force: true });
    write(a.at("work/out/r10/mine.txt"), "only here\n");
    a.setup(["lease", "take", "r10"]); ok(["take", "r10", "--new"]);
    [set = ""] = asides(a, "r10");
    assert.equal(chomp(readOr(path.join(set, ".kind"))), "check");
  });
  test("  its event says it stays, and that no session sorts it", () => {
    const [l = ""] = events("store-aside", "r10");
    has(l, "nothing recorded whose work all of it is, so it stays there: no session sorts it");
    hasnt(l, "a unit sorts it");
  });
  test("  no unit is filed for it: at once, at a look, or as the lanes stop", () => {
    sort(); run();
    assert.equal(`${fs.existsSync(path.join(set, ".unit"))} ${a.run("factory/tracker", ["show", "aside"]).code !== 0}`, "false true");
  });
  test("  the run it was made in ends: its own event was the line, no second one", () => { assert.deepEqual(events("store-aside-kept", "r10"), []); });
  test("  the next run ends with it still there: one line, saying what it holds and how old it is", () => {
    run();
    const ls = events("store-aside-kept", "r10");
    assert.equal(ls.length, 1);
    assert.match(ls[0], /is still there \(1 files, \S+, set aside today, in work\/\.store\/aside\/r10-[0-9-]+\): nothing recorded whose work it holds\. It costs no session, and nobody has to act on it; `just store aside drop r10-[0-9-]+` there removes it$/);
  });
  test("  two lanes stopping together, or a stop with no session between: no more lines", () => {
    ok(["leave"]); ok(["release-idle"]); ok(["leave"]);
    assert.equal(events("store-aside-kept", "r10").length, 1);
  });
  test("  a line each run it outlasts", () => { run(); assert.equal(events("store-aside-kept", "r10").length, 2); });
  test("  and it's still there, untouched", () => { assert.equal(readOr(path.join(set, "out/mine.txt")), "only here\n"); });
  test("  until someone drops it", () => { ok(["aside", "drop", path.basename(set)]); assert.deepEqual(asides(a, "r10"), []); });
});

describe("a kept set through runs of the lanes", () => {
  test("a set whose unit is parked isn't made one to sort, and gets no unit", () => {
    unfinished("r11/p");
    a.setup(["unclaim", "r11/p"], tag("r11/p")); a.setup(["park", "r11/p", "--why", "test"]);
    run(); run();
    assert.equal(`${kind("r11/p")} ${fs.existsSync(path.join(setOf("r11/p"), ".unit"))}`, "unmerged false");
  });
  test("  the summary line says what it waits for", () => { has(events("store-aside-kept", "r11")[0] ?? "", "it holds the outputs of Unit p of r11 (r11/p), not on main (parked), and stays until that has landed or is dropped"); });
  test("    and doesn't offer to drop a set its unit may get back", () => { hasnt(events("store-aside-kept", "r11")[0] ?? "x aside drop", "aside drop"); });
  test("  unparked and claimed here again, its outputs still go back to its session", () => {
    a.setup(["unpark", "r11/p"]); a.run("factory/tracker", ["lease", "take", "r11"]); a.setup(["claim", "r11/p"], tag("r11/p"));
    const r = store(a, ["restore", "r11", "r11/p"]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    has(readOr(a.at("work/out/r11/log.txt")), "r11/p on a");
  });
  test("  and the set is gone", () => { assert.equal(setOf("r11/p"), ""); });
});

// Factories updated from a version that filed a unit to sort each set: those units are dropped (on
// the machine they're pinned to, at its next look), and their sets are judged by the rule.
describe("units an older version filed to sort sets", () => {
  const set = "r12-20260101-000000", su = "aside/r12-a-20260101-000000", gone = "aside/r12-a-20260202-000000", away = "aside/r12-b-20260101-000000";
  const sortUnit = (id: string, host: string) => a.setup(["add-unit", id, "--title", `Sort Fighter r12's set-aside copy on ${host}`, "--check", "recorded", "--host", host, "--data", "none"]);
  test("a set with a unit filed to sort it: the unit is dropped at the next look", () => {
    a.setup(["add-group", "aside", "--title", "Set-aside copies to sort"]);
    sortUnit(su, "a"); sortUnit(gone, "a"); sortUnit(away, "b");
    write(a.at(`work/.store/aside/${set}/out/m.txt`), "mine\n");
    write(a.at(`work/.store/aside/${set}/.kind`), "check\n");
    write(a.at(`work/.store/aside/${set}/.unit`), `${su}\n`);
    sort();
    assert.equal(state(su), "dropped");
  });
  test("  its card saying no session sorts one any more", () => { has(card(su), "No session sorts a set-aside copy any more"); });
  test("  the set stops naming it, and stays", () => { assert.equal(`${fs.existsSync(a.at(`work/.store/aside/${set}/.unit`))} ${readOr(a.at(`work/.store/aside/${set}/out/m.txt`))}`, "false mine\n"); });
  test("  one whose set is gone already is dropped too", () => { assert.equal(state(gone), "dropped"); });
  test("  another machine's is left for that machine", () => { assert.equal(state(away), "ready"); });
  test("  no lane here is offered one", () => { hasnt(a.run("factory/tracker", ["next"]).stdout, "set-aside copy"); });
});

// A kind in neither tier wakes the overseer: these are for the morning summary only.
test("the rule's events are morning-summary events: they never wake the overseer", () => {
  for (const k of ["store-aside", "store-aside-removed", "store-aside-kept"]) assert.equal(`${k} ${EVENTS_SUMMARY.includes(k)} ${EVENTS_WAKE.includes(k)}`, `${k} true false`);
});

f.notBroken();
