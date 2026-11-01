// What the files in test/loop/lane/ share: test/loop/factory.ts's loopFactory, with the loop run
// as the real command, factory/loop.sh, for checks that don't hang on the clock (the in-process
// loop of inproc.ts is for those that do); laneFactory(name, laneName, {check, files}) passes the last
// on to it. The factory is <name><pid> and its one lane is named
// after it, not lane a: a clone <top>/<name><pid>-lane1 with host <name><pid> and locks
// <top>/locks-<name><pid>, so the systemd units its sessions run in (factory-<checkout>-<tag>) are
// this run's file's own, even beside another run of it. On top of loopFactory's:
//   loopSh(args, add):  factory/loop.sh <LOOP's options> <args> in the lane, to the end: its output
//                       (stdout and stderr merged) and exit code; failing if it runs past its
//                       --hours and a minute (test/lib's loopDeadline)
//   loopBg(args, add):  the same in the background, in a process group of its own (killed with all
//                       it started when the file's tests end): background()'s out, until, end, stop
//   oversee(args, add): factory/oversee.sh in the lane (merged output and exit code)
//   proj(fn):           changes tracker/project.json on origin's main (fn changes it in place)
//   steps(add):         adds CI steps to the project's (proj)
//   until(fn, what, s): polls (real time) until fn() is true
//   onMain(file, text): writes a file in the lane (executable; null: removes it) and lands that on
//                       origin's main, as the owner's commit would
import fs from "node:fs";
import path from "node:path";
import { background, killGroup, loopDeadline, stopFirst, type Result } from "../../lib/index.ts";
import { waitFor } from "../inproc.ts";
import { LOOP, loopFactory } from "../factory.ts";

type Env = NodeJS.ProcessEnv;

export function laneFactory(name: string, laneName = name, o: { check?: string; files?: Record<string, string> } = {}) {
  const f = loopFactory(`${name}${process.pid}`, { lane: `${laneName}${process.pid}`, ...o });
  const { a } = f;
  const groups: number[] = [];
  stopFirst(() => { for (const p of groups) killGroup(p); });
  const loopSh = (args: string[], add: Env = {}): Result => a.run("factory/loop.sh", [...LOOP, ...args], add, { timeout: loopDeadline(args) });
  const loopBg = (args: string[], add: Env = {}, { file = "factory/loop.sh", opts = LOOP } = {}) => {
    const b = background(a.at(file), [...opts, ...args], { cwd: a.dir, env: a.envWith(add), group: true });
    groups.push(b.pid!);
    return b;
  };
  const oversee = (args: string[], add: Env = {}) => a.run("factory/oversee.sh", args, add);
  const proj = (fn: (p: any) => void) => f.editMain("tracker/project.json", fn);
  const steps = (add: Record<string, unknown>) => proj((p) => { p.ci ??= { steps: {} }; Object.assign(p.ci.steps, add); });
  const onMain = (file: string, text: string | null) => {
    a.git("checkout", "-q", "main"); a.git("pull", "-q", "--rebase", "origin", "main");
    if (text === null) a.git("rm", "-q", file);
    else { fs.mkdirSync(path.dirname(a.at(file)), { recursive: true }); fs.writeFileSync(a.at(file), text); fs.chmodSync(a.at(file), 0o755); a.git("add", file); }
    a.git("commit", "-qm", `${text === null ? "no" : "a"} ${file}`, "--", file); a.git("push", "-q", "origin", "HEAD:main");
  };
  return { ...f, loopSh, loopBg, oversee, proj, steps, onMain, until: waitFor };
}
