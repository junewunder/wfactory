// The fleet on this machine (the bash suite's "fleet on this machine", but its deploy checks, which
// are deploy.test.ts): fleet start pulls the skill's checkout and starts the lane as a unit; the
// daemon has its record and comes back when killed; fleet beat, tell, wait (what wakes it, by
// tier, and a lane that stops), summary, events, stop, last-call, stop-at, tidy; a machine ssh
// can't reach; fleet usage. The lane's one unit is held until the test lets it go, so the lane is
// still running at each wait until the one for a lane that stops.
// Run: node --test test/loop/fleet/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { linuxOnly, has, hasnt, readOr, until, HOST, active, killPid } from "../../lib/index.ts";
import { fleetFactory, hog, readNext } from "./helpers.ts";

const f = fleetFactory("ffleet");
const { F, P, w, run, bg, fleet, oversee, dmn, setup, hold, lane, ev, dpid, record } = f;
const W = w.top, L1 = lane(1);
const { HOG } = hog(w.at("oombin"));
const git = (dir: string, ...a: string[]) => w.git(dir, ...a);
// fleet start pulls the skill the machine's tracker runs from: a throwaway skill checkout here
// (never this repo), one commit behind its origin.
git(W, "init", "-q", "--bare", w.at("skill-origin.git"));
git(W, "clone", "-q", w.at("skill-origin.git"), w.at("skill"));
fs.mkdirSync(w.at("skill/tracker")); fs.writeFileSync(w.at("skill/tracker/main.ts"), "// the skill's tracker\n");
git(w.at("skill"), "add", "-A"); git(w.at("skill"), "commit", "-qm", "skill"); git(w.at("skill"), "branch", "-q", "-M", "main"); git(w.at("skill"), "push", "-q", "origin", "main");
git(W, "clone", "-q", w.at("skill-origin.git"), w.at("skill2"));
git(w.at("skill2"), "commit", "-q", "--allow-empty", "-m", "a fix"); git(w.at("skill2"), "push", "-q", "origin", "main");
w.env.FACTORY_SKILL_CHECKOUT = w.at("skill");
const out = (args: string[], add: NodeJS.ProcessEnv = {}) => fleet(args, add).stdout;
const LANE = `factory-${P}-lane1`;
const mf = path.join(F, "docs/machines.md");
const editMachines = (fn: (s: string) => string) => fs.writeFileSync(mf, fn(readOr(mf)));
// fleet wait in the background, and the moment it has taken its first look at the lane's events
// (so an event logged after is news to it).
async function waitFor(args: string[]) {
  const read = readNext(path.join(L1, "runs/events.log"));
  const b = bg(path.join(F, "factory/fleet.sh"), ["wait", ...args], { add: { FACTORY_WAIT_EVERY: "1" } });
  await read();
  return b;
}

// What an earlier run's waits left: a kill they told, from long ago, and the record of it. A new
// run hears of kills from its own start on (the first wait below wakes only for time).
fs.mkdirSync(path.join(F, "runs"), { recursive: true });
fs.writeFileSync(path.join(F, "runs/.fleet-memory"), JSON.stringify({ [HOST]: { since: 1000, low: false } }) + "\n");
fs.writeFileSync(w.env.FACTORY_KERNEL_LOG!, `2000.000000 ${HOST} kernel: oom-kill:constraint=CONSTRAINT_NONE,nodemask=(null),global_oom,task_memcg=/user.slice/old.scope,task=olden,pid=7,uid=1000\n`);
const seven = hold("g/seven");
describe("fleet on this machine: start, heartbeat, stop", () => {
  let start = "";
  test("fleet start: this machine's lane", async () => {
    setup(["add-unit", "g/seven", "--title", "Unit seven"]);
    start = out(["start", "--hours", "0.05", "--no-awake"]);
    has(start, `=== ${HOST} lane 1`);
  });
  test("  after updating the machine's skill checkout", () => { has(start, "the skill's checkout: updated"); });
  test("  with FACTORY_SKILL set, lanes run that and nothing is deployed", () => { has(start, "lanes run FACTORY_SKILL"); });
  test("  which has origin's fix", () => { assert.equal(git(w.at("skill"), "log", "--format=%s", "-1"), "a fix"); });
  test("fleet beat: one heartbeat line", async () => {
    await seven.held();
    has(out(["beat"]), "1 busy, 0 waiting, 0 stopped");
  });
  test("  naming the unit", () => { has(out(["beat"]), "Unit seven (g/seven)"); });
  // How long the session has run and when it last wrote its transcript (2026-10-19:
  // the overseer ran ls -t on transcripts to tell a session still moving from a stuck one).
  test("  how long its session has run, and when its transcript was last written", () => {
    assert.match(out(["beat"]), /Unit seven \(g\/seven\), [0-9]+ (s|min) in, transcript written [0-9]+ (s|min) ago/);
  });
  test("  and each machine's memory available", () => { has(out(["beat"]), `memory available: ${HOST} 16.0 GB`); });
});

