// The checkout a lane runs in: a plain clone beside the factory's checkout, made on first use.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { enterRoot, asksHelp } from "./sys.ts";
import { netGit } from "../../tracker/src/net.ts";

export const HELP = `
lane.sh — the checkout a lane runs in, made on first use.

Every lane runs in a plain clone beside this checkout, \`<checkout>-lane<N>\`
(never a git worktree: a lane switches branches, merges and commits without
touching anyone else's index), so the checkout itself stays on main for the owner
and the overseer. The clone is made from origin, so lanes meet on origin's
main like machines do. Its \`work/\` is a link to this checkout's, so a laptop
keeps one \`work/\`, and \`.env\` is linked too. Without an origin there's
nothing to clone from, and lane 1 is this checkout. A project that needs more in a fresh clone (a virtualenv, a build) puts
it in an executable \`factory/lane-setup\`, run once in the new clone.

Usage:
  factory/lane.sh dir <N>     print lane N's checkout, making the clone if it's missing`;

// git in a folder: its output (trimmed), or null if it failed.
function git(dir: string, ...a: string[]) {
  const r = spawnSync("git", ["-C", dir, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return r.status === 0 ? r.stdout.trim() : null;
}
const exists = (p: string) => fs.existsSync(p);   // as `[ -e ]`: through links
const isLink = (p: string) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };
// `ln -sfn <target> <link>`: the link, in place of whatever file or link was there.
function link(target: string, at: string) {
  fs.rmSync(at, { force: true });
  fs.symlinkSync(target, at);
}
const tracksWork = (dir: string) => !!git(dir, "ls-files", "work");

// Lane N's checkout, made if it's missing: null (and why, on stderr) if it can't be.
export function laneDir(root: string, n: number): string | null {
  // A lane's clone runs this too: lane N is always beside the first checkout.
  const base = path.basename(root);
  if (/-lane[0-9]/.test(base)) root = path.join(path.dirname(root), base.replace(/-lane[0-9]*$/, ""));
  const url = git(root, "remote", "get-url", "origin");
  if (n === 1 && url === null) return root;

  const dir = `${root}-lane${n}`;
  if (!exists(`${dir}/.git`)) {
    if (url === null) { console.error(`lane: ${root} has no origin; a second lane meets the first on origin's main`); return null; }
    // Bounded (tracker/src/net.ts): on a dead connection a clone would wait forever. One cut
    // off leaves a part-made folder behind (not one that was there before it).
    const was = exists(dir);
    const c = netGit(["clone", "-q", url, dir], { encoding: "utf8", stdio: ["inherit", 2, "pipe"] }, 900);
    if (c.stderr) process.stderr.write(c.stderr);
    if (c.status !== 0) { if (!was) fs.rmSync(dir, { recursive: true, force: true }); process.exit(c.status ?? 1); }
    git(dir, "checkout", "-q", git(root, "rev-parse", "--abbrev-ref", "HEAD") ?? "");
    if (tracksWork(dir)) {
      console.error(`lane: work/ is tracked in git here, so lane ${n} keeps its own copy instead of a link`);
    } else {
      fs.mkdirSync(`${root}/work`, { recursive: true });
      fs.rmSync(`${dir}/work`, { recursive: true, force: true });
      fs.symlinkSync(`${root}/work`, `${dir}/work`);
    }
    if (exists(`${root}/.env`)) link(`${root}/.env`, `${dir}/.env`);
    // `just` in the new clone (lane-setup may use it) reads the same recipes as the checkout.
    let skill: string | null = null;
    try { skill = fs.readlinkSync(`${root}/.tracker/skill`); } catch {}
    if (skill !== null) { fs.mkdirSync(`${dir}/.tracker`, { recursive: true }); link(skill, `${dir}/.tracker/skill`); }
    const setup = `${dir}/factory/lane-setup`;
    let runnable = false;
    try { fs.accessSync(setup, fs.constants.X_OK); runnable = fs.statSync(setup).isFile(); } catch {}
    if (runnable) {
      const o = { cwd: dir, env: { ...process.env, PWD: dir }, stdio: ["inherit", 2, 2] as ("inherit" | number)[] };
      let r = spawnSync(setup, o);
      // Without a #! line, bash runs it itself, as the shell did.
      if ((r.error as NodeJS.ErrnoException | undefined)?.code === "ENOEXEC") r = spawnSync("bash", [setup], o);
      if (r.status !== 0) console.error(`lane: factory/lane-setup failed in ${dir}`);
    }
    console.error(`lane: made lane ${n}'s clone at ${dir} (work/ linked to ${root}/work)`);
  }
  // The links are never committed: 'work/' in a .gitignore matches a folder, not a link, and a
  // tracked link pulled into the checkout replaces its real work/ (a factory once lost a laptop's work that way).
  if (isLink(`${dir}/work`) || !exists(`${dir}/work`)) {
    const ex = `${dir}/.git/info/exclude`;
    for (const x of ["/work", "/.env"]) {
      let have = "";
      try { have = fs.readFileSync(ex, "utf8"); } catch {}
      if (!have.split("\n").includes(x)) { fs.mkdirSync(path.dirname(ex), { recursive: true }); fs.appendFileSync(ex, `${have && !have.endsWith("\n") ? "\n" : ""}${x}\n`); }
    }
    // A pull that dropped a wrongly tracked link leaves the lane without one: link it again.
    if (!exists(`${dir}/work`) && !tracksWork(dir)) { fs.mkdirSync(`${root}/work`, { recursive: true }); link(`${root}/work`, `${dir}/work`); }
  }
  return dir;
}

export function laneCli(args: string[], env: NodeJS.ProcessEnv = process.env): number {
  const [cmd = "", n = ""] = args;
  if (cmd === "" || asksHelp(args)) { console.log(HELP); return 0; }
  if (!enterRoot("lane.sh", env)) return 1;
  if (cmd !== "dir") { console.error(`lane: unknown command ${cmd} (dir <N>)`); return 2; }
  if (!/^[1-9][0-9]*$/.test(n)) { console.error("lane: which lane? (dir <N>, N from 1)"); return 2; }
  const dir = laneDir(env.FACTORY_ROOT!, Number(n));
  if (dir === null) return 2;
  console.log(dir);
  return 0;
}
