// The tracker CLI end to end: status computed from probes, a unit broken again, a check taking
// over a hand-done unit, probes cached by their inputs, and writes under the lock (a crashed
// write's temp file, a stale lock, a slow probe). Run: node --test tracker/test/
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { trackerRepo, has, hasnt, sleep, start, TRACKER } from "../../test/lib/index.ts";

const f = trackerRepo("repo", { FACTORY_TAG: "worker1", FACTORY_EVIDENCE_MIN: "0" });
const { t, ok, setup } = f;
setup(["init", "--title", "Test port"]);
setup(["add-group", "pipe", "--title", "Pipeline"]);
const lines = (p: string) => f.read(p).split("\n").length - 1;
const real = { cwd: f.dir, env: f.env };

describe("computed probe, broken again", () => {
  test("probe fails while missing", () => {
    // A ready unit beside it, so "broken goes first" has something to go before.
    setup(["add-unit", "pipe/other", "--title", "Some other work"]);
    setup(["add-unit", "pipe/report", "--title", "Write the report", "--probe-file", "out/report.json", "--probe-json", ".pass == true"]);
    has(ok(["check", "pipe/report"]), "not done yet");
  });
  test("refresh notices the pass", () => {
    f.write("out/report.json", '{"pass":true}\n');
    has(ok(["refresh"]), "now done");
  });
  test("refresh skips unchanged inputs", () => { has(ok(["refresh"]), "nothing changed"); });
  test("regression is loud", async () => {
    await sleep(1000); f.write("out/report.json", '{"pass":false}\n');
    has(ok(["refresh"]), "BROKEN AGAIN");
  });
  test("broken goes first", () => { has(ok(["next"]), "Next: Write the report"); });
  test("computed can't be marked done", () => { assert.equal(t(["done", "pipe/report", "--evidence", "x"]).code, 2); });
  test("fixed again", async () => {
    await sleep(1000); f.write("out/report.json", '{"pass":true}\n');
    has(ok(["refresh"]), "now done");
  });
  after(() => {
    setup(["drop", "pipe/other", "--why", "test"]);
  });
});

describe("hand-done units handed to their check", () => {
  test("check takes over a hand-done unit", () => {
    setup(["add-unit", "pipe/hand", "--title", "Done by hand first", "--check", "recorded"]);
    setup(["done", "pipe/hand", "--evidence", "by hand"]);
    setup(["edit", "pipe/hand", "--probe-file", "out/hand.ok"]);
    f.write("out/hand.ok", "");
    if (t(["recheck", "pipe/hand"]).code !== 0) ok(["check", "pipe/hand"]);
    assert.equal(f.json("tracker/groups/pipe.json").units.find((u: { id: string }) => u.id === "pipe/hand").record.by, "check");
  });
  test("and then catches it breaking", async () => {
    await sleep(1000); fs.rmSync(f.at("out/hand.ok"));
    has(ok(["refresh"]), "BROKEN AGAIN");
  });
  after(() => {
    setup(["drop", "pipe/hand", "--why", "test"]);
  });
});

describe("a temp file a crashed write left is swept, never kept in tracker/", () => {
  test("a crashed write's temp file is swept by the next write", () => {
    setup(["add-group", "nd", "--title", "Needs"]); setup(["add-unit", "nd/b", "--title", "Needs the first"]);
    f.write("tracker/groups/nd.json.tmp-12345", "junk\n");
    ok(["note", "nd/b", "a note"]);
    assert.ok(!fs.existsSync(f.at("tracker/groups/nd.json.tmp-12345")));
  });
});

describe("a stale lock broken by many at once lets one in at a time: no write is lost", () => {
  test("eight writers after a stale lock: all eight writes land", async () => {
    setup(["add-group", "lk", "--title", "Locks"]);
    f.write(".tracker/lock/pid", "999999 1\n");
    await Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map((i) => start(process.execPath, [TRACKER, "add-unit", `lk/u${i}`, "--title", `Lock unit ${i}`], real)));
    assert.equal(f.json("tracker/groups/lk.json").units.length, 8);
  });
});

describe("a slow probe runs outside the lock: other writes go on meanwhile", () => {
  test("a write during a slow refresh doesn't wait for its probe", async () => {
    setup(["add-unit", "lk/slow", "--title", "Slow probe", "--check", "computed", "--probe-cmd", "sleep 6; true"]);
    const refresh = start(process.execPath, [TRACKER, "refresh", "--all"], real);
    await sleep(1500);
    const s0 = Date.now(); ok(["note", "lk/u1", "written during a slow probe"]); const s1 = Date.now();
    await refresh;
    assert.ok(s1 - s0 <= 2000, `${s1 - s0} ms`);
  });
  test("and the refresh still records the result", () => { has(ok(["state", "lk/slow"]), "done"); });
});