// The daemon: fleet start left a record of the lane and started it; killed outright, the lane goes
// on, and the daemon is back within seconds with the lane in its records.
describe("the daemon, with a lane running", () => {
  let st = "";
  test("the daemon runs once a lane has started", () => { st = dmn(["status"]).stdout; has(st, "running (pid"); });
  test("  with the lane's record", () => { has(st, `${LANE}: running in ${L1}`); });
  let was = 0, now = 0;
  test("the daemon killed outright is started again", linuxOnly("systemd restarts it at once; macOS's crontab within a minute (runtime/test/os-jobs.test.ts)"), async () => {
    was = dpid();
    assert.ok(was > 0, "the daemon runs");
    assert.ok(killPid(was, "SIGKILL"), "the daemon was killed");
    await until(() => { now = dpid(); return now !== 0 && now !== was; }, "the daemon is started again", 20);
  });
  test("  the lane went on meanwhile", () => { assert.ok(active(`${LANE}.service`)); });
  test("  and the new daemon has it", () => { has(dmn(["status"]).stdout, `${LANE}: running`); });
  test("  (no resumed event)", () => { hasnt(readOr(path.join(L1, "runs/events.log")), "\tresumed\t"); });
});

describe("fleet tell", () => {
  test("fleet tell <unit>: the lane working it is told", () => { has(out(["tell", "g/seven", "Wrap up soon"]), "told session"); });
  const inbox = path.join(L1, "runs/inbox/current");
  const newMail = () => { try { return fs.readdirSync(path.join(inbox, "new")).map((m) => readOr(path.join(inbox, "new", m))).join(""); } catch { return ""; } };
  test("  into that session's inbox", () => { has(newMail(), "Wrap up soon"); });
  test("fleet tell <machine>/<lane>", () => { has(out(["tell", `${HOST}/1`, "Another"]), `=== ${HOST} lane 1`); });
  test("fleet tell: a unit nobody is working, exit 3", () => {
    // As its hook would: read.
    for (const m of fs.readdirSync(path.join(inbox, "new"))) fs.renameSync(path.join(inbox, "new", m), path.join(inbox, "done", m));
    assert.equal(fleet(["tell", "g/nobody", "hello"]).code, 3);
  });
  test("  and a lane told for a unit it no longer works refuses", () => { has(oversee(["tell", "--unit", "g/other", "--", "hello"]).stdout, "works g/seven now, not g/other"); });
  test("fleet start refuses a machine that isn't in the file", () => { assert.equal(fleet(["start", "nosuchbox", "--hours", "0.01"]).code, 2); });
  test("fleet start refuses --until with --hours too", () => {
    const r = fleet(["start", "--until", "09:00", "--hours", "0.01"]);
    assert.equal(r.code, 2);
    has(r.stdout, "pass one");
  });
});

