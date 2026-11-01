// The opening's gate: a new factory's tracker holds it, and no lane starts (the loop, or the
// fleet starting lanes) until the owner passes it. Run: node --test test/loop/fleet/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { workspace, cmd, has, hasnt, readOr } from "../../lib/index.ts";
import { CLAUDE } from "../factory.ts";

const w = workspace();
Object.assign(w.env, { FACTORY_EVIDENCE_MIN: "0", FACTORY_NOCAP: "1", FACTORY_POLL: "0.1", FACTORY_FETCH_EVERY: "0" });
fs.mkdirSync(w.env.FACTORY_LOCKS!, { recursive: true });
fs.writeFileSync(w.at("bin/claude"), CLAUDE, { mode: 0o755 });
w.profile();
const S = w.init(`opening${process.pid}`);
const fill = (p: string, from: RegExp, to: string) => fs.writeFileSync(path.join(S, p), readOr(path.join(S, p)).replace(from, to));
fill("docs/factory.md", /<fill[^>]*>/g, "filled"); fill("justfile", /@echo "TODO.*/g, "@true");
w.setup(["add-group", "g", "--title", "Group"], S);
w.setup(["add-unit", "g/one", "--title", "One unit"], S);
w.git(S, "add", "-A"); w.git(S, "commit", "-qm", "init");
const run = (file: string, args: string[]) => cmd(path.join(S, file), args, { cwd: S, env: w.env, merged: true });
const loop = () => run("factory/loop.sh", ["--no-awake", "--idle-wait", "0.05", "--last-call", "0", "--hours", "0.05"]);

describe("the opening's gate: no lanes until the owner passes it", () => {
  test("the loop refuses while it's open", () => {
    const r = loop();
    assert.equal(r.code, 2);
    has(r.stdout, "the opening isn't over");
  });
  test("  and works no unit", () => { hasnt(w.git(S, "log", "--format=%s"), "g/one"); });
  test("the fleet starts no lane while it's open", () => {
    const r = run("factory/fleet.sh", ["start", "--hours", "0.05"]);
    assert.equal(r.code, 2);
    has(r.stdout, "fleet: the opening isn't over");
  });
  test("a dropped gate: the loop says to reopen it, not to pass it", () => {
    w.setup(["drop", "opening/ready", "--why", "dropped by mistake"], S);
    const r = loop();
    w.setup(["reopen", "opening/ready"], S);
    assert.equal(r.code, 2);
    has(r.stdout, "the opening's gate was dropped");
  });
  test("once the owner passes it, the loop works the units", () => {
    w.setup(["pass", "opening/ready"], S);
    has(loop().stdout, "every unit is done");
  });
});
