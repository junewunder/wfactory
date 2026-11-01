// Group data on the store: a group's data copied between this machine and the store, by lease,
// for the loop (store.sh). The rules are design.md's "Group data on a store"; HELP says what's
// kept where, and why. This is the CLI; its commands are in modules beside it: take
// (store-take.ts, with room in the cache: store-cache.ts), end and up (store-copy.ts), the
// leases (store-leases.ts), seed and adopt (store-seed.ts) and aside (store-aside.ts), over the
// copy here (store-local.ts), rsync and the store's shell (store-remote.ts) and the tracker
// (store-tracker.ts).
import fs from "node:fs";
import path from "node:path";
import { enterRoot, host as hostName, pwd, asksHelp } from "./sys.ts";
import { HELP } from "./store-help.ts";
import { here } from "./store-here.ts";
import { aside } from "./store-aside.ts";
import { end, restore, tend, up } from "./store-copy.ts";
import { leave, releaseIdle } from "./store-leases.ts";
import { bytes, ciMade, dirty, due, gf, glock, groupsHere, localStamp, marks, safe, unchanged, workedOn } from "./store-local.ts";
import { code, remoteStamp, rsync, run } from "./store-remote.ts";
import { adopt, seed } from "./store-seed.ts";
import { take } from "./store-take.ts";
import { alt, cat, fields, isFile, json, L, log, MB, mkdirp, rm, tmpdir, type Json } from "./store-util.ts";
import { data, heldHere } from "./store-tracker.ts";

export { HELP };

// Groups here: size, current, worked on, leased.
function status(): number {
  for (const g of groupsHere()) {
    const d = data([g]);
    if (!d) return 2;
    const rs = remoteStamp(d.remote, g) ?? "(store unreachable)";
    const um = marks(g, "unmerged");
    console.log(`${g}\t${MB(bytes(d))} MB\t${localStamp(g) === rs ? "current" : "not current"}`
      + `${workedOn(g) ? ", worked on since its last copy back" : ""}${um.length ? ` (unmerged: ${um.map((f) => fields(f)?.[0] ?? "").join(" ")})` : ""}`
      + `${heldHere(g) ? ", leased here" : ""}`);
  }
  return 0;
}

// Once, for a new store: its stamps/ folder.
function init(): number {
  const r = process.env.FACTORY_STORE || String(alt((json(cat("tracker/project.json"))?.store as Json | undefined)?.remote, ""));
  if (!r) { console.error("store: no store.remote in tracker/project.json"); return 2; }
  const e = tmpdir();
  fs.chmodSync(e, 0o755);
  const rc = code(rsync(["-r", "--mkpath", "--protect-args", `${e}/`, `${r}/stamps/`], { show: true }));
  fs.rmdirSync(e);
  if (rc !== 0) return rc;
  log(`${r}/stamps/ is there`);
  return 0;
}

export function storeCli(args: string[]): number {
  const [cmd = "", ...a] = args;
  if (cmd === "" || asksHelp(args)) { console.log(HELP); return 0; }
  if (!enterRoot("store.sh")) return 2;
  const env = process.env;
  env.FACTORY_ACTOR ||= "loop";
  env.RSYNC_RSH ||= "ssh -o BatchMode=yes -o ConnectTimeout=20 -o ServerAliveInterval=15 -o ServerAliveCountMax=4";
  here.host = hostName();
  here.lid = path.basename(pwd());   // this lane's checkout: one "worked on" mark per lane
  // Branches, as the loop has them: with an origin, a unit's work reaches main only when its branch lands.
  here.branches = code(run("git", ["remote", "get-url", "origin"], { err: "ignore" })) === 0 && env.FACTORY_STATE !== "local";
  const project = String(alt(json(cat("tracker/project.json"))?.name, ""));
  here.locks = env.FACTORY_LOCKS || `${env.XDG_RUNTIME_DIR || "/tmp"}/factory-${project || here.lid}`;   // the loop's lane locks
  mkdirp(`${L}/groups`); mkdirp(`${L}/inputs`);
  try {
    switch (cmd) {
      case "take": return take(a);
      case "seed": return seed(a);
      case "adopt": return adopt(a[0] ?? "");
      case "up": return up(a[0] ?? "", a[1] ?? "", a[2] ?? "", a[3] === "--all");
      case "end": return end(a[0] ?? "", a[1] ?? "", a[2] ?? "");
      case "restore": return restore(a[0] ?? "", a[1] ?? "");
      case "dirty": dirty(a[0] ?? "", a[1], a[2]); return 0;
      case "clean": {
        // With --since <epoch>: what the run wrote is main's, rebuilt from git (ciMade). With --up
        // <commit> too: copied back as the group's CI run, once the copy is the store's and the
        // run's alone, owed before the run's mark goes (so no lease is released in between), and
        // sent as any copy back owed is (tend: by the lease holder, only over the copy it came from,
        // tried again at each look if it fails).
        const g = a[0] ?? "", i = a.indexOf("--since"), j = a.indexOf("--up");
        let owed = false;
        if (i >= 0) {
          glock(g);
          const t = Number(a[i + 1] ?? ""), d = t > 0 ? data([g], true) : null, n = d ? ciMade(g, d, t) : null;
          if (n) log(`${g}: ${n} files the CI run wrote are main's (rebuilt from git); a copy down replaces them without keeping them`);
          if (j >= 0 && d && n !== null && (n > 0 || !unchanged(g, d))) { due(g, "ci", a[j + 1] ?? ""); owed = true; }
          else if (j >= 0 && d && n === null) log(isFile(gf(g, "unsent")) ? `${g}: the CI run's outputs go back with the copy back already owed`
            : `${g}: the CI run's outputs aren't copied back: the copy here wasn't the store's alone (other work in it, or changed since its stamp)`);
        }
        rm(gf(g, `dirty.${here.lid}`), gf(g, `cistart.${here.lid}`));
        return owed && tend(g, true) ? 2 : 0;
      }
      case "init": return init();
      case "safe": return safe(a[0] ?? "") ? 0 : 1;
      case "release-idle": return releaseIdle();
      case "leave": return leave(a[0] === "--now");
      case "aside": return aside(a);
      case "status": return status();
    }
  } catch (e) {
    log(`${cmd} failed: ${(e as Error).message}`);
    return 2;
  }
  console.error(`store: unknown command ${cmd} (take | end | restore | up | dirty | release-idle | leave | safe | adopt | seed | status | aside | init)`);
  return 2;
}
