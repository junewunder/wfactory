// loop-affected.ts on its own: the ci.affected hook's range bookkeeping, in a lane's clone of a bare
// origin, with a fake tracker that keeps the covered commit and a real hook command. Run:
// node --test runtime/test/
import test from "node:test";
import "../../test/lib/tools.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tempDir } from "../../test/lib/index.ts";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { ciAffected, type AffectedCtx } from "../src/loop-affected.ts";
import type { TrOut } from "../src/tr.ts";

for (const [k, v] of Object.entries({ GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" })) process.env[k] = v;
const home = process.cwd();
test.afterEach(() => process.chdir(home));

function sh(dir: string, script: string) {
  const r = spawnSync("bash", ["-euo", "pipefail", "-c", script], { cwd: dir, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${script}: ${r.stderr}`);
  return r.stdout.trim();
}
// A lane's clone (the working directory from here on) of a fresh origin, and a lock folder.
function lane() {
  const d = tempDir("affected-");
  sh(d, `git init -q --bare -b main origin.git && git init -q -b main lane && mkdir locks && cd lane
    printf 'runs/\\n' > .gitignore; echo base > shared.py; mkdir -p tracker runs; echo '{}' > tracker/state.json
    git add -A && git commit -qm init && git remote add origin ../origin.git && git push -q origin main && git fetch -q origin`);
  process.chdir(path.join(d, "lane"));
  // A commit on origin's main (code, or tracker/ only), fetched: its ID.
  const push = (file: string) => sh(path.join(d, "lane"), `echo "$RANDOM" >> ${file} && git add -A && git commit -qm "change ${file}" && git push -q origin main && git fetch -q origin && git rev-parse HEAD`);
  return { d, locks: path.join(d, "locks"), push };
}

interface Fake { at: string | null; cmd: string | null; touches: string[]; events: [string, string][]; logs: string[]; runs: string[] }
// The loop's side: a tracker that keeps the hook's covered commit and the touches it was given.
function ctx(locks: string, cmd: string | null = "bash runs/hook.sh {old} {new}"): [AffectedCtx, Fake] {
  const f: Fake = { at: null, cmd, touches: [], events: [], logs: [], runs: [] };
  const ok = (out = ""): TrOut => ({ code: 0, out, err: "" });
  return [{
    ref: "origin/main", locks,
    tr: (a) => {
      if (a[0] !== "ci-affected") return ok();
      if (!a[1] || a[1] === "--json") return ok(JSON.stringify({ cmd: f.cmd, at: f.at }));
      const i = a.indexOf("--touches");
      if (i > 0) f.touches.push(...fs.readFileSync(a[i + 1], "utf8").split("\n").filter(Boolean));
      f.at = a[1];
      return ok("CI touched: something\n");
    },
    log: (s) => { f.logs.push(s); },
    event: (k, m) => { f.events.push([k, m]); },
    run: (c, secs, out, err) => new Promise((resolve) => {
      f.runs.push(c);
      const p = spawn("timeout", [String(secs), "bash", "-c", c], { stdio: ["ignore", out, err] });
      p.on("exit", (code) => resolve(code ?? 1));
    }),
  }, f];
}
// The hook: says which range it was given, then prints a group per line (or fails, or hangs).
const hook = (body: string) => fs.writeFileSync("runs/hook.sh", `echo "$1..$2" >> runs/ranges\n${body}\n`);

test("no hook: nothing to do", async () => {
  const r = lane(); const [c, f] = ctx(r.locks, null);
  assert.equal(await ciAffected(c), "none");
  assert.equal(f.runs.length, 0);
});

test("the first run records main's code commit and touches nothing; later runs go over old..new", async () => {
  const r = lane(); const [c, f] = ctx(r.locks);
  hook(`printf 'fox\\tshared code changed: shared.py\\nfalco\\tshared code changed: shared.py\\n'`);
  const first = sh(".", "git rev-parse origin/main");
  assert.equal(await ciAffected(c), "recorded");
  assert.equal(f.at, first);
  assert.equal(f.runs.length, 0);
  // main's code unchanged: nothing to do.
  assert.equal(await ciAffected(c), "none");
  // A tracker write moves main but not its code: nothing either.
  r.push("tracker/state.json");
  assert.equal(await ciAffected(c), "none");
  assert.equal(f.runs.length, 0);
  const second = r.push("shared.py");
  assert.equal(await ciAffected(c), "ran");
  assert.equal(fs.readFileSync("runs/ranges", "utf8"), `${first}..${second}\n`);
  assert.deepEqual(f.touches, ["fox\tshared code changed: shared.py", "falco\tshared code changed: shared.py"]);
  assert.equal(f.at, second);
  // And on from there.
  const third = r.push("other.py");
  assert.equal(await ciAffected(c), "ran");
  assert.equal(fs.readFileSync("runs/ranges", "utf8").split("\n")[1], `${second}..${third}`);
});

test("a hook that fails records nothing, the overseer hears once, and it's tried again over the same range", async () => {
  const r = lane(); const [c, f] = ctx(r.locks);
  const first = sh(".", "git rev-parse origin/main");
  f.at = first;
  const second = r.push("shared.py");
  hook(`echo "can't read the build graph" >&2; exit 3`);
  assert.equal(await ciAffected(c), "failed");
  assert.equal(f.at, first, "nothing recorded");
  assert.deepEqual(f.touches, []);
  assert.deepEqual(f.events.map(([k]) => k), ["ci-affected-failed"]);
  assert.match(f.events[0][1], /exit 3: can't read the build graph/);
  assert.equal(await ciAffected(c), "failed");
  assert.equal(f.events.length, 1, "told once");
  hook(`printf 'fox\\tchanged\\n'`);
  assert.equal(await ciAffected(c), "ran");
  assert.equal(fs.readFileSync("runs/ranges", "utf8").split("\n").filter(Boolean).at(-1), `${first}..${second}`);
  assert.equal(f.at, second);
  // Failing again later is news again.
  r.push("shared.py");
  hook("exit 1");
  assert.equal(await ciAffected(c), "failed");
  assert.equal(f.events.length, 2);
});

test("a hook past its time limit is cut off, and counts as failed", async () => {
  const r = lane(); const [c, f] = ctx(r.locks);
  f.at = sh(".", "git rev-parse origin/main");
  r.push("shared.py");
  hook("sleep 30");
  process.env.FACTORY_CI_AFFECTED_TIMEOUT = "1";
  try { assert.equal(await ciAffected(c), "failed"); } finally { delete process.env.FACTORY_CI_AFFECTED_TIMEOUT; }
  assert.match(f.events[0][1], /out of time after 1s/);
});

test("another lane on the machine running it: this one leaves it", async () => {
  const r = lane(); const [c, f] = ctx(r.locks);
  f.at = sh(".", "git rev-parse origin/main");
  r.push("shared.py");
  hook("true");
  const held = spawn("flock", [path.join(r.locks, "ci-affected.lock"), "sleep", "30"], { stdio: "ignore" });
  try {
    for (let i = 0; i < 50 && spawnSync("flock", ["-n", path.join(r.locks, "ci-affected.lock"), "true"]).status === 0; i++) await new Promise((x) => setTimeout(x, 100));
    assert.equal(await ciAffected(c), "busy");
    assert.equal(f.runs.length, 0);
  } finally { held.kill(); }
});

test("this clone behind what another machine covered: nothing to do", async () => {
  const r = lane(); const [c, f] = ctx(r.locks);
  const before = sh(".", "git rev-parse origin/main");
  const ahead = r.push("shared.py");
  sh(".", `git update-ref refs/remotes/origin/main ${before}`);
  f.at = ahead;
  hook("true");
  assert.equal(await ciAffected(c), "none");
  assert.equal(f.runs.length, 0);
});
