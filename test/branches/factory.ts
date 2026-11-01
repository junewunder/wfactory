// The factory every file in test/branches/ races lanes on: init.sh's, on a local bare origin
// (test/lib's originFactory), with group g. Its check counts its runs ($FACTORY_LOCKS/checks),
// runs a lane's check-hook if one is set (to race it, to be slow, or to fail), and fails while
// fail-check is in the tree. shared.txt is there for two lanes to conflict on.
import { originFactory } from "../lib/index.ts";

const CHECK = 'echo x >> "${FACTORY_LOCKS:-/tmp}/checks"; { [ ! -x "${FACTORY_LOCKS:-/nonexistent}/check-hook" ] || "$FACTORY_LOCKS/check-hook"; } && test ! -e fail-check';

// lanes: the lanes to make (clones of origin, each its own host); add(x): unit g/<x>, titled
// "Unit <x>", through the tracker in this process (setup).
export function branchFactory(lanes: string[]) {
  const f = originFactory("br", { check: CHECK, files: { "shared.txt": "base\n" } });
  const ls = lanes.map((n) => f.lane(n));
  ls[0].setup(["add-group", "g", "--title", "Group"]);
  const add = (x: string, ...more: string[]) => ls[0].setup(["add-unit", `g/${x}`, "--title", `Unit ${x}`, ...more]);
  const drop = (id: string) => ls[0].setup(["drop", id, "--why", "test"]);
  return { ...f, lanes: ls, add, drop };
}
// A loop's usual window here: one unit, three minutes at most.
export const ONE = ["--max", "1", "--hours", "0.05"];
