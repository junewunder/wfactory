// What the files in test/loop/ share (lane/ and fleet/ build on it): the fake claude, the loop's
// options, and the factory the loop runs in: init.sh's, on a local bare origin (test/lib's
// originFactory), with group g, the desk as a resource (titled "the desktop"), and two CI steps
// groups can name: lc (notes its group in <top>/lc.log) and desk (the same in <top>/order.log,
// and what `tracker busy --live` says in <top>/busy-live.log, using the desk). The loop runs in
// a lane (clone a, host a, by default), in this process (inproc.ts) or as factory/loop.sh.
import fs from "node:fs";
import path from "node:path";
import { originFactory, chomp, readOr, TRACKER } from "../lib/index.ts";
import { run, type Checkout } from "./inproc.ts";

// The fake claude the loop's sessions run (the bash suite's, without its sleeps): finds the unit in
// the appended card (in its file, or on its command line when the inbox couldn't take it) ("Next: Title (group/slug)"), notes what it was given ($FACTORY_LOCKS:
// args.seen, card.seen (its appended system prompt), stdin.seen, branch.seen, bash-timeout.seen, shell.seen, memory.seen, owner-shell.seen, env.seen (its environment, `env -0`)) and which copy of the skill ran it
// (skill.<group>-<slug>.seen), appends "work on <unit>" to out/<group>-<slug>.txt, commits it and
// records the unit done. FACTORY_FAKE_RL: a line to put in its transcript first (a
// rate_limit_event, say). FACTORY_FAKE_LONG: leaves a long job (leftover) running. A unit held
// ($FACTORY_LOCKS/hold.<group>-<slug>) works, its file written and not yet committed, until the
// test lets it go (go.<group>-<slug>), at most 5 minutes; while held, held.<group>-<slug> has its pid.
// A held session is inside a tool call (a Bash call running long: its tool_use is in the
// transcript, its tool_result comes when it's let go), so the loop doesn't end it for its
// silence; FACTORY_FAKE_SILENT=1 holds it with none open. While held, poke.<group>-<slug> makes it
// write a line to its transcript (and is taken away).
// (test/lib's FAKE_CLAUDE, for the branches and store suites, holds after its commit instead.)
export const CLAUDE = `#!/usr/bin/env bash
printf '%s\\n' "$*" > "$FACTORY_LOCKS/args.seen"
cat > "$FACTORY_LOCKS/stdin.seen"
card=""; while [ $# -gt 0 ]; do case $1 in --append-system-prompt-file) card=$(cat "$2") ;; --append-system-prompt) card=$2 ;; esac; shift; done
id=$(grep -oE '^Next: .*\\(([a-z0-9-]+/[a-z0-9.-]+)\\)' <<<"$card" | head -1 | sed -E 's/.*\\(([^)]*)\\)$/\\1/')
u=\${id//\\//-}
echo "$BASH_DEFAULT_TIMEOUT_MS" > "$FACTORY_LOCKS/bash-timeout.seen"
echo "\${CLAUDE_CODE_SHELL:-}" > "$FACTORY_LOCKS/shell.seen"
echo "\${CLAUDE_CODE_DISABLE_AUTO_MEMORY:-}" > "$FACTORY_LOCKS/memory.seen"
echo "\${FACTORY_OWNER_SHELL:-}" > "$FACTORY_LOCKS/owner-shell.seen"
env -0 > "$FACTORY_LOCKS/env.seen"
git rev-parse --abbrev-ref HEAD > "$FACTORY_LOCKS/branch.seen"
printf '%s\\n' "$card" > "$FACTORY_LOCKS/card.seen"
echo '{"type":"system","subtype":"init"}'
[ -z "\${FACTORY_FAKE_RL:-}" ] || echo "$FACTORY_FAKE_RL"
mkdir -p out; f="out/$u.txt"; echo "work on $id" >> "$f"
[ -z "\${FACTORY_FAKE_LONG:-}" ] || factory/long.sh start leftover -- sleep 300 >/dev/null
echo "\${FACTORY_SKILL:-}" > "$FACTORY_LOCKS/skill.$u.seen"
if [ -e "$FACTORY_LOCKS/hold.$u" ]; then
  [ -n "\${FACTORY_FAKE_SILENT:-}" ] || echo '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_held","name":"Bash","input":{}}]}}'
  echo $$ > "$FACTORY_LOCKS/held.$u.new" && mv "$FACTORY_LOCKS/held.$u.new" "$FACTORY_LOCKS/held.$u"
  for _ in $(seq 1500); do
    [ ! -e "$FACTORY_LOCKS/go.$u" ] || break
    if [ -e "$FACTORY_LOCKS/poke.$u" ]; then rm -f "$FACTORY_LOCKS/poke.$u"; echo '{"type":"assistant","message":{"content":[{"type":"text","text":"still here"}]}}'; fi
    sleep 0.2
  done
  [ -n "\${FACTORY_FAKE_SILENT:-}" ] || echo '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_held","content":"ok"}]}}'
fi
if [ -n "$id" ]; then git add "$f" && git commit -qm "$id: fake work" -- "$f" >/dev/null 2>&1; just done "$id" --evidence "fake session" >/dev/null 2>&1; fi
echo '{"type":"result","is_error":false,"result":"did '"$id"'","num_turns":1,"total_cost_usd":0.01}'
`;

// The loop's options here, as the bash suite's loop() gave them: no inhibitor, a 3-second look
// for work while waiting, no last call unless a test asks for one (a later --last-call wins).
export const LOOP = ["--no-awake", "--idle-wait", "0.05", "--last-call", "0"];

