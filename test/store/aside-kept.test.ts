// Kept sets (an unfinished unit's outputs, set aside when the store's copy was put back): a put-back
// that waited for another session here still records the commit they were built from, so the unit
// gets them back; a set whose unit is parked, pinned to another machine or asking the owner a
// question stays kept, with no unit filed to sort it; and a set still kept at the end of the next
// run of the lanes gets a line for the morning summary then, unless its units are dropped by then
// (deleted, as always) or its unit was claimed here again. Two lanes stopping together end one
// run, not two, even at once; lanes started and stopped with no session between end none; and a
// set a stop's put-back makes stays kept too (#140).
// Run: node --test test/store/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { has, readOr, cmd, chomp, start, until, ROOT } from "../lib/index.ts";
import { storeFactory, ONE } from "./factory.ts";

const f = storeFactory(["a"]);
const { add, store, asides, group } = f;
const [a] = f.lanes;
const ok = (args: string[]) => { const r = store(a, args); assert.equal(r.code, 0, `store.sh ${args.join(" ")}: ${r.stderr}`); return r; };
const git = (...args: string[]) => cmd("git", args, { cwd: a.dir, env: a.envWith() });
const G = (x: string) => a.at(`work/.store/groups/${x}`);
const state = (id: string) => chomp(a.run("factory/tracker", ["state", id]).stdout);
const card = (id: string) => a.run("factory/tracker", ["show", id]).stdout;
// The set holding a unit's outputs ("" if none), and one of its files.
const setOf = (u: string) => asides(a, u.split("/")[0]).find((x) => readOr(path.join(x, ".units")).split("\n").includes(u)) ?? "";
const kind = (u: string) => chomp(readOr(path.join(setOf(u), ".kind")));
// The morning-summary lines so far that say a unit's set is still there, and whether a unit was
// filed to sort its set.
const keptLines = (u: string) => a.events().split("\n").filter((l) => l.split("\t")[3] === "store-aside-kept" && l.includes(`(${u})`)).length;
const filed = (u: string) => fs.existsSync(path.join(setOf(u), ".unit"));

// A group of its own for each unit (two sets of one group made in the same second would share a
// folder), with data on the store from a merged unit first.
const GROUPS = ["k1", "k2", "k3", "k4", "k5", "k6", "k7", "k8", "k9", "k10", "k11", "kz"];
for (const g of GROUPS) { group(g); add(`${g}/r0`, "--reads", "none"); }
a.loop(["--max", String(GROUPS.length), "--hours", "0.1"]);
// A run of the lanes here, as the store sees one: a session ran (the loop notes it as each one
// ends), lanes running (release-idle at their looks), then the last one stopping (leave).
const sessionRan = () => fs.writeFileSync(a.at("work/.store/ran"), "");
const run = () => { sessionRan(); ok(["release-idle"]); ok(["leave"]); };
// u's session, in this lane, ends unfinished on its branch (at this clone's HEAD): the store's copy
// is put back over its outputs. before(): run before its end (another session's mark, say).
function unfinished(u: string, before = () => {}) {
  const g = u.split("/")[0];
  add(u, "--reads", "none");
  a.run("factory/tracker", ["lease", "take", g]); ok(["take", g]);
  a.setup(["claim", u], { FACTORY_BRANCHES: "1", FACTORY_TAG: `s-${g}` });
  git("branch", "-f", `unit/${u}`, "HEAD");
  ok(["dirty", g, u, String(process.pid)]);
  fs.appendFileSync(a.at(`work/out/${g}/log.txt`), `${u} on a\n`);
  before();
  ok(["end", g, u, "c"]);
}

