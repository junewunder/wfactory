// The session's environment: none of the owner's display (no DISPLAY or XAUTHORITY, and a
// WAYLAND_DISPLAY naming a socket that can't exist, since with none a Wayland app finds the
// owner's), so a lane's window can't open on the owner's screen, and tracker/project.json's
// "session_env" added, {clone} and {lane} filled in. What the loop runs of the project's own gets
// the same (#130): factory/pre-session, the unit's check (the settle's probe) and the landing check,
// and group CI steps and the ci.affected hook (#174).
// The loop is the real factory/loop.sh, in the
// file's lane, its session run as it is and in a memory-capped systemd scope. Run: node --test test/loop/
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { laneFactory } from "./helpers.ts";

// The landing check notes its environment in the clone's runs/.
const f = laneFactory("lane-env", "lane-env", { check: "bash check.sh", files: { "check.sh": "env -0 > runs/check.env\n" } });
const { a, setup, seen, proj, onMain, steps } = f;
const parse = (s: string): Record<string, string> => Object.fromEntries(s.split("\0").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const readEnv = (p: string) => parse(fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "");
const envSeen = () => Object.fromEntries(seen("env.seen").split("\0").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
// The owner's display as a user service has it.
const owner = { DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0", XAUTHORITY: "/tmp/owner-xauth" };
const one = (add: NodeJS.ProcessEnv = {}, more: string[] = []) => f.loopSh(["--max", "1", "--no-wait", "--hours", "0.05", ...more], { ...owner, FACTORY_TEST_KEPT: "kept", ...add });
const noDisplay = (e: () => Record<string, string>) => {
  test("  no DISPLAY", () => { assert.equal(e().DISPLAY, undefined); });
  test("  no XAUTHORITY", () => { assert.equal(e().XAUTHORITY, undefined); });
  // Unset, a Wayland app would connect to $XDG_RUNTIME_DIR/wayland-0: the owner's.
  test("  WAYLAND_DISPLAY set, to a socket that can't exist", () => {
    const w = e().WAYLAND_DISPLAY ?? "";
    assert.ok(path.isAbsolute(w), `WAYLAND_DISPLAY=${w}`);
    assert.equal(fs.existsSync(w), false);
  });
};

describe("the session's environment", () => {
  let e: Record<string, string> = {};
  test("a session runs with the owner's display in the loop's environment", () => {
    proj((p) => { p.session_env = { APP_CONFIG_DIR: "{clone}/runs/config", APP_LANE: "lane {lane} of {clone}", "no such; name": "x", APP_NUMBER: 3, APP_NUL: "a\0b", FACTORY_ACTOR: "project" }; });
    a.git("pull", "-q", "--rebase", "origin", "main");
    setup("add-unit", "g/e1", "--title", "Env one");
    one();
    e = envSeen();
    assert.equal(e.FACTORY_TEST_KEPT, "kept");
  });
  noDisplay(() => e);
  test("  session_env's entry, {clone} filled in", () => { assert.equal(e.APP_CONFIG_DIR, `${a.dir}/runs/config`); });
  test("  and {lane}", () => { assert.equal(e.APP_LANE, `lane 1 of ${a.dir}`); });
  test("  a name that isn't one, or a value that isn't a string or holds a NUL, is left out", () => {
    assert.equal(e["no such; name"], undefined);
    assert.equal(e.APP_NUMBER, undefined);
    assert.equal(e.APP_NUL, undefined);
  });
  test("  the loop's own win over session_env's", () => { assert.equal(e.FACTORY_ACTOR, "loop"); });
});

describe("a session in a memory-capped scope", () => {
  let e: Record<string, string> = {};
  test("gets the same environment", () => {
    setup("add-unit", "g/e2", "--title", "Env two");
    one({ FACTORY_NOCAP: "0" }, ["--mem", "500M"]);
    e = envSeen();
    assert.equal(e.FACTORY_TEST_KEPT, "kept");
    assert.match(seen("args.seen"), /^-p /);   // the fake claude ran
  });
  noDisplay(() => e);
  test("  session_env's entry", () => { assert.equal(e.APP_CONFIG_DIR, `${a.dir}/runs/config`); });
});

describe("a project's own display, through session_env", () => {
  test("reaches the session", () => {
    proj((p) => { p.session_env = { DISPLAY: ":99" }; });
    a.git("pull", "-q", "--rebase", "origin", "main");
    setup("add-unit", "g/e3", "--title", "Env three");
    one();
    assert.equal(envSeen().DISPLAY, ":99");
    proj((p) => { delete p.session_env; });
    a.git("pull", "-q", "--rebase", "origin", "main");
  });
});

// The loop's own runs of the project's code: the user manager's display reached them (#130).
describe("what the loop runs of the project's own", () => {
  const pre = path.join(a.locks, "pre-session.env");
  // The session's own `just done` runs the probe too: only the settle's run (no session) is noted.
  const probe = path.join(a.locks, "probe.env");
  test("a unit with a probe, a pre-session and a landing check, run with the owner's display in the loop's environment", () => {
    onMain("factory/pre-session", `#!/bin/sh\nenv -0 > ${pre}\n`);
    proj((p) => { p.session_env = { APP_CONFIG_DIR: "{clone}/runs/config" }; });
    a.git("pull", "-q", "--rebase", "origin", "main");
    setup("add-unit", "g/e4", "--title", "Env four", "--probe-cmd", `[ -n "$FACTORY_SESSION" ] || env -0 > ${probe}`);
    fs.rmSync(a.at("runs/check.env"), { force: true });
    one();
    onMain("factory/pre-session", null);
    proj((p) => { delete p.session_env; });
    a.git("pull", "-q", "--rebase", "origin", "main");
    assert.equal(readEnv(pre).FACTORY_TEST_KEPT, "kept", "pre-session ran");
    assert.equal(readEnv(probe).FACTORY_TEST_KEPT, "kept", "the settle's probe ran");
    assert.equal(readEnv(a.at("runs/check.env")).FACTORY_TEST_KEPT, "kept", "the landing check ran");
  });
  for (const [what, file] of [["factory/pre-session", () => pre], ["the unit's check (the settle's probe)", () => probe], ["the landing check", () => a.at("runs/check.env")]] as const) {
    test(what, () => {});
    noDisplay(() => readEnv(file()));
    test("  session_env's entry", () => { assert.equal(readEnv(file()).APP_CONFIG_DIR, `${a.dir}/runs/config`); });
  }
});

// Group CI steps and the ci.affected hook, the project's own code too, got the owner's display (#174).
describe("group CI and the ci.affected hook", () => {
  const step = path.join(a.locks, "ci-step.env"), hook = path.join(a.locks, "ci-affected.env");
  let out = "";
  test("a group's CI step and the ci.affected hook, run with the owner's display in the loop's environment", () => {
    proj((p) => { p.session_env = { APP_CONFIG_DIR: "{clone}/runs/config" }; p.ci = { ...(p.ci ?? {}), affected: `env -0 > ${hook}; : {old} {new}` }; });
    steps({ envstep: { cmd: `env -0 > ${step}` } });
    a.git("pull", "-q", "--rebase", "origin", "main");
    // The hook's first look only notes main's code; a code change after it runs it.
    one();
    onMain("code.txt", "changed\n");
    setup("add-group", "gc", "--title", "Group C", "--ci", "envstep");
    setup("add-unit", "gc/one", "--title", "C one");
    out = f.loopSh(["--hours", "0.05"], { ...owner, FACTORY_TEST_KEPT: "kept", FACTORY_CI_RETRY_WAIT: "1" }).stdout;
    proj((p) => { delete p.session_env; delete p.ci.affected; });
    a.git("pull", "-q", "--rebase", "origin", "main");
    assert.equal(readEnv(step).FACTORY_TEST_KEPT, "kept", `the CI step ran\n${out}`);
    assert.equal(readEnv(hook).FACTORY_TEST_KEPT, "kept", `the hook ran\n${out}`);
  });
  for (const [what, file] of [["a group's CI step", () => step], ["the ci.affected hook", () => hook]] as const) {
    test(what, () => {});
    noDisplay(() => readEnv(file()));
    test("  session_env's entry", () => { assert.equal(readEnv(file()).APP_CONFIG_DIR, `${a.dir}/runs/config`); });
  }
  test("  the step's own variables", () => { assert.equal(readEnv(step).FACTORY_CI_STEP, "envstep"); });
});
