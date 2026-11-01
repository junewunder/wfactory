// A lane's inbox: what the factory says to a session that's already running.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { hm, pwd, shq, stamp, tryLock, asksHelp } from "./sys.ts";

export const HELP = `
inbox.sh — a lane's inbox: what the factory says to a session that's already running.

A \`claude -p\` session reads its unit's card once, at the start, and nobody can type into
it. But a PostToolUse hook can add context after any tool call, and the model reads it
with that call's result. So the loop starts each session with this script as its hook
(\`claude --settings\`), and after each of the session's tool calls the hook passes on
anything new, each thing once:
  - messages queued in the session's inbox: \`just fleet tell\` (the overseer) and the loop
    itself (last call's wrap-up);
  - notes someone else added to the session's unit since it started, and decisions
    recorded since then whose scope takes in its unit (\`tracker show <unit> --json\`,
    asked at most every FACTORY_INBOX_EVERY seconds, default 120: the tracker may fetch
    origin, and a tool call mustn't wait on that every time).
With nothing new it prints nothing. It never fails a tool call: every error is swallowed,
and a call that finds another one delivering (parallel tool calls) leaves it to that one.
A subagent's tool calls fire the hook too; those are skipped, or the message would reach
the subagent and never the session.

The inbox is runs/inbox/<tag>/ in the lane's checkout, and runs/inbox/current points at
the running session's (the loop sets it, and removes it when the session ends):
  unit, tag, since, root   the session's unit, its tag, when its card was made (at the
                           claim, in the tracker's time format) and the checkout
  settings.json            what the loop passes to \`claude --settings\`: the hook, merged
                           with factory/auto-mode.json (only the last --settings counts)
  new/                     messages waiting; done/ once delivered
  card                     the unit's card, as the session got it
  seen                     the notes and decisions already passed on (or on the card at the claim)
  checked                  touched at each look at the tracker (the throttle)

Usage:
  inbox.sh open <dir> <unit> <tag> <since> [<auto-mode.json>] < card
                                        make a session's inbox (the loop; <since>: when its
                                        card was made, \`inbox.sh stamp\`)
  inbox.sh stamp                                        now, in the tracker's time format
  inbox.sh put <dir> <from> <text…>                     queue a message for it
  inbox.sh hook                                         the PostToolUse hook (FACTORY_INBOX=<dir>)`;

type Obj = { [k: string]: unknown };
const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);
// What the shell's $(cat f) gives: the file without its trailing newlines.
const cat = (f: string) => fs.readFileSync(f, "utf8").replace(/\n+$/, "");
const lines = (f: string) => { try { return fs.readFileSync(f, "utf8").split("\n").filter((l) => l !== ""); } catch { return []; } };
const touch = (f: string) => { const t = new Date(); try { fs.utimesSync(f, t, t); } catch { fs.closeSync(fs.openSync(f, "a")); } };

// jq's `*`: objects merged key by key, all the way down; anything else, the right side's.
function merge(a: unknown, b: unknown): unknown {
  if (!isObj(a) || !isObj(b)) return b;
  const out: Obj = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = k in a ? merge(a[k], v) : v;
  return out;
}

// The command a session's settings run as its hook: this inbox.sh, wherever it's deployed.
const hookCommand = () => `${shq(fs.realpathSync(fileURLToPath(new URL("../inbox.sh", import.meta.url))))} hook`;

// Make a session's inbox. The card (given, else stdin unless it's a terminal) already has the
// decisions that applied at the claim (their IDs: \`next --json\`'s decisions): those are never
// passed on again.
export function openInbox(d: string, unit: string, tag: string, since: string, autoMode?: string, card?: string, decisions: string[] = []) {
  fs.mkdirSync(path.join(d, "new"), { recursive: true });
  fs.mkdirSync(path.join(d, "done"), { recursive: true });
  for (const [f, v] of [["unit", unit], ["tag", tag], ["since", since], ["root", pwd()]]) fs.writeFileSync(path.join(d, f), v + "\n");
  fs.writeFileSync(path.join(d, "seen"), "");
  touch(path.join(d, "checked"));
  if (card === undefined && !process.stdin.isTTY) card = fs.readFileSync(0, "utf8");
  if (card !== undefined) fs.writeFileSync(path.join(d, "card"), card);
  if (decisions.length) fs.appendFileSync(path.join(d, "seen"), decisions.map((i) => i + "\n").join(""));
  const hook = { hooks: { PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: hookCommand(), timeout: 30 }] }] } };
  let settings: unknown = hook;
  if (autoMode && fs.existsSync(autoMode)) {
    // Its own settings and hooks stay; ours is added to its PostToolUse list.
    const own = JSON.parse(fs.readFileSync(autoMode, "utf8"));
    if (!isObj(own)) throw new Error(`${autoMode}: not a JSON object`);
    const theirs = isObj(own.hooks) ? own.hooks.PostToolUse ?? [] : [];
    if (!Array.isArray(theirs)) throw new Error(`${autoMode}: hooks.PostToolUse isn't a list`);
    const m = merge(own, hook) as { hooks: Obj };
    m.hooks.PostToolUse = [...theirs, ...hook.hooks.PostToolUse];
    settings = m;
  }
  fs.writeFileSync(path.join(d, "settings.json"), JSON.stringify(settings, null, 2) + "\n");
}

// Queue a message, written aside and moved in, so the hook never reads half of one.
export function put(d: string, from: string, text: string) {
  if (!fs.existsSync(path.join(d, "new")) || !fs.statSync(path.join(d, "new")).isDirectory()) throw new NoInbox(d);
  const f = `${BigInt(Date.now()) * 1_000_000n + process.hrtime.bigint() % 1_000_000n}-${process.pid}`;
  fs.writeFileSync(path.join(d, `.${f}`), `(${from}, ${hm()}) ${text}\n`);
  fs.renameSync(path.join(d, `.${f}`), path.join(d, "new", f));
}
export class NoInbox extends Error { constructor(d: string) { super(`inbox: no inbox at ${d}`); } }