describe("a put-back that waited for another session here", () => {
  test("its unit's session ends while another lane's works on the group: the put-back waits", () => {
    unfinished("k1/w", () => { ok(["dirty", "k1", "k1/x", String(process.pid)]); fs.renameSync(G("k1.dirty.a-lane1"), G("k1.dirty.a-lane2")); ok(["dirty", "k1", "k1/w", String(process.pid)]); });
    assert.equal(setOf("k1/w"), "");
  });
  test("  done by a later look, it records the commit its outputs were built from", () => {
    fs.rmSync(G("k1.dirty.a-lane2"));
    ok(["release-idle"]);
    assert.equal(readOr(path.join(setOf("k1/w"), ".from")).split("\t")[2], chomp(git("rev-parse", "HEAD").stdout));
  });
  test("  so the unit claimed again gets them back", () => {
    const r = store(a, ["restore", "k1", "k1/w"]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    has(readOr(a.at("work/out/k1/log.txt")), "k1/w on a");
  });
});

describe("a set whose unit can't be claimed here now stays kept, with no unit to sort it", () => {
  test("a kept set whose unit is parked: aside sort leaves it as it is", () => {
    unfinished("k2/p");
    a.setup(["unclaim", "k2/p"], { FACTORY_TAG: "s-k2" }); a.setup(["park", "k2/p", "--why", "test"]);
    ok(["aside", "sort"]);
    assert.equal(`${kind("k2/p")} ${filed("k2/p")}`, "unmerged false");
  });
  test("  and the parked unit's card still says the loop puts them back for its next session", () => { has(card("k2/p"), "The loop puts them back for its next session on a only if"); });
  test("one whose unit is pinned to another machine: kept too", () => {
    unfinished("k3/h");
    a.setup(["edit", "k3/h", "--host", "b"]);
    ok(["aside", "sort"]);
    assert.equal(`${kind("k3/h")} ${filed("k3/h")}`, "unmerged false");
  });
  test("one whose unit asks the owner a question stays kept: answered, it's claimed here again", () => {
    unfinished("k7/q");
    a.setup(["ask", "--title", "Which way should k7 go?", "--context", "test", "--option", "a | one way | this", "--option", "b | the other | that", "--default", "a", "--blocks", "k7/q"]);
    ok(["aside", "sort"]);
    assert.equal(`${state("k7/q")} ${kind("k7/q")}`, "you unmerged");
  });
});

describe("a set kept through a whole run of the lanes here", () => {
  test("the lanes stopping mark a kept set", () => {
    unfinished("k4/n");
    run();
    assert.equal(`${kind("k4/n")} ${fs.existsSync(path.join(setOf("k4/n"), ".night"))}`, "unmerged true");
  });
  test("  the next run ending, its unit not claimed here since: still kept, with a line for the morning summary", () => {
    run();
    assert.equal(`${kind("k4/n")} ${keptLines("k4/n")}`, "unmerged 1");
  });
  test("    and no unit filed", () => { assert.equal(filed("k4/n"), false); });
  test("its unit claimed here again in between: still kept", () => {
    unfinished("k5/c");
    run();
    // Claimed again on another commit: not put back, but the set waits for the unit again.
    git("commit", "-q", "--allow-empty", "-m", "elsewhere");
    try { assert.equal(store(a, ["restore", "k5", "k5/c"]).code, 3); } finally { git("reset", "-q", "--hard", "HEAD~1"); }
    run();
    assert.equal(`${kind("k5/c")} ${keptLines("k5/c")}`, "unmerged 0");
  });
  test("its unit dropped by the second stop: deleted", () => {
    unfinished("k6/d");
    run();
    f.drop("k6/d");
    run();
    assert.equal(setOf("k6/d"), "");
  });
  test("two leaves with no lanes run between (two lanes stopping together): one run, still kept", () => {
    unfinished("k8/t");
    run();
    ok(["leave"]);
    assert.equal(kind("k8/t"), "unmerged");
  });
  test("one whose unit asks the owner a question, still open after whole runs: still kept", () => {
    run();
    assert.equal(`${state("k7/q")} ${kind("k7/q")}`, "you unmerged");
  });
});

describe("a run of the lanes counts once a session has run", () => {
  test("a kept set marked at a stop", () => {
    unfinished("k9/n");
    run();
    assert.equal(fs.existsSync(path.join(setOf("k9/n"), ".night")), true);
  });
  // (As the store sees it: their looks and their stop.)
  test("  lanes started and stopped again with no session (a redeploy): still kept", () => {
    ok(["release-idle"]); ok(["leave"]);
    ok(["release-idle"]); ok(["leave"]);
    assert.equal(kind("k9/n"), "unmerged");
  });
  test("  the lanes run a session (another unit's), its unit not claimed here: a line for the morning summary", () => {
    add("k10/s", "--reads", "none");
    const before = keptLines("k9/n");
    a.loop(ONE);
    assert.equal(`${kind("k9/n")} ${before} ${keptLines("k9/n")}`, "unmerged 0 1");
  });
});

// A session mark the lanes' stop finds (a session that ended without its loop): the put-back makes
// a set as the leases are let go, after the stop's first sort.
describe("a set a stop's put-back makes", () => {
  test("its unit is pinned to another machine, its session ended without its loop: the lanes stop", () => {
    add("k11/p", "--reads", "none");
    a.run("factory/tracker", ["lease", "take", "k11"]); ok(["take", "k11"]);
    a.setup(["claim", "k11/p"], { FACTORY_BRANCHES: "1", FACTORY_TAG: "s-k11" });
    git("branch", "-f", "unit/k11/p", "HEAD");
    ok(["dirty", "k11", "k11/p", String(process.pid)]);
    fs.appendFileSync(a.at("work/out/k11/log.txt"), "k11/p on a\n");
    a.setup(["edit", "k11/p", "--host", "b"]);
    ok(["leave"]);
    assert.notEqual(setOf("k11/p"), "");
  });
  test("  stays kept, for whichever machine lands its unit, with no unit to sort it", () => { assert.equal(`${kind("k11/p")} ${filed("k11/p")}`, "unmerged false"); });
});

// Two lanes stopping at once: the one that ends the run walks the kept sets (held here at its
// first look at a unit, through a tracker that waits), while the other lets its leases go and marks
// the sets. A set made in this run mustn't be marked before the walk reaches it, or it's reported a
// run early.
describe("two leaves at once", () => {
  const hold = f.w.at("tracker-hold"), blocker = f.w.at("tracker-hold.mjs");
  fs.writeFileSync(blocker, `import fs from "node:fs";
if (process.argv[2] === "state" && (() => { try { fs.mkdirSync(${JSON.stringify(`${hold}.held`)}); return true; } catch { return false; } })())
  while (!fs.existsSync(${JSON.stringify(`${hold}.go`)})) await new Promise((r) => setTimeout(r, 50));
await import(${JSON.stringify(path.join(ROOT, "tracker/tracker.mjs"))});
`);
  // Whether a process waits for the night lock now (Linux's /proc/locks lists the waiters, "->").
  const nightWaited = () => {
    let ino = 0; try { ino = fs.statSync(a.at("work/.store/lock-night")).ino; } catch { return false; }
    return readOr("/proc/locks").split("\n").some((l) => l.includes("->") && l.includes(`:${ino} `));
  };
  const leave = (add: NodeJS.ProcessEnv = {}) => start(a.at("factory/store.sh"), ["leave"], { cwd: a.dir, env: a.envWith(add) });
  let first: ReturnType<typeof leave>, second: ReturnType<typeof leave>;
  test("a set marked last run, and one made in this run; a session ran", () => {
    unfinished("k3/m");   // (a new set, beside k3's earlier one)
    run();
    unfinished("kz/t");
    sessionRan();
    assert.equal(`${kind("k3/m")} ${kind("kz/t")} ${fs.existsSync(path.join(setOf("kz/t"), ".night"))}`, "unmerged unmerged false");
  });
  test("the first leave ends the run, and is held walking the sets", async () => {
    first = leave({ FACTORY_TRACKER: blocker });
    await until(() => fs.existsSync(`${hold}.held`), "the first leave asks the tracker about a kept set's unit", 60);
    assert.equal(fs.existsSync(a.at("work/.store/ran")), false);
  });
  test("  the second leave meanwhile: done, or waiting for the first's walk", async () => {
    let done = false;
    second = leave();
    void second.then(() => { done = true; });
    await until(() => done || nightWaited(), "the second leave ends or waits for the night lock", 60);
  });
  test("  both end", async () => {
    fs.writeFileSync(`${hold}.go`, "");
    const [r1, r2] = await Promise.all([first, second]);
    assert.equal(r1.code, 0, r1.stderr);
    assert.equal(r2.code, 0, r2.stderr);
  });
  test("  the set marked last run: its line for the morning summary", () => { assert.equal(`${kind("k3/m")} ${keptLines("k3/m")}`, "unmerged 1"); });
  test("  the set made in this run: no line yet, marked for the next", () => {
    assert.equal(`${kind("kz/t")} ${keptLines("kz/t")} ${fs.existsSync(path.join(setOf("kz/t"), ".night"))}`, "unmerged 0 true");
  });
});

f.notBroken();
