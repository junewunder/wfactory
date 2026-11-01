// session.ts on its own: what in a session's transcript and stderr is a usage limit, and when a
// running session is stopped, driven with a fake claude (the loop suite drives a session's other
// stops end to end), and what the rendered prompt tells it about jobs. Run: node --test runtime/test/
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { limitHit, linkedDirs, runSession, streamWatch } from "../src/session.ts";
import { killPid, readOr, tempDir } from "../../test/lib/index.ts";

const d = tempDir("session-");
function hit(lines: unknown[], err = "") {
  fs.writeFileSync(path.join(d, "out.jsonl"), lines.map((l) => typeof l === "string" ? l : JSON.stringify(l)).join("\n") + "\n");
  fs.writeFileSync(path.join(d, "err"), err);
  return limitHit(path.join(d, "out.jsonl"), path.join(d, "err"));
}

test("a usage limit, as the CLI reports one", () => {
  assert.ok(hit([{ type: "result", is_error: true, result: "Claude AI usage limit reached|1760000000" }]));
  assert.ok(hit([{ type: "result", is_error: true, result: "You've hit your limit · resets 5am" }]));
  assert.ok(hit([{ type: "assistant", error: "rate_limit" }]));
  assert.ok(hit([{ type: "assistant", isApiErrorMessage: true, message: { content: [{ type: "text", text: "API Error: Request rejected (429)" }] } }]));
  assert.ok(hit([{ type: "system", subtype: "api_retry", error_status: 429 }]));
  assert.ok(hit([], "Error: Session limit reached\n"));
});

test("not a limit: the session's own words, a result that isn't an error, other failures", () => {
  assert.ok(!hit([{ type: "assistant", message: { content: [{ type: "text", text: "the server answers 429 under a rate limit" }] } }, { type: "result", is_error: true, result: "the build failed" }]));
  assert.ok(!hit([{ type: "result", is_error: false, result: "fixed the rate limit handling" }]));
  assert.ok(!hit([{ type: "system", subtype: "api_retry", error_status: 529 }]));
  assert.ok(!hit(["not json", { type: "result", is_error: true, result: "exit 1" }], "build: 4290 files\n"));
});

// A factory's case (2026-10-08): a killed session whose own text and tool output talked
// about the limit check was taken for a usage limit and the lane slept.
test("not a limit: the limit check's own words in a session's text and tool output, a cut-off last line", () => {
  const talk = "the usage-limit check greps 429 and 'hit your limit'; rate limit";
  const said = [{ type: "assistant", message: { content: [{ type: "text", text: talk }] } }, { type: "user", message: { content: [{ type: "tool_result", content: talk }] } }];
  assert.ok(!hit([...said, "{truncated"]));
  assert.ok(!hit([...said, { type: "result", is_error: true, result: "boom" }, "{truncated"]));
  assert.ok(hit([...said, { type: "result", is_error: true, result: "You've hit your limit · resets 3am" }, "{truncated"]));
});

// A fake claude: a bash script with this body.
function fake(body: string) {
  const f = tempDir("session-fake-");
  fs.writeFileSync(path.join(f, "claude"), `#!/usr/bin/env bash\n${body}`, { mode: 0o755 });
  return f;
}
const RESULT = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done" });
const run = (f: string, scope = "") => runSession({ out: path.join(f, "out.jsonl"), err: path.join(f, "err"), scope, cmd: [path.join(f, "claude")], env: { ...process.env, FACTORY_RESULT_GRACE: "1", FACTORY_POLL: "0.2" } }, () => {});
const killChild = (f: string) => { killPid(readOr(path.join(f, "child.pid"))); };

// A factory's case: `claude -p` posted its result, then sat waiting on an editor it started.
test("a session still running after its result is stopped after the grace, its transcript kept", async () => {
  const f = fake(`echo '${RESULT}'\nsleep 300 &\necho $! > "$(dirname "$0")/child.pid"\nwait\n`);
  const t0 = Date.now();
  try {
    const e = await run(f);
    assert.equal(e.stopped, 1);
    assert.ok(Date.now() - t0 < 15000);
    assert.equal(fs.readFileSync(path.join(f, "out.jsonl"), "utf8").trim(), RESULT);
  } finally { killChild(f); }   // no scope here to take the orphan with it
});

test("a session that exits on its own keeps its exit status", async () => {
  const e = await run(fake(`echo '${RESULT}'\nexit 3\n`));
  assert.deepEqual([e.rc, e.stopped], [3, 0]);
});

