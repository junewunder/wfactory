// The tracker CLI end to end: check units (checks.ts). A check waits for the open fixes of its
// group that name it (or that it names), a check its project's check-ready hook says can't be
// judged yet isn't handed out, and a note that waits on CI for a group with no CI is refused.
// (An overnight run of a mod factory: checks claimed for an hour and more, then handed back on a
// fix already filed, on Melee stills nobody had made, or on a CI the group didn't have.)
// Run: node --test tracker/test/
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { trackerRepo, has, hasnt, TRACKER } from "../../test/lib/index.ts";
import { waitsOnCi } from "../src/checks.ts";

const repo = (name: string) => {
  const f = trackerRepo(name, { FACTORY_TAG: "s1", FACTORY_EVIDENCE_MIN: "0" });
  f.setup(["init", "--title", "Checks"]);
  return f;
};
const unitOf = (f: ReturnType<typeof repo>, g: string, id: string) => f.json(`tracker/groups/${g}.json`).units.find((x: { id: string }) => x.id === id);

describe("a check waits for the open fixes that name it", () => {
  const f = repo("cover");
  const { t, ok, setup } = f;
  const next = () => JSON.parse(t(["next", "--json"]).stdout);
  const state = (id: string) => ok(["state", id]).trim();
  test("setup: a fighter with a fix, its check, and a fix filed by another check's look", () => {
    f.edit("tracker/project.json", (p) => { p.checks = { units: "*-check" }; });
    setup(["add-group", "fal", "--title", "Falco"]);
    setup(["add-unit", "fal/blaster", "--title", "Falco's blaster shown"]);
    setup(["add-unit", "fal/blaster-check", "--title", "Check: Falco's blaster in the game", "--needs", "fal/blaster", "--detail", "After {unit:fal/blaster}: a look of the laser."]);
    setup(["add-unit", "fal/throw-check", "--title", "Check: Falco's throws in the game", "--detail", "A look of all four throws."]);
    setup(["add-unit", "fal/glow-box", "--title", "Falco's laser glow, not a hatched box", "--detail", "Strip ({unit:fal/blaster-check}): the glow is a hatched box. Fix offline; look in its check."]);
    setup(["done", "fal/blaster", "--evidence", "blaster shown"]);
  });
  test("the check isn't offered while the fix naming it is open", () => {
    assert.equal(state("fal/blaster-check"), "waiting");
    has(ok(["status", "fal"]), "Check: Falco's blaster in the game (fal/blaster-check): can't start until Falco's laser glow, not a hatched box (fal/glow-box) is done; a check waits for the open fixes it covers");
  });
  test("its card says what it covers", () => {
    has(ok(["show", "fal/blaster-check"]), "Covers (open fixes of its group that name it, waited for like needs): Falco's laser glow, not a hatched box (fal/glow-box)");
  });
  test("a sibling check's card lists that fix, not waited for", () => {
    const c = ok(["show", "fal/throw-check"]);
    has(c, "Open fixes this group's other checks found (not waited for): Falco's laser glow, not a hatched box (fal/glow-box). If one shows in this look too");
    hasnt(c, "Covers");
  });
  test("a check the fix's notes name waits too", () => {
    assert.equal(state("fal/throw-check"), "ready");
    setup(["note", "fal/glow-box", "The throws' lasers show the same box: {unit:fal/throw-check} waits on this."]);
    assert.equal(state("fal/throw-check"), "waiting");
  });
  test("next offers the fix, not the checks", () => {
    assert.equal(next().id, "fal/glow-box");
  });
  test("a unit that names the check but needs it isn't waited on (no cycle)", () => {
    setup(["add-unit", "fal/after", "--title", "Falco's publish after his look", "--needs", "fal/blaster-check", "--detail", "Once {unit:fal/blaster-check} passes, publish."]);
    setup(["done", "fal/glow-box", "--evidence", "glow drawn as Melee's"]);
    assert.equal(state("fal/blaster-check"), "ready");
    assert.equal(state("fal/after"), "waiting");
  });
  test("nor one that needs it through another unit", () => {
    setup(["add-unit", "fal/mid", "--title", "Falco's middle step", "--needs", "fal/blaster-check"]);
    setup(["add-unit", "fal/late", "--title", "Falco's late step", "--needs", "fal/mid", "--detail", "Seen in {unit:fal/blaster-check}'s strip."]);
    assert.equal(state("fal/blaster-check"), "ready");
  });
  test("nor another check, nor a parked fix", () => {
    setup(["add-unit", "fal/other-check", "--title", "Check: Falco's other look", "--detail", "Same look as {unit:fal/blaster-check}."]);
    setup(["add-unit", "fal/parked", "--title", "Falco's parked fix", "--detail", "Look in {unit:fal/blaster-check}."]);
    assert.equal(state("fal/blaster-check"), "waiting");
    setup(["park", "fal/parked", "--why", "later"]);
    assert.equal(state("fal/blaster-check"), "ready");
  });
  test("a fix in another group isn't covered (that's what --needs is for)", () => {
    setup(["add-group", "tool", "--title", "Toolchain"]);
    setup(["add-unit", "tool/strip", "--title", "Strip crop", "--detail", "Seen in {unit:fal/blaster-check}."]);
    assert.equal(state("fal/blaster-check"), "ready");
  });
  test("an interrupted check whose covered fix opened since isn't taken back", () => {
    setup(["claim", "fal/blaster-check"], { FACTORY_TAG: "s2" });
    f.edit("tracker/groups/fal.json", (j) => { const u = j.units.find((x: { id: string }) => x.id === "fal/blaster-check"); u.record.pid = 999999; u.record.start = "1"; });
    assert.equal(next().id, "fal/blaster-check");
    setup(["add-unit", "fal/flash", "--title", "Falco's muzzle flash", "--detail", "Strip ({unit:fal/blaster-check}): no flash."]);
    assert.notEqual(next().id, "fal/blaster-check");
  });
  test("units are checks only by project.json checks.units (default tag:check)", () => {
    f.edit("tracker/project.json", (p) => { delete p.checks; });
    assert.equal(state("fal/throw-check"), "ready");
    setup(["add-unit", "fal/flash-look", "--title", "Look at Falco's flash", "--tags", "check"]);
    setup(["add-unit", "fal/flash-fix", "--title", "Falco's flash colour", "--detail", "Look in {unit:fal/flash-look}."]);
    assert.equal(state("fal/flash-look"), "waiting");
  });
});

