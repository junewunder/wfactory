// runs/events.log, what `just fleet wait` reads to wake the overseer: one line per event.
import fs from "node:fs";
import path from "node:path";
import { host, pwd, ymdHm } from "./sys.ts";

// The loop's events.log line: date, host, lane, kind, message (tab-separated), in the
// checkout we're in. The lane is its clone's number (<checkout>-lane<N>), else 1.
export function event(kind: string, message: string, env: NodeJS.ProcessEnv = process.env) {
  const lane = /-lane([0-9]*)$/.exec(path.basename(pwd(env)))?.[1] || "1";
  fs.mkdirSync("runs", { recursive: true });
  fs.appendFileSync("runs/events.log", [ymdHm(), host(env), lane, kind, message.replace(/[\t\n]/g, " ")].join("\t") + "\n");
}