// What's new for the session since the last call, or null.
export function hook(input: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const d = env.FACTORY_INBOX || "";
  if (!d || !fs.existsSync(path.join(d, "new"))) return null;
  // A subagent's call: what it got, the session would never see.
  let agent: unknown = null; try { const j = JSON.parse(input); if (isObj(j)) agent = j.agent_id; } catch {}
  if (agent !== null && agent !== undefined && agent !== false && agent !== "") return null;
  if (tryLock(path.join(d, "lock")) === null) return null;   // held until we exit
  const items: string[] = [];
  for (const n of fs.readdirSync(path.join(d, "new")).filter((n) => !n.startsWith(".")).sort()) {
    const f = path.join(d, "new", n), to = path.join(d, "done", n);
    try { if (!fs.statSync(f).isFile()) continue; fs.renameSync(f, to); } catch { continue; }
    items.push(cat(to));
  }
  const every = Number(env.FACTORY_INBOX_EVERY || 120);
  let last = 0; try { last = Math.floor(fs.statSync(path.join(d, "checked")).mtimeMs / 1000); } catch {}
  // The messages are moved already: whatever goes wrong with the tracker, they still go out.
  if (Math.floor(Date.now() / 1000) - last >= every) try {
    touch(path.join(d, "checked"));
    const since = cat(path.join(d, "since")), tag = cat(path.join(d, "tag"));
    let r: ReturnType<typeof spawnSync> | null = null;
    try { r = spawnSync("factory/tracker", ["show", cat(path.join(d, "unit")), "--json"], { cwd: cat(path.join(d, "root")), env, encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "ignore"] }); } catch {}
    if (r && r.status === 0) {
      const seen = new Set(lines(path.join(d, "seen")));
      for (const [k, t] of news(String(r.stdout), since, tag)) {
        if (!k || seen.has(k)) continue;
        seen.add(k); fs.appendFileSync(path.join(d, "seen"), k + "\n"); items.push(t);
      }
    }
  } catch {}
  if (!items.length) return null;
  const t = ["While you work, from the factory:", ...items.map((i) => `- ${i}`),
    "This is newer than your unit's card and takes precedence over it and over your plan so far: adjust what you're doing before going on. (A note or decision here is already recorded; don't record it again.)"].join("\n");
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: t } }, null, 2);
}

// The unit's notes and decisions (from `tracker show <unit> --json`) since the session started
// that aren't its own: [key, text] each, the key what \`seen\` remembers.
function news(json: string, since: string, tag: string): [string, string][] {
  const out: [string, string][] = [];
  let j: unknown; try { j = JSON.parse(json); } catch { return out; }
  if (!isObj(j)) return out;
  const s = (x: unknown) => typeof x === "string" ? x : JSON.stringify(x ?? null);
  const who = (by: unknown) => by === "owner" ? "the owner" : `agent ${typeof by === "string" ? by : ""}`;
  const fresh = (x: Obj) => typeof x.at === "string" && x.at >= since && x.by !== tag;
  const flat = (p: [string, string]) => p.map((x) => x.replace(/[\t\n]/g, " ")) as [string, string];
  for (const n of Array.isArray(j.notes) ? j.notes : []) {
    if (isObj(n) && fresh(n)) out.push(flat([`note ${s(n.at)} ${s(n.by)}`, `A note on your unit (${who(n.by)}, ${s(n.at).slice(11, 16)} UTC): ${s(n.text)}`]));
  }
  for (const x of Array.isArray(j.decisions) ? j.decisions : []) {
    if (isObj(x) && fresh(x)) out.push(flat([typeof x.id === "string" ? x.id : "", `A decision that now applies to your unit (${who(x.by)}, ${s(x.id)}): ${s(x.title)}${x.why !== "" && x.why != null ? `. Why: ${s(x.why)}` : ""}`]));
  }
  return out;
}

export function inboxCli(args: string[]): number {
  const [cmd, ...a] = args;
  if (asksHelp(args, cmd === "put" ? 4 : args.length)) { console.log(HELP); return 0; }
  switch (cmd) {
    case "open":
      if (a.length < 4) { console.error("usage: inbox.sh open <dir> <unit> <tag> <since> [<auto-mode.json>] < card"); return 1; }
      try { openInbox(a[0], a[1], a[2], a[3], a[4]); return 0; } catch (e) { console.error(`inbox: ${(e as Error).message}`); return 1; }
    case "stamp": console.log(stamp()); return 0;
    case "put":
      if (a.length < 2) { console.error("usage: inbox.sh put <dir> <from> <text…>"); return 1; }
      try { put(a[0], a[1], a.slice(2).join(" ")); return 0; } catch (e) {
        if (e instanceof NoInbox) { console.error(e.message); return 2; }
        console.error(`inbox: ${(e as Error).message}`); return 1;
      }
    case "hook": {
      // Whatever goes wrong, the tool call it follows goes on: exit 0, and nothing on stdout but the answer.
      let out: string | null = null;
      try { let input = ""; try { input = fs.readFileSync(0, "utf8"); } catch {} out = hook(input); } catch {}
      if (out) process.stdout.write(out + "\n");
      return 0;
    }
    case undefined: case "-h": case "--help": console.log(HELP); return 0;
    default: console.error(`inbox: unknown command ${cmd} (open | stamp | put | hook)`); return 2;
  }
}
