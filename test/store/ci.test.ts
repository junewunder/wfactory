// Group CI on data: the lease holder runs it before letting the lease go, and copies what it
// rebuilt back to the store before it does; CI whose data another
// laptop leases isn't run here; a laptop with no lease claims it with the lease. A dead laptop's CI
// and claims free up once its heartbeat is stale, not after 12 hours; a live laptop's heartbeat
// keeps them, and ends a dead lane's run there at once. Run: node --test test/store/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { has, hasnt, readOr, sleeper } from "../lib/index.ts";
import { storeFactory, ONE } from "./factory.ts";
import fs from "node:fs";

const f = storeFactory(["a", "b"]);
const { add, drop, tr, leases, state, st } = f;
const [a, b] = f.lanes;
// b has the inputs here already, copied down by an earlier unit of another group.
add("f1/before"); b.loop(ONE);
// (Runs of minutes: no least time before last call for its CI groups' units.)
f.editMain("tracker/project.json", (j) => { j.ci = { steps: { drill: { cmd: "echo drilled; echo built by CI > work/out/{group}/built.txt; tail -1 work/out/{group}/log.txt" } } }; j.min_unit_minutes = 0; });
a.setup(["edit-group", "f5", "--ci", "drill"]);

describe("group CI on data: the lease holder runs it before letting the lease go", () => {
  let ci1 = "";
  test("the laptop that worked the group's last unit runs its CI before releasing the lease", () => {
    add("f5/c1", "--reads", "none");
    ci1 = b.loop(["--max", "2", "--hours", "0.05"]);
    const order = [...ci1.matchAll(/iteration 1: Unit c1|ci: Fighter f5 \(f5\): drill|f5: copied back after f5's CI run|f5: lease released[^)]*\)/g)].map((m) => m[0]).join(",");
    assert.equal(order, "iteration 1: Unit c1,ci: Fighter f5 (f5): drill,f5: copied back after f5's CI run,f5: lease released (no more units for it on b)");
  });
  test("  (and then finds nothing else to take)", () => { hasnt(ci1, "iteration 2"); });
  test("  what it rebuilt is on the store, stamped as the group's CI", () => {
    assert.equal(readOr(st("groups/f5/out/built.txt")), "built by CI\n");
    const s = JSON.parse(readOr(st("stamps/f5.json")) || "{}");
    assert.equal(s.ci, "f5"); assert.equal(s.host, "b");
  });
  test("  on the data it has (its last line, IDs written as titles)", () => {
    has(tr(a, ["ci", "f5"]).stdout + (JSON.parse(readOr(a.at(".tracker/main/tracker/groups/f5.json")) || "{}").ci?.passed?.evidence ?? ""), "drill: {unit:f5/c1} saw the input");
  });
});

describe("who runs CI on leased data", () => {
  test("CI whose data another laptop leases isn't run here", () => {
    a.setup(["reopen", "f5/c1"]); a.setup(["done", "f5/c1", "--evidence", "x"]);
    b.setup(["lease", "take", "f5"], { FACTORY_TAG: "bl" });
    const out = tr(a, ["ci-next", "--json"], { FACTORY_LEASES: "1" }).stdout;
    has(out, "its data is leased by b, which runs it");
  });
  test("  nor waited for", () => { has(tr(a, ["ci-next", "--json"], { FACTORY_LEASES: "1" }).stdout, '"wait":false'); });
  let out = "";
  test("with no lease, a laptop claims the CI", () => {
    b.setup(["lease", "release", "f5"]);
    out = tr(a, ["ci-next", "--claim", "--json"], { FACTORY_LEASES: "1", FACTORY_TAG: "ac" }).stdout;
    has(out, '"group":"f5"');
  });
  test("  taking the lease in the same push", () => { has(out, '"new_lease":true'); });
  test("  the lease", () => { assert.equal(leases(), "f5=a"); });
  test("  and lease idle keeps it while the CI runs", () => {
    const r = tr(a, ["lease", "idle"]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.ok(!r.stdout.split("\n").includes("f5"));
    assert.equal(leases(), "f5=a");
  });
  test("ci-unclaim gives the lease back too", () => {
    a.ok(["ci-unclaim", "f5"], { FACTORY_TAG: "ac" });
    assert.equal(leases(), "");
  });
});

// The loop's records (FACTORY_ACTOR=loop) live as long as its process: a sleep here, killed to kill
// the lane. The bash suite waited 3 s with FACTORY_LEASE_STALE=2; here the records are made an hour
// older on origin's main (anHourLater), past the default limit of 30 minutes.
describe("a dead laptop's CI and claims: they free up once its heartbeat is stale, not after 12 hours", () => {
  let out = "";
  test("laptop a's loop claims f5's CI", async () => {
    const lane = sleeper();
    out = tr(a, ["ci-next", "--claim", "--json"], { FACTORY_LEASES: "1", FACTORY_ACTOR: "loop", FACTORY_PID: String(lane.pid), FACTORY_TAG: "ak" }).stdout;
    await lane.kill();
    has(out, '"group":"f5"');
  });
  test("  and stamps a's heartbeat in the same write", () => { has(JSON.stringify(JSON.parse(readOr(a.at(".tracker/main/tracker/leases.json")) || "{}").hosts ?? {}), '"a"'); });
  test("with a's heartbeat fresh, b still sees it running", () => { has(tr(b, ["ci", "f5"]).stdout, "running (session ak on a"); });
  test("a dead laptop's CI is due on b once a's lease and heartbeat are stale", () => {
    f.anHourLater();
    has(tr(b, ["ci", "f5"]).stdout, "due:");
  });
  test("  and b runs it", () => {
    out = tr(b, ["ci-next", "--claim", "--json"], { FACTORY_LEASES: "1", FACTORY_ACTOR: "loop", FACTORY_TAG: "bk" }).stdout;
    has(out, '"group":"f5"');
  });
  test("  taking over the lease", () => { assert.equal(leases(), "f5=b"); });
  // A run made by hand (no loop, no heartbeat) keeps the 12-hour rule.
  test("a run started by hand on a stays running on b past the heartbeat limit", () => {
    b.setup(["ci-unclaim", "f5"], { FACTORY_TAG: "bk" });
    a.ok(["ci-start", "f5"], { FACTORY_TAG: "am" });
    f.anHourLater();
    has(tr(b, ["ci", "f5"]).stdout, "running (session am on a");
  });
  after(() => { a.setup(["ci-unclaim", "f5"], { FACTORY_TAG: "am" }); });
});

// A live laptop's heartbeat keeps its runs alive past the limit; a dead lane's run there is ended
// by the next heartbeat of another lane, at once. A code-only group: no lease, only a's own heartbeat.
describe("a live laptop's heartbeat", () => {
  const lane = sleeper();
  test("a live laptop's heartbeat keeps its CI running on b past the limit", () => {
    add("code/w1"); a.setup(["done", "code/w1", "--evidence", "x"]);   // work for the group's CI to check
    a.setup(["edit-group", "code", "--ci", "drill"]);
    assert.equal(tr(a, ["ci-next", "--claim", "--group", "code"], { FACTORY_ACTOR: "loop", FACTORY_PID: String(lane.pid), FACTORY_TAG: "al" }).code, 0);
    f.anHourLater();
    assert.equal(tr(a, ["lease", "beat"]).code, 0);
    has(tr(b, ["ci", "code"]).stdout, "running (session al on a");
  });
  test("a lane killed on a live laptop: its next heartbeat ends the run, and b sees it due at once", async () => {
    await lane.kill();
    assert.equal(tr(a, ["lease", "beat"]).code, 0);
    has(tr(b, ["ci", "code"]).stdout, "due: its last run (session al on a) stopped");
  });
  after(() => { a.setup(["edit-group", "code", "--ci", "none"]); });
});

// The loop's claim of a unit on a dead laptop is interrupted elsewhere once its heartbeat is stale.
describe("a dead lane's claim", () => {
  test("a dead lane's claim on a live laptop isn't ended by its heartbeat: it's in progress on b", async () => {
    add("code/k1");
    const lane = sleeper();
    assert.equal(tr(a, ["claim", "code/k1"], { FACTORY_ACTOR: "loop", FACTORY_PID: String(lane.pid), FACTORY_TAG: "ak2" }).code, 0);
    await lane.kill();
    assert.equal(tr(a, ["lease", "beat"]).code, 0);
    assert.equal(state("code/k1", b), "doing");
  });
  test("  and interrupted on a, for a's lanes to resume", () => { assert.equal(state("code/k1", a), "interrupted"); });
  test("  and interrupted once it's stale", () => {
    f.anHourLater();
    assert.equal(state("code/k1", b), "interrupted");
  });
  after(() => { drop("code/k1"); });
});

f.notBroken();
