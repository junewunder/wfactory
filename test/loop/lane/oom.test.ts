// A session killed over its memory cap: the lane goes on, the unit interrupted with a snapshot of
// what used the memory; a second kill by the same kind of process blocks it. The loop is the real
// factory/loop.sh, in the file's lane, its sessions capped (--mem 40M) in systemd scopes named
// after that lane. Run: node --test test/loop/
// A real kill pops Plasma's "Memory Shortage Avoided" on the desktop, so by default the hog stops
// at 16M of the 40M cap, holds it 2 s (the session's looks see it) and kills itself, and systemd's
// verdict on the scope (oom-kill) is stood in for. FACTORY_TEST_OOM=1, and always on macOS: the cap
// kills it.
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { cmd, has, hasnt, lastLine, readOr, ROOT, newest } from "../../lib/index.ts";
import { laneFactory } from "./helpers.ts";

const f = laneFactory("lane-oom");
const { a, w, setup, t, state, claude, events } = f;
// (macOS: the kills are the watch's, which pops nothing: always real.)
const realOom = !!process.env.FACTORY_TEST_OOM || process.platform === "darwin";
const hog = w.at("bin/hog");
// Grows by about 2M every 50 ms, so the session's looks catch it on the way up.
fs.writeFileSync(hog, `#!/usr/bin/env bash
x=""; while :; do x+=$(head -c 2000000 /dev/zero | tr '\\0' a); [ -n "\${FACTORY_TEST_OOM:-}" ] || [ \${#x} -lt 16000000 ] || { sleep 2; kill -9 $$; }; sleep 0.05; done
`, { mode: 0o755 });
let PATH = w.env.PATH!;
if (!realOom) {
  fs.mkdirSync(w.at("oomshim"));
  const systemctl = lastLine(cmd("bash", ["-c", "command -v systemctl"], { cwd: w.top, env: w.env }).stdout);
  fs.writeFileSync(w.at("oomshim/systemctl"), `#!/usr/bin/env bash
case "$*" in *"show -p Result "*) echo oom-kill ;; *) exec ${systemctl} "$@" ;; esac
`, { mode: 0o755 });
  PATH = `${w.at("oomshim")}:${PATH}`;
}
// The hungry unit eats memory; one whose command line holds "; " and a unit's ID (which the note
// must keep in backticks) too; any other is worked as usual. The unit is the one its card names,
// in the system prompt's file.
const OOM = `#!/usr/bin/env bash
echo '{"type":"system","subtype":"init"}'
sys=$(for ((i = 1; i < $#; i++)); do [ "\${!i}" = --append-system-prompt-file ] && j=$((i + 1)) && cat "\${!j}"; done)
if grep -qF '(g/semi)' <<<"$sys"; then bash -c "source ${hog}; : g/after"; exit 1; fi
grep -qF '(g/hungry)' <<<"$sys" || exec claude-ok "$@"
hog; exit 1
`;
const capped = (args: string[], add: NodeJS.ProcessEnv = {}) => f.loopSh(["--mem", "40M", "--no-wait", ...args], { PATH, FACTORY_NOCAP: "0", ...(realOom ? { FACTORY_TEST_OOM: "1" } : {}), ...add }).stdout;

describe("a session killed over its memory cap: the lane goes on, the unit interrupted with a snapshot", () => {
  let out = "";
  test("an OOM-killed session: the lane goes on", () => {
    setup("add-unit", "g/hungry", "--title", "Hungry unit");
    claude(OOM);
    out = capped(["--max", "1"]);
    has(out, "Hungry unit (g/hungry) shows as interrupted, with a note on what used the memory; the lane goes on");
  });
  test("  it doesn't stop", () => { hasnt(out, "Stopping"); });
  test("  the unit is interrupted", () => { assert.equal(state("g/hungry"), "interrupted"); });
  test("  its note names what used the memory", () => { has(t("show", "g/hungry"), `out of memory at 40M. Biggest then: \`bash ${hog}`); });
  test("  and its kind", () => { has(t("show", "g/hungry"), "[oom: `bash hog`]"); });
  const err = () => readOr(newest(a.at("runs"), /\.err$/));
  test("  the session's .err has the snapshot", () => { has(err(), "What used the memory at the last look before the kill:"); });
  test("  with pid, RSS and the full command line", () => { has(err(), `bash ${hog}`); });
  test("  an oom-kill event, with the biggest", () => { has(events().split("\n").filter((l) => l.includes("Hungry unit")).join("\n"), "oom-kill\tsession"); });
});

