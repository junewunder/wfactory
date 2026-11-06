// A session killed over its memory cap: telling it from a failure, and what the unit's notes say.
import fs from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { log } from "./session.ts";
import { platform } from "./os.ts";
import { trWait } from "./tr.ts";
import { exists, json, read, type Json } from "./loop-util.ts";
import type { Loop } from "./loop.ts";

// Did the session's scope run out of memory? systemd says so (it may take a moment to settle),
// or the session's poll saw the kernel count a kill in it (<out>.mem.oom). Without a scope
// there's no cap, and a failed session is just that.
export async function sessionOom(l: Loop, scope: string, err: string) {
  if (!scope) return false;
  for (let k = 0; k < 20; k++) {
    if (!platform.cappedRunning(scope)) break;
    await sleep(100); await l.halt();
  }
  const r = platform.cappedOverCap(scope);
  platform.forgetCapped(scope);   // a failed run stays known until then
  return r || exists(`${err.replace(/\.err$/, "")}.mem.oom`);
}

// The kind of process a command line is, to tell a repeat kill from a new one: the program and
// its first argument that isn't an option, without their folders ("python3 expand.py").
export function oomKind(cmd: string) {
  const f = cmd.trim().split(/\s+/).filter(Boolean);
  if (!f.length) return "";
  let k = f[0].replace(/.*\//, "");
  const a = f.slice(1).find((x) => !x.startsWith("-"));
  if (a !== undefined) k += ` ${a.replace(/.*\//, "")}`;
  return k.slice(0, 40).replace(/[[\]`]/g, "");
}

// The unit's out-of-memory kills since it was last reopened, one kind each ("unknown" without a
// snapshot), from the tracker's log: notes rotate (three are kept), the log doesn't.
function oomHistory(tdir: string, u: string): string[] {
  const es = (read(`${tdir}/log.jsonl`) ?? "").split("\n").filter((x) => x.includes(`"id":"${u}"`)).map(json)
    .filter((e): e is Json => !!e && (e.cmd === "note" || e.cmd === "reopen"))
    .sort((a, b) => String(a.at ?? "") < String(b.at ?? "") ? -1 : String(a.at ?? "") > String(b.at ?? "") ? 1 : 0);
  let r = -1; es.forEach((e, k) => { if (e.cmd === "reopen") r = k; });
  return es.slice(r + 1).filter((e) => e.cmd === "note").flatMap((e) => { const m = /\[oom: `?([^\]`]*)`?\]/.exec(String(e.text ?? "")); return m ? [m[1]] : []; });
}

// What the snapshot says used the memory, with the snapshot added to the session's .err.
//   kind: the biggest process's kind ("" without one); cmd1, size1: its command and size;
//   big: the three biggest, or why there's no say, for the events log.
function whatUsedIt(mem: string, out: string, end: number) {
  const base = out.replace(/\.jsonl$/, ""), snap = `${base}.mem`, err = `${base}.err`;
  const poll = Number(process.env.FACTORY_POLL || 5);
  let kind = "", big = "", cmd1 = "", size1 = "";
  const s = read(snap) ?? "";
  // A snapshot from well before the end is an earlier peak's, not the kill's.
  let age = 0; if (s) { try { age = end - Math.floor(fs.statSync(snap).mtimeMs / 1000); } catch {} }
  if (s && age > Math.trunc(3 * poll) + 10) {
    fs.appendFileSync(err, `\nloop: the session was killed: out of memory at ${mem}. The last snapshot is ${age}s older than the kill, from an earlier peak, so it doesn't say what used the memory then:\n${s}`);
    big = "not caught: it went from under a quarter of the cap to over it between two looks (an earlier peak's snapshot is in the .err)";
  } else if (s) {
    fs.appendFileSync(err, `\nloop: the session was killed: out of memory at ${mem}. What used the memory at the last look before the kill:\n${s}`);
    // Commands go in backticks (the tracker reads a path like shaders/water as a unit's bare ID
    // otherwise), so none may hold one; nor a tab or newline, which separate them here.
    const lines = s.replace(/\n$/, "").split("\n");
    const second = (lines[1] ?? "").split("\t");
    cmd1 = second.slice(2).join("\t").replace(/`/g, "").replace(/ *$/, ""); size1 = second[1] ?? "";
    kind = oomKind(cmd1);
    big = lines.slice(1, 4).map((x) => {
      const f = x.replace(/`/g, "").split("\t");
      let c = (f[2] ?? "").replace(/ +$/, "");
      if (c.length > 100) c = `${c.slice(0, 97)}...`;
      return `\`${c}\` (${f[1] ?? ""})`;
    }).join("; ");
  } else {
    fs.appendFileSync(err, `loop: the session was killed: out of memory at ${mem}, with no snapshot: it never used a quarter of its cap at a look (every ${process.env.FACTORY_POLL || 5}s)\n`);
    big = "not caught: it went from under a quarter of the cap to over it between two looks";
  }
  return { err, kind, big, cmd1, size1 };
}

