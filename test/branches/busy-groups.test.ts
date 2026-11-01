// Two lanes on one laptop share work/: one lane's half-written outputs there don't hold up the
// other's merges (2026-10-12: a factory's check saw them, and main looked broken). The check
// is told the busy groups (FACTORY_BUSY_GROUPS); one that ignores them makes the branch wait, and
// the overseer hears why. Run: node --test test/branches/
import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { has, until, readOr } from "../lib/index.ts";
import { branchFactory, ONE } from "./factory.ts";

const f = branchFactory(["a"]);
const [a] = f.lanes;
const { add, w } = f;
const work = w.at("h-work");
fs.mkdirSync(work);
const [h1, h2] = [1, 2].map((k) => {
  const l = f.lane("h", { k });
  fs.symlinkSync(work, l.at("work"));
  fs.appendFileSync(l.at(".git/info/exclude"), "/work\n");
  return l;
});
const lk = (x: string) => path.join(h1.locks, x);   // both lanes' lock folder
// Lane 1 works a unit of group w, leaving work/wip-w while it works, held until go().
function slow(u: string) {
  const k = u.replace("/", "-");
  fs.writeFileSync(lk(`hold.${k}`), "");
  const l = h1.loopBg(ONE, { FACTORY_FAKE_WIP: "1" });
  return {
    l,
    held: () => until(() => fs.existsSync(lk(`held.${k}`)) && fs.existsSync(path.join(work, "wip-w")), `${u}'s session is working, its output in work/`, 30),
    go: async () => { fs.rmSync(lk(`hold.${k}`)); fs.writeFileSync(lk(`go.${k}`), ""); return (await l.end()).stdout; },
  };
}
const quick = (x: string) => { add(x); return h2.loop(ONE); };

// Like a factory's code-in-git check: an output in work/ that isn't in git fails it, unless its
// group is busy and the project's check honours FACTORY_BUSY_GROUPS (the honour file).
fs.writeFileSync(lk("check-hook"), `#!/usr/bin/env bash
echo "busy=[$FACTORY_BUSY_GROUPS]" >> "$FACTORY_LOCKS/busy.seen"
for f in work/wip-*; do
  [ -e "$f" ] || continue; g=\${f#work/wip-}
  [ -e "$FACTORY_LOCKS/honour" ] && [[ " $FACTORY_BUSY_GROUPS " == *" $g "* ]] && continue
  echo "an output in work/ that isn't in git: $f"; exit 1
done
`, { mode: 0o755 });
a.setup(["add-group", "w", "--title", "Wip group"]);
const unit = (x: string) => a.setup(["add-unit", `w/${x}`, "--title", `Unit ${x}`]);

describe("a check that honours the busy groups", () => {
  let h2log = "";
  let s: ReturnType<typeof slow>;
  test("lanes on one laptop: the other lane's unit is in the check's busy groups", async () => {
    fs.writeFileSync(lk("honour"), "");
    unit("slow");
    s = slow("w/slow");
    await s.held();
    h2log = quick("quick");
    has(readOr(lk("busy.seen")), "busy=[w]");
  });
  test("  a check that skips them lets this lane's branch land", () => { has(h2log, "unit/g/quick merged into main"); });
  test("  and the busy lane's own unit lands after", async () => { has(await s.go(), "unit/w/slow merged into main"); });
});

// A check that doesn't skip busy groups: main fails while they're busy. The branch waits, the
// overseer hears why it may be, and it's checked again once those units move on (at the lane's next start).
describe("a check that ignores the busy groups", () => {
  let s: ReturnType<typeof slow>;
  let h4 = "";
  test("a check that ignores busy groups: the branch waits", async () => {
    fs.rmSync(lk("honour"));
    unit("slow2");
    s = slow("w/slow2");
    await s.held();
    h4 = quick("quick2");
    has(h4, "while units of w have outputs in work/");
  });
  test("  the overseer hears the busy groups may be why", () => {
    has(h2.events().split("\n").filter((l) => l.includes("main-broken")).join("\n"), "doesn't skip FACTORY_BUSY_GROUPS");
  });
  test("  once the other lane's unit is done, the waiting branch lands at the next start", async () => {
    await s.go();
    has(quick("quick3"), "unit/g/quick2 merged into main");
  });
});

// The other lane's unit interrupted, not landed: its outputs stay in work/, and its group stays busy.
describe("a unit interrupted mid-way on the other lane", () => {
  test("a unit interrupted mid-way leaves its outputs in work/", async () => {
    fs.writeFileSync(lk("honour"), "");
    unit("cut");
    const s = slow("w/cut");
    await s.held();
    h1.run("factory/oversee.sh", ["pause", "--now"]);
    await s.l.end();
    fs.rmSync(lk("hold.w-cut")); fs.writeFileSync(lk("go.w-cut"), "");
    assert.equal(h1.ok(["state", "w/cut"]), "interrupted");
    assert.ok(fs.existsSync(path.join(work, "wip-w")));
  });
  let h7 = "";
  // Lane 1 carries it on later; lane 2 takes other work meanwhile.
  test("  the other lane's branch still lands", () => {
    a.setup(["edit", "w/cut", "--lane", "h/1"]);
    h7 = quick("quick4");
    has(h7, "unit/g/quick4 merged into main");
  });
  test("  its group is busy while it's interrupted here", () => {
    assert.equal(readOr(lk("busy.seen")).replace(/\n+$/, "").split("\n").at(-1), "busy=[w]");
  });
  after(() => { fs.rmSync(lk("check-hook"), { force: true }); f.drop("w/cut"); });
});