// loopFactory(name, {lane, check, files}): that factory, with its lane: a clone <top>/<lane>-lane1,
// host <lane>, locks <top>/locks-<lane> (originFactory's lane(), still there as f.lane for more);
// check and files as originFactory takes them.
//   a:              the lane (originFactory's lane() of it)
//   setup / t / state: the tracker in this process there (a test's own setup) / the real command
//                   (its stdout, as `$(t …)` gives it) / `t state <unit>`
//   claude(script): the fake claude the sessions run from now on, or (no script) the usual one;
//                   the usual one is also bin/claude-ok, for a script to hand over to
//   loop(args, add, t0): the loop in the lane, in this process (inproc.ts's run), LOOP's options
//                   first; checkout is the lane as run() takes it
//   seen(x):        a file the fake claude noted in the lane's locks; events(): runs/events.log
//   onBranch(branch, file): a file on origin's branch ("" if it isn't there)
export function loopFactory(name: string, { lane: laneName = "a", check = "true", files = {} as Record<string, string> } = {}) {
  const f = originFactory(name, {
    claude: CLAUDE, check, files,
    prepare: (F) => {
      const top = path.dirname(F), pf = path.join(F, "tracker/project.json"), p = JSON.parse(fs.readFileSync(pf, "utf8"));
      p.resources = { desk: { title: "the desktop" } };
      p.ci = { steps: {
        lc: { cmd: `echo {group} >> ${top}/lc.log; echo checked {group}` },
        desk: { cmd: `echo {group} >> ${top}/order.log; factory/tracker busy --live > ${top}/busy-live.log; echo used the desk`, uses: ["desk"] },
      } };
      fs.writeFileSync(pf, JSON.stringify(p, null, 2) + "\n");
      // A section every session follows, for the system prompt to bring in with the loop's.
      fs.appendFileSync(path.join(F, "docs/factory.md"), "\n## Data rules (every session)\n\nNever commit game data.\n");
    },
  });
  const { w } = f;
  fs.copyFileSync(w.at("bin/claude"), w.at("bin/claude-ok"));
  const a = f.lane(laneName);
  a.setup(["add-group", "g", "--title", "Group"]);
  // The tracker in this process, for a test's own setup; the real command (factory/tracker in
  // the lane) for what a check reads: its stdout, as `$(t …)` gives it.
  const setup = (...args: string[]) => a.setup(args);
  const t = (...args: string[]) => chomp(a.tracker(args).stdout);
  const state = (id: string) => t("state", id);
  // The fake claude the sessions run from now on (a script), or the usual one.
  const claude = (script?: string) => {
    fs.rmSync(w.at("bin/claude"));
    if (script === undefined) fs.copyFileSync(w.at("bin/claude-ok"), w.at("bin/claude"));
    else fs.writeFileSync(w.at("bin/claude"), script, { mode: 0o755 });
  };
  // The loop in the lane, in this process (LOOP's options first), and the lane's checkout for others.
  const checkout: Checkout = { dir: a.dir, envWith: a.envWith };
  const loop = (args: string[], add: NodeJS.ProcessEnv = {}, t0?: number) => run(checkout, [...LOOP, ...args], add, t0);
  const seen = (x: string) => readOr(path.join(a.locks, x));
  const events = () => a.events();
  // A file on origin's unit branch ("" if it isn't there).
  const onBranch = (branch: string, file: string) => { a.run("git", ["fetch", "-q", "origin"]); const r = a.run("git", ["show", `origin/${branch}:${file}`]); return r.code === 0 ? chomp(r.stdout) : ""; };
  return { ...f, a, setup, t, state, claude, checkout, loop, seen, events, onBranch };
}

// The lines of a loop's output matching re, in order, "iteration N: " cut, joined by commas (as
// `grep -oE … | sed … | paste -sd,`).
export const order = (out: string, re: RegExp) =>
  [...out.matchAll(new RegExp(re.source, "g"))].map((m) => m[0].replace(/^iteration [0-9]+: /, "")).join(",");

// A tracker that refuses one command (exit 1, "tracker: refused for this test") and runs every
// other: written to file, for FACTORY_TRACKER.
export function refusingTracker(file: string, command: string) {
  fs.writeFileSync(file, `if (process.argv[2] === ${JSON.stringify(command)}) { console.error("tracker: refused for this test"); process.exit(1); }
await import(${JSON.stringify(TRACKER)});
`);
  return file;
}

// A tracker that answers a command as a busy lock does (exit 75, "locked by another command") its
// first n times, and runs every other call: written to file, for FACTORY_TRACKER. The command is
// matched by its first arguments, each a prefix (["state", "merge/"]: \`state\` of any merge unit).
// <file>.busy counts the busy answers given.
export function busyTracker(file: string, match: string[], n = 1) {
  fs.writeFileSync(file, `import fs from "node:fs";
const m = ${JSON.stringify(match)}, f = ${JSON.stringify(`${file}.busy`)};
const given = () => { try { return Number(fs.readFileSync(f, "utf8")) || 0; } catch { return 0; } };
if (m.every((x, i) => (process.argv[2 + i] ?? "").startsWith(x)) && given() < ${n}) {
  fs.writeFileSync(f, String(given() + 1));
  console.error("the tracker is locked by another command (.tracker/lock); try again"); process.exit(75);
}
await import(${JSON.stringify(TRACKER)});
`);
  return file;
}
