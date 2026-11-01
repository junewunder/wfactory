// Landing's loose ends (#135, #134): a clone's stale copy of a branch finished elsewhere is
// dropped, so origin's lands; a lane keeps every merge unit it filed, not only the last; and a
// merge unit whose lane is gone from the machines file is taken over by a lane on its machine,
// worked from origin's branch. Lanes b and b2 are two lanes of machine b. Run: node --test test/branches/
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { has, hasnt, readOr } from "../lib/index.ts";
import { branchFactory, ONE } from "./factory.ts";

const f = branchFactory(["b", "e"]);
const [b, e] = f.lanes;
const b2 = f.lane("b", { k: 2, locks: "b2" });
const { add, w } = f;
const hook = path.join(b2.locks, "check-hook");
const failing = (when: string) => fs.writeFileSync(hook, `#!/bin/sh\n${when}\n`, { mode: 0o755 });
const remote = (br: string) => b.git("ls-remote", "origin", `refs/heads/${br}`);

describe("a stale copy of a branch finished elsewhere: dropped, and origin's lands", () => {
  let out = "";
  test("lane b leaves a unit unfinished, pushed, and its clone gets a commit origin never sees", () => {
    add("st");
    has(b.loop(ONE, { FACTORY_FAKE_NODONE: "1" }), "unit/g/st pushed");
    b.git("checkout", "-q", "unit/g/st");
    fs.writeFileSync(b.at("stale.txt"), "an earlier attempt's\n");
    b.git("add", "stale.txt"); b.git("commit", "-qm", "g/st: never pushed");
    b.git("checkout", "-q", "main");
  });
  test("lane b2 carries it on and finishes it, but main looks red to it, so its finished branch waits on origin", () => {
    failing("exit 1");
    const o = b2.loop(ONE);
    has(o, "carrying on from unit/g/st as pushed");
    has(o, "main itself fails");
    assert.equal(b.ok(["state", "g/st"]), "merging");
  });
  test("lane b looks again", () => { fs.rmSync(hook); out = b.loop(ONE); });
  test("  dropping its stale copy", () => { has(out, "unit/g/st's unit was finished elsewhere; this clone's earlier copy"); });
  test("  and landing origin's", () => { has(out, "landing unit/g/st, finished elsewhere"); has(out, "unit/g/st merged into main"); });
  test("  without the stale commit", () => { assert.equal(f.main("stale.txt"), ""); assert.ok(f.main("out/g-st.txt")); });
  test("  the unit is done, its branch gone from origin", () => { assert.equal(b.ok(["state", "g/st"]), "done"); assert.equal(remote("unit/g/st"), ""); });
});

