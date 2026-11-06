// runs/events.log, what `just fleet wait` reads to wake the overseer: one line per event.
import fs from "node:fs";
import path from "node:path";
import { host, pwd, ymdHm } from "./sys.ts";

// The loop's events.log line: date, host, lane, kind, message (tab-separated), in the
// checkout we're in, and the unit it happened in when that's known: the one given, else the one
// the session it runs in holds (FACTORY_SESSION_UNIT, which a long job's service inherits), so
// the morning summary can say what became of it. The lane is its clone's number
// (<checkout>-lane<N>), else 1. Readers show fields 0-4; older lines have no sixth.
export function event(kind: string, message: string, env: NodeJS.ProcessEnv = process.env, unit = env.FACTORY_SESSION_UNIT || "") {
  const lane = /-lane([0-9]*)$/.exec(path.basename(pwd(env)))?.[1] || "1";
  fs.mkdirSync("runs", { recursive: true });
  fs.appendFileSync("runs/events.log", [ymdHm(), host(env), lane, kind, message.replace(/[\t\n]/g, " "), ...(unit ? [unit.replace(/\s/g, "")] : [])].join("\t") + "\n");
}
