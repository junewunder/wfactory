// The factory every file in test/store/ moves group data on: init.sh's, on a local bare origin
// (test/lib's originFactory), with a store (a local folder standing in for a NAS) at <top>/store.
// Laptops are lane clones, each with its own work/, locks and host. The machines file has two:
// a can do "steam", b can't. Groups f1 to f5 keep their data on the store (out: work/out/<group>,
// mod: mods/m-<group>), and read the store's inputs (rip: common, and the group's fighter part);
// group code is code only. Sessions are a fake claude that appends to its group's data.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { test, after } from "node:test";
import { originFactory, cmd, chomp, has, readOr } from "../lib/index.ts";

// The store needs rsync 3 or later first on PATH (runtime/src/store-remote.ts). macOS's own is
// openrsync, which it can't copy with: there, without Homebrew's rsync, each file here is one
// skipped test saying why, and stops before its own setup (which needs the store) runs.
if (!/^rsync\s+version\s+([3-9]|\d{2,})\./m.test(spawnSync("rsync", ["--version"], { encoding: "utf8" }).stdout ?? "")) {
  test("the store's tests", { skip: "the store needs rsync 3 or later first on PATH, and this one isn't (macOS's own is openrsync): brew install rsync" }, () => {});
  await new Promise(() => { after(() => setImmediate(() => process.exit(0))); });
}

// The fake claude: appends a line to its group's data (work/out/<group>/log.txt and the mod
// folder), notes whether the input it reads is here, commits a code file, records done. A unit
// held ($FACTORY_LOCKS/hold.<group>-<slug>) waits, its data written and its code file not yet
// committed, until the test lets it go (go.<group>-<slug>), at most 5 minutes; held.<…> has its pid.
// FACTORY_FAKE_UNDONE: the session ends with its unit unfinished (handed back), its claim left open.
const CLAUDE = `#!/usr/bin/env bash
card=""; while [ $# -gt 0 ]; do [ "$1" = --append-system-prompt-file ] && card=$(cat "$2"); shift; done
id=$(grep -oE '^Next: .*\\(([a-z0-9-]+/[a-z0-9.-]+)\\)' <<<"$card" | head -1 | sed -E 's/.*\\(([^)]*)\\)$/\\1/')
u=\${id//\\//-}
echo '{"type":"system","subtype":"init"}'
g=\${id%%/*}
if [ -d "work/out/$g" ] || grep -q '^  Data: ' <<<"$card"; then
  mkdir -p "work/out/$g"; echo "$id on $FACTORY_HOST" >> "work/out/$g/log.txt"
  [ -f "work/out/$g/pad.bin" ] || head -c 100000 /dev/zero > "work/out/$g/pad.bin"
  [ -f "work/rip/common/c.txt" ] && echo "$id saw the input" >> "work/out/$g/log.txt"
  m=$(factory/tracker data --unit "$id" | jq -r '.paths[] | select(.name == "mod") | .local')
  mkdir -p "$m"; echo "$id" >> "$m/mod.txt"
fi
mkdir -p out; f="out/$u.txt"; echo "work on $id from $FACTORY_HOST" >> "$f"
if [ -e "$FACTORY_LOCKS/hold.$u" ]; then
  echo $$ > "$FACTORY_LOCKS/held.$u.new" && mv "$FACTORY_LOCKS/held.$u.new" "$FACTORY_LOCKS/held.$u"
  for _ in $(seq 1500); do [ ! -e "$FACTORY_LOCKS/go.$u" ] || break; sleep 0.2; done
fi
git add "$f"
git commit -qm "$id: fake work" >/dev/null 2>&1
[ -n "\${FACTORY_FAKE_UNDONE:-}" ] || just done "$id" --evidence "fake session" >/dev/null 2>&1
echo '{"type":"result","is_error":false,"result":"did '"$id"'","num_turns":1,"total_cost_usd":0.01}'
`;

