// What every fleet command works from: the machines file's machines and their lanes, this
// machine, the loop, and running a command on a machine (here, or over ssh).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { FIELDS, machineRows, type Field } from "./machines.ts";
import { answer, project, type Answer } from "./oversee.ts";
import { expandHome, pwd, shq, ymdHm } from "./sys.ts";
import { platform, remote } from "./os.ts";
import { brief, reserveOf } from "./heavy.ts";
import { EVENTS_SUMMARY } from "./fleet-help.ts";
import { DEPLOY, JOURNAL, PULL_SKILL } from "./fleet-scripts.ts";
import { cat, chomp, isDir, lines, say } from "./fleet-util.ts";

// What a command run on a machine came to: its exit status (255: ssh couldn't reach it) and,
// when asked for, its output.
export interface Ran { status: number; out: string }
type Out = "inherit" | "capture" | "ignore";
interface On { out?: Out; err?: Out | "merge"; unset?: string[] }
export type State = "running" | "stopped" | "unreachable";
// A machine's memory for the beat (heavy.ts's brief).
export type Brief = { available: number | null; held: { what: string; mem: number }[] };
// A lane: its machine, its number there, and its checkout.
export type Lane = { m: string; n: number; d: string };

export type Fleet = Exclude<ReturnType<typeof openFleet>, number>;

