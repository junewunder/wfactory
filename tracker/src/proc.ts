// Processes: whether one is still the one it was, and which one a claim lives with. What they are
// is the OS's to say (runtime/src/os.ts).
import { platform } from "../../runtime/src/os.ts";
import { ctx } from "./ctx.ts";

// A process's start time, which tells it from a later process given the same PID. null if it's
// gone.
export const procStart = (pid: number): string | null => platform.processStart(pid) || null;

// The process a claim lives as long as: $FACTORY_PID, else the nearest claude ancestor.
export function claimPid(): number | null {
  if (ctx.env.FACTORY_PID) return Number(ctx.env.FACTORY_PID);
  let pid = process.ppid;
  for (let i = 0; i < 30 && pid > 1; i++) {
    const cmd = platform.processArgs(pid);
    if (cmd === null) return null;
    if (cmd.some((a, j) => j < 3 && /(^|\/)claude(\.js|\.exe)?$/.test(a))) return pid;
    pid = platform.processParent(pid);
    if (!pid) return null;
  }
  return null;
}
