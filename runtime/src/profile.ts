// The user's profile: one per user, shared by every factory.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cell } from "./machines.ts";
import { host, asksHelp } from "./sys.ts";

const SKILL = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const HELP = `profile.sh — the user's wfactory profile: who the owner is, where they
read reports, the agent CLI and its usage limits, the machines, and an
optional store. One per user; every factory on the machine reads it.

It lives at ~/.config/wfactory/profile.md, or wherever
WFACTORY_PROFILE points. Prose is for agents; the Settings and
Machines tables are for the scripts.

Usage:
  scripts/profile.sh path      print where the profile is (whether or not it exists)
  scripts/profile.sh new       write a new profile from the template, with this machine's
                               hostname filled in; refuses to overwrite one
  scripts/profile.sh check     exit 0 if the profile exists with no <fill: …> left;
                               else exit 2 and list what's missing. A row still under
                               an old name ("stop below", now "keep back") works, and
                               check says to rename it
  scripts/profile.sh get <setting> [default]   one value from the Settings table
  scripts/profile.sh machines  the Machines table, tab-separated

The runtime's own commands (main.mjs profile …) are the same, plus:
  profile file                the profile's path: $WFACTORY_PROFILE, else
                              \${XDG_CONFIG_HOME:-~/.config}/wfactory/profile.md
  profile get <setting> [default]   a value from its Settings table ("agent", "pause below",
                              "keep back", "store"), else the default
  profile machines            its Machines table, one line per machine: name, ssh, lanes, heavy,
                              can, cache (tab-separated)
  profile unfilled            the \`<fill: …>\` placeholders left in it, one per line, as
                              <line>:<placeholder> (none: no output)

No profile means every setting takes its default. Only the scripts that need the owner's
answers (init.sh, the loop) refuse to run without one, or with placeholders left.`;

export function profileFile(env: NodeJS.ProcessEnv = process.env) {
  if (env.WFACTORY_PROFILE) return env.WFACTORY_PROFILE;
  const config = env.XDG_CONFIG_HOME || `${env.HOME ?? os.homedir()}/.config`;
  return `${config}/wfactory/profile.md`;
}

const read = (env: NodeJS.ProcessEnv) => { try { return fs.readFileSync(profileFile(env), "utf8"); } catch { return null; } };

// The rows of the first table whose first column is headed so (any case): every cell but the
// one after the row's last "|".
export function profileTable(first: string, env: NodeJS.ProcessEnv = process.env): string[][] {
  const text = read(env);
  if (text === null) return [];
  const rows: string[][] = [];
  let head = false;
  for (const line of text.split("\n")) {
    if (!/^[ \t]*\|/.test(line)) { if (rows.length) break; head = false; continue; }
    const f = line.split("|");
    if (!head) { if (cell(f[1]).toLowerCase() === first.toLowerCase()) head = true; continue; }
    if (/^-+$/.test(cell(f[1]))) continue;
    rows.push([cell(f[1]), ...f.slice(2, -1).map(cell)]);
  }
  return rows;
}

// A setting's value; "", "-" and "—" mean unset, and give the default.
export function profileGet(setting: string, dflt = "", env: NodeJS.ProcessEnv = process.env) {
  const v = profileTable("Setting", env).find((r) => r[0].toLowerCase() === setting.toLowerCase())?.[1] ?? "";
  return ["", "-", "—"].includes(v) ? dflt : v;
}

export const profileMachines = (env: NodeJS.ProcessEnv = process.env) => profileTable("Machine", env);

// The `<fill: …>` placeholders left, as "<line>:<placeholder>".
export function profileUnfilled(env: NodeJS.ProcessEnv = process.env): string[] {
  const text = read(env);
  if (text === null) return [];
  const out: string[] = [];
  text.split("\n").forEach((line, i) => { for (const m of line.matchAll(/<fill[:>][^>]*>?/g)) out.push(`${i + 1}:${m[0]}`); });
  return out;
}

// What \`profile.sh check\` says is missing, as its error lines; [] when the profile is complete.
// init.sh and the smoke test refuse to run until it is.
export function profileProblems(env: NodeJS.ProcessEnv = process.env): string[] {
  const f = profileFile(env);
  if (!fs.existsSync(f) || !fs.statSync(f).isFile()) return [`profile: no profile at ${f} (make one: scripts/profile.sh new)`];
  const left = profileUnfilled(env);
  if (left.length) return [`profile: ${f} still has placeholders:`, ...left.map((l) => `  line ${l}`)];
  if (!profileMachines(env).length) return [`profile: ${f} has no Machines table rows`];
  return [];
}

// Rows still under an old name, which the scripts read all the same: what \`profile.sh check\`
// says of each, with the profile complete. ("stop below" was the fixed floor under the week's
// usage; its value is read as the share of the week kept back.)
export function profileRenames(env: NodeJS.ProcessEnv = process.env): string[] {
  const has = (setting: string) => profileTable("Setting", env).some((r) => r[0].toLowerCase() === setting);
  if (!has("stop below")) return [];
  return [has("keep back")
    ? `profile: ${profileFile(env)} has a "stop below" row beside its "keep back" row: remove it ("keep back" is the one read)`
    : `profile: ${profileFile(env)} has a "stop below" row: rename it to "keep back" (its value is read as the share of the week kept back for your own use)`];
}

// A new profile from the template, with this machine as its one machine.
function profileNew(env: NodeJS.ProcessEnv): number {
  const f = profileFile(env);
  if (fs.existsSync(f)) { console.error(`profile: ${f} already exists; edit it instead`); return 2; }
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const h = host(env);
  const t = fs.readFileSync(path.join(SKILL, "scripts", "profile.template.md"), "utf8");
  fs.writeFileSync(f, t.split("\n").map((l) => l.replace("<fill: hostname> | <fill: ssh address>", `${h} | ${h}`)).join("\n"));
  console.log(`wrote ${f}; fill in every <fill: …>`);
  return 0;
}

export function profileCli(args: string[]): number {
  const [cmd, ...a] = args;
  const lines = (xs: string[]) => { for (const x of xs) console.log(x); return 0; };
  if (cmd === undefined || asksHelp(args)) return lines([HELP]);
  if (cmd === "file" || cmd === "path") return lines([profileFile()]);
  if (cmd === "new") return profileNew(process.env);
  if (cmd === "check") {
    const p = profileProblems();
    if (p.length) { for (const l of p) console.error(l); return 2; }
    for (const l of profileRenames()) console.error(l);
    return lines([`profile: ${profileFile()} is complete`]);
  }
  if (cmd === "get") {
    if (!a.length) { console.error("profile.sh: get: which setting?"); return 1; }
    return lines([profileGet(a[0], a[1] ?? "")]);
  }
  if (cmd === "machines") return lines(profileMachines().map((r) => r.join("\t")));
  if (cmd === "unfilled") return lines(profileUnfilled());
  console.error(`profile.sh: unknown command ${cmd} (path | new | check | get | machines)`);
  return 2;
}
