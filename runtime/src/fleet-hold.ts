// fleet off and fleet on: the lanes held off while work is done by hand beside the factory (a
// sweep, a sprint: the skill's docs/sweep.md and docs/sprint.md), and let go again. The hold is
// the tracker's (`lanes off`), on main, so every machine's lanes see it: `fleet start` and the
// loop refuse to start a lane while it holds, and a running loop stops after its unit. It keeps
// which lanes were running and until when, for whoever starts them again.
import { epoch, expandHome, hm, ymdHm } from "./sys.ts";
import { trWait } from "./tr.ts";
import { say } from "./fleet-util.ts";
import type { Fleet, Lane } from "./fleet-ctx.ts";

interface Hold { at: string; by: string; for: string; were: { machine: string; lanes: number; until?: number }[] }
const wait = (a: string[]) => trWait(a, (m) => console.error(`fleet: ${m}`), { FACTORY_ACTOR: process.env.FACTORY_ACTOR || "oversee" });
const hold = (): Hold | null => { try { return JSON.parse(wait(["lanes", "--json"]).out) as Hold | null; } catch { return null; } };
// A stop time as `fleet start --until` takes it back: the time of day when that's within the day.
const untilArg = (t: number, now: number) => t - now < 86400 ? hm(new Date(t * 1000)) : `'${ymdHm(new Date(t * 1000))}'`;

// fleet off [--now] --for "<what>": hold the lanes off, and ask each running one to stop after
// its unit (--now: end its session too). Run again, it says how far they've got. Exit 0 once
// every lane has stopped; 3 while one still runs or a machine can't be reached.
export async function off(f: Fleet, args: string[]): Promise<number> {
  const { ME, env, loopArg, on, laneState, watchOn, service, allLanes } = f;
  const usage = 'usage: fleet off --for "<what runs in the lanes\' place>" [--now]';
  let what = "", now = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--now") now = true;
    else if (args[i] === "--for" && args[i + 1] !== undefined) what = args[++i];
    else { console.error(usage); return 2; }
  }
  const L = allLanes();
  const st = new Map<Lane, string>(L.map((l) => [l, laneState(l.m, l.d)]));
  const running = L.filter((l) => st.get(l) === "running");
  let h = hold();
  if (!h) {
    if (!what) { console.error(`fleet: the lanes aren't held off. ${usage}`); return 2; }
    // Which lanes run, and until when: what `fleet on` gives back.
    const were: string[] = [];
    for (const m of [...new Set(running.map((l) => l.m))]) {
      const ls = running.filter((l) => l.m === m);
      const r = await watchOn(m, { op: "look", lanes: ls.map((l) => ({ unit: service(l.d), dir: m === ME ? expandHome(l.d, env) : l.d })) }, new AbortController().signal);
      const until = Math.max(0, ...(r?.lanes ?? []).map((x) => x.deadline ?? 0));
      were.push(`${m} ${ls.length}${until > 0 ? ` ${until}` : ""}`);
    }
    const r = wait(["lanes", "off", "--for", what, ...were.flatMap((w) => ["--were", w])]);
    if (r.code !== 0) { process.stderr.write(r.out + r.err); return r.code; }
    h = hold();
  } else if (what && what !== h.for) say(`(already held off for ${h.for}; that stands)`);
  for (const l of running) {
    const r = on(l.m, l.d, ["factory/oversee.sh", "pause", ...loopArg, ...(now ? ["--now"] : [])], { out: "ignore" });
    say(`=== ${l.m} lane ${l.n}: ${r.status === 255 ? "unreachable over ssh; it stops after its unit by itself, once it reads the hold" : now ? "its session is ended; it settles its unit and stops (a minute or two)" : "asked to stop after the unit it's on"}`);
  }
  const away = [...new Set(L.filter((l) => st.get(l) === "unreachable").map((l) => l.m))];
  for (const m of away) say(`=== ${m}: unreachable over ssh; lanes running there stop after their unit by themselves, once they read the hold`);
  say(wait(["lanes", "--why"]).out.trim());
  if (running.length || away.length) {
    say(`${running.length ? `${running.length} lane${running.length > 1 ? "s" : ""} still running` : "no lane seen running"}${away.length ? `, ${away.join(" ")} unreachable` : ""}: \`just fleet off\` again says when every lane has stopped (\`just fleet beat\` shows what each works on)`);
    return 3;
  }
  say("every lane has stopped");
  return 0;
}

// fleet on: let go of the hold, and say which lanes ran before it and how to start them again.
// It starts nothing: that's the owner's call.
export function onAgain(f: Fleet): number {
  const { lanes, known } = f;
  const h = hold();
  const r = wait(["lanes", "on"]);
  process.stdout.write(r.out); process.stderr.write(r.err);
  if (r.code !== 0 || !h) return r.code;
  const now = epoch();
  for (const w of h.were) {
    const n = `${w.lanes} lane${w.lanes > 1 ? "s" : ""}`, count = known(w.machine) && lanes(w.machine) === w.lanes ? "" : ` --lanes ${w.lanes}`;
    if (w.until && w.until > now) say(`  ${w.machine}: ${n} ran, until ${hm(new Date(w.until * 1000))}: \`just fleet start ${w.machine}${count} --until ${untilArg(w.until, now)}\``);
    else say(`  ${w.machine}: ${n} ran${w.until ? `, until ${ymdHm(new Date(w.until * 1000))}, which has passed` : ""}: \`just fleet start ${w.machine}${count} --until <a new stop time>\``);
  }
  if (!h.were.length) say("  no lane was running when they were held off: `just fleet start --until <a stop time>` starts this machine's");
  say("nothing was started: starting the lanes is the owner's call");
  return 0;
}