describe("fleet wait: what wakes it", () => {
  // A morning-summary event (a set-aside) doesn't wake the overseer: the wait runs out, exit 0.
  let r = { code: 0, stdout: "" };
  test("fleet wait: a summary event doesn't wake it, and the time running out exits 0", async () => {
    const b = await waitFor(["--minutes", "0.1"]);
    ev("store-aside", `set aside Group's data on ${HOST}`);
    r = await b.end();
    assert.equal(r.code, 0);
  });
  test("  it says why it woke", () => { has(r.stdout, "woke: time"); });
  test("  (not for a kill from before the run started)", () => { hasnt(r.stdout, "olden"); });
  test("  nothing for the owner", () => { hasnt(r.stdout, "--- for the owner"); });
  test("  and that the summary has one more", () => { has(r.stdout, "(1 more for the morning summary"); });
  let sum = "";
  test("fleet summary: the summary events since the run started", () => { sum = out(["summary"]); has(sum, "The rest:\n  store-aside (1):"); });
  test("  after saying nothing went wrong, first", () => { has(sum, "What went wrong:\n  nothing\nThe rest:"); });
  test("  with what they said", () => { has(sum, `set aside Group's data on ${HOST}`); });
  // Each group's CI since the run started, after the events: one cut off says so.
  test("  then each group's CI: a run cut off says so, where it was cut", () => {
    f.editMain("tracker/project.json", (p) => { p.ci = { steps: { drill: { cmd: "true" } } }; });
    setup(["add-group", "gcut", "--title", "Group Cut", "--ci", "drill"]);
    // (Its unit done by hand on main, not through `done`: the night's done count, which summary --done
    // checks below, stays the run's own.)
    setup(["add-unit", "gcut/a", "--title", "Cut a"]);
    f.editMain("tracker/groups/gcut.json", (g) => { g.units[0].record = { state: "done", by: "test", at: new Date().toISOString().replace(/\.\d+Z$/, "Z"), evidence: "x" }; });
    setup(["ci-start", "gcut"]); setup(["ci-unclaim", "gcut", "--cut", "the machine froze", "--step", "drill"]);
    const o = out(["summary"]);
    has(o, "What went wrong:\n  Group CI that didn't pass:\n    Group Cut (gcut): cut off: at drill, the machine froze; started ");
  });
  // The bad news first (#78): an owner reads the top of the report.
  test("  the problems first, whichever tier they're in, then the rest", () => {
    ev("review-skipped", "Unit q (g/q) landed without the loop's review: its review ran over 30 minutes");
    const o = out(["summary"]);
    const at = (x: string) => { const i = o.indexOf(x); assert.ok(i >= 0, `no ${x} in:\n${o}`); return i; };
    assert.ok(at("What went wrong:") < at("review-skipped (1):"));
    assert.ok(at("review-skipped (1):") < at("The rest:"));
    assert.ok(at("The rest:") < at("store-aside (1):"));
    has(o, "landed without the loop's review: its review ran over 30 minutes");
  });
  // Under each problem, the unit it happened in and what became of it, as the tracker has it now:
  // an overseer once reported a killed job as rerun and finished when it was neither.
  let sum2 = "";
  test("  under a problem event, its unit, the unit's status now and its newest note", () => {
    setup(["add-unit", "g/emsum", "--title", "Sum the emitters"]);
    setup(["note", "g/emsum", "Split the big part off; the rerun never finished"]);
    setup(["block", "g/emsum", "--why", "the rerun at 8G was killed too"]);
    ev("oom-kill", "just long start emsum (make sum) was killed: out of memory at 6G\tg/emsum");
    sum2 = out(["summary"]);
    has(sum2, "just long start emsum (make sum) was killed: out of memory at 6G\n      unit: Sum the emitters (g/emsum): stuck: the rerun at 8G was killed too\n      last note: Split the big part off; the rerun never finished");
  });
  test("  a line that names no unit but its message does: that one", () => {
    ev("stuck", "Sum the emitters (g/emsum): stuck after its review");
    has(out(["summary"]), "Sum the emitters (g/emsum): stuck after its review\n      unit: Sum the emitters (g/emsum): stuck");
  });
  test("  an older kill in a job, with no unit: the session open on that host then", () => {
    ev("oom-kill", "just capped make all was killed: out of memory at 4G");
    has(out(["summary"]), "just capped make all was killed: out of memory at 4G\n      unit: Unit seven (g/seven): in progress");
  });
  test("  one in a unit with none to be found: unit: unknown", () => {
    ev("silent", "a session said nothing for 30 minutes");
    has(out(["summary"]), "a session said nothing for 30 minutes\n      unit: unknown");
  });
  test("  (and the events list doesn't print the unit field)", () => { hasnt(out(["events", "50"]), "6G · g/emsum"); });
  // The check-in offer (tracker prune --due), after the CI: only when one is due.
  test("  no check-in offer when none is due", () => { hasnt(out(["summary"]), "Check-in due"); });
  test("  a due one: the decisions to prune", () => {
    f.editMain("tracker/decisions.json", (j) => { j.decisions.push({ id: "d/cut-first-tonight", title: "Group Cut first tonight", why: "the owner", by: "owner", at: "2020-01-01T20:00:00Z", scope: ["*"] }); });
    f.editMain("tracker/project.json", (p) => { p.prune_at = 0; });
    const o = out(["summary"]);
    has(o, "Check-in due (an open unit's card carries 1 decision, over 0): 1 decision to prune.");
    has(o, "Group Cut first tonight (the owner, 2020-01-01; d/cut-first-tonight)\n     Lapse: it says \"tonight\"");
  });
  test("  a start time it can't read: it says so, and the events still come", () => {
    const sf = path.join(F, "runs/.fleet-start"), was = readOr(sf);
    fs.writeFileSync(sf, "not a time\n");
    const o = fleet(["summary"]);
    if (was) fs.writeFileSync(sf, was); else fs.rmSync(sf, { force: true });
    assert.equal(o.code, 0);
    has(o.stdout, "Group CI: no time to look from (not a time)");
  });
  // A project can move a kind to wake now (tracker/project.json "events").
  const pj = path.join(F, "tracker/project.json"), was = readOr(pj);
  const events = (e: unknown) => fs.writeFileSync(pj, JSON.stringify({ ...JSON.parse(was), events: e }, null, 2) + "\n");
  test("  a project's own wake list wakes it", async () => {
    events({ wake: ["store-aside"] });
    const b = await waitFor(["--minutes", "0.2"]);
    ev("store-aside", "set aside again");
    has((await b.end()).stdout, "woke: news: store-aside");
  });
  test("  and its summary list quiets a kind that wakes by default", async () => {
    events({ summary: ["stuck"] });
    const b = await waitFor(["--minutes", "0.1"]);
    ev("stuck", "Some unit (g/x): stuck: a test");
    const o = (await b.end()).stdout;
    fs.writeFileSync(pj, was);
    has(o, "woke: time");
  });
  test("a stuck unit wakes fleet wait", async () => {
    const b = await waitFor(["--minutes", "0.2"]);
    ev("stuck", "Refused unit (g/refused): stuck: a test");
    has((await b.end()).stdout, "woke: news: stuck");
  });
  // A capped job in the lane killed over its cap, while fleet wait watches.
  test("fleet wait reports a capped job's out-of-memory kill, exit 0", async () => {
    const b = await waitFor(["--minutes", "1"]);
    await bg("just", ["capped", ...HOG.split(" ")], { cwd: L1, add: { FACTORY_MEM: "20M" } }).end();
    r = await b.end();
    assert.equal(r.code, 0);
  });
  test("  saying it woke for news", () => { has(r.stdout, "woke: news: oom-kill"); });
  test("  for the owner, with the cap", () => { has(r.stdout, `${HOST} · oom-kill · just capped ${HOG} was killed: out of memory at 20M`); });
});

