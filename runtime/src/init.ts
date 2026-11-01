// init.sh: lay down the factory layer in a new or existing project.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { profileFile, profileGet, profileMachines, profileProblems } from "./profile.ts";
import { pwd } from "./sys.ts";
import { OPENING_GATE, tr } from "./tr.ts";

export const HELP = `init.sh — lay down the factory layer in a new or existing project.

Needs a complete profile (scripts/profile.sh: who the owner is, the
machines). Copies the skill's template: AGENTS.md, CLAUDE.md,
docs/factory.md, docs/machines.md (its table from the profile's Machines),
docs/tools.md, memory/MEMORY.md, a justfile importing factory/factory.just, and factory/
(stubs that run the skill's deployed loop code: factory/skill says which
copy). Then makes a tracker/ with the shared tracker CLI, holding only the gate
that ends the opening (opening/ready: no lanes until the owner passes it). Never
overwrites a file. In an existing project it merges instead: a pointer
section appended to AGENTS.md, an \`import\` line added to the justfile (plus a
placeholder \`check\` if there is none), and missing .gitignore lines. Runs
\`git init\` if the target isn't a repo; never commits.

Usage:
  init.sh <project-name> [--dir <parent>]
  init.sh .                                  # the current directory

Examples:
  init.sh my-factory --dir ~/factories
  init.sh .                                  # retrofit the repo you're in

Options:
  <project-name>   Directory to create under <parent>, or "." for the current
                   directory (the project name is then its basename).
  --dir <parent>   Parent directory. Default: the current directory.`;

const SKILL = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TEMPLATE = path.join(SKILL, "template");

// The factory file defines these; a project recipe with the same name would clash.
const RECIPES = "status next claim show find questions recheck refresh done review block reopen drop note ask answer pass decide decisions log lint memory view tracker mark loop oversee pause fleet long usage runs capped store view-image".split(" ");

const AGENTS_SECTION = `
## Factory

- \`docs/factory.md\` is the factory spec: the unit, the oracle, when to stop,
  and the loop. "Continue" means work one unit by that loop; "oversee" means run
  the lanes detached on the machines the owner includes (\`just fleet\`) and
  supervise them (\`just oversee-guide\`). Machine facts: \`docs/machines.md\`.
  What's installed for images, video and audio: \`docs/tools.md\`.
- Until the owner passes the opening's gate (\`opening/ready\`), the work is the
  project's issues, run by the wfactory skill's docs/opening.md;
  "continue" and "oversee" mean that, not the loop.
- \`tracker/\` is the state, changed only through the tracker CLI: \`just status\`,
  \`just next --claim\`, \`just done\`, \`just ask\`, \`just lint\` (\`just tracker --help\`).
- Talk to the owner in titles, never bare IDs: what a unit is first, the ID after in
  parentheses.
`;

const read = (f: string) => { try { return fs.readFileSync(f, "utf8"); } catch { return null; } };
const isFile = (f: string) => { try { return fs.statSync(f).isFile(); } catch { return false; } };
const exists = (f: string) => fs.existsSync(f);

// Every file under the template, relative to it, sorted.
function templateFiles(dir = TEMPLATE, rel = ""): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...templateFiles(path.join(dir, e.name), r));
    else if (e.isFile()) out.push(r);
  }
  return out.sort();
}

// docs/machines.md's table and sections, from the profile's Machines. Every machine keeps the
// factory at the same path as here (written with ~ when it's under $HOME).
function machinesFromProfile(file: string, root: string, env: NodeJS.ProcessEnv) {
  const home = env.HOME ?? "";
  const co = home && root.startsWith(`${home}/`) ? `~/${root.slice(home.length + 1)}` : root;
  const store = profileGet("store", "none", env);
  const rows: string[] = [], secs: string[] = [];
  for (const [m, ssh, lanes, heavy, can, cache] of profileMachines(env)) {
    const c = can || "—";
    rows.push(`| ${m} | ${ssh || m} | ${lanes || 1} | any | ${co} | ${c} | ${cache || "—"} | ${heavy || 1} | 3G | 0 |`);
    secs.push([
      `## ${m}`, "",
      "- **Accounts:** none recorded",
      ["-", "—", "none"].includes(c) ? "- **Can do:** anything any machine can" : `- **Can do:** <fill: what each name in this machine's Can column (${c}) means>`,
      store === "none" ? "- **Cache:** `work/` in the checkout; no store" : `- **Cache:** \`work/\` in the checkout; the store is \`${store}\` (the profile)`,
      "- **Notes:** none",
    ].join("\n"));
  }
  const t = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, t.replace("__MACHINE_ROWS__", () => rows.join("\n")).replace("__MACHINE_SECTIONS__", () => secs.join("\n\n")));
}

