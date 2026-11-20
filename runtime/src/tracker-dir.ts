// Where a checkout's tracker state is on disk, for what the runtime reads of it itself (its
// settings, tracker/project.json): the checkout's clone of origin's state branch when it has
// one, else its own tracker/ (no origin, or FACTORY_STATE=local). tracker/src/store.ts is what
// keeps the clone; the tracker's commands make it and bring it up to date, so a run asks the
// tracker something (`dir --sync`) before it reads a setting.
import fs from "node:fs";
import path from "node:path";
import { STATE_CLONE } from "../../tracker/src/store.ts";

export function trackerDir(dir = ".", env: NodeJS.ProcessEnv = process.env): string {
  const shared = path.join(dir, STATE_CLONE, "tracker");
  return env.FACTORY_STATE !== "local" && fs.existsSync(path.join(shared, "project.json")) ? shared : path.join(dir, "tracker");
}
export const projectFile = (dir = ".", env: NodeJS.ProcessEnv = process.env) => path.join(trackerDir(dir, env), "project.json");
