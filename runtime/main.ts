#!/usr/bin/env node
// The runtime's commands in TypeScript: `main.ts <command> [args]`. Each runtime/<command>.sh
// runs one through main.mjs, which finds Node 26 for it. More of the runtime moves here as it's
// ported (docs/goal-ts.md, phase 2).
import module from "node:module";

// As the tracker's main.ts: the compile cache before the modules load, since stripping their
// types costs more than most commands do (the inbox's hook runs after every tool call).
module.enableCompileCache();

const USAGE = `main.ts <command> [args]: the runtime's commands (<command> --help for each)
  machines   docs/machines.md's Lanes table (factory/machines.sh's machine_rows, machine_get)
  profile    the user's profile: its path, settings, machines and placeholders
  usage      how much of the plan's usage is left (factory/usage.sh)
  inbox      a lane's inbox: what reaches a running session (runtime/inbox.sh)
  heavy      the machine's heavy jobs: memory budget, slots, how jobs ended (just heavy)
  capped     a command under a memory cap (just capped)
  long       a long job, detached and memory-capped (just long)
  lane       the checkout a lane runs in (factory/lane.sh)
  store      group data copied between this machine and the store (factory/store.sh)
  oversee    one lane's loop, run detached for an overseer to watch (factory/oversee.sh)
  fleet      every machine's lanes from one overseeing session (factory/fleet.sh)
  daemon     the machine's factory daemon: lanes back after it went down, and fleet wait
  loop       the factory run unattended, one fresh session per unit (factory/loop.sh)
  session    what the loop does with one session: its memory snapshot, a usage limit (session.sh)
  init       lay down the factory layer in a new or existing project (scripts/init.sh)
  factory-diff   whether a factory runs the deployed skill through the current stubs (scripts/factory-diff.sh)
  to-stubs   switch a factory from copies of the loop's scripts to the stubs (scripts/to-stubs.sh)
  smoke      the install's smoke test: a toy factory worked by one lane (scripts/smoke.sh)
  runs       the last loop iterations on this machine (just runs)
  scorecard  where a run's sessions and time went, from the records (just scorecard)
  prompt     the loop's worker prompt, then the project's own rules (just prompt)
  oversee-guide  the overseer's card, or with --full its guide, then the project's additions (just oversee-guide)
  until      wait up to some seconds for a check to pass, or that long (just until)
  view-image a smaller copy of an image, to read instead of it (just view-image)`;

const [cmd, ...args] = process.argv.slice(2);
const commands: Record<string, () => Promise<number>> = {
  machines: async () => (await import("./src/machines.ts")).machinesCli(args),
  profile: async () => (await import("./src/profile.ts")).profileCli(args),
  usage: async () => (await import("./src/usage.ts")).usageCli(args),
  inbox: async () => (await import("./src/inbox.ts")).inboxCli(args),
  heavy: async () => (await import("./src/heavy.ts")).heavyCli(args),
  capped: async () => (await import("./src/capped.ts")).cappedCli(args),
  long: async () => (await import("./src/long.ts")).longCli(args),
  lane: async () => (await import("./src/lane.ts")).laneCli(args),
  store: async () => (await import("./src/store.ts")).storeCli(args),
  oversee: async () => (await import("./src/oversee.ts")).overseeCli(args),
  fleet: async () => (await import("./src/fleet.ts")).fleetCli(args),
  daemon: async () => (await import("./src/daemon.ts")).daemonCli(args),
  loop: async () => (await import("./src/loop.ts")).loopCli(args),
  session: async () => (await import("./src/session.ts")).sessionCli(args),
  init: async () => (await import("./src/init.ts")).initCli(args),
  "factory-diff": async () => (await import("./src/stubs.ts")).factoryDiffCli(args),
  "to-stubs": async () => (await import("./src/stubs.ts")).toStubsCli(args),
  smoke: async () => (await import("./src/smoke.ts")).smokeCli(args),
  runs: async () => (await import("./src/recipes.ts")).runsCli(args),
  scorecard: async () => (await import("./src/scorecard.ts")).scorecardCli(args),
  prompt: async () => (await import("./src/recipes.ts")).promptCli(args),
  "oversee-guide": async () => (await import("./src/recipes.ts")).overseeGuideCli(args),
  until: async () => (await import("./src/recipes.ts")).untilCli(args),
  "view-image": async () => (await import("./src/recipes.ts")).viewImageCli(args),
};
if (cmd !== undefined && Object.hasOwn(commands, cmd)) process.exitCode = await commands[cmd]();
else {
  console.log(USAGE);
  process.exitCode = cmd === undefined || cmd === "-h" || cmd === "--help" ? 0 : 2;
}