describe("a check whose reference doesn't exist yet isn't handed out", () => {
  const f = repo("ready");
  const { t, ok, setup } = f;
  const next = (add = {}) => JSON.parse(t(["next", "--json"], add).stdout);
  // The hook: exit 0 once ready/<unit> exists; else what say/<unit> holds, exit 1 (or its code).
  const say = (id: string, text: string, code = 1) => { f.write(`say/${id.replace("/", "_")}`, text); f.write(`code/${id.replace("/", "_")}`, String(code)); };
  test("setup: a project with a check-ready hook", () => {
    f.write("hook.sh", `u=\${1/\\//_}\n[ -f ready/$u ] && exit 0\ncat say/$u 2>/dev/null\nexit $(cat code/$u 2>/dev/null || echo 1)\n`);
    f.edit("tracker/project.json", (p) => { p.checks = { units: "*-check", ready: "bash hook.sh {unit} {group}" }; });
    setup(["add-group", "fal", "--title", "Falco"]);
    setup(["add-group", "tool", "--title", "Toolchain"]);
    setup(["add-unit", "fal/throw-check", "--title", "Check: Falco's throws against Melee's"]);
    setup(["add-unit", "fal/later", "--title", "Falco's later work"]);
  });
  test("not ready, the hook files the unit that provides the reference, and the check waits on it", () => {
    say("fal/throw-check", "no Melee stills of a throw\nfile tool/throw-stills Melee stills for throws\ndetail Script a grab and each throw in GD.\n");
    const j = next();
    assert.notEqual(j.id, "fal/throw-check", JSON.stringify(j));
    const s = unitOf(f, "tool", "tool/throw-stills");
    assert.equal(s.title, "Melee stills for throws");
    assert.equal(s.detail, "Script a grab and each throw in GD.");
    assert.deepEqual(unitOf(f, "fal", "fal/throw-check").needs, ["tool/throw-stills"]);
    has(ok(["state", "fal/throw-check"]), "waiting");
    has(ok(["log"]), "not ready to judge (no Melee stills of a throw)");
  });
  test("once that's done, the hook runs again; ready, the check goes out", () => {
    setup(["done", "tool/throw-stills", "--evidence", "stills scripted"]);
    f.write("ready/fal_throw-check", "");
    assert.equal(next().id, "fal/throw-check");
  });
  test("needs <id> waits on a unit that exists", () => {
    setup(["add-unit", "fal/dthrow-check", "--title", "Check: Falco's down throw"]);
    setup(["add-unit", "tool/crop", "--title", "Crop strips at hitpause"]);
    f.write("ready/fal_throw-check", "");
    setup(["edit", "fal/throw-check", "--priority", "0"]);
    say("fal/dthrow-check", "strips aren't cropped\nneeds tool/crop\n");
    setup(["edit", "fal/dthrow-check", "--priority", "5"]);
    const j = next();
    assert.notEqual(j.id, "fal/dthrow-check");
    assert.ok(unitOf(f, "fal", "fal/dthrow-check").needs.includes("tool/crop"));
  });
  test("naming nothing it could use, the check is stuck with the hook's reason", () => {
    setup(["add-unit", "fal/odd-check", "--title", "Check: Falco's odd move", "--priority", "9"]);
    say("fal/odd-check", "no reference for the odd move\nneeds tool/nothing\n");
    assert.notEqual(next().id, "fal/odd-check");
    const st = ok(["status", "fal"]);
    has(st, "Check: Falco's odd move (fal/odd-check): stuck: its check-ready hook says it can't be judged yet");
    has(st, "no reference for the odd move");
  });
  test("exit 75 (couldn't tell here): the check goes out as before", () => {
    setup(["add-unit", "fal/here-check", "--title", "Check: Falco's here move", "--priority", "9"]);
    say("fal/here-check", "no editor here", 75);
    assert.equal(next().id, "fal/here-check");
  });
  test("claim refuses a check that isn't ready", () => {
    setup(["add-unit", "fal/claim-check", "--title", "Check: Falco's claimed move"]);
    setup(["add-unit", "tool/ref", "--title", "Reference for the claimed move"]);
    say("fal/claim-check", "no reference yet\nneeds tool/ref\n");
    const r = t(["claim", "fal/claim-check"]);
    assert.equal(r.code, 1, r.stdout + r.stderr);
    has(r.stderr, "waits on Reference for the claimed move (tool/ref)");
    assert.equal(unitOf(f, "fal", "fal/claim-check").record, undefined);
  });
  test("next --claim claims other work, not the check", () => {
    setup(["park", "fal/here-check", "--why", "x"]);
    setup(["add-unit", "fal/top-check", "--title", "Check: Falco's top move", "--priority", "20"]);
    say("fal/top-check", "no reference for the top move\nfile tool/top-ref Reference for the top move\n");
    const j = JSON.parse(ok(["next", "--claim", "--json"], { FACTORY_TAG: "s3" }));
    assert.notEqual(j.id, "fal/top-check");
    assert.equal(unitOf(f, "fal", "fal/top-check").record, undefined);
    assert.deepEqual(unitOf(f, "fal", "fal/top-check").needs, ["tool/top-ref"]);
  });
  test("a unit that isn't a check never runs the hook", () => {
    setup(["add-unit", "fal/plain", "--title", "Falco's plain fix", "--priority", "30"]);
    say("fal/plain", "would refuse\nneeds tool/crop\n");
    assert.equal(next().id, "fal/plain");
  });
});

