// The heartbeat for a lane's leases, claims and CI runs: a process of its own beside the loop.
import path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { epoch } from "./sys.ts";
import { tr } from "./tr.ts";

// The heartbeat for this machine's leases, and its claims and CI runs, while the lane runs (the
// tracker writes only every 10 minutes): a process of its own, so it beats while the loop waits
// on a copy back, a probe or the claim lock. It ends with the loop <pid>, even a SIGKILLed one, so
// a dead laptop's leases, claims and CI go stale for the other machines.
export async function beat(pid: number): Promise<number> {
  const every = Number(process.env.FACTORY_BEAT_EVERY || 300);
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (let next = epoch() + every; alive(); await sleep(1000)) {
    if (epoch() < next) continue;
    next = epoch() + every;
    try { tr(["lease", "beat"]); } catch {}
  }
  return 0;
}
export function startBeat(here: string): number {
  try {
    const c = spawn(process.execPath, [path.join(here, "main.mjs"), "loop", "beat", String(process.pid)], { stdio: "ignore" });
    c.on("error", () => {});
    return c.pid ?? 0;
  } catch { return 0; }
}