// A lane that died landing (its finished branch pushed, main merged in) and restarts while the other
// lane here, which took its landing, waits on a red main: it doesn't push its copy over that lane's.
describe("a lane that died landing, restarted while another lane holds its landing", () => {
  const bhook = path.join(b.locks, "check-hook");
  let out = "";
  test("lane b finishes a unit while main moves, and dies landing it", async () => {
    add("rl");
    const h = b.hold("g/rl");
    const bl = b.loopBg(ONE);
    await h.held();
    const sc = w.at("main-move");
    w.git(w.top, "clone", "-q", f.origin, sc);
    fs.writeFileSync(path.join(sc, "moved.txt"), "main moved\n");
    w.git(sc, "add", "moved.txt"); w.git(sc, "commit", "-qm", "main moves"); w.git(sc, "push", "-q", "origin", "HEAD:main");
    // The landing's check kills the lane (everything it started), after its finished branch is pushed.
    fs.writeFileSync(bhook, `#!/bin/sh\nkill -KILL -- -$(cat "${b.locks}/lane-pgid")\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(b.locks, "lane-pgid"), String(bl.pid));
    h.go();
    await bl.end();
    fs.rmSync(bhook);
    assert.equal(b.ok(["state", "g/rl"]), "merging");
  });
  test("lane b2 takes its landing, but main looks red to it", () => {
    failing("exit 1");
    const o = b2.loop(ONE);
    has(o, "landing unit/g/rl, finished elsewhere");
    has(o, "main itself fails");
    fs.rmSync(hook);
  });
  test("lane b, started again", () => { out = b.loop(ONE); });
  test("  doesn't push its copy over origin's", () => { hasnt(out, "unit/g/rl pushed"); hasnt(b.events(), "stuck-branch"); });
  test("  drops it, and lands origin's", () => { has(out, "unit/g/rl's unit was finished elsewhere"); has(out, "unit/g/rl merged into main"); });
  test("  leaving no branch on origin", () => { assert.equal(remote("unit/g/rl"), ""); assert.equal(b2.ok(["state", "g/rl"]), "done"); });
});

// A lane that dies before its finished branch is pushed (the push itself fails): origin has only an
// earlier attempt's copy, and no other lane lands that; the lane, started again, lands its own.
describe("a lane that dies before its finished branch is pushed: no other lane lands an earlier copy", () => {
  const prepush = b.at(".git/hooks/pre-push");
  test("lane b leaves a unit unfinished, its branch pushed", () => { add("ec"); has(b.loop(ONE, { FACTORY_FAKE_NODONE: "1" }), "unit/g/ec pushed"); });
  test("  carries it on and finishes it, and dies pushing it", async () => {
    fs.writeFileSync(prepush, `#!/bin/sh\nkill -KILL -- -$(cat "${b.locks}/lane-pgid")\nexit 1\n`, { mode: 0o755 });
    const k = b.loopBg(ONE);
    fs.writeFileSync(path.join(b.locks, "lane-pgid"), String(k.pid));
    await k.end();
    fs.rmSync(prepush);
    assert.equal(b.ok(["state", "g/ec"]), "merging");
  });
  test("  the other lane on its machine doesn't land origin's earlier copy", () => {
    hasnt(b2.loop(ONE), "unit/g/ec merged into main");
    assert.equal(b2.ok(["state", "g/ec"]), "merging");
  });
  test("  lane b, started again, lands its finished copy", () => {
    has(b.loop(ONE), "unit/g/ec merged into main");
    assert.equal(f.main("out/g-ec.txt").split("\n").length, 2);
  });
});

describe("a lane keeps every merge unit it filed", () => {
  let first = "";
  test("its first merge unit waits on a question", () => {
    add("q1");
    has(e.loop(ONE, { FACTORY_FAKE_BREAK: "1" }), "filed Merge main on e lane 1");
    first = readOr(e.at("runs/.merge-unit")).trim();
    e.setup(["ask", "--title", "Keep which side of q1?", "--context", "test", "--option", "a | keep | keep it", "--option", "b | drop | drop it", "--default", "a", "--blocks", first, "--id", "q1-side"]);
  });
  let out = "";
  test("meanwhile another of its branches can't merge", () => {
    add("q2");
    out = e.loop(ONE, { FACTORY_FAKE_BREAK: "1" });
    has(out, "iteration 1: Unit q2 (g/q2)");
    has(out, "filed Merge main on e lane 1");
  });
  test("  both are this lane's, the first first", () => {
    const l = readOr(e.at("runs/.merge-unit")).split("\n").filter(Boolean);
    assert.equal(l.length, 2, l.join(" "));
    assert.equal(l[0], first);
  });
  test("  the first still holds its branch back", () => { hasnt(out, "landing unit/g/q1"); });
});

// The machines file's row for b: init.sh's row for this machine, renamed, with this many lanes.
function lanesOfB(n: number) {
  const scratch = w.at("machines-edit");
  if (!fs.existsSync(scratch)) w.git(w.top, "clone", "-q", f.origin, scratch);
  w.git(scratch, "fetch", "-q", "origin"); w.git(scratch, "reset", "-q", "--hard", "origin/main");
  const mf = path.join(scratch, "docs/machines.md"), text = fs.readFileSync(mf, "utf8").split("\n");
  const sep = text.findIndex((l) => /^\|(-+\|)+$/.test(l.replace(/ /g, "")));
  const cells = text[sep + 1].split("|");
  cells[1] = " b "; cells[3] = ` ${n} `;
  text.splice(sep + 1, 0, cells.join("|"));
  fs.writeFileSync(mf, text.join("\n"));
  w.git(scratch, "commit", "-qam", `test: machine b runs ${n} lane(s)`); w.git(scratch, "push", "-q", "origin", "HEAD:main");
}

describe("a merge unit whose lane is gone: a lane on its machine takes it over", () => {
  let mu = "", out = "";
  test("lane b2's branch fails the check there, and becomes its merge unit, pinned to it", () => {
    // The check fails on a unit's branch in b2 only.
    failing('case "$(git rev-parse --abbrev-ref HEAD)" in unit/*) exit 1;; esac');
    add("gl");
    has(b2.loop(ONE), "filed Merge main on b lane 2");
    mu = readOr(b2.at("runs/.merge-unit")).trim();
    fs.rmSync(hook);
  });
  test("lane b, while lane 2 is still in the machines file, leaves it alone", () => {
    lanesOfB(2);
    out = b.loop(ONE);
    hasnt(out, "takes it over");
    hasnt(out, "unit/g/gl merged into main");
  });
  test("once machine b has one lane, lane b takes it over", () => {
    lanesOfB(1);
    out = b.loop(ONE);
    has(out, `(${mu}) was lane 2's, which isn't in docs/machines.md any more: this lane takes it over, on origin's unit/g/gl`);
  });
  test("  works it from origin's branch", () => { has(out, "iteration 1: Merge main on b lane 1"); has(out, "carrying on from unit/g/gl as pushed"); });
  test("  and lands it", () => { has(out, "unit/g/gl merged into main"); assert.equal(b.ok(["state", "g/gl"]), "done"); });
  test("  the merge unit is done, and not this lane's any more", () => {
    assert.equal(b.ok(["state", mu]), "done");
    assert.ok(!readOr(b.at("runs/.merge-unit")).includes(mu));
  });
});

// A lane killed in the session of a merge unit it took over (#134) keeps what that session left: at
// its next start the branch is saved and pushed as its own, not dropped as another lane's copy.
describe("a lane killed working a merge unit it took over keeps the session's work", () => {
  const claude = w.at("bin/claude"), usual = fs.readFileSync(claude, "utf8");
  test("lane b2's branch becomes its merge unit; lane b takes it over and is killed in its session", async () => {
    failing('case "$(git rev-parse --abbrev-ref HEAD)" in unit/*) exit 1;; esac');
    add("gk");
    has(b2.loop(ONE), "filed Merge main on b lane 2");
    fs.rmSync(hook);
    // The merge session leaves a tracked file changed, uncommitted, then the lane dies (everything
    // it started).
    fs.writeFileSync(claude, `#!/usr/bin/env bash\necho "left by the merge session" >> shared.txt\nkill -KILL -- -$(cat "${b.locks}/lane-pgid")\n`, { mode: 0o755 });
    try {
      const k = b.loopBg(ONE);
      fs.writeFileSync(path.join(b.locks, "lane-pgid"), String(k.pid));
      has((await k.end()).stdout, "this lane takes it over");
    } finally { fs.writeFileSync(claude, usual, { mode: 0o755 }); }
  });
  test("  started again, it saves the branch and the merge lands with the session's work", () => {
    has(b.loop(ONE), "unit/g/gk merged into main");
    has(f.main("shared.txt"), "left by the merge session");
  });
});


// A lane killed in a merge unit's session, then removed from the machines file, never runs the
// save at its next start: what it committed stays in its clone, on this machine (#172). The lane
// that takes the merge unit over fetches it and merges it in; one that clashes with origin's copy
// is left in the clone, as is a change never committed, and the overseer hears of it either way.
describe("a merge unit taken over from a gone lane takes in the commits left in its clone", () => {
  let mu = "", out = "", tip = "";
  test("lane b2's branch becomes its merge unit, and its clone gets a commit origin never sees", () => {
    lanesOfB(2);
    failing('case "$(git rev-parse --abbrev-ref HEAD)" in unit/*) exit 1;; esac');
    add("gw");
    has(b2.loop(ONE), "filed Merge main on b lane 2");
    mu = readOr(b2.at("runs/.merge-unit")).trim();
    fs.rmSync(hook);
    b2.git("checkout", "-q", "unit/g/gw");
    fs.writeFileSync(b2.at("left.txt"), "the killed merge session's\n");
    b2.git("add", "left.txt"); b2.git("commit", "-qm", "g/gw: committed, never pushed");
    tip = b2.git("rev-parse", "HEAD").trim();
    b2.git("checkout", "-q", "main");
  });
  test("once machine b has one lane, lane b takes it over", () => {
    lanesOfB(1);
    out = b.loop(ONE);
    has(out, `(${mu}) was lane 2's, which isn't in docs/machines.md any more: this lane takes it over`);
  });
  test("  merges in the clone's commit, and pushes it", () => {
    has(out, `merged lane 2's unit/g/gw (${tip.slice(0, 12)}, left unpushed in ${b2.dir}) into this clone's, and pushed it`);
  });
  test("  says so in an event naming the clone and the commit", () => {
    has(b.events(), `gone-lane-merged`);
    has(b.events(), `unit/g/gw in lane 2's clone (${b2.dir}) had commits origin's lacked, up to ${tip.slice(0, 12)}`);
  });
  test("  and the merge lands with it", () => {
    has(out, "unit/g/gw merged into main");
    has(f.main("left.txt"), "the killed merge session's");
    assert.equal(b.ok(["state", mu]), "done");
  });
});

describe("a gone lane's commits that clash with origin's copy: left in its clone, and told", () => {
  let mu = "", out = "", tip = "";
  test("lane b2's merge unit; its clone and origin's copy of the branch each change shared.txt", () => {
    lanesOfB(2);
    failing('case "$(git rev-parse --abbrev-ref HEAD)" in unit/*) exit 1;; esac');
    add("gc");
    has(b2.loop(ONE), "filed Merge main on b lane 2");
    mu = readOr(b2.at("runs/.merge-unit")).trim();
    fs.rmSync(hook);
    b2.git("checkout", "-q", "unit/g/gc");
    fs.writeFileSync(b2.at("shared.txt"), "lane 2's side\n");
    b2.git("commit", "-qam", "g/gc: lane 2's side, never pushed");
    tip = b2.git("rev-parse", "HEAD").trim();
    b2.git("checkout", "-q", "main");
    // And a change the killed session never committed.
    fs.appendFileSync(b2.at("shared.txt"), "never committed\n");
    const sc = w.at("clash-gc");
    w.git(w.top, "clone", "-q", "-b", "unit/g/gc", f.origin, sc);
    fs.writeFileSync(path.join(sc, "shared.txt"), "origin's side\n");
    w.git(sc, "commit", "-qam", "g/gc: origin's side"); w.git(sc, "push", "-q", "origin", "HEAD:unit/g/gc");
  });
  test("once machine b has one lane, lane b takes it over", () => {
    lanesOfB(1);
    out = b.loop(ONE);
    has(out, `(${mu}) was lane 2's, which isn't in docs/machines.md any more: this lane takes it over`);
  });
  test("  can't merge the clone's commit, and works from origin's", () => {
    has(out, `lane 2's unit/g/gc (${tip.slice(0, 12)}, in ${b2.dir}) has commits origin's lacks, and they clash with origin's copy; working from origin's`);
    has(out, "carrying on from unit/g/gc as pushed");
  });
  test("  an event names the clone and the commit", () => {
    has(b.events(), "gone-lane-left");
    has(b.events(), `unit/g/gc in lane 2's clone (${b2.dir}) has commits origin's lacks, up to ${tip.slice(0, 12)}, and they clash with origin's copy`);
  });
  test("  and the change never committed", () => { has(b.events(), "the clone also has changes never committed (on main), left there"); });
  test("  the clone is left as it was, and nothing of it in this clone's refs", () => {
    assert.equal(b2.git("rev-parse", "unit/g/gc").trim(), tip);
    assert.equal(b2.git("status", "--porcelain").trim(), "M shared.txt");
    assert.equal(b.git("for-each-ref", "refs/factory-gone/").trim(), "");
  });
  test("  and the merge lands origin's copy, without lane 2's side", () => {
    has(out, "unit/g/gc merged into main");
    hasnt(f.main("shared.txt"), "lane 2's side");
  });
});

describe("a gone lane's clone with nothing to bring in but changes never committed: told, and left", () => {
  let out = "";
  test("lane b2's merge unit; its clone has a change never committed, and no new commit", () => {
    lanesOfB(2);
    failing('case "$(git rev-parse --abbrev-ref HEAD)" in unit/*) exit 1;; esac');
    add("gd");
    has(b2.loop(ONE), "filed Merge main on b lane 2");
    fs.rmSync(hook);
    b2.git("checkout", "-q", "unit/g/gd");
    fs.writeFileSync(b2.at("half.txt"), "the killed session's, never committed\n");
    lanesOfB(1);
    out = b.loop(ONE);
    has(out, "this lane takes it over");
  });
  test("  an event says so, naming the clone and the branch it's on", () => {
    has(b.events(), `unit/g/gd: lane 2's clone (${b2.dir}) has no commits origin's copy lacks; the clone also has changes never committed (on unit/g/gd), left there`);
  });
  test("  the clone is left as it was, and the merge lands origin's copy", () => {
    assert.equal(b2.git("status", "--porcelain").trim(), "?? half.txt");
    has(out, "unit/g/gd merged into main");
    assert.equal(f.main("half.txt"), "");
  });
});
