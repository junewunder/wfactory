// Whether a group's build is the same at two commits, as restore() asks before putting a set back
// that was built from a commit other than the one this clone is on: the outputs are good only if
// nothing that feeds the group's build changed between them. The project's ci.affected hook says
// (tracker/project.json ci.affected, `tracker ci-affected --help`), asked about the one group with
// FACTORY_CI_AFFECTED_ONLY=<group>: it must answer "<group>\tunchanged" for the same build. Anything
// else (the group named with a why, no line for it, a hook that fails or runs out of time, no hook,
// a commit this clone hasn't got and can't fetch) is "can't tell", and the set stays aside.
import { spawnSync } from "node:child_process";
import { code, run } from "./store-remote.ts";
import { out } from "./store-util.ts";
import { tr } from "./store-tracker.ts";

export type Same = { same: true; how: string } | { same: false; why: string };
const short = (c: string) => c.slice(0, 8);
const have = (c: string) => code(run("git", ["cat-file", "-e", `${c}^{commit}`], { err: "ignore" })) === 0;

// from: the commit the set's outputs were built from; to: the commit this clone is on.
export function sameBuild(g: string, from: string, to: string): Same {
  if (!from) return { same: false, why: "no record of the commit they were built from" };
  if (!to) return { same: false, why: "this clone's commit can't be read" };
  if (from === to) return { same: true, how: `built from ${short(from)}, the commit your branch is on` };
  // A commit only another clone had (a branch pushed from elsewhere, then moved): fetched by name.
  if (!have(from)) {
    run("timeout", [process.env.FACTORY_FETCH_TIMEOUT || "60", "git", "fetch", "-q", "origin", from], { err: "ignore" });
    if (!have(from)) return { same: false, why: `built from ${short(from)}, which this clone hasn't got and couldn't fetch from origin` };
  }
  let cmd: string | null | undefined;
  try { cmd = (JSON.parse(tr(["ci-affected", "--json"], "ignore").stdout) as { cmd?: string | null }).cmd; } catch { cmd = undefined; }
  if (cmd === undefined) return { same: false, why: `built from ${short(from)}, and the tracker couldn't say what the project's ci.affected hook is` };
  if (!cmd) return { same: false, why: `built from ${short(from)}, and the project has no ci.affected hook to compare the build's inputs by` };
  const secs = process.env.FACTORY_CI_AFFECTED_TIMEOUT || "120";
  const r = spawnSync("timeout", [secs, "bash", "-c", cmd.replaceAll("{old}", from).replaceAll("{new}", to)], {
    encoding: "utf8", maxBuffer: 1 << 24, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, FACTORY_CI_AFFECTED_ONLY: g },
  });
  const rc = code(r), said = `ci.affected over ${short(from)}..${short(to)}`;
  if (rc !== 0) {
    const last = (out(r.stderr).split("\n").pop() ?? "").slice(0, 200);
    return { same: false, why: `${said} couldn't say whether ${g}'s build changed (${rc === 124 ? `out of time after ${secs}s` : `exit ${rc}`}${last ? `: ${last}` : ""})` };
  }
  const mine = out(r.stdout).split("\n").map((l) => l.split("\t")).filter((x) => x[0].trim() === g);
  if (mine.length === 1 && mine[0].slice(1).join(" ").trim() === "unchanged") return { same: true, how: `built from ${short(from)}; ${said}: ${g}'s build inputs are unchanged` };
  if (!mine.length) return { same: false, why: `${said} didn't say ${g}'s build is unchanged` };
  const why = mine.map((x) => x.slice(1).join(" ").trim()).filter((w) => w !== "unchanged").join("; ") || "it gave two answers";
  return { same: false, why: `${said} says ${g}'s build changed: ${why.slice(0, 300)}` };
}