// A store folder that can't be reached (no such host), for FACTORY_STORE.
export const NOPE = "nohost.invalid:/x";
// A loop's usual window here: one unit, three minutes at most.
export const ONE = ["--max", "1", "--hours", "0.05"];

// lanes: the laptops to make (clones of origin, each its own host). The first is the one whose
// tracker the helpers below read the shared state through.
export function storeFactory(lanes: string[]) {
  let S = "";
  const f = originFactory("st", {
    claude: CLAUDE,
    prepare: (F) => {
      const mf = path.join(F, "docs/machines.md"), m = fs.readFileSync(mf, "utf8");
      const two = m.replace(/\| \S+ \| \S+ \| 1 \| any \| [^|\n]* \| \S+ \| \S+ \|/, "| a | a | 1 | any | ~/x | steam | — |\n| b | b | 1 | any | ~/x | — | — |");
      assert.ok(two.includes("| a | a |"), "test setup: couldn't write the machines table");
      fs.writeFileSync(mf, two);
      const gi = path.join(F, ".gitignore");
      if (!/^work\//m.test(readOr(gi))) fs.appendFileSync(gi, "work/\n");
      fs.appendFileSync(gi, "mods/\n");
      S = path.join(path.dirname(F), "store");
      for (const [p, text] of [["common/c.txt", "common"], ["fighters/f1/f.txt", "f1"], ["fighters/f2/f.txt", "f2"]]) {
        fs.mkdirSync(path.dirname(path.join(S, "inputs/rip", p)), { recursive: true });
        fs.writeFileSync(path.join(S, "inputs/rip", p), `${text}\n`);
      }
      const pf = path.join(F, "tracker/project.json"), pj = JSON.parse(fs.readFileSync(pf, "utf8"));
      pj.store = { remote: S, paths: { out: "work/out/{group}", mod: "mods/{mod}" }, inputs: { rip: { local: "work/rip", parts: { common: "common", fighter: "fighters/{group}" } } }, reads: ["rip:common", "rip:fighter"] };
      fs.writeFileSync(pf, JSON.stringify(pj, null, 2) + "\n");
    },
  });
  const ls = lanes.map((n) => f.lane(n));
  const [a] = ls;
  type Lane = typeof a;
  const group = (g: string) => a.setup(["add-group", g, "--title", `Fighter ${g}`, "--data", `mod=m-${g}`]);
  for (const g of ["f1", "f2", "f3", "f4", "f5"]) group(g);
  a.setup(["add-group", "code", "--title", "Code only"]);
  // The store's folders, as the owner makes them once (stamps/ wasn't there before).
  const hadStamps = fs.existsSync(path.join(S, "stamps"));
  const init = a.run("factory/store.sh", ["init"]);
  assert.equal(init.code, 0, `store.sh init: ${init.stdout}`);
  const initMadeStamps = !hadStamps && fs.existsSync(path.join(S, "stamps"));
  // A unit, titled "Unit <slug> of <group>", added through the tracker in this process.
  const add = (id: string, ...more: string[]) => a.setup(["add-unit", id, "--title", `Unit ${id.split("/")[1]} of ${id.split("/")[0]}`, ...more]);
  const drop = (id: string) => a.setup(["drop", id, "--why", "test"]);
  // The real commands in a lane, stdout and stderr apart (as `$(…)` and `2>` give them):
  // factory/tracker, factory/store.sh.
  const tr = (l: Lane, args: string[], add: NodeJS.ProcessEnv = {}) => cmd("factory/tracker", args, { cwd: l.dir, env: l.envWith(add) });
  const store = (l: Lane, args: string[], add: NodeJS.ProcessEnv = {}) => cmd("factory/store.sh", args, { cwd: l.dir, env: l.envWith(add) });
  // A unit's state, as factory/tracker state says it in that lane (a by default).
  const state = (id: string, l: Lane = a, add: NodeJS.ProcessEnv = {}) => chomp(tr(l, ["state", id], add).stdout);
  // Who leases what: "<group>=<host> …", sorted.
  const leases = () => {
    const r = tr(a, ["leases", "--json"]);
    assert.equal(r.code, 0, `tracker leases: ${r.stderr}`);
    return (JSON.parse(r.stdout) as { id: string; host: string }[]).map((l) => `${l.id}=${l.host}`).sort().join(" ");
  };
  const st = (p: string) => path.join(S, p);
  // The unit the store's copy of a group is stamped with ("" if none).
  const stamp = (g: string) => { try { return String(JSON.parse(fs.readFileSync(st(`stamps/${g}.json`), "utf8")).unit); } catch { return ""; } };
  // Data put on the store by hand for a group: out/pad.bin, 100 KB, stamped as a seed from c.
  const onStore = (g: string) => {
    fs.mkdirSync(st(`groups/${g}/out`), { recursive: true });
    fs.writeFileSync(st(`groups/${g}/out/pad.bin`), crypto.randomBytes(100000));
    fs.writeFileSync(st(`stamps/${g}.json`), JSON.stringify({ unit: "seed", commit: "x", host: "c", at: "2026-01-01T00:00:00Z", bytes: 100000 }) + "\n");
  };
  // An hour passing, for the leases' and claims' heartbeats: every moment recorded in the tracker's
  // leases and groups on origin's main is made an hour earlier, as if they had been an hour ago.
  const anHourLater = () => {
    const r = cmd("git", ["--git-dir", f.origin, "ls-tree", "--name-only", "main", "tracker/groups/"], { cwd: f.w.top, env: f.w.env });
    const files = ["tracker/leases.json", ...chomp(r.stdout).split("\n").filter((x) => x.endsWith(".json"))];
    const shift = (v: any): any => {
      if (typeof v === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(v)) return new Date(Date.parse(v) - 3600e3).toISOString().replace(/\.\d+Z$/, "Z");
      if (Array.isArray(v)) return v.map(shift);
      if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shift(x)]));
      return v;
    };
    f.editMain(files, (j) => { const s = shift(j); for (const k of Object.keys(j)) delete j[k]; Object.assign(j, s); });
  };
  // A file's time set, as `touch -d`: t in ms since the epoch.
  // (made empty if it isn't there, as touch does).
  const touch = (file: string, t: number) => { if (!fs.existsSync(file)) fs.writeFileSync(file, ""); fs.utimesSync(file, t / 1000, t / 1000); };
  const write = (file: string, text: string | Buffer) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  // The folders under a lane's work/.store/aside/ for a group (their full paths).
  const asides = (l: Lane, g: string) => { const d = l.at("work/.store/aside"); return fs.existsSync(d) ? fs.readdirSync(d).filter((x) => x.startsWith(`${g}-`)).map((x) => path.join(d, x)) : []; };
  // The same file in each of those (`cat aside/<g>-*/<p>`), joined.
  const asideRead = (l: Lane, g: string, p: string) => asides(l, g).map((x) => readOr(path.join(x, p))).join("");
  // Some files of each of those, as `cat aside/<g>-*/<p1> aside/<g>-*/<p2> | paste -sd' '`: their
  // lines, in that order, joined by spaces.
  const asideLines = (l: Lane, g: string, ...ps: string[]) => ps.flatMap((p) => asides(l, g).map((x) => readOr(path.join(x, p)))).join("").split("\n").filter(Boolean).join(" ");
  // The end of a file's tests: whatever they did, the tracker's data isn't broken.
  const notBroken = () => test("the tracker isn't broken after all that", () => { has(a.tracker(["lint", "--broken"]).stdout, "no broken data"); });
  return { ...f, S, st, initMadeStamps, lanes: ls, group, add, drop, tr, store, state, leases, stamp, onStore, anHourLater, touch, write, asides, asideRead, asideLines, notBroken };
}
