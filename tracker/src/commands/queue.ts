// What each machine's lanes take next, and why: the order `next` follows, shown before the night.
import { ctx, setContext } from "../ctx.ts";
import { load } from "../store.ts";
import { parseArgs } from "../text.ts";
import { name } from "../names.ts";
import { idleWhy, pick, rankWhy, ranked } from "../status.ts";
import { ciPick, ciState } from "../ci.ts";
import { C } from "./registry.ts";
import type { State } from "../types.ts";

// The tracker as the loop sees it on machine m: its capabilities, and new leases allowed. Another
// machine's lane locks and resources can't be seen from here, so they're taken as free.
function onMachine<R>(T: State, m: string, fn: () => R): R {
  const c = ctx, here = m === c.HOST;
  const env: NodeJS.ProcessEnv = { ...c.env, FACTORY_LEASES: "1" };
  if (!here) { delete env.FACTORY_LOCKS; delete env.FACTORY_NO_NEW_LEASE; delete env.FACTORY_HOST_ONLY; delete env.FACTORY_CAPS; }
  const resCache = new Map<string, boolean>(here ? [] : Object.keys(T.project.resources || {}).map((r) => [r, false]));
  // Another machine's lanes have tags of their own: none of this session's claims or reviews are theirs.
  setContext({ ...c, env, HOST: m, TAG: here ? c.TAG : `queue-${m}`, CAPS: here ? c.CAPS : c.MCAPS.get(m) || new Set(), heldCache: new Map(), resCache });
  T._memo = null;
  try { return fn(); } finally { setContext(c); T._memo = null; }
}

C.queue = (a) => {
  const o = parseArgs(a);
  const n = Number(o.n ?? 3) || 3;
  const T = load();
  const hosts = [...new Set([ctx.HOST, ...ctx.MCAPS.keys()])];
  const out = hosts.map((m) => onMachine(T, m, () => {
    // Due CI a lane there can run comes before any unit.
    const cp = ciPick(T), c = cp.code === 0 ? ciState(T, cp.group) : null;
    const ci = cp.code === 0 ? { group: cp.group.id, title: cp.group.title, why: c && "why" in c ? c.why : "" } : null;
    const us = ranked(T).slice(0, n);
    if (us.length) return { host: m, ci, next: us.map((u) => ({ id: u.id, title: u.title, why: rankWhy(T, u) })) };
    const p = pick(T);
    return { host: m, ci, next: [], idle: p.code === 0 ? "" : idleWhy(T, p) };
  }));
  if (o.json) { console.log(JSON.stringify({ machines: out })); return 0; }
  for (const m of out) {
    console.log(`${m.host}${m.host === ctx.HOST ? " (this machine)" : ""}:`);
    if (m.ci) console.log(`  first: ${m.ci.title}'s CI (${m.ci.group}), due: ${m.ci.why}`);
    if (!m.next.length) console.log(`  ${m.idle}`);
    m.next.forEach((u, i) => console.log(`  ${i + 1}. ${name(u)}: ${u.why}`));
  }
  console.log(`\nEach list is what \`next\` offers there now, best first; a unit two machines list goes to the first lane to ask.${hosts.length > 1 ? " Other machines' lanes and resources can't be seen from here, so they're taken as free." : ""}`);
  return 0;
};
