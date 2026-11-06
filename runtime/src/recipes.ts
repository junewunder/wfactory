// The recipes in factory.just that do more than run one command: runs, prompt, oversee-guide, until,
// view-image.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { pwd } from "./sys.ts";

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));   // the skill's runtime/

const read = (f: string) => { try { return fs.readFileSync(f, "utf8"); } catch { return null; } };

// `column -t -s '\t'`: each column as wide as its widest cell, two spaces between.
export function columns(rows: string[][]): string[] {
  const w: number[] = [];
  const len = (s: string) => [...s].length;
  for (const r of rows) r.forEach((c, i) => { w[i] = Math.max(w[i] ?? 0, len(c)); });
  return rows.map((r) => r.map((c, i) => i === r.length - 1 ? c : c + " ".repeat(w[i] - len(c) + 2)).join(""));
}

export const RUNS_HELP = `runs [n] [--tsv]: the last n (default 20) loop iterations on this machine, its lanes'
clones included: unit, result, turns, cost, minutes (just runs). --tsv: the rows as they are,
tab-separated under their header, for awk and cut (the columns pad with spaces, and titles have them).`;

// The last n loop iterations on this machine, from the checkout's runs/index.tsv and its lanes'
// clones' beside it, by when each started.
export function runsCli(args: string[]): number {
  if (args[0] === "-h" || args[0] === "--help") { console.log(RUNS_HELP); return 0; }
  const tsv = args.includes("--tsv");
  args = args.filter((a) => a !== "--tsv");
  const n = Number(args[0] ?? 20);
  if (!Number.isInteger(n) || n < 0) { console.error(`runs: not a number of runs: ${args[0]}`); return 2; }
  const here = pwd();
  const root = path.join(path.dirname(here), path.basename(here).replace(/-lane[0-9]*$/, ""));
  const parent = path.dirname(root), base = path.basename(root);
  const lanes = fs.readdirSync(parent).filter((d) => d.startsWith(`${base}-lane`)).sort().map((d) => path.join(parent, d));
  let hdr = "";
  const rows: string[] = [];
  for (const d of [root, ...lanes]) {
    const text = read(path.join(d, "runs", "index.tsv"));
    if (text === null) continue;
    const lines = text.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    if (!hdr) hdr = lines[0] ?? "";
    const m = /-lane([0-9]+)$/.exec(d);
    const l = m ? `lane${m[1]}` : "checkout";
    for (const x of lines.slice(1)) rows.push(`${l}\t${x}`);
  }
  if (!hdr) { console.log("no loop has run on this machine yet"); return 0; }
  // By when each started (`sort -t '\t' -k2,2`, ties by the whole line).
  const key = (r: string) => r.split("\t")[1] ?? "";
  const cmp = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  rows.sort((a, b) => cmp(key(a), key(b)) || cmp(a, b));
  const shown = n > 0 ? rows.slice(-n) : [];
  if (tsv) { for (const l of [`lane\t${hdr}`, ...shown]) console.log(l); return 0; }
  for (const l of columns([`lane\t${hdr}`, ...shown].map((r) => r.split("\t")))) console.log(l);
  console.log("(transcripts: <that clone>/runs/<started>-<tag>.jsonl; another machine's: just fleet state)");
  return 0;
}

// The skill's file, then the project's additions to it after a rule, if it has any.
function withLocal(file: string, local: string): number {
  const text = read(path.join(HERE, file));
  if (text === null) { console.error(`${file}: not found in ${HERE}`); return 1; }
  process.stdout.write(text);
  const more = read(local);
  if (more !== null) process.stdout.write(`\n---\n\n${more}`);
  return 0;
}

// The loop's worker prompt (the skill's runtime/prompt.md), then this project's own rules.
export const promptCli = (args: string[]) => args[0] === "-h" || args[0] === "--help"
  ? (console.log("prompt: the loop's worker prompt (the skill's runtime/prompt.md), then factory/prompt.local.md (just prompt)."), 0)
  : withLocal("prompt.md", "factory/prompt.local.md");

// The overseer's card (the skill's runtime/oversee-card.md: the rules, and what to do at each
// wake), or with --full the whole guide (runtime/oversee.md); then this project's additions.
export const overseeGuideCli = (args: string[]) => args[0] === "-h" || args[0] === "--help"
  ? (console.log("oversee-guide [--full]: the overseer's card (the skill's runtime/oversee-card.md), or with --full the whole guide (runtime/oversee.md); then factory/oversee.local.md (just oversee-guide)."), 0)
  : withLocal(args.includes("--full") ? "oversee.md" : "oversee-card.md", "factory/oversee.local.md");