describe("probe caching by input globs: a probe runs again only when its inputs change", () => {
  test("--inputs is kept on the probe", () => {
    setup(["add-group", "pc", "--title", "Probe cache"]);
    f.write("pin/a.txt", "1\n");
    ok(["add-unit", "pc/cmd", "--title", "Probe with inputs", "--probe-cmd", "echo run >> pruns.log; test -e pin/pass", "--inputs", "pin/*.txt"]);
    assert.equal(JSON.stringify(f.json("tracker/groups/pc.json").units[0].probe), '{"cmd":"echo run >> pruns.log; test -e pin/pass","inputs":["pin/*.txt"]}');
  });
  // (What the loop reserves memory for before a refresh.)
  test("refresh --due names the command it would run, running nothing", () => {
    assert.deepEqual(JSON.parse(ok(["refresh", "--due", "--group", "pc"])).due, ["echo run >> pruns.log; test -e pin/pass"]);
    assert.ok(!fs.existsSync(f.at("pruns.log")));
  });
  test("refresh runs a probe with inputs the first time", () => {
    setup(["add-unit", "pc/noin", "--title", "Probe without inputs", "--probe-cmd", "echo run >> pnoin.log; true"]);
    fs.rmSync(f.at("pruns.log"), { force: true }); fs.rmSync(f.at("pnoin.log"), { force: true });
    ok(["refresh", "--group", "pc"]);
    assert.equal(lines("pruns.log"), 1);
  });
  test("a command probe without inputs only runs when asked (check, refresh --all)", () => { assert.ok(!fs.existsSync(f.at("pnoin.log"))); });
  test("inputs unchanged: nothing to do", () => { has(ok(["refresh", "--group", "pc"]), "refresh: nothing changed"); });
  test("without running it again", () => { assert.equal(lines("pruns.log"), 1); });
  test("  and refresh --due names none (nor the probe without inputs)", () => { assert.deepEqual(JSON.parse(ok(["refresh", "--due", "--group", "pc"])).due, []); });
  test("a change outside the inputs isn't noticed", () => {
    f.write("pin/pass", "");
    has(ok(["refresh", "--group", "pc"]), "nothing changed");
  });
  test("an input changed: run again", async () => {
    await sleep(1000); f.write("pin/a.txt", "22\n");
    has(ok(["refresh", "--group", "pc"]), "Probe with inputs (pc/cmd): now done");
  });
  test("once: the run outside the lock is reused under it", () => { assert.equal(lines("pruns.log"), 2); });
  let n = 0;
  test("a new file matching the glob is a change", () => {
    n = lines("pruns.log"); f.write("pin/b.txt", "b\n");
    ok(["refresh", "--group", "pc"]);
    assert.ok(lines("pruns.log") > n);
  });
  test("and is then cached too", () => {
    n = lines("pruns.log"); ok(["refresh", "--group", "pc"]);
    assert.equal(lines("pruns.log"), n);
  });
  test("refresh --all runs every probe", () => {
    ok(["refresh", "--all", "--group", "pc"]);
    assert.ok(lines("pruns.log") > n);
    assert.ok(fs.statSync(f.at("pnoin.log")).size > 0);
  });
  test("the cache keeps each probe's fingerprint and result", () => {
    const c = f.json(".tracker/cache.json")["pc/cmd"];
    assert.ok(c.fp && c.pass === true, JSON.stringify(c));
  });
  // (Read without bash's globstar, which macOS's bash 3.2 lacks.)
  test("** in an input glob reaches files folders deep", () => {
    f.write("deep/a/b/one.txt", "1\n");
    ok(["add-unit", "pc/deep", "--title", "Probe with deep inputs", "--probe-cmd", "echo run >> pdeep.log; true", "--inputs", "deep/**/*.txt"]);
    ok(["refresh", "--group", "pc"]);
    n = lines("pdeep.log");
    ok(["refresh", "--group", "pc"]);
    assert.equal(lines("pdeep.log"), n);
    f.write("deep/a/b/c/two.txt", "2\n");
    ok(["refresh", "--group", "pc"]);
    assert.ok(lines("pdeep.log") > n);
  });
});