describe("a second kill by the same kind of process blocks the unit", () => {
  let out = "";
  test("a second kill by the same kind of process blocks the unit", () => {
    // Other notes in between: the tracker keeps three, but the kills are counted from its log.
    for (const k of [1, 2, 3]) setup("note", "g/hungry", `a note in between, ${k}`);
    setup("add-unit", "g/after", "--title", "After unit");
    out = capped(["--max", "2"]);
    has(out, "twice in the same kind of process (`bash hog`)");
  });
  test("  and the lane goes on to other work", () => { has(out, "iteration 2: After unit (g/after)"); });
  test("  it's stuck", () => { assert.equal(state("g/hungry"), "stuck"); });
  test("  and the overseer hears it's stuck", () => { has(events(), "stuck\tHungry unit (g/hungry): stuck: out of memory at 40M twice"); });
  test("  reopened, the next kill starts the count again", () => {
    setup("reopen", "g/hungry", "--note", "split the big step");
    out = capped(["--max", "1"]);
    setup("drop", "g/hungry", "--why", "test");
    has(out, "Hungry unit (g/hungry) shows as interrupted");
  });
  test("a command line with \"; \" and a unit's ID still makes the note, in backticks", () => {
    setup("add-unit", "g/semi", "--title", "Semicolon unit");
    capped(["--max", "1"]);
    claude();
    has(t("show", "g/semi"), `Biggest then: \`bash -c source ${hog}; : g/after\``);
  });
});

// Just after a kill the scope is still charged but its processes hold nothing: a look then keeps
// the snapshot that names the biggest. (A fake cgroup: the real moment is too brief to hit.)
// The look is `main.mjs session mem-snap <cgroup> <file>`, as the loop's session takes it.
describe("a look at a session's memory: the snapshot kept through a kill", { skip: process.platform !== "linux" && "a fake cgroup (macOS's groups are its watch's folders, which tell only the total)" }, () => {
  const cg = w.at("fakecg"), snap = w.at("fake.mem");
  fs.mkdirSync(cg, { recursive: true });
  const look = () => {
    const r = cmd(process.execPath, [path.join(ROOT, "runtime/main.mjs"), "session", "mem-snap", cg, snap], { cwd: w.top, env: w.env });
    assert.equal(r.code, 0, r.stderr);
    return readOr(snap);
  };
  const sleeper = (s: string) => {
    const p = spawn("sleep", [s], { stdio: "ignore" });
    const ended = new Promise<void>((r) => p.on("close", () => r()));
    after(() => { p.kill("SIGKILL"); });
    return { pid: p.pid!, kill: () => { p.kill("SIGKILL"); return ended; } };
  };
  const stat = (anon: number, shmem = 0) => fs.writeFileSync(path.join(cg, "memory.stat"), `anon ${anon}\nfile 0\nshmem ${shmem}\n`);
  const procs = (pid?: number) => fs.writeFileSync(path.join(cg, "cgroup.procs"), pid ? `${pid}\n` : "");
  test("a look while the processes hold a quarter of the cap takes a snapshot", async () => {
    const p = sleeper("30");
    fs.writeFileSync(path.join(cg, "memory.max"), `${40 << 20}\n`); procs(p.pid);
    fs.writeFileSync(path.join(cg, "memory.current"), `${20 << 20}\n`); stat(16 << 20);
    const s = look();
    await p.kill(); procs();
    has(s, "sleep 30");
  });
  test("  a look just after the kill, the scope still charged, keeps it", () => {
    fs.writeFileSync(path.join(cg, "memory.current"), `${14 << 20}\n`); stat(0);
    has(look(), "sleep 30");
  });
  test("  and so does one while its memory is still being freed", async () => {
    // The killed process's memory still being freed: held, but in no live process's RSS.
    const p = sleeper("31");
    procs(p.pid); stat(16 << 20);
    const s = look();
    await p.kill(); procs();
    has(s, "sleep 30");
  });
  test("  but a tmpfs file still holding memory is counted", () => {
    stat(0, 12 << 20);
    has(look(), "shmem 12M");
  });
});

// The loop's review runs in a capped scope of its own: one killed over its cap is told as a kill,
// with what used the memory, and the branch lands unreviewed (review-skipped names the kill).
describe("a review killed over its memory cap: an oom-kill event, and the branch lands unreviewed", () => {
  let out = "";
  const reviewer = w.at("bin/review-hog");
  fs.writeFileSync(reviewer, `#!/usr/bin/env bash\necho '{"type":"system","subtype":"init"}'\nhog; exit 1\n`, { mode: 0o755 });
  test("a unit worked, its review eats memory", () => {
    setup("drop", "g/semi", "--why", "test");   // (the last describe's, interrupted)
    setup("add-unit", "g/rvhog", "--title", "Review hog unit");
    out = capped(["--max", "1"], { FACTORY_REVIEWER: reviewer });
    has(out, "unit/g/rvhog merged into main");
  });
  test("  the log says the review was OOM-killed", () => { has(out, "the review of Review hog unit (g/rvhog) was OOM-killed inside its 40M scope"); });
  const lines = () => events().split("\n").filter((l) => l.includes("Review hog unit")).join("\n");
  test("  an oom-kill event naming the biggest", () => { has(lines(), `oom-kill\tthe review of Review hog unit (g/rvhog) was killed: out of memory at 40M; biggest: \`bash ${hog}`); });
  test("  and review-skipped names the kill", () => { has(lines(), "review-skipped\tReview hog unit (g/rvhog) landed without the loop's review: its review was killed: out of memory at 40M"); });
  test("  the review's .err has the snapshot", () => { has(readOr(path.join(newest(a.at("runs/review"), /-g-rvhog$/), "review.err")), "What used the memory at the last look before the kill:"); });
});
