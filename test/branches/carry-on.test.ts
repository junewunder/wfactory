// A unit cut short on one laptop is carried on from its work, never fresh from main: paused
// asap (its branch pushed, another laptop takes it), the lane killed outright (the next start
// saves the branch), a session that ended mid-unit (the branch is up before the claim ends),
// and a check given up without a verdict (back in review, never landed).
// Run: node --test test/branches/
import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { has, hasnt, until, lines, groupAlive } from "../lib/index.ts";
import { branchFactory, ONE } from "./factory.ts";

const f = branchFactory(["a", "c", "d", "e"]);
const [a, c, d, e] = f.lanes;
const { add, drop } = f;
type Lane = typeof a;
// A unit's session in that lane, held once its work is committed, until go(); held() waits for it.
const hold = (l: Lane, u: string) => {
  const k = u.replace("/", "-");
  fs.writeFileSync(path.join(l.locks, `hold.${k}`), "");
  return {
    held: () => until(() => fs.existsSync(path.join(l.locks, `held.${k}`)), `${u}'s session is working in lane ${l.n}`),
    go: () => { fs.rmSync(path.join(l.locks, `hold.${k}`), { force: true }); fs.rmSync(path.join(l.locks, `held.${k}`), { force: true }); fs.writeFileSync(path.join(l.locks, `go.${k}`), ""); },
  };
};

describe("an interrupted unit is carried on from another laptop", () => {
  let dlog = "";
  test("pause asap on one laptop pushes the unit's branch", async () => {
    add("carry");
    const h = hold(c, "g/carry");
    const cl = c.loopBg(["--hours", "0.05"]);
    await h.held();
    c.run("factory/oversee.sh", ["pause", "--now"]);
    const out = (await cl.end()).stdout;
    h.go();
    has(out, "unit/g/carry pushed");
  });
  test("another laptop takes the interrupted unit", () => {
    dlog = d.loop(ONE);
    has(dlog, "iteration 1: Unit carry (g/carry)");
  });
  test("  carries on from the pushed branch", () => { has(dlog, "carrying on from unit/g/carry"); });
  test("  and main has both laptops' work", () => { has(f.main("out/g-carry.txt"), "from c"); });
  test("  and main has both laptops' work (2)", () => { has(f.main("out/g-carry.txt"), "from d"); });
  test("  the pushed branch is deleted once merged", () => { assert.equal(d.git("ls-remote", "origin", "refs/heads/unit/g/carry"), ""); });
});

describe("stop now (the lane killed mid-session): the next start saves the branch and carries on", () => {
  let k2 = "";
  test("a killed lane leaves the unit's branch checked out", async () => {
    add("killed");
    const h = hold(c, "g/killed");
    // Like `just fleet stop`: everything the lane started is killed at once (its own process group here).
    const k = c.loopBg(["--hours", "0.05"]);
    await h.held();
    process.kill(-k.pid!, "SIGKILL");
    await k.end();
    await until(() => !groupAlive(k.pid!), "everything the killed lane started is gone");
    h.go();
    assert.equal(c.git("rev-parse", "--abbrev-ref", "HEAD"), "unit/g/killed");
  });
  test("  its next start pushes it", () => {
    k2 = c.loop(ONE);
    has(k2, "unit/g/killed pushed");
  });
  test("  and carries the unit on", () => { has(k2, "iteration 1: Unit killed (g/killed)"); });
  test("  keeping the killed session's work", () => { assert.equal(lines(f.main("out/g-killed.txt")), 2); });
});

describe("a unit the session didn't finish: its branch is pushed before its claim is settled", () => {
  // So a lane taking it the moment the claim ends carries on from the work, never fresh from main.
  test("an unfinished unit's branch is pushed before its claim ends", () => {
    add("unfinished");
    e.loop(ONE, { FACTORY_FAKE_NODONE: "1" });
    e.git("fetch", "-q", "origin");
    const sc = e.git("log", "--format=%H", "--grep", "Unit unfinished: session ended mid-unit", "origin/main").split("\n").filter(Boolean).at(-1) ?? "";
    assert.ok(sc, "no commit settling the session's claim");
    const g = JSON.parse(e.git("show", `${sc}:tracker/groups/g.json`));
    assert.equal(g.units.find((u: any) => u.id === "g/unfinished")?.record?.pushed, true, `settle commit ${sc.slice(0, 9)}`);
  });
  test("  the branch is on origin", () => { assert.notEqual(e.git("ls-remote", "origin", "refs/heads/unit/g/unfinished"), ""); });
  after(() => { drop("g/unfinished"); });
});

describe("a check of a unit in review that ends without a verdict: back in review, never landed", () => {
  let before = "", log = "";
  test("a check given up without a verdict puts the unit back in review", () => {
    add("reviewme");
    a.setup(["edit", "g/reviewme", "--check", "independent"]);
    a.setup(["claim", "g/reviewme"], { FACTORY_TAG: "wa" });
    a.setup(["review", "g/reviewme", "--evidence", "see out/"], { FACTORY_TAG: "wa" });
    e.git("fetch", "-q", "origin");
    before = e.git("rev-parse", "origin/main");
    log = e.loop(ONE, { FACTORY_FAKE_NODONE: "1", FACTORY_FAKE_NOWORK: "1" });
    has(log, "iteration 1: Unit reviewme (g/reviewme)");
    has(a.tracker(["state", "g/reviewme"]).stdout, "review");
  });
  test("  and its branch isn't landed", () => { hasnt(log, "unit/g/reviewme merged into main"); });
  test("  main has no merge for it", () => {
    e.git("fetch", "-q", "origin");
    assert.ok(!/Unit reviewme.*merged from/.test(e.git("log", "--format=%s", `${before}..origin/main`)));
  });
});