describe("check-ready: races and many checks", () => {
  const f = repo("ready-race");
  const { t, ok, setup } = f;
  test("another lane claims the check while this lane's hook runs: its claim stands", () => {
    // The hook, run by lane s1, has lane s2 claim the check (s2's own hook passes) before it answers.
    f.write("hook.sh", `if [ "$FACTORY_TAG" = s2 ]; then exit 0; fi\nFACTORY_TAG=s2 "${process.execPath}" "${TRACKER}" claim "$1" >/dev/null\necho "no reference here"\nexit 1\n`);
    f.edit("tracker/project.json", (p) => { p.checks = { units: "*-check", ready: "bash hook.sh {unit}" }; });
    setup(["add-group", "fal", "--title", "Falco"]);
    setup(["add-unit", "fal/x-check", "--title", "Check: Falco's x move"]);
    const r = t(["next", "--claim", "--json"]);
    has(r.stderr, "left as it is");
    const rec = unitOf(f, "fal", "fal/x-check").record;
    assert.equal([rec.state, rec.by].join(","), "claimed,s2", JSON.stringify(rec));
  });
  test("past its hook runs, next passes over checks it hasn't vetted rather than hand them out", () => {
    f.write("hook.sh", `echo "no reference"\necho "needs tool/ref"\nexit 1\n`);
    setup(["add-group", "tool", "--title", "Toolchain"]);
    setup(["add-unit", "tool/ref", "--title", "Reference for every move"]);
    for (let i = 0; i < 20; i++) setup(["add-unit", `fal/c${i}-check`, "--title", `Check: Falco's move ${i}`, "--priority", "10"]);
    const j = JSON.parse(ok(["next", "--claim", "--json"], { FACTORY_TAG: "s3" }));
    assert.equal(j.id, "tool/ref", JSON.stringify(j));
    const waiting = f.json("tracker/groups/fal.json").units.filter((u: { needs?: string[] }) => u.needs?.includes("tool/ref")).length;
    assert.equal(waiting, 8);
    const plain = JSON.parse(t(["next", "--json"], { FACTORY_TAG: "s4" }).stdout);
    assert.ok(!/-check$/.test(plain.id ?? ""), JSON.stringify(plain));
  });
  test("lint checks the checks keys", () => {
    f.edit("tracker/project.json", (p) => { p.checks = { units: 3, ready: "", ready_timeout: -1 }; });
    const r = t(["lint"]);
    has(r.stdout + r.stderr, "project.json checks.units");
    has(r.stdout + r.stderr, "project.json checks.ready:");
    has(r.stdout + r.stderr, "project.json checks.ready_timeout");
  });
});

