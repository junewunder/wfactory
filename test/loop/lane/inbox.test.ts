// The inbox: what changes while a session works reaches it through its PostToolUse hook (a real
// `claude -p` adds the hook's additionalContext to the tool result; this fake runs the hook from
// its --settings after each pretend tool call, as a subagent's call too, and keeps what it says).
// And inbox.sh's hook, stamp and put on their own. The loop is the real factory/loop.sh, in the
// file's lane. Run: node --test test/loop/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { has, hasnt, readOr, ROOT, newest } from "../../lib/index.ts";
import { laneFactory } from "./helpers.ts";

const f = laneFactory("lane-inbox");
const { a, w, setup, claude, events, main, onMain, until } = f;
const L = (x: string) => path.join(a.locks, x);
// The fake: after each pretend tool call (hook.calls counts them) it runs the hook, as the
// session's and as a subagent's, until hook.stop; then (hook.stopped) it has its last words, no
// tool call in them, until hook.end, and records its unit done.
const INBOX = `#!/usr/bin/env bash
card="" settings=""
while [ $# -gt 0 ]; do case $1 in --append-system-prompt-file) card=$(cat "$2") ;; --settings) settings=$2 ;; esac; shift; done
id=$(grep -oE '^Next: .*\\(([a-z0-9-]+/[a-z0-9.-]+)\\)' <<<"$card" | head -1 | sed -E 's/.*\\(([^)]*)\\)$/\\1/')
cp "$settings" "$FACTORY_LOCKS/settings.seen"
hook=$(jq -r '.hooks.PostToolUse[-1].hooks[0].command' "$settings")
echo '{"type":"system","subtype":"init"}'
for i in $(seq 1 200); do
  echo '{"tool_name":"Bash","agent_id":"a1b2"}' | $hook >> "$FACTORY_LOCKS/hook.sub"
  echo '{"tool_name":"Bash"}' | $hook >> "$FACTORY_LOCKS/hook.out"
  echo "$i" > "$FACTORY_LOCKS/hook.calls"
  [ ! -f "$FACTORY_LOCKS/hook.stop" ] || break
  sleep 0.3
done
touch "$FACTORY_LOCKS/hook.stopped"
for _ in $(seq 600); do [ ! -e "$FACTORY_LOCKS/hook.end" ] || break; sleep 0.1; done
just done "$id" --evidence "fake session" >/dev/null 2>&1
echo '{"type":"result","is_error":false,"result":"did '"$id"'","num_turns":1,"total_cost_usd":0.01}'
`;
// inbox.sh, the real command, with stdin.
const inboxSh = (args: string[], { input = "", add = {} as NodeJS.ProcessEnv } = {}) => {
  const r = spawnSync(path.join(ROOT, "runtime/inbox.sh"), args, { cwd: a.dir, env: a.envWith(add), input, encoding: "utf8" });
  return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
};
const tell = (text: string) => f.oversee(["tell", "--", text]);

// An inbox that can't be made (runs/inbox can't be written, here from factory/pre-session): the
// session still gets its prompts, on its command line, and the loop says so.
describe("no inbox: the prompts go on the session's command line", () => {
  let out = "";
  test("a session with no inbox", () => {
    setup("add-unit", "g/nobox", "--title", "Unit nobox");
    onMain("factory/pre-session", "#!/usr/bin/env bash\nmkdir -p runs/inbox && chmod a-w runs/inbox\n");
    try { out = f.loopSh(["--max", "1", "--hours", "0.05"]).stdout; } finally {
      if (fs.existsSync(a.at("runs/inbox"))) fs.chmodSync(a.at("runs/inbox"), 0o755);
      onMain("factory/pre-session", null);
    }
    has(out, "this session's prompts in");
  });
  test("  the loop says where they went", () => { has(out, "; they go on its command line"); });
  test("  it got its card", () => { has(readOr(L("card.seen")), "Next: Unit nobox (g/nobox)"); });
  test("  and its prompt", () => { has(readOr(L("args.seen")), "You are one iteration of a factory loop in this repo"); });
  test("  and did the work", () => { has(main("out/g-nobox.txt"), "work on g/nobox"); });
});

