// The tracker, as the store asks it: a group's data, a unit's state, who leases a group.
import { here } from "./store-here.ts";
import { code, run } from "./store-remote.ts";
import { type Data, out } from "./store-util.ts";

// The tracker, as the stub runs it (FACTORY_TRACKER still picks the file).
export const tr = (args: string[], err: "inherit" | "pipe" | "ignore" = "inherit") => run("factory/tracker", args, { err });
export function data(args: string[], quiet = false): Data | null {
  const r = tr(["data", ...args], quiet ? "ignore" : "inherit");
  if (code(r) !== 0) return null;
  try { return JSON.parse(r.stdout) as Data; } catch { return null; }
}
// A set-aside's group: its data, "lost" when the tracker says it keeps none on the store any more
// (or has no such group), null when the tracker can't say now.
export function setData(g: string): Data | "lost" | null {
  const r = tr(["data", g], "pipe");
  if (code(r) !== 0) return /no group "|keeps no data on the store/.test(r.stderr ?? "") ? "lost" : null;
  try { return JSON.parse(r.stdout) as Data; } catch { return null; }
}
// The store and store.rebuilt, without a group (a set whose group lost its data); null if none.
export function storeOnly(): Pick<Data, "remote" | "rebuilt"> | null {
  const r = tr(["data", "--all"], "ignore");
  if (code(r) !== 0) return null;
  try { const j = JSON.parse(r.stdout) as Data; return { remote: j.remote, rebuilt: j.rebuilt ?? [] }; } catch { return null; }
}
// A unit's state for what its outputs owe the store: gone if the tracker has no such unit, unknown
// if it can't say.
export function ustate(u: string) {
  const r = tr(["state", u], "pipe");
  if (code(r) === 0) return out(r.stdout);
  return (r.stderr ?? "").includes('no unit "') ? "gone" : "unknown";
}
// Only an answer from origin counts: offline, the lease can't be shown to be ours.
export const heldHere = (g: string) => out(tr(["lease", "holder", g, "--fresh"], "ignore").stdout) === here.host;