describe("a note that waits on CI, for a group with no CI", () => {
  const f = repo("noci");
  const { t, setup } = f;
  test("setup: a group without CI and one with", () => {
    f.edit("tracker/project.json", (p) => { p.ci = { steps: { drill: { cmd: "true" } } }; p.store = { remote: "store:/s", paths: { out: "work/out/{group}" } }; });
    setup(["add-group", "pea", "--title", "Peach"]);
    setup(["add-group", "mar", "--title", "Marth", "--ci", "drill", "--data", "mod=1"]);
    setup(["add-unit", "pea/dthrow-check", "--title", "Check: Peach's down throw"]);
    setup(["add-unit", "pea/fix", "--title", "Peach's down throw victim"]);
    setup(["add-unit", "mar/check", "--title", "Check: Marth's down throw"]);
  });
  test("note: refused, saying the group has no CI and to give the rebuild command", () => {
    const r = t(["note", "pea/dthrow-check", "Look at Peach's down throw after her CI rebuild."]);
    assert.notEqual(r.code, 0);
    has(r.stderr, "The note waits on CI, but Peach (pea) has no CI");
    has(r.stderr, "Give the command that rebuilds");
    assert.equal(unitOf(f, "pea", "pea/dthrow-check").notes, undefined);
  });
  test("other ways of waiting on it", () => {
    for (const s of ["once CI has run, look again", "wait for CI before the look", "look when CI rebuilds her", "CI's rebuild has the fix"]) assert.ok(waitsOnCi(s), s);
    for (const s of ["Peach has no CI: run just character peach first", "without CI, rebuild by hand", "the ci-fix landed", "CI passed on Marth",
      "Added a test for the CI config", "Fails when CI is set in the env", "the CI build script is broken", "CI runs the old tests, see log",
      "Moved the stills for CI to tracker/", "Ported the CI's build step", "Set up CI for the group: drill and publish steps"]) assert.ok(!waitsOnCi(s), s);
  });
  test("a note naming the rebuild command is fine", () => {
    setup(["note", "pea/dthrow-check", "Peach has no CI: run `just character peach --only fbx` before the look."]);
  });
  test("a group with CI may wait on it", () => {
    setup(["note", "mar/check", "Look after Marth's CI rebuild."]);
  });
  test("so may a unit working on such a group's data", () => {
    setup(["add-unit", "pea/on-marth", "--title", "Peach's grab on Marth", "--data", "mar"]);
    setup(["note", "pea/on-marth", "Look after the CI rebuild."]);
  });
  test("done and review evidence, reopen notes and details too", () => {
    for (const args of [["done", "pea/fix", "--evidence", "fixed; the look is after CI rebuilds her"], ["review", "pea/fix", "--evidence", "fixed; look once CI has run"],
      ["reopen", "pea/fix", "--note", "look after the CI run"], ["edit", "pea/fix", "--detail", "Look after her CI rebuild."],
      ["add-unit", "pea/new-check", "--title", "Check: Peach's new move", "--detail", "Look after her CI rebuild."]]) {
      const r = t(args);
      assert.notEqual(r.code, 0, args.join(" "));
      has(r.stderr, "has no CI");
    }
    hasnt(f.read("tracker/groups/pea.json"), "pea/new-check");
  });
});