// The import, after the justfile's last setting (settings must stay first; comments can sit
// between them), or at the top if it has none.
function addImport(jf: string) {
  const imp = "import 'factory/factory.just'";
  const lines = fs.readFileSync(jf, "utf8").split("\n");
  const end = lines[lines.length - 1] === "" ? lines.pop() : undefined;
  let at = 0;
  lines.forEach((l, i) => { if (l.startsWith("set ")) at = i + 1; });
  if (at === 0) lines.unshift(imp, "");
  else lines.splice(at, 0, "", imp);
  fs.writeFileSync(jf, lines.join("\n") + (end !== undefined ? "\n" : ""));
}

const hasRecipe = (text: string, name: string, more = "") => new RegExp(`^${name}( |:${more})`, "m").test(text);

export function initCli(args: string[], env: NodeJS.ProcessEnv = process.env): number {
  let name = "", parent = ".";
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--dir") parent = args[++i] ?? "";
    else if (a === "-h" || a === "--help") { console.log(HELP); return 0; }
    else if (a.startsWith("-")) { console.error(`unknown option: ${a}`); return 2; }
    else if (name) { console.error(`unexpected arg: ${a}`); return 2; }
    else name = a;
  }
  if (!name) { console.error("error: project name required (use '.' for the current dir)"); return 2; }
  // The owner's answers come first: the machines file is made from them.
  const problems = profileProblems(env);
  if (problems.length) {
    for (const l of problems) console.error(l);
    console.error(`init: fill in the profile first (${profileFile(env)}; install.md says how)`);
    return 2;
  }

  // As the shell's \`cd … && pwd\` names it, through symlinks.
  const root = path.resolve(pwd(env), parent, name);
  try {
    if (name !== ".") fs.mkdirSync(root, { recursive: true });
    process.chdir(root);
  } catch (e) { console.error(`init: ${(e as Error).message}`); return 2; }
  const project = path.basename(root);
  env.PWD = root;
  console.log(`Factory layer for '${project}' in ${root}`);

  const created: string[] = [], merged: string[] = [], skipped: string[] = [];

  // The project's own justfile may be spelled Justfile or .justfile: merge into that one. (By
  // the folder's own names: on a filesystem that ignores case, as macOS's does, "justfile"
  // exists whenever "Justfile" does.)
  const here = fs.readdirSync(".");
  const jf = ["justfile", "Justfile", ".justfile"].find((f) => here.includes(f)) ?? "justfile";

  // ---- copy what's missing
  for (const rel of templateFiles()) {
    if (exists(rel) || (rel === "justfile" && jf !== "justfile")) continue;
    fs.mkdirSync(path.dirname(rel), { recursive: true });
    const src = path.join(TEMPLATE, rel);
    fs.writeFileSync(rel, fs.readFileSync(src, "utf8").replaceAll("__PROJECT__", project));
    if (rel === "docs/machines.md") machinesFromProfile(rel, root, env);
    if (fs.statSync(src).mode & 0o100) fs.chmodSync(rel, fs.statSync(rel).mode | 0o111);
    created.push(rel);
  }

  // ---- merge into files the project already had
  const made = (f: string) => created.includes(f);

  if (!made("AGENTS.md") && !(read("AGENTS.md") ?? "").includes("docs/factory.md")) {
    fs.appendFileSync("AGENTS.md", AGENTS_SECTION);
    merged.push("AGENTS.md (Factory section)");
  }

  if (!made("justfile")) {
    if (!(read(jf) ?? "").includes("factory/factory.just")) { addImport(jf); merged.push(`${jf} (import)`); }
    if (hasRecipe(read(jf) ?? "", "check", "|\\*")) {
      skipped.push(`${jf} already has a 'check' recipe: the factory treats it as the oracle. If it's a pipeline step, rename it and write a real oracle`);
    } else {
      fs.appendFileSync(jf, '\n# The oracle: everything that must pass before a unit counts as done.\ncheck:\n    @echo "TODO: wire the oracle (tests, typecheck, golden diff, regression gate)" >&2; exit 1\n');
      merged.push(`${jf} (placeholder check)`);
    }
    if (!hasRecipe(read(jf) ?? "", "rebuildable", "|\\*")) {
      fs.appendFileSync(jf, "\n# Files on disk with no source or copy in git: how many, and which (exit 1 if any).\nrebuildable:\n    @echo \"TODO: list written files that aren't in git, and derived ones no command rebuilds\" >&2; exit 1\n");
      merged.push(`${jf} (placeholder rebuildable)`);
    }
    const text = read(jf) ?? "";
    for (const r of RECIPES) if (hasRecipe(text, r)) skipped.push(`${jf} already has a '${r}' recipe: the project's wins over the factory's, so rename one if you want both`);
  }

  if (!made(".gitignore")) {
    for (const line of ["/runs/", "/.scratch/", "/.tracker/", "/work"]) {
      if ((read(".gitignore") ?? "").split("\n").includes(line)) continue;
      fs.appendFileSync(".gitignore", `${line}\n`);
      merged.push(`.gitignore (${line})`);
    }
  }

  if (!made("memory/MEMORY.md") && !(read("memory/MEMORY.md") ?? "").includes("by `just memory`")) {
    skipped.push("memory/MEMORY.md is written by hand: give each memory file title/hook frontmatter (open: true for the Open section), then `just memory` rebuilds the index from them");
  }

  if (!made("CLAUDE.md") && !(read("CLAUDE.md") ?? "").includes("@AGENTS.md")) {
    skipped.push("CLAUDE.md exists and doesn't import AGENTS.md: add '@AGENTS.md' to it");
  }

  if (!exists(".git") && spawnSync("git", ["-C", root, "rev-parse", "--git-dir"], { stdio: "ignore" }).status !== 0) {
    // (On main, the branch the loop lands on, whatever this machine's git would name it.)
    spawnSync("git", ["init", "-q", "-b", "main"], { stdio: "inherit" });
    created.push(".git");
  }

  let gated = false;
  if (!isFile("tracker/project.json")) {
    const r = tr(["init", "--title", project]);
    if (r.err) process.stderr.write(r.err);
    if (r.code === 0) {
      created.push("tracker/");
      // A new tracker starts with the opening's gate: no lanes until the owner says the
      // factory's ground is ready (the skill's docs/opening.md).
      gated = [["add-group", "opening", "--title", "The opening"],
        ["add-unit", OPENING_GATE, "--gate", "--title", "The opening is over: ready for lanes",
          "--detail", "Pass when every entry check in docs/factory.md's \"The opening\" holds."]].every((a) => {
        const g = tr(a);
        if (g.code !== 0) process.stderr.write(g.err);
        return g.code === 0;
      });
    }
  }

  // `just` finds the skill's recipes through .tracker/skill, which any stub makes (deploying
  // the skill first if this machine has none).
  let ran = false;
  try { ran = (fs.statSync("factory/tracker").mode & 0o111) !== 0 && spawnSync("factory/tracker", ["dir"], { stdio: "ignore" }).status === 0; } catch {}
  if (!ran) skipped.push("factory/tracker didn't run: deploy the skill (its scripts/deploy.sh), then run `factory/tracker status` once so `just` finds the recipes");

  // ---- report
  for (const f of created) console.log(`created: ${f}`);
  for (const f of merged) console.log(`merged:  ${f}`);
  for (const f of skipped) console.log(`CHECK:   ${f}`);
  console.log(gated ? `
Next: the opening (the skill's docs/opening.md): one-off work on the
project's issues until docs/factory.md's entry checks hold and the owner
passes the gate (\`just pass ${OPENING_GATE}\`). Along the way, replace every
<fill: …> in docs/factory.md and wire \`just check\`; then settle the design
(the skill's docs/design-questions.md), add the first units (\`just tracker
add-group\`, \`just tracker add-unit\`, or a template in tracker/templates/)
and pilot them by hand (the skill's docs/pilot.md) before \`just loop\`.
A project already past its opening: go through the entry checks with the
owner, and they pass the gate.` : `
Next: replace every <fill: …> in docs/factory.md, add the first units
(\`just tracker add-group\`, \`just tracker add-unit\`, or a template in
tracker/templates/), wire \`just check\`, and run a few units by hand before
\`just loop\`.`);
  console.log(`In an existing repo, run \`just lint\` now: old memory files and index lines often
need trimming to fit the caps.`);
  return 0;
}