// The machine's memory, as its daemon reads it (stand-ins: test/lib's originFactory).
describe("fleet wait: a machine short of memory", () => {
  const klog = w.env.FACTORY_KERNEL_LOG!, meminfo = w.env.FACTORY_MEMINFO!;
  const plenty = readOr(meminfo);
  let r = { code: 0, stdout: "" };
  test("an out-of-memory kill in the kernel's log wakes fleet wait", linuxOnly("Linux's kernel log"), async () => {
    const b = await waitFor(["--minutes", "1"]);
    const t = (Date.now() / 1000).toFixed(6);
    fs.appendFileSync(klog, `${t} ${HOST} kernel: oom-kill:constraint=CONSTRAINT_NONE,nodemask=(null),cpuset=user.slice,mems_allowed=0,global_oom,task_memcg=/user.slice/app.slice/editor.service,task=GameThread,pid=4242,uid=1000
${t} ${HOST} kernel: Out of memory: Killed process 4242 (GameThread) total-vm:1kB, anon-rss:7340032kB, file-rss:0kB, shmem-rss:0kB, UID:1000 pgtables:1kB oom_score_adj:0
`);
    r = await b.end();
    assert.equal(r.code, 0);
  });
  test("  as news: oom", linuxOnly("Linux's kernel log"), () => { has(r.stdout, "woke: news: oom"); });
  test("  for the owner: what was killed, how big, where, and that the machine ran out", linuxOnly("Linux's kernel log"), () => {
    has(r.stdout, `${HOST} · oom · the kernel killed GameThread (pid 4242, holding 7.0 GB) in editor.service: the machine ran out of memory`);
  });
  test("  noted in the overseer's journal", linuxOnly("Linux's kernel log"), () => { has(readOr(path.join(F, "runs/oversee.log")), "oom on"); });
  test("  the next wait doesn't wake for it again", async () => { has((await (await waitFor(["--minutes", "0.25"])).end()).stdout, "woke: time"); });
  test("memory available falling under the floor wakes it", async () => {
    const b = await waitFor(["--minutes", "1"]);
    fs.writeFileSync(meminfo, "MemTotal:       33554432 kB\nMemAvailable:    2097152 kB\n");
    r = await b.end();
    has(r.stdout, "woke: news: memory-low");
  });
  test("  saying how much is left, under the machine's reserve (3G when docs/machines.md gives none)", () => { has(r.stdout, `${HOST} has 2.0 GB of memory available, under its 3.0 GB reserve (docs/machines.md, Reserve and GPU)`); });
  test("  and the beat says so", () => { has(r.stdout, `memory available: ${HOST} 2.0 GB (under its 3.0 GB reserve)`); });
  test("  told once: the next wait doesn't wake while it stays low", async () => {
    const o = (await (await waitFor(["--minutes", "0.1"])).end()).stdout;
    fs.writeFileSync(meminfo, plenty);
    has(o, "woke: time");
  });
  test("  and fleet summary puts it with what went wrong, from the overseer's journal", () => {
    const o = out(["summary"]);
    has(o, "in the overseer's journal (");
    has(o, `memory-low on ${HOST}: ${HOST} has 2.0 GB of memory available`);
    assert.ok(o.indexOf("memory-low on") < o.indexOf("The rest:"), o);
  });
  // The floor is each machine's own reserve, as \`just heavy\` reads it: Reserve and GPU, the
  // table's last two columns.
  const was = readOr(mf);
  test("the floor is the machine's Reserve and GPU in docs/machines.md", async () => {
    has((await (await waitFor(["--minutes", "0.05"])).end()).stdout, "woke: time");   // (back above: told again)
    editMachines((t) => t.split("\n").map((l) => l.startsWith(`| ${HOST} |`) ? l.replace(/\| [^|]* \| [^|]* \|$/, "| 5G | 1G |") : l).join("\n"));
    const b = await waitFor(["--minutes", "1"]);
    fs.writeFileSync(meminfo, "MemTotal:       33554432 kB\nMemAvailable:    4194304 kB\n");
    r = await b.end();
    fs.writeFileSync(meminfo, plenty);
    fs.writeFileSync(mf, was);
    has(r.stdout, "woke: news: memory-low");
  });
  test("  4 GB is under its 6 GB", () => { has(r.stdout, `${HOST} has 4.0 GB of memory available, under its 6.0 GB reserve`); });
});

