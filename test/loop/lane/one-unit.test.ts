// A factory made by init.sh, its machines file, and one unit, then nothing left: the lane works it
// on its own branch, merges it into main and stops. The loop is the real factory/loop.sh, in the
// file's lane (a clone of a local bare origin). Run: node --test test/loop/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { cmd, has, hasnt, HOST } from "../../lib/index.ts";
import { laneFactory } from "./helpers.ts";

const f = laneFactory("lane-one");
const { a, w, F, setup, t, seen, events, main, onMain } = f;

describe("a factory made by init.sh", () => {
  test("init.sh writes the machines file from the profile", () => {
    has(fs.readFileSync(`${F}/docs/machines.md`, "utf8"), `| ${HOST} | ${HOST} | 1 | any | ${F} | — | — | 1 |`);
  });
  test("  and refuses without a profile", () => {
    assert.equal(w.script("init", ["np", "--dir", w.top], { add: { WFACTORY_PROFILE: w.at("no-profile.md") } }).code, 2);
  });
});

// factory/machines.sh, sourced as a project's script does.
describe("machines file", () => {
  const sh = (s: string) => cmd("bash", ["-c", `. factory/machines.sh; ${s}`], { cwd: F, env: w.env });
  test("machines file: this machine's row", () => { has(sh("machine_rows").stdout, `${HOST}\t${HOST}\t1\tany\t${F}`); });
  test("machine_get reads a field", () => { assert.equal(sh(`machine_get ${HOST} 4`).stdout.trim(), "any"); });
});

