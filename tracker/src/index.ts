// The tracker as a library: run(argv) does what `tracker <argv>` does, in this process, and
// returns the exit code. Output goes to the console. The loop calls it in-process later; the
// CLI (../main.ts) is a thin wrapper around it.
import { makeContext, setContext } from "./ctx.ts";
import { prepare, resetSession } from "./store.ts";
import { BUSY, LockBusy, UsageError } from "./text.ts";
import { HELP, USAGE } from "./help.ts";
import { C } from "./commands/registry.ts";
import "./commands/work.ts";
import "./commands/queue.ts";
import "./commands/ask.ts";
import "./commands/ci.ts";
import "./commands/setup.ts";
import "./commands/loop.ts";
import "./commands/lint.ts";
import "./commands/memory.ts";
import "./commands/merge.ts";
import "./commands/view.ts";
import "./commands/prune.ts";
import "./commands/expect.ts";

export { C as commands };

export function run(argv: string[], { env = process.env, cwd = process.cwd() }: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): number {
  const [cmd, ...args] = argv;
  setContext(makeContext(env, cmd, cwd));
  resetSession();
  const fn = cmd !== undefined && Object.hasOwn(C, cmd) ? C[cmd] : undefined;
  if (fn && (args.includes("--help") || args.includes("-h"))) {
    console.log(HELP[cmd] || `${cmd}: no help written (add it to HELP in tracker/src/help.ts)`);
    return 0;
  }
  // A command that doesn't exist says so in one line, so it's also the last line (callers often
  // see only the last lines): the whole usage, printed as well, reads as if the command ran.
  if (!fn && cmd && !["-h", "--help", "help"].includes(cmd)) {
    console.error(`tracker: there's no command "${cmd}"; \`tracker --help\` lists them (\`status <group>\` lists a group's open units and where each stands)`);
    return 2;
  }
  if (!fn || cmd === "-h" || cmd === "--help") { console.log(USAGE); return 0; }
  try {
    prepare(cmd);
    const rc = fn(args);
    return typeof rc === "number" ? rc : 0;
  } catch (e) {
    if (e instanceof LockBusy) { console.error(e.message); return BUSY; }
    if (e instanceof UsageError) { console.error(e.message); return 2; }
    throw e;
  }
}
