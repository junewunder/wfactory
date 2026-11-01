// Every machine's lanes from one overseeing session (factory/fleet.sh): each lane is
// factory/oversee.sh in its own clone, run here for this machine and over ssh for the others.
// This is the CLI; what every command works from is fleet-ctx.ts, and the commands are in
// fleet-lanes.ts (start, restart, stop, tidy, tell…), fleet-wait.ts, fleet-journal.ts (attach,
// note, summary, events) and fleet-beat.ts (the heartbeat).
import { enterRoot, asksHelp } from "./sys.ts";
import { HELP } from "./fleet-help.ts";
import { openFleet } from "./fleet-ctx.ts";
import { beat } from "./fleet-beat.ts";
import { attach, events, noteCmd, summary } from "./fleet-journal.ts";
import { restart, run, start, state, stopAt, tell, tidy, usage } from "./fleet-lanes.ts";
import { wait } from "./fleet-wait.ts";

export { HELP, EVENTS_SUMMARY, EVENTS_WAKE } from "./fleet-help.ts";
export { QUIET_MINUTES, dur, forYou, stake } from "./fleet-beat.ts";

export async function fleetCli(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let floop = "";
  if (argv[0] === "--loop") { floop = argv[1] ?? ""; argv = argv.slice(2); }
  const [cmd = "", ...args] = argv;
  // note and tell take free text: past its first word, -h and --help are part of it.
  const textAt = cmd === "tell" ? 3 : cmd === "note" ? (args[0] === "--as" ? 4 : 2) : argv.length;
  if (cmd === "" || asksHelp([cmd, ...args], textAt)) { console.log(HELP); return 0; }
  if (!enterRoot("fleet.sh", env)) return 1;
  const f = openFleet(env, floop);
  if (typeof f === "number") return f;
  const { takeMachines, each } = f;

  switch (cmd) {
    case "start": return start(f, args);
    case "wait": return wait(f, args);
    case "attach": return attach(f, args);
    case "note": return noteCmd(f, args);
    case "summary": return summary(f, args);
    case "beat": beat(f); return 0;
    case "state": state(f, takeMachines(args).ms); return 0;
    case "events": return events(f, args);
    case "pause": each(takeMachines(args).ms, ["pause"]); return 0;
    case "pause-now": each(takeMachines(args).ms, ["pause", "--now"]); return 0;
    case "last-call": each(takeMachines(args).ms, ["last-call"]); return 0;
    case "restart": return restart(f, args);
    case "stop-at": return stopAt(f, args);
    case "tell": return tell(f, args);
    case "stop": {
      const { ms } = takeMachines(args);
      each(ms, ["stop"]);
      tidy(f, ms);
      return 0;
    }
    case "tidy": tidy(f, takeMachines(args).ms); return 0;
    case "usage": return usage(f, args);
    case "run": return run(f, args);
    default:
      console.error(`fleet: unknown command ${cmd} (start | attach | wait | note | summary | beat | state | events | pause | pause-now | restart | last-call | stop-at | tell | stop | tidy | usage | run)`);
      return 2;
  }
}
