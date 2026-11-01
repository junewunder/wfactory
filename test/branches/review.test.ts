// The loop reviews a finished branch's diff before it lands (runtime/src/review.ts), with the fake
// reviewer (test/lib's FAKE_REVIEWER) in place of a claude session. A pass lands; a fix doesn't, and
// puts the unit back to ready on its branch with the findings; a second fix makes it stuck; a branch
// with nothing to merge lands unreviewed; a review that can't give a verdict lands, and the overseer
// hears. The review is launched as sessions are: its words in files, never on its command line, and
// no display. Run: node --test test/branches/
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { has, hasnt, readOr } from "../lib/index.ts";
import { branchFactory, ONE } from "./factory.ts";

const f = branchFactory(["r"]);
const [r] = f.lanes;
const { add } = f;
const lk = (x: string) => path.join(r.locks, x);
const reviews = () => Number(readOr(lk("reviews")).trim() || 0);
const verdicts = (...v: string[]) => fs.writeFileSync(lk("review-verdicts"), v.map((x) => x + "\n").join(""));
const remote = (br: string) => r.git("ls-remote", "origin", `refs/heads/${br}`);
const env = (n: number) => Object.fromEntries(readOr(lk(`review.${n}.env`)).split("\0").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const FIX = (s: string) => JSON.stringify({ verdict: "fix", findings: [s] });

describe("a review that passes: the branch lands", () => {
  let out = "";
  test("a unit finished and reviewed", () => {
    add("ok");
    out = r.loop(ONE);
    assert.equal(reviews(), 1);
  });
  test("  passed, and landed", () => {
    has(out, "review: Unit ok (g/ok) passed");
    has(out, "unit/g/ok merged into main");
    assert.equal(r.ok(["state", "g/ok"]), "done");
    assert.ok(f.main("out/g-ok.txt"));
  });
  test("  the reviewer was given the diff and the card, on stdin", () => {
    const p = readOr(lk("review.1.prompt"));
    has(p, "+work on g/ok from r");
    has(p, "Unit ok (g/ok)");
    has(readOr(lk("review.1.system")), "You are the factory's reviewer");
  });
  test("  none of it on its command line", () => {
    const a = readOr(lk("review.1.args"));
    hasnt(a, "work on g/ok");
    hasnt(a, "reviewer");
    has(a, "--append-system-prompt-file");
  });
  test("  and no display", () => {
    const e = env(1);
    assert.equal(e.WAYLAND_DISPLAY, "/dev/null/no-display");
    assert.equal(e.DISPLAY, undefined);
  });
});

describe("a review that asks for fixes: not landed, back to ready on its branch; a second makes it stuck", () => {
  let out = "";
  test("a unit finished, and its review asks for a fix", () => {
    verdicts(FIX("out/g-fx.txt:1: says nothing useful; say what was done"));
    add("fx");
    out = r.loop(ONE);
    has(out, "review: Unit fx (g/fx) needs fixes before it lands");
  });
  test("  not landed", () => {
    hasnt(out, "unit/g/fx merged into main");
    assert.equal(f.main("out/g-fx.txt"), "");
  });
  test("  its branch kept on origin", () => { assert.notEqual(remote("unit/g/fx"), ""); });
  test("  the unit is ready again, with the findings in a note", () => {
    assert.equal(r.ok(["state", "g/fx"]), "ready");
    has(r.ok(["show", "g/fx"]), "The loop's review asked for fixes before landing");
    has(r.ok(["show", "g/fx"]), "out/g-fx.txt:1: says nothing useful; say what was done");
  });
  test("  the next claim carries the branch on, and its card has the findings", () => {
    verdicts(FIX("out/g-fx.txt:2: still says nothing"));
    out = r.loop(ONE);
    has(out, "iteration 1: Unit fx (g/fx)");
    has(readOr(lk("card.seen")), "says nothing useful; say what was done");
    const two = r.run("git", ["show", "origin/unit/g/fx:out/g-fx.txt"]).stdout;
    assert.equal(two.split("\n").filter((l) => l.startsWith("work on g/fx")).length, 2, "the second session's work is on top of the first's");
  });
  test("  a second fix: stuck, for the overseer, not round again", () => {
    has(out, "review: Unit fx (g/fx) needs fixes before it lands");
    assert.equal(r.ok(["state", "g/fx"]), "stuck");
    has(r.ok(["show", "g/fx"]), "asked for fixes a second time");
    has(r.events(), "Unit fx (g/fx): the loop's review asked for fixes a second time");
    assert.equal(f.main("out/g-fx.txt"), "");
    assert.notEqual(remote("unit/g/fx"), "");
  });
  test("  reopened by the overseer, it gets another round, and a pass lands it", () => {
    r.ok(["reopen", "g/fx"]);
    out = r.loop(ONE);
    has(out, "unit/g/fx merged into main");
    assert.equal(r.ok(["state", "g/fx"]), "done");
  });
});

describe("a branch with nothing to merge lands without a review", () => {
  test("a unit that commits nothing lands, unreviewed", () => {
    const n = reviews();
    add("none");
    const out = r.loop(ONE, { FACTORY_FAKE_NOWORK: "1" });
    has(out, "unit/g/none had nothing to merge");
    assert.equal(r.ok(["state", "g/none"]), "done");
    assert.equal(reviews(), n);
  });
});

describe("a branch that changes only tracker/ lands without a review", () => {
  test("its tracker/ edits dropped, nothing left to review", () => {
    const n = reviews();
    add("tronly");
    const out = r.loop(ONE, { FACTORY_FAKE_TRACKERONLY: "1" });
    has(out, "review: Unit tronly (g/tronly) changes nothing outside tracker/; no review");
    assert.equal(r.ok(["state", "g/tronly"]), "done");
    assert.equal(reviews(), n);
  });
});

describe("a review that can't give a verdict: the branch lands, and the overseer hears why", () => {
  for (const [what, v, why] of [["fails", "exit 3", "the review session failed (exit 3"], ["says no verdict that parses", "looks fine to me", "the review gave no verdict that could be read"]]) {
    test(`a review that ${what}`, () => {
      verdicts(v);
      const id = what.split(" ")[0];
      add(id);
      const out = r.loop(ONE);
      has(out, `unit/g/${id} merged into main`);
      assert.equal(r.ok(["state", `g/${id}`]), "done");
      has(r.events(), `Unit ${id} (g/${id}) landed without the loop's review: ${why}`);
    });
  }
});

describe("a review that runs too long: ended, with its own log line, and the branch lands", () => {
  let out = "";
  test("a review past FACTORY_REVIEW_TIMEOUT", () => {
    verdicts("sleep 60");
    add("slow");
    out = r.loop(ONE, { FACTORY_REVIEW_TIMEOUT: "2", FACTORY_POLL: "1" });
    has(out, "unit/g/slow merged into main");
  });
  test("  the log says the review ran over, not that the wrap-up time is over", () => {
    has(out, "the review has run over 2 s: ending it");
    hasnt(out, "wrap-up time is over");
  });
  test("  and the overseer hears why it wasn't reviewed", () => { has(r.events(), "Unit slow (g/slow) landed without the loop's review: its review ran over 2 s"); });
});

describe("the reviewer reads what the lane's sessions can: the clone's linked folders", () => {
  test("a clone whose work/ is a link to a folder outside it", () => {
    const work = path.join(path.dirname(r.dir), "shared-work");
    fs.mkdirSync(work, { recursive: true });
    fs.symlinkSync(work, r.at("work"));
    fs.appendFileSync(r.at(".git/info/exclude"), "/work\n");
    add("ln");
    r.loop(ONE);
    fs.rmSync(r.at("work"));
    has(readOr(lk(`review.${reviews()}.args`)), `--add-dir ${fs.realpathSync(work)}`);
  });
});

describe("the reviewer's model: tracker/project.json's review_model, else the lane's", () => {
  test("the lane's model, with none set", () => {
    add("m1");
    r.loop([...ONE, "--model", "lane-model"]);
    has(readOr(lk(`review.${reviews()}.args`)), "--model lane-model");
  });
  test("review_model, once set", () => {
    f.editMain("tracker/project.json", (p) => { p.review_model = "review-model"; });
    add("m2");
    r.loop([...ONE, "--model", "lane-model"]);
    has(readOr(lk(`review.${reviews()}.args`)), "--model review-model");
  });
});

describe("the reviewer hears which other groups' builds the branch changes (the ci.affected hook over it)", () => {
  test("a unit finished in a project with the hook: its lines reach the review, its own group's left out", () => {
    fs.writeFileSync(lk("affected-branch.sh"), `#!/bin/bash
echo "$1..$2" >> "${lk("affected-branch.calls")}"
env -0 > "${lk("affected-branch.env")}"
printf 'g\\tthe units group itself\\nfighters\\tchanged its build: fbx (shared.py)\\n'
`, { mode: 0o755 });
    f.editMain("tracker/project.json", (p) => { p.ci = { ...(p.ci ?? {}), affected: `${lk("affected-branch.sh")} {old} {new}` }; });
    add("af");
    r.loop(ONE);
    const p = readOr(lk(`review.${reviews()}.prompt`));
    has(p, "fighters\tchanged its build: fbx (shared.py)");
    hasnt(p, "the units group itself");
    assert.match(readOr(lk("affected-branch.calls")), /^[0-9a-f]{40}\.\.[0-9a-f]{40}$/m);
    f.editMain("tracker/project.json", (p) => { delete p.ci.affected; });
  });
  // The project's own code, run without the owner's display (#174).
  test("  the hook ran with no display", () => {
    const e = Object.fromEntries(readOr(lk("affected-branch.env")).split("\0").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
    assert.equal(e.WAYLAND_DISPLAY, "/dev/null/no-display");
    assert.equal(e.DISPLAY, undefined);
  });
  test("  none without the hook", () => {
    add("na");
    const n = reviews();
    r.loop(ONE);
    assert.equal(reviews(), n + 1);
    hasnt(readOr(lk(`review.${reviews()}.prompt`)), "changes the build of these groups");
  });
});