describe("the inbox: what changes while a session works reaches it through its PostToolUse hook", () => {
  let h = "", told = "", outs: any[] = [];
  test("a running session's inbox takes the overseer's message", async () => {
    onMain("factory/auto-mode.json", `${JSON.stringify({ autoMode: { allow: ["$defaults"] }, hooks: { PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "true" }] }] } })}\n`);
    setup("add-unit", "g/inbox", "--title", "Unit inbox"); setup("add-unit", "g/other", "--title", "Unit other", "--needs", "g/inbox");
    setup("decide", "--title", "Decided before the claim", "--why", "x", "--scope", "g/inbox");
    claude(INBOX);
    const b = f.loopBg(["--max", "1", "--hours", "0.05"], { FACTORY_INBOX_EVERY: "0" });
    await until(() => fs.existsSync(a.at("runs/inbox/current/new")), "the session's inbox is open");
    told = tell("Skip the Final Strike effect sets").stdout;
    a.setup(["note", "g/inbox", "the rig is in work/rig"], { FACTORY_TAG: "ovr1" });
    a.setup(["decide", "--title", "Final Strike sets are skipped", "--why", "the owner said so", "--scope", "g/inbox"], { FACTORY_TAG: "ovr1" });
    setup("decide", "--title", "Only for the other unit", "--why", "x", "--scope", "g/other");
    await until(() => { const o = readOr(L("hook.out")); return o.includes("Final Strike sets are skipped") && o.includes("work/rig"); }, "the hook has passed on the note and the decision");
    // Two more tool calls, with nothing new for them.
    const calls = () => Number(readOr(L("hook.calls")) || 0), n = calls();
    await until(() => calls() >= n + 2, "two more tool calls");
    fs.writeFileSync(L("hook.stop"), "");
    await until(() => fs.existsSync(L("hook.stopped")), "the session's last tool call");
    tell("Too late to be read");
    fs.writeFileSync(L("hook.end"), "");
    await b.until("ran its --max", 30);
    await b.end();
    claude();
    const raw = readOr(L("hook.out")).trim();
    outs = raw ? JSON.parse(`[${raw.replace(/}\n{/g, "},{")}]`) : [];
    h = outs.map((o) => o.hookSpecificOutput.additionalContext).join("\n");
    has(told, "told session");
  });
  test("a message the session ended before reading reaches the overseer", () => { has(events(), "inbox-unread\tUnit inbox (g/inbox): session"); });
  test("the hook passes it on after a tool call", () => { has(h, "(the overseer, "); });
  test("  headed, as context the model reads", () => { has(h, "While you work, from the factory:"); });
  test("  saying it outranks the session's plan", () => { has(h, "takes precedence over it and over your plan so far"); });
  test("  the message", () => { has(h, "Skip the Final Strike effect sets"); });
  test("  a note someone else added to its unit", () => { has(h, "A note on your unit (agent ovr1"); });
  test("  with its text", () => { has(h, "the rig is in work/rig"); });
  test("  a decision recorded since the claim, scoped to its unit", () => { has(h, "A decision that now applies to your unit (agent ovr1, d/"); });
  test("  with its why", () => { has(h, "): Final Strike sets are skipped. Why: the owner said so"); });
  test("  not one scoped to another unit", () => { hasnt(h, "Only for the other unit"); });
  test("  (the one after its last tool call isn't in it)", () => { hasnt(h, "Too late to be read"); });
  test("  not one already on its card", () => { hasnt(h, "Decided before the claim"); });
  test("  each once", () => {
    const n = (s: string) => h.split(s).length - 1;
    assert.deepEqual([n("Skip the Final Strike"), n("work/rig"), n("Final Strike sets are skipped. Why")], [1, 1, 1], h);
  });
  test("  as PostToolUse hook output, and nothing when there's nothing new", () => {
    assert.deepEqual([...new Set(outs.map((o) => o.hookSpecificOutput.hookEventName))], ["PostToolUse"]);
    // Every call's output is one JSON object (nothing for the calls with nothing new).
    assert.ok(outs.length >= 1 && outs.length <= 3, `${outs.length} outputs`);
  });
  test("  a subagent's tool calls get nothing (the session would never see it)", () => { assert.equal(readOr(L("hook.sub")), ""); });
  test("  its settings keep factory/auto-mode.json's, hooks included", () => {
    const s = JSON.parse(readOr(L("settings.seen")));
    assert.deepEqual([s.autoMode.allow[0], s.hooks.PostToolUse.length], ["$defaults", 2]);
  });
  test("  the inbox is closed when the session ends", () => { assert.ok(!fs.existsSync(a.at("runs/inbox/current"))); });
  test("  then tell says no session is running (exit 3)", () => { assert.equal(tell("too late").code, 3); });
  test("  even with the link a killed loop leaves behind (exit 3)", () => {
    fs.symlinkSync(path.basename(newest(a.at("runs/inbox"), /^(?!current$)/)), a.at("runs/inbox/current"));
    const c = tell("too late").code;
    fs.rmSync(a.at("runs/inbox/current"));
    assert.equal(c, 3);
  });
});

