// The loop's clock: when it started, its stop time and last call.
// Last call is "last_call" minutes before the stop time (#159: no reserve for CI; CI runs as it
// falls due through the night, and what hasn't run by the stop is listed for the morning). Each
// lane writes its last call to last-call in the machine's lock folder (FACTORY_LOCKS), for its stop
// time, so the daemon bringing a lane back reads the time the loop worked out. The file is gone
// after a reboot: the daemon then works it out from last_call itself, as the loop does.
import fs from "node:fs";
import { epoch } from "./sys.ts";
import { cat, exists, hmAt, isInt, json } from "./loop-util.ts";
import { log } from "./session.ts";

// Times for one stop time: a lane brought back gets its stop time again to within a minute.
export const SAME_STOP_S = 120;
// The last-call file of this machine's lanes of the factory: {"at", "deadline", "last_call",
// "written"}: the writer's last call, for its stop time and its last_call minutes (epoch seconds
// but last_call).
export const lastCallFile = (locks = process.env.FACTORY_LOCKS) => locks ? `${locks}/last-call` : "";
// The last call written there for a stop time and last_call minutes (null: nothing, or for
// another stop time, or a lane with another last_call).
export function writtenLastCall(file: string, deadline: number, lastCall: number): number | null {
  const j = file ? json(cat(file)) : null;
  const at = Number(j?.at), d = Number(j?.deadline);
  return Number.isInteger(at) && at > 0 && Number.isInteger(d) && Math.abs(d - deadline) <= SAME_STOP_S && Number(j?.last_call) === lastCall ? at : null;
}

export class Clock {
  start = 0;
  deadline = 0;
  stopAt = "";          // the stop time the overseer set, as "HH:MM" ("" while it's --hours's)
  lastCall = 30;        // minutes before the stop time that last call begins (0: none timed)
  graceS = 900;         // seconds a session holding what CI needs gets to wrap up in last call
  inLc = false;         // last call has begun (it doesn't end)
  lcTold: string | null = null;   // what last call holds back, as last said
  carried = 0;          // the last call of the run a lane brought back carries on (FACTORY_LAST_CALL_AT), 0: none
  published = 0;        // the last-call time this lane last wrote

  // The stop time: --hours, or an earlier one the overseer set (`just fleet stop-at`, runs/.stop-at).
  refresh() {
    const s = cat("runs/.stop-at");
    if (isInt(s) && Number(s) < this.deadline) { this.deadline = Number(s); this.stopAt = hmAt(this.deadline); }
  }
  // When the timed last call begins (the stop time, with none): lastCall minutes before the
  // stop time, for the work in flight to land; at most half the run (a short run still works
  // some units). A lane brought back (by the daemon) keeps the last call of the run it carries
  // on, if that's earlier: its own run is only what was left of that one.
  lcAt() {
    let w = this.lastCall * 60;
    const half = Math.trunc((this.deadline - this.start) / 2);
    if (w > half) w = half;
    const at = this.deadline - w;
    return this.carried > 0 && this.carried < at ? this.carried : at;
  }
  // Write this lane's last call (the loop does, before each unit, until last call), saying so when
  // it moved by more than 5 minutes (an earlier stop time).
  publish() {
    if (this.lastCall <= 0) return;
    const at = this.lcAt(), f = lastCallFile();
    if (this.published && Math.abs(at - this.published) > 300) log(`last call now at ${hmAt(at)} (was ${hmAt(this.published)}), for the stop at ${hmAt(this.deadline)}`);
    if (at === this.published && writtenLastCall(f, this.deadline, this.lastCall) === at) return;
    this.published = at;
    if (!f) return;
    try {
      const tmp = `${f}.${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify({ at, deadline: this.deadline, last_call: this.lastCall, written: epoch() }) + "\n");
      fs.renameSync(tmp, f);
    } catch {}
  }
  // Last call: `just fleet last-call` (runs/.last-call), or the timed one.
  inLastCall() {
    if (exists("runs/.last-call")) return true;
    if (this.lastCall <= 0) return false;
    return epoch() >= this.lcAt();
  }
}