describe("one unit, then nothing left: the lane stops", () => {
  let out = "";
  test("a lane works a unit", () => {
    setup("add-unit", "g/one", "--title", "Unit one");
    // This lane's host (the file's name) gets its own section of the machines file, for the
    // system prompt to bring in; the real host's section is init.sh's.
    onMain("docs/machines.md", fs.readFileSync(`${a.dir}/docs/machines.md`, "utf8") + `\n## ${a.n}\n\nThe test's lane, on this machine.\n\n## otherbox\n\nAnother machine.\n`);
    out = f.loopSh(["--hours", "0.05"]).stdout;
    has(out, "iteration 1: Unit one (g/one)");
  });
  test("  and stops when nothing is left", () => { has(out, "every unit is done or dropped"); });
  test("  telling the overseer it stopped", () => { has(events(), "lane-stop"); });
  test("  the session runs on the unit's branch", () => { assert.equal(seen("branch.seen").trim(), "unit/g/one"); });
  test("  and is told so", () => { has(seen("card.seen"), "You are on branch unit/g/one"); });
  test("  its branch is merged into origin's main", () => { assert.equal(main("out/g-one.txt"), "work on g/one"); });
  const log = () => { a.git("fetch", "-q", "origin"); return a.git("log", "--format=%s", "origin/main"); };
  test("  with a merge commit naming the unit", () => { has(log(), `Unit one (g/one): merged from ${a.n} lane 1`); });
  test("  and the branch is deleted", () => { assert.notEqual(a.run("git", ["show-ref", "-q", "--verify", "refs/heads/unit/g/one"]).code, 0); });
  test("  and never pushed", () => { assert.equal(a.git("ls-remote", "origin", "refs/heads/unit/*"), ""); });
  test("  the lane is back on main", () => { assert.equal(a.git("rev-parse", "--abbrev-ref", "HEAD"), "main"); });
  test("  the tracker says done, not merging", () => { has(t("show", "g/one"), "done (recorded)"); });
  test("  claims and done went to main as tracker commits", () => { has(log(), "tracker: Unit one: claimed"); });
  test("  and nothing else touched tracker/", () => {
    const other = a.git("log", "--format=%s", "origin/main", "--", "tracker").split("\n").filter((s) => !/^(tracker: |init$)/.test(s));
    assert.deepEqual(other, []);
  });
  // Its start-up reading comes in the system prompt: the spec's loop section and this machine's own.
  test("  the system prompt has the spec's loop section", () => { has(seen("card.seen"), "From docs/factory.md, its loop and the sections every session follows:"); });
  test("    from its heading", () => { has(seen("card.seen"), "## The loop"); });
  test("    and the sections marked (every session)", () => { has(seen("card.seen"), "Never commit game data."); });
  test("    and none of the spec's other sections", () => { hasnt(seen("card.seen"), "## The oracle"); });
  test("  and this machine's section of the machines file", () => { has(seen("card.seen"), "This machine's section of docs/machines.md:"); });
  test("    from its heading", () => { has(seen("card.seen"), `## ${a.n}\n\nThe test's lane, on this machine.`); });
  test("    and not another machine's", () => { hasnt(seen("card.seen"), "## otherbox"); });
  test("    not the Lanes table", () => { hasnt(seen("card.seen"), "## Lanes"); });
  // No prompt text on its command line (a `pkill -A -f` for a word a card mentions would hit every
  // lane): the system prompt comes in a file in its inbox, factory/prompt.md on its stdin.
  test("the session's command line holds no card", () => {
    hasnt(seen("args.seen"), "Next: Unit one (g/one)");
    hasnt(seen("args.seen"), "You are on branch");
  });
  test("  and no line of its prompt", () => {
    // Not the short ones (a list marker, a rule), which could turn up anywhere.
    const lines = seen("stdin.seen").split("\n").map((x) => x.trim()).filter((x) => x.length >= 10);
    assert.ok(lines.length > 10, "the prompt came on stdin");
    for (const x of lines) hasnt(seen("args.seen"), x);
  });
  test("  the system prompt comes in its inbox's system.md", () => {
    const m = /--append-system-prompt-file (\S+)/.exec(seen("args.seen"));
    assert.ok(m, seen("args.seen"));
    assert.match(m[1], /\/runs\/inbox\/[^/]+\/system\.md$/);
    has(seen("card.seen"), "Next: Unit one (g/one)");
  });
  test("  and factory/prompt.md on its stdin", () => {
    has(seen("stdin.seen"), "You are one iteration of a factory loop in this repo");
    hasnt(seen("stdin.seen"), "{{SPEC}}");
  });
  test("  still named on its command line, for a pattern that means it", () => {
    has(seen("args.seen"), "--name factory: Unit one --append-system-prompt-file");
    assert.match(seen("args.seen"), /--session-id [0-9a-f-]{36} /);
  });
  test("sessions get a 10-minute Bash limit (for just long wait)", () => { assert.equal(seen("bash-timeout.seen").trim(), "600000"); });
  // The session's Bash: plain bash with stdin from /dev/null (a stray read ends at once, here under
  // a stdin that never ends), SHELL=/bin/bash for what it starts, and no aliases left in the
  // snapshot the CLI takes; and the CLI's own grep and find, not its ugrep and bfs (it shadows them
  // unless the session takes its Grep and Glob tools).
  const shell = () => seen("shell.seen").trim();
  test("sessions' Bash runs in lane-bash.sh", () => {
    assert.equal(path.basename(shell()), "lane-bash.sh");
    fs.accessSync(shell(), fs.constants.X_OK);
  });
  test("  with stdin from /dev/null and SHELL=/bin/bash", () => {
    const fifo = w.at("never");
    cmd("mkfifo", [fifo], { cwd: w.top, env: w.env });
    // Opened for reading and writing: a stdin that never ends.
    const r = cmd("bash", ["-c", `timeout 10 "$1" -c 'cat; [ /dev/fd/0 -ef /dev/null ] && echo /dev/null; echo "$SHELL"' 2>&1 <> "$2" || echo "rc=$?"`, "_", shell(), fifo], { cwd: w.top, env: w.env });
    assert.equal(r.stdout, "/dev/null\n/bin/bash\n");
  });
  // A snapshot like the CLI's: the shell's aliases, then its own part (an rg alias where there's
  // no rg). The owner's shell (a stand-in) adds a directory to PATH that bash's rc files don't.
  let snap = "";
  test("  and none of the shell's aliases in its snapshot, the CLI's own kept", () => {
    fs.writeFileSync(w.at("rc"), 'alias ls="echo aliased"\n');
    fs.writeFileSync(w.at("owner-sh"), '#!/bin/bash\nPATH=/owner/bin:/usr/bin exec /bin/bash -c "$3"\n', { mode: 0o755 });
    snap = w.at("snap.sh");
    const take = `SNAPSHOT_FILE=${snap}\n. '${w.at("rc")}'; { echo 'shopt -s expand_aliases'; alias | sed 's/^alias /alias -- /'; echo '# Check for rg availability'; echo 'alias rg="echo cli-rg"'; } >| "$SNAPSHOT_FILE"`;
    const r = cmd("bash", ["-c", `"$1" -c -l "$2" < /dev/null`, "_", shell(), take], { cwd: w.top, env: { ...w.env, HOME: w.top, FACTORY_OWNER_SHELL: w.at("owner-sh") } });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(cmd("bash", ["-c", `. '${snap}'\ntype -t ls; type -t rg`], { cwd: w.top, env: w.env, merged: true }).stdout, "file\nalias\n");
  });
  test("  and the owner's shell's PATH, then the session's", () => {
    const out = cmd("bash", ["-c", `. '${snap}'\necho "$PATH"`], { cwd: w.top, env: { ...w.env, PATH: "/usr/bin:/bin" } }).stdout;
    assert.ok(out.startsWith("/owner/bin:/usr/bin:") && out.includes(w.at("bin")), out);
  });
  test("  the loop tells it the owner's shell", () => { assert.notEqual(seen("owner-shell.seen").trim(), ""); });
  test("  the CLI's Grep and Glob tools are allowed", () => { has(seen("args.seen"), "Bash(factory/long.sh:*) Grep Glob"); });
  // Only the tools lanes use: not the Skill tool and the owner's skills (~12k tokens in every turn).
  test("  sessions take the lanes' tools", () => { has(seen("args.seen"), "--tools Bash,Read,Edit,Write,Grep,Glob,Task,SendMessage,TaskStop,WebFetch,WebSearch,ToolSearch --allowedTools"); });
  test("  and no auto-memory", () => { assert.equal(seen("memory.seen").trim(), "1"); });
});