// The fleet for the loop <floop> ("" for the factory's one), or the exit code it refuses with.
export function openFleet(env: NodeJS.ProcessEnv, floop: string) {
  const PWD = pwd(env);
  const ME = os.hostname().split(".")[0];

  let rows = machineRows();
  const hasOrigin = spawnSync("git", ["remote", "get-url", "origin"], { stdio: "ignore" }).status === 0;
  if (rows.length === 0) rows = [[ME, ME, "1", "any", PWD]];   // no machines file: just this one
  let mf = "";
  try { mf = fs.readFileSync("docs/machines.md", "utf8"); } catch {}
  if (/<fill[:>]/.test(mf)) { console.error("fleet: docs/machines.md still has <fill: …> placeholders"); return 2; }
  const NAMES = rows.map((r) => r[0]);
  const known = (m: string) => NAMES.includes(m);
  const field = (m: string, k: Field) => rows.find((r) => r[0] === m)?.[FIELDS.indexOf(k)] ?? "";
  const checkout = (m: string) => field(m, "checkout") || PWD;
  const lanes = (m: string) => Number(field(m, "lanes") || "1");
  const loopArg = floop ? [floop] : [];
  const fromDeploy = env.FACTORY_SKILL_FROM === "deploy";
  // On the copy just deployed, not the one this command started with (unless chosen by hand).
  const deployed = fromDeploy ? ["FACTORY_SKILL", "FACTORY_SKILL_FROM"] : [];

  // Machines named at the front of the arguments, and the rest; with none named, every machine.
  const takeMachines = (a: string[], dflt = NAMES) => {
    let i = 0;
    while (i < a.length && known(a[i])) i++;
    return { ms: i ? a.slice(0, i) : dflt, rest: a.slice(i) };
  };

  // Run a command in <dir> on <machine>: here, or over ssh with the desktop session's variables
  // and the usual tool folders, which a non-login ssh shell lacks.
  const on = (m: string, dir: string, cmd: string[], o: On = {}): Ran => {
    const { out = "inherit", err = "inherit", unset = [] } = o;
    const envCmd = ["env", ...unset.flatMap((v) => ["-u", v]), ...cmd];
    let file: string, a: string[], cwd: string | undefined;
    if (m === ME) {
      cwd = expandHome(dir, env);
      if (!isDir(cwd)) {
        const why = `fleet: cd: ${cwd}: No such file or directory\n`;
        if (err === "merge") return { status: 1, out: why };
        if (err !== "ignore") process.stderr.write(why);
        return { status: 1, out: "" };
      }
      [file, ...a] = envCmd;
    } else {
      const addr = field(m, "ssh") || m;
      file = "ssh";
      a = ["-n", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", addr,
        `cd ${dir} && export PATH="$HOME/.local/bin:/home/linuxbrew/.linuxbrew/bin:/opt/homebrew/bin:$HOME/.cargo/bin:$PATH" && ${remote.sessionEnvScript} && ${envCmd.map(shq).join(" ")} `];
    }
    // Output and errors together, in order (2>&1), go through one file.
    let tmp: string | null = null, fd: number | null = null;
    if (err === "merge") { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-")); fd = fs.openSync(path.join(tmp, "out"), "w+"); }
    const io = (x: Out) => x === "capture" ? "pipe" : x;
    const stdout = fd ?? io(out), stderr = fd ?? io(err as Out);
    const r = spawnSync(file, a, { cwd, env, encoding: "utf8", maxBuffer: 1 << 28, stdio: [m === ME ? "inherit" : "ignore", stdout, stderr] });
    let text = r.stdout ?? "";
    if (fd !== null && tmp !== null) { fs.closeSync(fd); text = fs.readFileSync(path.join(tmp, "out"), "utf8"); fs.rmSync(tmp, { recursive: true, force: true }); }
    const status = r.error ? ((r.error as NodeJS.ErrnoException).code === "ENOENT" ? 127 : 126) : r.signal ? 128 + (os.constants.signals[r.signal] ?? 0) : r.status ?? 1;
    return { status, out: text };
  };
  const sh = (m: string, dir: string, script: string, o: On = {}, ...a: string[]) => on(m, dir, ["sh", "-c", script, ...a], o);

  // A line in this machine's overseer journal.
  const note = (as: string, text: string) => {
    fs.mkdirSync("runs", { recursive: true });
    fs.appendFileSync(JOURNAL, [ymdHm(), ME, as || "-", text.replace(/[\t\n]/g, " ")].join("\t") + "\n");
  };

  // Ask a machine's daemon about its lanes (oversee.sh watch): here directly, elsewhere over ssh,
  // kept alive so a machine that went to sleep fails it instead of hanging it. null if it
  // couldn't be reached or answered nothing it could read.
  const watchOn = async (m: string, req: Parameters<typeof answer>[0], signal: AbortSignal): Promise<Answer | null> => {
    if (m === ME) {
      try { return await answer(req, env, signal); } catch { return null; }
    }
    const addr = field(m, "ssh") || m;
    const cmd = ["factory/oversee.sh", "watch", JSON.stringify(req)];
    return new Promise((resolve) => {
      let out = "";
      const c = spawn("ssh", ["-n", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=4", addr,
        `cd ${checkout(m)} && export PATH="$HOME/.local/bin:/home/linuxbrew/.linuxbrew/bin:/opt/homebrew/bin:$HOME/.cargo/bin:$PATH" && ${remote.sessionEnvScript} && ${cmd.map(shq).join(" ")} `],
      { env, stdio: ["ignore", "pipe", "ignore"], signal });
      c.stdout.on("data", (d) => { out += d; });
      c.on("error", () => resolve(null));
      c.on("close", (code) => { try { const a = code === 0 ? JSON.parse(out) : null; resolve(a?.lanes ? a : null); } catch { resolve(null); } });
    });
  };

  const updateSkill = (m: string): string[] => {
    const said: string[] = [];
    let r = on(m, checkout(m), ["bash", "-c", PULL_SKILL], { out: "capture", err: "merge" });
    said.push(`=== ${m}: the skill's checkout: ${r.status === 0 ? chomp(r.out) : "unreachable over ssh: not updated"}`);
    if (m === ME && env.FACTORY_SKILL && !fromDeploy) {
      said.push(`=== ${m}: lanes run FACTORY_SKILL (${env.FACTORY_SKILL}); nothing deployed`);
      return said;
    }
    r = on(m, checkout(m), ["bash", "-c", DEPLOY], { out: "capture", err: "merge" });
    const out = chomp(r.out);
    said.push(`=== ${m}: the wfactory skill for its lanes: ${r.status === 255 ? "unreachable over ssh" : r.status !== 0 ? `deploy failed: ${out.slice(out.lastIndexOf("\n") + 1)}` : out}`);
    return said;
  };

  // The tiers (Events, above): a project's own lists win over ours, and a kind in neither wakes.
  const ev = (project().events ?? {}) as { wake?: unknown; summary?: unknown };
  const list = (x: unknown) => Array.isArray(x) ? x.map(String) : [];
  const pWake = list(ev.wake), pSummary = list(ev.summary);
  const tier = (kind: string) => pWake.includes(kind) ? "wake" : pSummary.includes(kind) ? "summary" : EVENTS_SUMMARY.includes(kind) ? "summary" : "wake";
  const onlyTier = (t: "wake" | "summary", text: string) => lines(text).filter((l) => tier(l.split("\t")[3] ?? "") === t);

  const service = (d: string) => `factory-${path.basename(d)}${floop ? `-${floop}` : ""}`;
  // Stopped only when the service manager says so: one it couldn't ask (slow, as under memory
  // pressure) counts as running, so a lane is never taken for stopped on a failed look.
  const laneState = (m: string, d: string): State => {
    if (m === ME) return platform.jobState(service(d)) === "stopped" ? "stopped" : "running";
    // Asked from the home folder: a lane folder that isn't there (no clone yet) mustn't read as a
    // failed ask.
    const s = on(m, "~", remote.jobRunningCmd(service(d)), { err: "ignore" }).status;
    return s === 255 ? "unreachable" : remote.jobStoppedStatus.includes(s) ? "stopped" : "running";
  };

  // The lanes this run started on a machine, when a start gave --lanes (runs/.fleet-lanes, per
  // loop; "<machine> <N>" a line): those, not the machines file's count, until the next start there
  // without it, or the next run.
  const LANES_FILE = `runs/.fleet-lanes${floop ? `-${floop}` : ""}`;
  const MEM_FILE = `runs/.fleet-memory${floop ? `-${floop}` : ""}`;
  // The questions this checkout's overseers were told of (fleet-util.ts, firstQuestions), a line
  // each: what fleet wait drops when another lane logs one again. fleet attach adds every one the
  // lanes' logs have, so an overseer that takes over on another machine isn't told them again.
  // One file for every loop, as the questions are the tracker's, which the loops share. Added to,
  // never written over: a replaced overseer's wait ends after the new one's attach.
  const TOLD_FILE = "runs/.fleet-questions";
  const told = () => new Set(lines(cat(TOLD_FILE)));
  const tell = (qs: Set<string>) => {
    fs.mkdirSync("runs", { recursive: true });
    fs.writeFileSync(TOLD_FILE, [...new Set([...told(), ...qs])].slice(-1000).map((q) => q + "\n").join(""));
  };
  const overrides = () => new Map(lines(cat(LANES_FILE)).map((l) => l.split(" ")).filter((f) => known(f[0]) && /^[0-9]+$/.test(f[1] ?? "")).map((f) => [f[0], Number(f[1])]));
  const setOverride = (m: string, n: number | null) => {
    const o = overrides();
    if (n === null) o.delete(m); else o.set(m, n);
    fs.mkdirSync("runs", { recursive: true });
    if (o.size) fs.writeFileSync(LANES_FILE, [...o].map(([k, v]) => `${k} ${v}\n`).join("")); else fs.rmSync(LANES_FILE, { force: true });
  };
  const runLanes = (m: string) => overrides().get(m) ?? lanes(m);

  // Every lane: lanes run in clones beside the checkout; without an origin, lane 1 is the
  // checkout (factory/lane.sh).
  const laneDir = (m: string, i: number) => `${checkout(m)}${i === 0 && !hasOrigin ? "" : `-lane${i + 1}`}`;
  const allLanes = (ms = NAMES): Lane[] => ms.flatMap((m) =>
    Array.from({ length: Math.max(0, runLanes(m)) }, (_, i) => ({ m, n: i + 1, d: laneDir(m, i) })));

  // Run an oversee.sh command in every lane of these machines. It makes no clones (only start
  // does), and says so when a machine can't be reached. With capture, what they say is returned.
  const each = (ms: string[], c: string[], capture = false): string => {
    let said = "";
    const put = (s: string) => { if (capture) said += s + "\n"; else say(s); };
    for (const { m, n, d } of allLanes(ms)) {
      put(`=== ${m} lane ${n}`);
      const r = on(m, d, ["factory/oversee.sh", c[0], ...loopArg, ...c.slice(1)], { out: capture ? "capture" : "inherit" });
      if (capture) said += r.out;
      if (r.status === 255) put(`(${m} is unreachable over ssh: nothing was done there)`);
      else if (r.status !== 0) put(`(${m} lane ${n}: the command failed (exit ${r.status}); has the lane ever started there?)`);
    }
    return said;
  };

  // Each machine's memory, for the beat: available now (bytes; null where it couldn't be read),
  // and what holds its budget of heavy jobs (`just heavy` there), biggest first. A machine whose
  // deployed copy has no `heavy brief` yet, or nothing deployed (factory/skill exits, so in a
  // subshell), tells only what's available.
  const memOf = (m: string): Brief => {
    if (m === ME) { try { return brief(env); } catch { return { available: platform.memory().available, held: [] }; } }
    const r = on(m, checkout(m), ["bash", "-c", `( . factory/skill && "$FACTORY_SKILL/runtime/heavy.sh" brief ) 2>/dev/null || ${remote.memAvailableCmd.map(shq).join(" ")}`], { out: "capture", err: "ignore" });
    const o = chomp(r.out).split("\n").pop() ?? "";
    if (r.status !== 0) return { available: null, held: [] };
    if (/^[0-9]+$/.test(o)) return { available: Number(o), held: [] };
    try { const b = JSON.parse(o) as Brief; return { available: typeof b.available === "number" ? b.available : null, held: Array.isArray(b.held) ? b.held : [] }; } catch { return { available: null, held: [] }; }
  };
  // Under this, a machine is short of memory (memory-low): its reserve in docs/machines.md (Reserve
  // and GPU), as `just heavy` reads it, by the machine's name there.
  const floorOf = (m: string) => reserveOf(m).reserve;

  // The project's loops ("" the factory's own): a clone's lanes run as one unit per loop.
  const loopNames = ["", ...Object.keys((project().loops ?? {}) as object)];

  return { env, floop, PWD, ME, NAMES, hasOrigin, known, field, checkout, lanes, loopArg, fromDeploy, deployed, takeMachines,
    on, sh, note, watchOn, updateSkill, tier, onlyTier, service, laneState, LANES_FILE, MEM_FILE, told, tell, overrides, setOverride,
    runLanes, laneDir, allLanes, each, memOf, floorOf, loopNames };
}