// Its prompt comes on stdin, from a file (#119: no prompt text on its command line); with none, no stdin.
test("a session reads its stdin file", async () => {
  const f = fake(`cat > "$(dirname "$0")/stdin.seen"\necho '${RESULT}'\n`);
  fs.writeFileSync(path.join(f, "prompt.md"), "the prompt\nits second line\n");
  const e = await runSession({ out: path.join(f, "out.jsonl"), err: path.join(f, "err"), scope: "", cmd: [path.join(f, "claude")], stdin: path.join(f, "prompt.md"), env: process.env }, () => {});
  assert.equal(e.rc, 0);
  assert.equal(readOr(path.join(f, "stdin.seen")), "the prompt\nits second line\n");
  await run(f);
  assert.equal(readOr(path.join(f, "stdin.seen")), "");
});
test("  and so does one run by bash, a script without a #! line", async () => {
  const f = tempDir("session-fake-");
  fs.writeFileSync(path.join(f, "claude"), `cat > "$(dirname "$0")/stdin.seen"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(f, "prompt.md"), "the prompt\n");
  const e = await runSession({ out: path.join(f, "out.jsonl"), err: path.join(f, "err"), scope: "", cmd: [path.join(f, "claude")], stdin: path.join(f, "prompt.md"), env: process.env }, () => {});
  assert.equal(e.rc, 0, readOr(path.join(f, "err")));
  assert.equal(readOr(path.join(f, "stdin.seen")), "the prompt\n");
});

test("a session past the grace with no result yet is left alone", async () => {
  const e = await run(fake(`sleep 2\necho '{"type":"assistant"}'\n`));
  assert.deepEqual([e.rc, e.stopped], [0, 0]);
});

test("a session stopped whose scope doesn't exist still ends, without throwing", async () => {
  const f = fake(`echo '${RESULT}'\nsleep 300 &\necho $! > "$(dirname "$0")/child.pid"\nwait\n`);
  try {
    const e = await run(f, `no-such-scope-${process.pid}`);
    assert.equal(e.stopped, 1);
    assert.notEqual(e.rc, 0);
  } finally { killChild(f); }
});

// Twice on 2026-10-09 a session backgrounded a long job and ended its turn to "continue when it
// finished"; a headless session is never woken, so it was stopped.
test("the prompt forbids ending a turn on a running job, and says how to wait", () => {
  const prompt = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "prompt.md"), "utf8");
  const text = prompt.replaceAll("{{SPEC}}", "docs/factory.md").replaceAll("{{THIS_LOOP}}", "").split(/\s+/).join(" ").toLowerCase();
  assert.ok(!text.includes("{{"));
  for (const s of ["never end your turn on a running job", "just long start", "just long wait", "pkill -a -f"]) assert.ok(text.includes(s), s);
});

// 14-15 Oct: a lane's work/ links to the checkout's, and the CLI refused 40 writes
// through it; the loop passes --add-dir for each such link's real directory (linkedDirs).
test("linkedDirs: the real directory behind each top-level link out of the checkout, and nothing else", () => {
  const t = tempDir("wf-linked-");
  try {
    const co = path.join(t, "lane"), shared = path.join(t, "shared"), deep = path.join(t, "deep");
    for (const d of [path.join(co, "sub"), shared, path.join(deep, "a")]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(t, "file.txt"), "x");
    fs.symlinkSync(shared, path.join(co, "work"));                       // out of the checkout: in
    fs.symlinkSync(path.join(t, "work-again"), path.join(co, "dangling"));   // to nothing: out
    fs.symlinkSync(path.join(co, "sub"), path.join(co, "inside"));       // within it: out
    fs.symlinkSync(path.join(t, "file.txt"), path.join(co, "f"));         // a file: out
    fs.symlinkSync(path.join(deep, "a"), path.join(co, "a"));            // another: in
    fs.symlinkSync(shared, path.join(co, "work2"));                      // the same again: once
    fs.symlinkSync(deep, path.join(co, "sub", "nested"));                // not top-level: out
    assert.deepEqual(linkedDirs(co), [fs.realpathSync(path.join(deep, "a")), fs.realpathSync(shared)].sort());
    assert.deepEqual(linkedDirs(path.join(t, "none")), []);
  } finally { fs.rmSync(t, { recursive: true, force: true }); }
});

// The rules from the same nights: shared data is never walked, a refused compound command is about
// where it writes, images through view-image, the tool list.
test("the prompt says not to walk shared data, why a compound command is refused, and how to look at an image", () => {
  const prompt = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "prompt.md"), "utf8");
  const text = prompt.split(/\s+/).join(" ").toLowerCase();
  for (const s of ["never walk it: no `find -l`", "compound commands pass", "splitting the command won't get it through", "just view-image", "docs/tools.md", "at two hours the loop tells it"]) assert.ok(text.includes(s), s);
});

// streamWatch: the transcript read as it grows, a part at a time, as a session's polls find it.
test("the transcript's open tool calls and result, read as it grows", () => {
  const f = path.join(d, "stream.jsonl");
  fs.writeFileSync(f, "");
  const w = streamWatch(f);
  const add = (s: string) => fs.appendFileSync(f, s);
  const use = (id: string, extra = {}) => JSON.stringify({ type: "assistant", ...extra, message: { content: [{ type: "text", text: "é…" }, { type: "tool_use", id, name: "Bash", input: { command: "sleep 1 # ünïcode" } }] } }) + "\n";
  const res = (id: string) => JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "done ✓" }] } }) + "\n";
  assert.equal(w.look(), false, "nothing new");
  // Two calls open, one of them a subagent's; the second line arrives in two parts, cut inside a
  // character of more than one byte.
  add(use("a"));
  const b = Buffer.from(use("b", { parent_tool_use_id: "a" }));
  const cut = b.indexOf(Buffer.from("é")) + 1;
  fs.appendFileSync(f, b.subarray(0, cut));
  assert.equal(w.look(), true);
  assert.deepEqual([...w.open], ["a"]);
  fs.appendFileSync(f, b.subarray(cut));
  assert.equal(w.look(), true);
  assert.deepEqual([...w.open].sort(), ["a", "b"]);
  assert.equal(w.look(), false, "nothing new");
  add(res("b"));
  w.look();
  assert.deepEqual([...w.open], ["a"]);
  // A result for a call it never saw open changes nothing; a line that isn't JSON is passed over.
  add(res("zz") + "not json \"tool_use\"\n" + res("a"));
  w.look();
  assert.deepEqual([...w.open], []);
  assert.equal(w.result, false);
  // A result line counts before its newline is written.
  add(JSON.stringify({ type: "result", is_error: false }));
  w.look();
  assert.equal(w.result, true);
});

test("a missing transcript is nothing new", () => {
  const w = streamWatch(path.join(d, "none.jsonl"));
  assert.equal(w.look(), false);
  assert.equal(w.result, false);
  assert.equal(w.open.size, 0);
});