describe("inbox.sh hook, stamp and put", () => {
  test("the hook with nothing new: nothing, at once", () => {
    const d = newest(a.at("runs/inbox"), /^(?!current$)/);
    for (const m of fs.readdirSync(path.join(d, "new"))) fs.rmSync(path.join(d, "new", m));
    fs.writeFileSync(path.join(d, "checked"), "");
    const t0 = performance.now(), r = inboxSh(["hook"], { input: "{}", add: { FACTORY_INBOX: d } }), ms = performance.now() - t0;
    assert.deepEqual([r.code, r.stdout], [0, ""]);
    assert.ok(ms < 500, `${ms} ms`);
  });
  const bad = w.at("badinbox");
  test("  and with a broken inbox, still exit 0 and silent", () => {
    fs.mkdirSync(path.join(bad, "new"), { recursive: true });
    fs.writeFileSync(path.join(bad, "root"), "/nonexistent\n"); fs.writeFileSync(path.join(bad, "unit"), "g/inbox\n");
    const r = inboxSh(["hook"], { input: "not json", add: { FACTORY_INBOX: bad, FACTORY_INBOX_EVERY: "0" } });
    assert.deepEqual([r.code, r.stdout + r.stderr], [0, ""]);
  });
  test("  and its messages still go out, though the tracker can't be asked", () => {
    fs.mkdirSync(path.join(bad, "done"));
    assert.equal(inboxSh(["put", bad, "the overseer", "still delivered"]).code, 0);
    const r = inboxSh(["hook"], { input: "{}", add: { FACTORY_INBOX: bad, FACTORY_INBOX_EVERY: "0" } });
    has(r.stdout + r.stderr, "still delivered");
  });
  test("inbox stamp: now, in the tracker's time format", () => {
    const s = inboxSh(["stamp"]).stdout.trim();
    assert.match(s, /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/);
    const off = Date.now() / 1000 - Date.parse(s) / 1000;
    assert.ok(off >= 0 && off <= 2, `${s}: ${off} s off`);
  });
  test("inbox put with no inbox there: exit 2", () => { assert.equal(inboxSh(["put", w.at("nobox"), "me", "hello"]).code, 2); });
  test("  and says so", () => { has(inboxSh(["put", w.at("nobox"), "me", "hello"]).stderr, `inbox: no inbox at ${w.at("nobox")}`); });
  const pbox = w.at("pbox");
  test("inbox put: one file each, who and when, the words joined, in order", () => {
    fs.mkdirSync(path.join(pbox, "new"), { recursive: true });
    assert.equal(inboxSh(["put", pbox, "the overseer", "first", "message here"]).code, 0);
    assert.equal(inboxSh(["put", pbox, "the loop", "second"]).code, 0);
    const files = fs.readdirSync(path.join(pbox, "new")).sort();
    const out = files.map((m) => readOr(path.join(pbox, "new", m))).join("").replace(/, [0-2][0-9]:[0-5][0-9]\) /g, ", HH:MM) ");
    assert.equal(out, "(the overseer, HH:MM) first message here\n(the loop, HH:MM) second\n");
  });
  test("  nothing left beside them", () => { assert.deepEqual(fs.readdirSync(pbox), ["new"]); });
});
