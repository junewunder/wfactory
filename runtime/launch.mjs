// launch.mjs: run a TypeScript entry point (main.ts) on Node 26, whatever `node` ran this.
// Callers that run the system's `node` (an old factory/ stub, a recipe, a systemd unit without
// $FACTORY_NODE) get Debian's 18 or 20, which can't run TypeScript. So on Node 26 (what
// deploy.sh pins) the entry point runs in this process; on an older Node it runs on the deployed
// Node 26: $FACTORY_NODE, else the one beside this deployed copy, else the deployed current's.
// Plain JavaScript, so any Node can read it.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import module from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// launch(<main.ts URL>, <name for the error>): returns once an in-process entry point has loaded.
export async function launch(main, name) {
  // The compile cache before the entry point loads, so its own types come from it too.
  if (Number(process.versions.node.split(".")[0]) >= 26) { module.enableCompileCache(); await import(main); return; }
  const deploy = process.env.FACTORY_DEPLOY || path.join(os.homedir(), ".local", "share", "wfactory");
  const node = [process.env.FACTORY_NODE, path.join(here, "..", "..", "node", "bin", "node"), path.join(deploy, "current", "node", "bin", "node")]
    .find((n) => n && path.isAbsolute(n) && fs.existsSync(n));
  if (node) {
    const r = spawnSync(node, [fileURLToPath(main), ...process.argv.slice(2)], { stdio: "inherit" });
    if (r.signal) process.kill(process.pid, r.signal);
    if (r.status === null) { console.error(`${name}: couldn't run ${node}: ${r.error?.message || "no exit status"}`); process.exit(2); }
    process.exit(r.status);
  } else if (process.features.typescript) await import(main);
  else {
    console.error(`${name}: it's TypeScript, and needs Node 26; this is Node ${process.versions.node}, and no deployed Node 26 was found. The wfactory skill's scripts/deploy.sh installs it.`);
    process.exit(2);
  }
}
