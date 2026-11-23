// The loop reviews a finished branch's diff before it lands (runtime/src/review.ts), with the fake
// reviewer (test/lib's FAKE_REVIEWER) in place of a claude session. A pass lands; a fix doesn't, and
// puts the unit back to ready on its branch with the findings; a second fix makes it stuck; a branch
// with nothing to merge lands unreviewed; a review that can't give a verdict doesn't land it: the
// branch waits and is reviewed again later, the overseer hearing each time, and the third with no
// verdict makes the unit stuck; a usage limit waits and isn't counted. The review is launched as
// sessions are: its words in files, never on its command line, and no display.
// Run: node --test test/branches/
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

// 22 Nov: a reviewer said a strip folder the Evidence cited under work/ didn't exist (its Glob lists
// files, not folders) and sent the unit back. The loop looks the cited paths up and tells it.
describe("the paths its Evidence cites are looked up for the reviewer, folders included", () => {
  test("a unit whose evidence cites a folder under work/, a file and a path that isn't there", () => {
    fs.mkdirSync(r.at("work/logs/look/123-strip"), { recursive: true });
    fs.writeFileSync(r.at("work/logs/look/123-strip/frame-1.png"), "png");
    add("ev");
    const out = r.loop(ONE, { FACTORY_FAKE_EVIDENCE: "strips in work/logs/look/123-strip/ and `out/g-ev.txt:1`; also work/logs/look/gone.json; ran for g/ev" });
    has(out, "unit/g/ev merged into main");
  });
  test("  the reviewer is told what's there", () => {
    const p = readOr(lk(`review.${reviews()}.prompt`));
    has(p, "- work/logs/look/123-strip: a folder, 1 entry, last changed");
    has(p, "- out/g-ev.txt: a file,");
    has(p, "- work/logs/look/gone.json: not there");
    has(p, "Take these as found");
  });
  test("  and a unit id isn't taken for a missing path", () => { hasnt(readOr(lk(`review.${reviews()}.prompt`)), "- g/ev:"); });
  // (A later test makes work/ a link.)
  test("  (work/ cleared)", () => { fs.rmSync(r.at("work"), { recursive: true, force: true }); });
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

// 22 Nov: the overseer reopened units the review sent back twice without weighing the findings,
// and good units went round again. Overruled, the branch lands as it is, not reviewed again.
describe("a unit the review sent back twice, overruled by the overseer: landed without another review", () => {
  let out = "";
  test("sent back twice: stuck", () => {
    add("ov");
    verdicts(FIX("work/x doesn't exist"));
    r.loop(ONE);
    verdicts(FIX("work/x still doesn't exist"));
    r.loop(ONE);
    assert.equal(r.ok(["state", "g/ov"]), "stuck");
    assert.notEqual(remote("unit/g/ov"), "");
  });
  test("  overruled, the next look lands it, unreviewed", () => {
    r.ok(["overrule", "g/ov", "--why", "work/x is a folder the reviewer's Glob didn't list; it's there"], { FACTORY_ACTOR: "oversee" });
    const n = reviews();
    verdicts(FIX("would send it back again"));
    out = r.loop(ONE);
    has(out, "review: the overseer overruled the review of g/ov");
    has(out, "unit/g/ov merged into main");
    assert.equal(reviews(), n);
    assert.equal(r.ok(["state", "g/ov"]), "done");
    assert.ok(f.main("out/g-ov.txt"));
    verdicts();
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

// (Before, such a branch landed unreviewed, a review-skipped event telling the overseer.)
const unrun = (id: string) => r.events().split("\n").filter((l) => l.split("\t")[3] === "review-unrun" && l.includes(`g/${id}`));
describe("a review that can't give a verdict: the branch waits, pushed, and is reviewed again later; a pass then lands it", () => {
  for (const [what, v, why] of [["fails", "exit 3", "the review session failed (exit 3"], ["says no verdict that parses", "looks fine to me", "the review gave no verdict that could be read"]]) {
    const id = what.split(" ")[0];
    let out = "";
    test(`a review that ${what}`, () => {
      verdicts(v);
      add(id);
      out = r.loop(ONE);
      assert.equal(reviews() > 0, true);
    });
    test("  not landed: the unit still waits to merge, its branch on origin", () => {
      hasnt(out, `unit/g/${id} merged into main`);
      assert.equal(f.main(`out/g-${id}.txt`), "");
      assert.equal(r.ok(["state", `g/${id}`]), "merging");
      assert.notEqual(remote(`unit/g/${id}`), "");
    });
    test("  the overseer hears why, and that it waits", () => {
      assert.equal(unrun(id).length, 1, r.events());
      has(unrun(id)[0], `Unit ${id} (g/${id}): the loop's review gave no verdict on its branch (${why}`);
      has(unrun(id)[0], "so it isn't landed: the branch waits, pushed, and is reviewed again after");
      has(unrun(id)[0], "try 1 of 3");
      hasnt(r.events(), "landed without the loop's review");
    });
    test("  not reviewed again before FACTORY_REVIEW_RETRY has passed", () => {
      const n = reviews();
      out = r.loop(ONE);
      assert.equal(reviews(), n);
      has(out, `the loop's review gave no verdict on it at`);
      assert.equal(r.ok(["state", `g/${id}`]), "merging");
    });
    test("  after it, reviewed again: a pass lands it", () => {
      const n = reviews();
      out = r.loop(ONE, { FACTORY_REVIEW_RETRY: "0" });
      assert.equal(reviews(), n + 1);
      has(out, `unit/g/${id} merged into main`);
      assert.equal(r.ok(["state", `g/${id}`]), "done");
      assert.equal(unrun(id).length, 1);
    });
  }
});

describe("a review with no verdict three times: the unit is stuck, for the overseer, never landed", () => {
  let out = "";
  test("three reviews that fail, half an hour apart (FACTORY_REVIEW_RETRY 0 here)", () => {
    verdicts("exit 3", "exit 4", "exit 5");
    add("thrice");
    const n = reviews();
    // (A run may look at the waiting branch more than once.)
    for (let i = 0; i < 4 && r.ok(["state", "g/thrice"]) !== "stuck"; i++) {
      out += r.loop(ONE, { FACTORY_REVIEW_RETRY: "0" });
      if (reviews() < n + 3) assert.equal(r.ok(["state", "g/thrice"]), "merging");
    }
    assert.equal(reviews(), n + 3);
  });
  test("  told the first two times", () => {
    assert.deepEqual(unrun("thrice").map((l) => /try (\d) of 3/.exec(l)?.[1]), ["1", "2"]);
  });
  test("  the third: stuck, its branch on origin, not landed", () => {
    hasnt(out, "unit/g/thrice merged into main");
    assert.equal(f.main("out/g-thrice.txt"), "");
    assert.equal(r.ok(["state", "g/thrice"]), "stuck");
    assert.notEqual(remote("unit/g/thrice"), "");
  });
  test("  the card says why, the last try's why with it", () => {
    has(r.ok(["show", "g/thrice"]), "the loop's review gave no verdict 3 times, so it waits for the overseer: the review session failed (exit 5");
  });
  test("  and the overseer hears it's stuck", () => {
    has(r.events(), "Unit thrice (g/thrice): the loop's review gave no verdict 3 times, so it waits for the overseer");
  });
  test("  reopened by the overseer, it gets three more tries, and a pass lands it", () => {
    r.ok(["reopen", "g/thrice"]);
    out = r.loop(ONE, { FACTORY_REVIEW_RETRY: "0" });
    has(out, "unit/g/thrice merged into main");
    assert.equal(r.ok(["state", "g/thrice"]), "done");
  });
});

describe("a review that hits a usage limit: the branch waits, and it isn't counted as a try", () => {
  test("three usage limits in a row", () => {
    verdicts("limit", "limit", "limit");
    add("lim");
    const n = reviews();
    // (A run may look at the waiting branch more than once.)
    for (let i = 0; i < 4 && reviews() < n + 3; i++) has(r.loop(ONE), "review: the reviewer hit a usage limit;");
    assert.equal(reviews(), n + 3);
  });
  test("  not landed, not stuck, and no review-unrun event", () => {
    assert.equal(r.ok(["state", "g/lim"]), "merging");
    assert.equal(f.main("out/g-lim.txt"), "");
    assert.equal(unrun("lim").length, 0);
  });
  test("  the next look reviews it, and a pass lands it", () => {
    has(r.loop(ONE), "unit/g/lim merged into main");
    assert.equal(r.ok(["state", "g/lim"]), "done");
  });
});

describe("a review that runs too long: ended, with its own log line, and the branch waits", () => {
  let out = "";
  test("a review past FACTORY_REVIEW_TIMEOUT", () => {
    verdicts("sleep 60");
    add("slow");
    out = r.loop(ONE, { FACTORY_REVIEW_TIMEOUT: "2", FACTORY_POLL: "1" });
    hasnt(out, "unit/g/slow merged into main");
    assert.equal(r.ok(["state", "g/slow"]), "merging");
  });
  test("  the log says the review ran over, not that the wrap-up time is over", () => {
    has(out, "the review has run over 2 s: ending it");
    hasnt(out, "wrap-up time is over");
  });
  test("  and the overseer hears why it wasn't reviewed", () => { has(unrun("slow")[0] ?? "", "Unit slow (g/slow): the loop's review gave no verdict on its branch (its review ran over 2 s)"); });
  test("  reviewed again later, a pass lands it", () => {
    has(r.loop(ONE, { FACTORY_REVIEW_RETRY: "0" }), "unit/g/slow merged into main");
  });
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