describe("fleet beat: what holds each machine's budget of heavy jobs", () => {
  const editor = bg("sleep", ["300"]);
  test("a standing reservation, and one more", () => {
    const r = w.just(["heavy", "reserve", "editor", "8G", "--pid", String(editor.pid)], F);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(w.just(["heavy", "reserve", "bake", "2G", "--pid", String(editor.pid)], F).code, 0);
  });
  test("  the beat names them by machine, biggest first", () => { has(out(["beat"]), `memory available: ${HOST} 16.0 GB (budget held by editor 8.0 GB, bake 2.0 GB)`); });
  test("  and not once they're let go", () => {
    for (const n of ["editor", "bake"]) assert.equal(w.just(["heavy", "release", n], F).code, 0);
    killPid(editor.pid!, "SIGKILL");
    has(out(["beat"]), `memory available: ${HOST} 16.0 GB ·`);
  });
});

describe("fleet wait: one per overseer", () => {
  test("a second wait for the same overseer is refused, exit 2", async () => {
    const b = await waitFor(["--minutes", "0.2", "--as", "ovX"]);
    const r = fleet(["wait", "--minutes", "0.1", "--as", "ovX"]);
    await b.end();
    assert.equal(r.code, 2);
    has(r.stdout, "a wait for overseer ovX is already running (pid");
  });
  test("  another overseer's wait isn't", async () => {
    const b = await waitFor(["--minutes", "0.1", "--as", "ovX"]);
    const r = fleet(["wait", "--minutes", "0.05", "--as", "ovY"]);
    await b.end();
    has(r.stdout, "woke: time");
  });
});