export const UNTIL_HELP = `until <seconds> [-- <check…>]: wait up to <seconds> for a check to pass, rerunning it every
2 seconds, then print its output (just until). Exit 0 once it passes; 124, with its last output,
if it still fails at the limit. With no check, wait that long. One word after -- runs in bash
(\`just until 60 -- 'test -s out/a.txt && tail -3 out/a.txt'\`); several run as they are. At most
540 seconds, under the 10-minute cut-off of a Bash call: a longer job goes through \`just long\`.
A check that can't change (\`false\`, \`true\`) is refused (exit 2): wait on a
subagent by starting it with run_in_background: false, on a job with \`just long wait\`.
It's how a session waits: the CLI refuses a Bash call that starts with \`sleep\`, and points to
a Monitor tool lanes don't take.`;

export const UNTIL_TRIVIAL = "until: waits for a condition to come true. To wait on a subagent, start it with run_in_background: false; to wait on a job, `just long wait <name>`.";
const TRIVIAL = new Set(["false", "true", ":"]);
// The check's text, unwrapped from one `bash -c` / `sh -c`, trimmed.
const trivialOf = (check: string[]) => (check.length === 3 && /^(?:ba)?sh$/.test(check[0]) && check[1] === "-c" ? check[2] : check.length === 1 ? check[0] : "")
  .trim().replace(/^(?:(?:ba)?sh -c\s+)?(['"]?)(.*)\1$/, "$2").trim();

// Wait for something a session can't wait on with `just long wait`: an app to settle, a file a
// background job writes (Oct 2026: 25 Bash calls refused for starting with sleep).
export async function untilCli(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (!args.length || args[0] === "-h" || args[0] === "--help") { console.log(UNTIL_HELP); return args.length ? 0 : 2; }
  const secs = Number(args[0]);
  if (!Number.isFinite(secs) || secs < 0) { console.error(`until: not a number of seconds: ${args[0]}`); return 2; }
  if (secs > 540) { console.error(`until: ${secs} seconds is past what one Bash call may take (540 at most); run the job with \`just long start\` and \`just long wait\``); return 2; }
  const rest = args.slice(1);
  if (rest.length && rest[0] !== "--") { console.error(`until: the check goes after --: just until ${args[0]} -- <check…>`); return 2; }
  const check = rest.slice(1);
  // A check that can never change (`false`, `true`, `bash -c false`): a blind sleep dressed as a
  // wait. Lanes waited on background subagents with `just until 500 -- false`.
  if (check.length && TRIVIAL.has(trivialOf(check))) { console.error(UNTIL_TRIVIAL); return 2; }
  const end = Date.now() + secs * 1000, p = Number(env.FACTORY_UNTIL_POLL), poll = (Number.isFinite(p) && p > 0 ? p : 2) * 1000;
  if (!check.length) { await sleep(secs * 1000); return 0; }
  const [cmd, ...cargs] = check.length === 1 ? ["bash", "-c", check[0]] : check;
  for (;;) {
    const r = await runCheck(cmd, cargs, env, Math.max(end - Date.now(), 1000));
    if (r.code === 0) { process.stdout.write(r.out); process.stderr.write(r.err); return 0; }
    if (Date.now() + poll > end) {
      process.stdout.write(r.out); process.stderr.write(r.err);
      console.error(`until: still failing after ${secs} s (${r.why}): ${check.join(" ")}`);
      return 124;
    }
    await sleep(poll);
  }
}

// One run of the check, in its own process group, all of which is killed at the limit (a
// pipeline's other processes too, which would keep its output open). Its output's last 64 KB.
const KEEP = 64 * 1024;
function runCheck(cmd: string, args: string[], env: NodeJS.ProcessEnv, ms: number): Promise<{ code: number | null; out: string; err: string; why: string }> {
  return new Promise((resolve) => {
    const c = spawn(cmd, args, { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    // Stopped itself (the Bash call cut off): the check's group goes with it.
    const stop = () => { try { process.kill(-c.pid!, "SIGKILL"); } catch {} process.exit(143); };
    process.once("SIGTERM", stop); process.once("SIGINT", stop);
    let out = "", err = "", late = false;
    c.stdout.on("data", (d) => { out = (out + d).slice(-KEEP); });
    c.stderr.on("data", (d) => { err = (err + d).slice(-KEEP); });
    const t = setTimeout(() => { late = true; try { process.kill(-c.pid!, "SIGKILL"); } catch {} }, ms);
    c.on("error", (e) => { clearTimeout(t); process.off("SIGTERM", stop); process.off("SIGINT", stop); resolve({ code: null, out, err, why: e.message }); });
    c.on("close", (code, sig) => { clearTimeout(t); process.off("SIGTERM", stop); process.off("SIGINT", stop); resolve({ code: late ? null : code, out, err, why: late ? "cut off at the limit" : `exit ${code ?? sig}` }); });
  });
}

export const VIEW_IMAGE_HELP = `view-image <path> [--max <pixels>]: a copy of an image no bigger than <pixels> (default
1568) on its longer side, to Read instead of the image itself (just view-image). It goes in
runs/view/ and the command prints its path. A whole image read as it is goes into context at full
size.
What an image costs grows with its pixels, so a smaller --max (800) is cheaper for a glance. Needs
ImageMagick (magick, or convert); without it, it says so and exits 1: docs/tools.md lists what
the project has for images.`;

// Downscale an image for a session to Read, with ImageMagick if it's installed (Oct
// 2026: crop sheets read whole, about 670K characters each, 3.7M in one session).
export function viewImageCli(args: string[]): number {
  if (!args.length || args[0] === "-h" || args[0] === "--help") { console.log(VIEW_IMAGE_HELP); return args.length ? 0 : 2; }
  let file = "", max = 1568;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--") continue;
    const eq = /^--max=(.*)$/.exec(args[i]);
    if (args[i] === "--max" || eq) {
      max = Number(eq ? eq[1] : args[++i]);
      if (!Number.isInteger(max) || max < 16) { console.error(`view-image: --max takes a number of pixels (16 or more), not ${args[i] ?? "nothing"}`); return 2; }
    } else if (!file) file = args[i];
    else { console.error(`view-image: one image at a time (${file}, then ${args[i]})`); return 2; }
  }
  if (!file) { console.error("view-image: which image? just view-image <path> [--max 1568]"); return 2; }
  if (!fs.existsSync(file)) { console.error(`view-image: no such file: ${file}`); return 1; }
  // ImageMagick 7 is magick; 6 is convert and identify.
  const im = (tool: string, a: string[]) => {
    for (const [cmd, pre] of [["magick", tool === "convert" ? [] : [tool]], [tool, []]] as const) {
      const r = spawnSync(cmd, [...pre, ...a], { encoding: "utf8" });
      if (!(r.error && (r.error as NodeJS.ErrnoException).code === "ENOENT")) return r;
    }
    return null;
  };
  const size = (f: string) => {
    const r = im("identify", ["-format", "%w %h\n", f]);
    const m = r && r.status === 0 ? /^(\d+) (\d+)/.exec(r.stdout) : null;
    return m ? `${m[1]}x${m[2]}` : "";
  };
  const was = size(file);
  if (was === "" && im("identify", ["-version"]) === null) {
    console.error(`view-image: ImageMagick isn't installed on this machine (no magick or convert), so there's no smaller copy of ${file}. docs/tools.md lists what the project has for images; Read the whole image only if you must, as it goes into context at full size.`);
    return 1;
  }
  const ext = /\.(png|jpe?g|webp|gif)$/i.exec(file)?.[1].toLowerCase() ?? "png";
  // Two images of one name in different folders get a copy each.
  const tag = crypto.createHash("sha1").update(fs.realpathSync(file)).digest("hex").slice(0, 6);
  const out = path.join("runs", "view", `${path.basename(file).replace(/\.[^.]*$/, "")}-${tag}-${max}.${ext}`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  // [0]: a GIF's or a PDF's first frame. ">": only ever smaller.
  const r = im("convert", [`${file}[0]`, "-resize", `${max}x${max}>`, out]);
  if (!r || r.status !== 0) { process.stderr.write(r?.stderr ?? ""); console.error(`view-image: ImageMagick couldn't make a copy of ${file}`); return 1; }
  console.log(`${out} (${size(out)}${was ? `, from ${was}` : ""}): Read this one`);
  return 0;
}