// settle --pushed (the loop pushed an unfinished unit's branch) runs no check: the loop's settle
// after the session does, with memory reserved for it (#117).
describe("settle --pushed runs no check", () => {
  const runs = () => fs.existsSync(`${f.dir}/pushed.log`) ? lines("pushed.log") : 0;
  let n = 0;
  test("a computed unit claimed on a branch, its branch pushed", () => {
    setup(["add-group", "sp", "--title", "Pushed"]);
    setup(["add-unit", "sp/u", "--title", "Pushed unit", "--probe-cmd", "echo run >> pushed.log; exit 1"]);
    setup(["claim", "sp/u"], { FACTORY_BRANCHES: "1", FACTORY_TAG: "pusher" });
    n = runs();
    ok(["settle", "sp/u", "--pushed"], { FACTORY_TAG: "pusher" });
  });
  test("  its check didn't run", () => { assert.equal(runs(), n); });
  test("  the settle after its session runs the check", () => {
    ok(["settle", "sp/u"], { FACTORY_TAG: "pusher" });
    assert.equal(runs(), n + 1);
  });
});

// Exit 75 is "couldn't run here" (`just capped` with no turn in the memory budget): a check
// that didn't run says nothing, so a done unit stays done and nothing is cached for its inputs.
describe("a probe that couldn't run (exit 75) changes nothing and runs again next time", () => {
  const runs = () => lines("e75.log");
  const record = () => f.json("tracker/groups/nr.json").units[0].record;
  test("done by its check", () => {
    setup(["add-group", "nr", "--title", "Not run"]);
    f.write("e75/in.txt", "1\n"); f.write("e75/code", "0\n");
    setup(["add-unit", "nr/u", "--title", "Checked unit", "--probe-cmd", "echo run >> e75.log; exit $(cat e75/code)", "--inputs", "e75/in.txt"]);
    has(ok(["check", "nr/u"]), "now done");
  });
  let n = 0;
  test("exit 75 at settle: still done, said as not run", () => {
    f.write("e75/code", "75\n"); n = runs();
    has(ok(["settle", "nr/u"]), "couldn't run");
    assert.equal(record().state, "done");
    assert.equal(runs(), n + 1);
  });
  test("logged as not run", () => { has(f.read("tracker/log.jsonl"), "its check couldn't run here"); });
  test("not in the probe cache", () => { assert.equal(f.json(".tracker/cache.json")["nr/u"], undefined); });
  test("so a refresh runs it again, though its inputs haven't changed", () => {
    n = runs(); ok(["refresh", "--group", "nr"]);
    assert.equal(runs(), n + 1);
    assert.equal(record().state, "done");
  });
  test("still not run: logged once, not at every refresh", () => {
    const logged = () => f.read("tracker/log.jsonl").split("its check couldn't run here").length;
    const n = logged(); ok(["refresh", "--group", "nr"]);
    assert.equal(logged(), n);
  });
  test("and the next settle runs it again", () => {
    n = runs(); ok(["settle", "nr/u"]);
    assert.equal(runs(), n + 1);
  });
  test("exit 1 still marks it broken", () => {
    f.write("e75/code", "1\n");
    has(ok(["settle", "nr/u"]), "BROKEN AGAIN");
    assert.equal(record().state, "broken");
  });
  test("a probe killed by its timeout fails too: a done unit goes broken", () => {
    setup(["add-unit", "nr/hang", "--title", "Hanging check", "--probe-cmd", "if test -e e75/hang; then sleep 30; fi"]);
    f.edit("tracker/groups/nr.json", (g) => { g.units[1].probe.timeout = 1; });
    has(ok(["check", "nr/hang"]), "now done");
    f.write("e75/hang", "");
    const out = ok(["check", "nr/hang"]);
    has(out, "BROKEN AGAIN"); has(out, "timed out after 1s");
  });
  test("the cache keeps how long each probe ran", () => {
    f.write("e75/code", "0\n"); ok(["check", "nr/u"]);
    const c = f.json(".tracker/cache.json");
    assert.equal(typeof c["nr/u"].secs, "number");
    assert.ok(c["nr/hang"].secs >= 1, JSON.stringify(c["nr/hang"]));
  });
  after(() => { for (const u of ["nr/u", "nr/hang"]) setup(["drop", u, "--why", "test"]); });
});

describe("refresh --group: only that group's probes", () => {
  test("refresh --group leaves other groups' probes alone", () => {
    setup(["add-group", "pd", "--title", "Other probes"]);
    setup(["add-unit", "pd/x", "--title", "Probe elsewhere", "--probe-file", "pd.ok"]);
    f.write("pd.ok", "");
    hasnt(ok(["refresh", "--group", "pc"]), "pd/x");
  });
  test("refresh without it reaches them", () => {
    has(ok(["refresh"]), "Probe elsewhere (pd/x): now done");
  });
  after(() => {
    for (const u of ["pc/cmd", "pc/noin", "pd/x"]) setup(["drop", u, "--why", "test"]);
  });
});