describe("fleet wait: a lane that stops", () => {
  let r = { code: 0, stdout: "" };
  test("fleet wait returns when a lane stops", async () => {
    const b = await waitFor(["--minutes", "3"]);
    seven.go();
    r = await b.end();
    assert.equal(r.code, 0);
  });
  // Why it woke, then the heartbeat, are its last lines (a finished background command's
  // notice shows the end of its output).
  const ls = () => r.stdout.replace(/\n+$/, "").split("\n");
  test("  saying so at the end, then the heartbeat", () => {
    const i = ls().findIndex((l) => l.startsWith("woke: "));
    assert.equal(ls()[i], `woke: a lane stopped: ${HOST}/lane1`);
    has(ls().slice(i + 1).join("\n"), "0 busy, 0 waiting, 1 stopped");
    assert.ok(ls().slice(i + 1).every((l) => !l.startsWith("stopped:") && !l.startsWith("--- ")), "only the heartbeat after it");
  });
  test("  naming it", () => { has(r.stdout, `stopped: ${HOST}/lane1`); });
  test("  with a heartbeat", () => { has(r.stdout, "0 busy, 0 waiting, 1 stopped"); });
  test("  each wake noted in the overseer's journal", () => { has(readOr(path.join(F, "runs/oversee.log")), `wait: woke: a lane stopped: ${HOST}/lane1`); });
  test("  a lane that stops by itself drops its daemon record", () => { assert.ok(!fs.existsSync(record(LANE))); });
});

describe("fleet events, stop, last-call, stop-at, tidy", () => {
  test("fleet events", () => { has(out(["events", "5"]), "lane-stop"); });
  let stop = "";
  test("fleet stop", () => { stop = out(["stop"]); has(stop, "not running"); });
  test("fleet last-call reaches each lane", () => { fleet(["last-call"]); assert.ok(fs.existsSync(path.join(L1, "runs/.last-call"))); });
  test("fleet stop-at gives each lane a stop time to come", () => {
    fleet(["stop-at", "23:59"]);
    assert.ok(Number(readOr(path.join(L1, "runs/.stop-at")) || 0) > Date.now() / 1000);
  });
  test("  a date in the past is refused", () => { assert.equal(fleet(["stop-at", "2020-01-01 09:00"]).code, 2); });
  test("  and so are no time and now", () => { assert.equal(fleet(["stop-at", ""]).code, 2); });
  test("  (now)", () => {
    const c = fleet(["stop-at", "now"]).code;
    for (const x of [".last-call", ".stop-at"]) fs.rmSync(path.join(L1, "runs", x), { force: true });
    assert.equal(c, 2);
  });
  test("  and tidies the machine", () => { has(stop, "factory/tidy: done"); });
  test("fleet tidy: a machine with no lane running", () => { has(out(["tidy"]), `=== ${HOST}`); });
  // The machines file gives checkouts as ~/…: lane clones are found from that too.
  test("  it reaches lane clones when the checkout is ~/…", () => {
    fs.mkdirSync(w.at("home")); fs.symlinkSync(F, w.at(`home/${P}`)); fs.symlinkSync(L1, w.at(`home/${P}-lane1`));
    editMachines((s) => s.replace(`${F} `, `~/${P} `));
    const o = out(["tidy"], { HOME: w.at("home") });
    editMachines((s) => s.replace(`~/${P} `, `${F} `));
    has(o, `factory-${P}-lane1`);
  });
  test("fleet's lane 1 ran in its own clone", () => { assert.ok(fs.statSync(path.join(L1, ".git")).isDirectory()); });
  test("  and its unit landed on main", () => {
    git(F, "fetch", "-q", "origin");
    has(git(F, "log", "--format=%s", "origin/main"), `Unit seven (g/seven): merged from ${HOST} lane 1`);
  });
  // The count for the report, from the tracker (2026-10-19: grep said 117, the
  // report 103).
  test("fleet summary --done: how many units were done since the run started", () => {
    assert.match(out(["summary", "--done"]), /^Done since [0-9-]+ [0-9:]+: 1 unit /);
  });
});

