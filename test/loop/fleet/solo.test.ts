// One machine, nothing else: no origin, no store, no fleet settings, the profile as written. The
// loop works every unit in the checkout itself. Run: node --test test/loop/fleet/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { workspace, cmd, has, readOr } from "../../lib/index.ts";
import { CLAUDE } from "../factory.ts";

const w = workspace();
Object.assign(w.env, { FACTORY_EVIDENCE_MIN: "0", FACTORY_NOCAP: "1", FACTORY_POLL: "0.1", FACTORY_FETCH_EVERY: "0" });
fs.mkdirSync(w.env.FACTORY_LOCKS!, { recursive: true });
fs.writeFileSync(w.at("bin/claude"), CLAUDE, { mode: 0o755 });
w.profile();
const S = w.init(`solo${process.pid}-solo`);
const fill = (p: string, from: RegExp, to: string) => fs.writeFileSync(path.join(S, p), readOr(path.join(S, p)).replace(from, to));
fill("docs/factory.md", /<fill[^>]*>/g, "filled"); fill("justfile", /@echo "TODO.*/g, "@true");
w.setup(["pass", "opening/ready"], S);   // past its opening
w.git(S, "add", "-A"); w.git(S, "commit", "-qm", "init");
// A command in the checkout: its output, stdout and stderr merged.
const run = (file: string, args: string[]) => cmd(file, args, { cwd: S, env: w.env, merged: true }).stdout;

describe("one machine, nothing else: no origin, no store, no fleet settings, the profile as written", () => {
  test("one machine: init writes a machines file with nothing left to fill", () => { assert.ok(!readOr(path.join(S, "docs/machines.md")).includes("<fill")); });
  let out = "";
  test("  the loop works every unit in the checkout itself", () => {
    w.setup(["add-group", "solo", "--title", "Solo"], S);
    w.setup(["add-unit", "solo/one", "--title", "Solo one"], S);
    w.setup(["add-unit", "solo/two", "--title", "Solo two"], S);
    out = run(path.join(S, "factory/loop.sh"), ["--no-awake", "--idle-wait", "0.05", "--last-call", "0", "--hours", "0.05"]);
    has(out, "every unit is done");
  });
  test("  each committed there", () => { has(w.git(S, "log", "--format=%s"), "solo/two: fake work"); });
  test("  with the tracker's state in the checkout", () => { has(run(path.join(S, "factory/tracker"), ["show", "solo/one"]), "done"); });
  test("  on its own branch, no unit branches", () => { assert.ok(["main", "master"].includes(w.git(S, "rev-parse", "--abbrev-ref", "HEAD"))); });
});