// The session was killed over its memory cap. The snapshot goes to its .err; the unit gets a note
// saying what used the memory and stays interrupted, unless the same kind of process was killed
// on it before (or it's the third kill) since it was last reopened, when it's blocked. Either
// way an oom-kill event tells the overseer.
export async function oomSession(l: Loop, u: string, t: string, tg: string, out: string, end: number) {
  const MEM = l.o.mem;
  const { err, kind, big, size1, cmd1: c1 } = whatUsedIt(MEM, out, end);
  let cmd1 = c1;
  const hist = oomHistory(l.cfg.tdir, u);
  const n = hist.length;
  const same = !!kind && hist.includes(kind);
  // A note is at most 280 characters: the biggest process's command gives way first. The kind is
  // in backticks too, for the same reason as the commands.
  const otag = `[oom: \`${kind || "unknown"}\`]`, where = `${err} on ${l.host} lane ${l.lane}`;
  const head = `Session ${tg} was killed: out of memory at ${MEM}. Biggest then: `, tail = `. All of it: ${where}. ${otag}`;
  let what: string;
  if (cmd1) {
    const room = 280 - head.length - tail.length - size1.length - 5;   // the backticks, " (" and ")"
    if (cmd1.length > room) cmd1 = `${cmd1.slice(0, room - 3)}...`;
    what = `\`${cmd1}\` (${size1})`;
  } else what = big.slice(0, Math.max(0, 280 - head.length - tail.length));
  // Each kill must reach the log, or the next one isn't counted: shorter notes if one is refused
  // (a busy lock is waited out: it isn't a refusal).
  let noted = false;
  for (const note of [`${head}${what}${tail}`, `Session ${tg} was killed: out of memory at ${MEM}; what used it is in ${where}. ${otag}`, `Session ${tg} was killed: out of memory. ${otag}`]) {
    if (trWait(["note", u, note], log, { FACTORY_TAG: tg, FACTORY_ACTOR: "loop" }).code === 0) { noted = true; break; }
  }
  if (!noted) log(`tracker: couldn't note the out-of-memory kill on ${t} (${u}); blocking it, since the next kill couldn't be counted`);
  if (same || n >= 2 || !noted) {
    const why = same ? `out of memory at ${MEM} twice in the same kind of process (\`${kind}\`); its notes say what used the memory`
      : noted ? `out of memory at ${MEM} ${n + 1} times; its notes say what used the memory`
      : `out of memory at ${MEM}, and the loop couldn't note it; what used the memory is in ${where}`;
    if (trWait(["block", u, "--why", why], log, { FACTORY_TAG: tg, FACTORY_ACTOR: "loop" }).code !== 0) log(`tracker: couldn't block ${t} (${u})`);
    log(`session ${tg} was OOM-killed inside its ${MEM} scope (${kind || "unknown"}); ${why}, so ${t} (${u}) is blocked; the lane goes on`);
    l.event("oom-kill", `session ${tg} on ${t} (${u}) was killed: out of memory at ${MEM}; biggest: ${big}. It's blocked: ${why}`, u);
    l.stuckEvent(u, t);
  } else {
    log(`session ${tg} was OOM-killed inside its ${MEM} scope; ${t} (${u}) shows as interrupted, with a note on what used the memory; the lane goes on`);
    l.event("oom-kill", `session ${tg} on ${t} (${u}) was killed: out of memory at ${MEM}; biggest: ${big}. It shows as interrupted and the lane goes on; a second kill by the same kind of process blocks it`, u);
  }
  await l.commitTracker(`tracker: ${t} (${u}), out of memory in session ${tg}`);
}
