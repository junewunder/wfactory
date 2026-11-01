// The tracker CLI end to end: the one order `next` offers units in (the higher of a unit's own
// priority and its group's; leases and units that come back only break ties at that, then group
// priority, group order, unit priority, unit order), `queue`, which shows that order per machine
// and agrees with `next`, and old trackers' urgent priorities turned into it. Run: node --test tracker/test/
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { trackerRepo, has, hasnt } from "../../test/lib/index.ts";

const f = trackerRepo("repo", { FACTORY_TAG: "worker1", FACTORY_EVIDENCE_MIN: "0" });
const { t, ok, setup } = f;
setup(["init", "--title", "Order"]);
f.write("docs/machines.md", "# Machines\n\n| Machine | Lanes | Can |\n|---|---|---|\n| wren | 1 | — |\n| tern | 1 | — |\n");
f.edit("tracker/project.json", (p) => {
  p.store = { remote: "store:/s", paths: { mod: "mods/{mod}" } };
  p.resources = { editor: { title: "the level editor" } };
});
// A lock another lane holds (as in lanes.test.ts): flock in a process group of its own.
function hold(file: string): Promise<() => void> {
  return new Promise((resolve, reject) => {
    const p = spawn("flock", ["-o", file, "sh", "-c", "echo held; exec sleep 600"], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    p.on("error", reject);
    p.stdout.on("data", (d) => { if (String(d).includes("held")) resolve(() => { try { process.kill(-p.pid!, "SIGKILL"); } catch { /* gone */ } }); });
  });
}
// Each machine as its loop sees it: new leases allowed.
const on = (host: string, add: Record<string, string> = {}) => ({ FACTORY_HOST: host, FACTORY_LEASES: "1", ...add });
const next = (host: string, add: Record<string, string> = {}) => JSON.parse(t(["next", "--json"], on(host, add)).stdout).id as string | undefined;
type Q = { machines: { host: string; next: { id: string; why: string }[]; idle?: string }[] };
const queue = (host = "wren"): Q => JSON.parse(ok(["queue", "--json"], on(host)));
const first = (q: Q, host: string) => q.machines.find((m) => m.host === host)!.next[0]?.id;
// queue, run on wren, says what each machine takes next; next there says the same.
const agrees = () => { const q = queue(); for (const h of ["wren", "tern"]) assert.equal(first(q, h), next(h), `${h}: queue says ${first(q, h)}, next says ${next(h)}`); };

// Overnight 2026-10-15: each machine leased a character's group, and its lanes kept
// taking those units while Classic particles (130) and Classic sounds (125) never started.
describe("that night: two machines, each with a leased group, and higher-ranked groups elsewhere", () => {
  test("setup", () => {
    for (const [g, title, mod, pri] of [["spare", "Spare character", "5", ""], ["zed", "Zed", "1", ""], ["rook", "Rook", "2", ""], ["mpart", "Classic particles", "3", "130"], ["msnd", "Classic sounds", "4", "125"]]) {
      setup(["add-group", g, "--title", title, "--data", `mod=${mod}`, ...(pri ? ["--priority", pri] : [])]);
      for (const n of ["1", "2"]) setup(["add-unit", `${g}/u${n}`, "--title", `${title} work ${n}`, "--uses", "editor"]);
    }
    setup(["lease", "take", "zed"], { FACTORY_HOST: "wren" });
    setup(["lease", "take", "rook"], { FACTORY_HOST: "tern" });
  });
  test("queue lists the higher-ranked group first on wren, though its data isn't there", () => {
    assert.equal(first(queue(), "wren"), "mpart/u1");
  });
  test("  saying why", () => {
    assert.equal(queue().machines[0].next[0].why, "priority 130 (its group's); its data is on the store and moves to wren");
  });
  test("  and it agrees with next on both machines", agrees);
  test("wren's lane takes Classic particles", () => {
    has(ok(["next", "--claim", "--json"], on("wren", { FACTORY_TAG: "q1" })), '"id":"mpart/u1"');
  });
  test("  and its lease", () => { has(ok(["leases"]), "Classic particles (mpart): wren"); });
  test("then queue and next agree that tern takes Classic sounds, not its own Rook", () => {
    agrees();
    assert.equal(next("tern"), "msnd/u1");
  });
  test("tern's lane takes it", () => {
    has(ok(["next", "--claim", "--json"], on("tern", { FACTORY_TAG: "p1" })), '"id":"msnd/u1"');
  });
  // One editor each: wren's lane holds its editor while it works, as loop.sh does.
  const LOCKS = path.join(f.top, "wren-locks");
  let release = () => {};
  after(() => release());
  test("while wren's editor is in use, wren's second lane takes nothing that needs it", async () => {
    fs.mkdirSync(LOCKS, { recursive: true });
    release = await hold(path.join(LOCKS, "res-editor.lock"));
    const j = JSON.parse(t(["next", "--json"], on("wren", { FACTORY_TAG: "q2", FACTORY_LOCKS: LOCKS })).stdout);
    assert.equal([j.code, j.wait].join(","), "1,true", JSON.stringify(j));
  });
  test("  and queue on wren says so", () => {
    has(ok(["queue"], on("wren", { FACTORY_LOCKS: LOCKS })), "wren (this machine):\n  nothing workable:");
  });
  // Lanes on one machine share work/: while q1 works on Classic particles' data there, another
  // lane takes no unit on that data, and goes to the group leased there that's next in rank.
  test("once it's free, wren's next lane leaves Classic particles to the lane working on it", () => {
    release();
    agrees();
    assert.equal(next("wren", { FACTORY_TAG: "q2" }), "zed/u1");
  });
  test("  and stays on Classic particles once that lane's session is gone", () => {
    const was = f.read("tracker/groups/mpart.json");
    f.edit("tracker/groups/mpart.json", (g) => { const r = g.units[0].record; r.pid = 999999; r.start = "1"; r.ended = "2026-10-10T00:00:00Z"; });
    const id = next("wren", { FACTORY_TAG: "q2" });
    f.write("tracker/groups/mpart.json", was);
    // (The interrupted unit itself comes back first.)
    assert.equal(id, "mpart/u1");
  });
  test("queue lists another machine's in-progress unit as nobody's own", () => {
    hasnt(ok(["queue"], on("wren", { FACTORY_TAG: "q1" })), "tern:\n  1. Classic particles work 1 (mpart/u1)");
  });
  test("with both higher groups done, each machine goes back to the group it leases", () => {
    for (const [u, h] of [["mpart/u1", "wren"], ["mpart/u2", "wren"], ["msnd/u1", "tern"], ["msnd/u2", "tern"]]) setup(["drop", u, "--why", "test"], { FACTORY_HOST: h });
    agrees();
    assert.equal([next("wren"), next("tern")].join(","), "zed/u1,rook/u1");
  });
  after(() => {
    for (const g of ["mpart", "msnd"]) setup(["lease", "release", g, "--force"]);
  });
});

describe("a unit's own priority, ties, and units that come back", () => {
  // Left from the night: zed leased by wren, rook by tern, spare by nobody, all priority 0.
  test("a unit's own priority beats another group's", () => {
    setup(["add-group", "early", "--title", "Early work", "--priority", "50"]);
    setup(["add-unit", "early/a", "--title", "Early thing"]);
    setup(["add-group", "late", "--title", "Late work"]);
    setup(["add-unit", "late/hot", "--title", "Hot late thing", "--priority", "60"]);
    assert.equal(next("wren"), "late/hot");
  });
  test("  but one below its group's doesn't sink it, and orders it within the group as before", () => {
    setup(["add-unit", "early/low", "--title", "Low early thing", "--priority", "10"]);
    setup(["add-unit", "early/b", "--title", "Second early thing", "--priority", "20"]);
    setup(["add-group", "mid", "--title", "Middle work", "--priority", "20"]);
    setup(["add-unit", "mid/a", "--title", "Middle thing"]);
    assert.deepEqual(JSON.parse(ok(["queue", "-n", "5", "--json"], on("wren"))).machines[0].next.map((u: { id: string }) => u.id),
      ["late/hot", "early/b", "early/low", "early/a", "mid/a"]);
  });
  test("  setting it says it ranks at its group's", () => { has(ok(["edit", "early/low", "--priority", "5"]), "priority 5 (it ranks at its group's 50): runs before"); });
  test("queue lists 3 per machine", () => { assert.equal(queue().machines[0].next.length, 3); });
  test("  or -n of them", () => { assert.equal(JSON.parse(ok(["queue", "-n", "2", "--json"], on("wren"))).machines[0].next.length, 2); });
  test("  queue says where each priority comes from", () => {
    const q = queue().machines[0].next;
    assert.deepEqual([q[0].why, q[1].why], ["priority 60", "priority 50 (its group's)"]);
  });
  test("a unit's card says the same", () => { has(ok(["show", "early/a"]), "Order: priority 50 (its group's); runs before"); });
  test("an interrupted unit doesn't come back ahead of a higher priority", () => {
    for (const u of ["late/hot", "early/low", "early/b", "mid/a"]) setup(["drop", u, "--why", "test"]);
    setup(["add-unit", "late/back", "--title", "Late thing that stopped"]);
    f.edit("tracker/groups/late.json", (g) => {
      g.units.find((u: { id: string }) => u.id === "late/back").record = { state: "claimed", by: "dead", host: "wren", pid: 999999, start: "1", at: "2026-10-10T00:00:00Z" };
    });
    assert.equal(next("wren"), "early/a");
  });
  test("  but at equal priority it does, ahead of earlier groups and leased data", () => {
    setup(["drop", "early/a", "--why", "test"]);
    assert.equal(next("wren"), "late/back");
  });
  test("  so does a review that isn't this session's", () => {
    setup(["add-unit", "late/rev", "--title", "Late thing to check"]);
    ok(["claim", "late/rev"], on("wren", { FACTORY_TAG: "w9" })); ok(["review", "late/rev", "--evidence", "x"], on("wren", { FACTORY_TAG: "w9" }));
    assert.deepEqual(queue().machines[0].next.map((u) => u.id), ["late/back", "late/rev", "zed/u1"]);
  });
  test("  but not to the session that worked it", () => { assert.equal(JSON.parse(ok(["queue", "-n", "9", "--json"], on("wren", { FACTORY_TAG: "w9" }))).machines[0].next.some((u: { id: string }) => u.id === "late/rev"), false); });
  test("  saying so in queue", () => { assert.equal(queue().machines[0].next[0].why, "no priority; interrupted, so it comes back first among units of its priority"); });
  test("  and queue agrees with next", agrees);
  test("a lane's own unit in progress comes first, above a higher priority", () => {
    ok(["claim", "zed/u2"], on("wren", { FACTORY_TAG: "mine" }));
    setup(["add-unit", "late/top", "--title", "Top late thing", "--priority", "90"]);
    assert.equal(next("wren", { FACTORY_TAG: "mine" }), "zed/u2");
  });
  test("  and to other lanes, it isn't offered", () => { assert.equal(next("wren"), "late/top"); });
  test("at equal priority, data leased here beats an earlier group", () => {
    ok(["unclaim", "zed/u2"], on("wren", { FACTORY_TAG: "mine" }));
    for (const u of ["late/back", "late/rev", "late/top"]) setup(["drop", u, "--why", "test"]);
    assert.equal([next("wren"), next("tern")].join(","), "zed/u1,rook/u1");
  });
  test("  and then the rest by group order", () => {
    setup(["add-group", "code", "--title", "Code work"]); setup(["add-unit", "code/a", "--title", "Code thing"]);
    assert.deepEqual(JSON.parse(ok(["queue", "-n", "4", "--json"], on("wren"))).machines[0].next.map((u: { id: string }) => u.id), ["zed/u1", "zed/u2", "spare/u1", "spare/u2"]);
  });
  test("with nothing it can take, a machine's queue says why", () => {
    for (const u of ["zed/u1", "zed/u2", "code/a", "spare/u1", "spare/u2"]) setup(["drop", u, "--why", "test"]);
    has(ok(["queue"], on("wren")), "wren (this machine):\n  nothing workable: 2 units of Rook (leased by tern)");
  });
});

// Before the one order, a unit at 100 or more ran ahead of every group, and a unit's own priority
// otherwise only ordered it within its group. The first load turns the first kind into priorities
// above every group's, so they still run first.
describe("an old tracker's priorities of 100 or more stay ahead of every group", () => {
  const o = trackerRepo("old", { FACTORY_TAG: "worker1", FACTORY_EVIDENCE_MIN: "0" });
  o.setup(["init", "--title", "Old"]);
  test("setup", () => {
    o.setup(["add-group", "big", "--title", "Big group", "--priority", "1034"]); o.setup(["add-unit", "big/a", "--title", "Big thing"]);
    o.setup(["add-group", "fx", "--title", "Effects"]);
    o.setup(["add-unit", "fx/a", "--title", "Urgent effects", "--priority", "120"]); o.setup(["add-unit", "fx/b", "--title", "Plain effects", "--priority", "5"]);
    o.edit("tracker/project.json", (p) => { delete p.ranking; });
  });
  test("a read ranks the urgent unit first", () => { has(o.ok(["next"]), "Urgent effects"); });
  test("  and writes nothing", () => {
    assert.equal(o.json("tracker/groups/fx.json").units[0].priority, 120);
    assert.equal(o.json("tracker/project.json").ranking, undefined);
  });
  test("  above the top group's, by its old priority", () => { has(o.ok(["queue"]), "1. Urgent effects (fx/a): priority 1154"); });
  test("  and the rest as before", () => { has(o.ok(["queue"]), "2. Big thing (big/a): priority 1034 (its group's)\n  3. Plain effects (fx/b): priority 5"); });
  test("a write saves it", () => {
    o.ok(["note", "big/a", "a write"]);
    assert.equal(o.json("tracker/groups/fx.json").units.map((u: { priority?: number }) => u.priority).join(","), "1154,5");
  });
  test("  once", () => {
    assert.equal(o.json("tracker/project.json").ranking, 2);
    o.ok(["note", "big/a", "another write"]);
    assert.equal(o.json("tracker/groups/fx.json").units[0].priority, 1154);
  });
  test("  and the log says so", () => { has(o.ok(["log"]), "priorities of 100 or more, which ran ahead of every group, now rank above them all: Urgent effects 1154"); });
});

describe("an old focus list and urgent units, converted in one load", () => {
  const o = trackerRepo("oldfocus", { FACTORY_TAG: "worker1", FACTORY_EVIDENCE_MIN: "0" });
  o.setup(["init", "--title", "Old focus"]);
  test("setup", () => {
    o.setup(["add-group", "top", "--title", "Top group", "--priority", "40"]); o.setup(["add-unit", "top/a", "--title", "Top thing"]);
    o.setup(["add-group", "foc", "--title", "Focused group"]); o.setup(["add-unit", "foc/a", "--title", "Focused thing"]);
    o.setup(["add-group", "fx", "--title", "Effects"]); o.setup(["add-unit", "fx/a", "--title", "Urgent effects", "--priority", "100"]);
    o.edit("tracker/project.json", (p) => { delete p.ranking; p.focus = ["foc"]; });
    o.ok(["note", "top/a", "a write"]);
  });
  test("focus goes above the other groups, and the urgent unit above it", () => {
    assert.equal([o.json("tracker/groups/foc.json").priority, o.json("tracker/groups/fx.json").units[0].priority].join(","), "41,141");
  });
  test("  in that order", () => { has(o.ok(["queue"]), "1. Urgent effects (fx/a): priority 141\n  2. Focused thing (foc/a): priority 41 (its group's)\n  3. Top thing (top/a)"); });
});

describe("a tracker already on the one order converts nothing", () => {
  const o = trackerRepo("new", { FACTORY_TAG: "worker1", FACTORY_EVIDENCE_MIN: "0" });
  o.setup(["init", "--title", "New"]);
  test("a unit at 100 set now stays at 100", () => {
    o.setup(["add-group", "g", "--title", "Group", "--priority", "500"]); o.setup(["add-unit", "g/a", "--title", "Thing", "--priority", "100"]);
    o.ok(["note", "g/a", "a write"]);
    assert.equal(o.json("tracker/groups/g.json").units[0].priority, 100);
  });
  test("  nor with a later ranking", () => {
    o.edit("tracker/project.json", (p) => { p.ranking = 3; });
    o.ok(["note", "g/a", "another write"]);
    assert.equal(o.json("tracker/groups/g.json").units[0].priority, 100);
  });
});

// 2026-10-29: Yoshi's CI fix sat ready for 7 hours behind higher-priority effects work, and Yoshi
// missed the playtest.
describe("a group's CI fix comes before any other work, at any priority", () => {
  const o = trackerRepo("cifix", { FACTORY_TAG: "worker1", FACTORY_EVIDENCE_MIN: "0" });
  o.setup(["init", "--title", "CI fix first"]);
  const nx = () => JSON.parse(o.t(["next", "--json"], { FACTORY_HOST: "wren" }).stdout).id as string | undefined;
  test("setup: effects work at 900, and a fighter whose drill fails", () => {
    o.edit("tracker/project.json", (p) => { p.ci = { steps: { drill: { cmd: "just drill {group}" } } }; });
    o.setup(["add-group", "fx", "--title", "Effects", "--priority", "900"]); o.setup(["add-unit", "fx/a", "--title", "Urgent effects"]);
    o.setup(["add-group", "yo", "--title", "Yoshi", "--ci", "drill"]); o.setup(["add-unit", "yo/a", "--title", "Yoshi thing"]);
    o.setup(["ci-start", "yo", "--force"]); o.setup(["ci-fail", "yo", "--evidence", "drill: 3 clips drift", "--step", "drill"]);
    assert.equal(o.ok(["state", "yo/ci-fix"]).trim(), "ready");
  });
  test("  next offers the fix first", () => { assert.equal(nx(), "yo/ci-fix"); });
  test("  and queue agrees", () => { has(o.ok(["queue"]), "1. Fix Yoshi's CI (yo/ci-fix)"); });
  test("  its card says to fix shared causes for every group, and rerun the failed step only", () => {
    const c = o.ok(["show", "yo/ci-fix"]);
    has(c, "fix it for every group it reaches");
    has(c, "Rerun the failed step, not the whole build");
  });
});