// a machine ssh can't reach is "unreachable", never "stopped"
describe("a machine ssh can't reach", () => {
  test("an unreachable machine shows as unreachable", () => {
    editMachines((s) => s.split("\n").flatMap((l) => l.startsWith(`| ${HOST} |`) ? [l, "| ghost | ghost.invalid | 1 | any | ~/nowhere |"] : [l]).join("\n"));
    has(out(["beat"]), "0 busy, 0 waiting, 1 stopped, 1 unreachable (ghost)");
  });
  test("  and fleet start says so instead of failing", () => { has(out(["start", "ghost", "--hours", "0.01"]), "unreachable"); });
  let usage = "";
  test("fleet usage: each machine's reading, from its lanes' transcripts too", () => {
    const s = Math.floor(Date.now() / 1000);
    fs.mkdirSync(path.join(L1, "runs"), { recursive: true });
    fs.writeFileSync(path.join(L1, "runs/zz-usage.jsonl"), JSON.stringify({ type: "rate_limit_event", rate_limit_info: { unifiedWindows: {
      five_hour: { utilization: 0.2, resetsAt: s + 9000 }, seven_day: { utilization: 0.06, resetsAt: s + 90000 } } } }) + "\n");
    usage = out(["usage"]);
    has(usage, `${HOST}: usage (as of`);
  });
  test("  with the week's figure", () => { has(usage, "week 6% used"); });
  test("  and where the week's line is", () => { has(usage, "week 6% used, the line is at 73%; resets"); });
  test("  an unreachable machine says so", () => { has(usage, "ghost: unreachable"); });
  test("  and it points at the newest", () => { has(usage, `newest: ${HOST}'s`); });
  test("usage.sh in a lane clone reads the checkout's and other lanes' runs too", () => {
    const sib = path.join(F, "runs/zz-sib.jsonl");
    fs.mkdirSync(path.dirname(sib), { recursive: true });
    fs.writeFileSync(sib, readOr(path.join(L1, "runs/zz-usage.jsonl")).replace("0.06", "0.25"));
    const later = new Date(Date.now() + 5000); fs.utimesSync(sib, later, later);
    const o = run(path.join(L1, "factory/usage.sh"), ["show"], { cwd: L1 }).stdout;
    fs.rmSync(sib); fs.rmSync(path.join(L1, "runs/zz-usage.jsonl"));
    has(o, "week 25% used");
  });
  // a skill checkout with changes of its own isn't pulled
  test("fleet start leaves a skill checkout with changes alone", () => {
    editMachines((s) => s.split("\n").filter((l) => !l.startsWith("| ghost |")).join("\n"));
    fs.appendFileSync(w.at("skill/tracker/main.ts"), "// local\n");
    const o = out(["start", "--hours", "0.01", "--no-awake"]);
    fleet(["stop"]);
    git(w.at("skill"), "checkout", "-q", "--", ".");
    has(o, "has changes: not updated");
  });
  // A lane's state is this run's lines: the last run's stop sat above the new start's header and
  // read as this one's (2026-10-19 01:37).
  test("a lane's state shows only its latest run's lines", () => {
    has(f.laneLog(), "Unit seven (g/seven)");
    const st = oversee(["state"]).stdout;
    has(st, "==== ");
    hasnt(st, "Unit seven (g/seven)");
  });
});
