// docs/opening.md's step 3, run as written: its command block files the probe's review as a gate
// that the opening's gate needs, in a factory made by init.sh. Then go (pass the probe) and stop
// (park the opening's gate), with the loop refusing throughout. Run: node --test test/scripts/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { workspace, cmd, has, chomp, ROOT } from "../lib/index.ts";

// Step 3's fenced bash block: from "3. **" up to step 4.
const opening = fs.readFileSync(path.join(ROOT, "docs/opening.md"), "utf8");
const step3 = opening.slice(opening.indexOf("\n3. **"), opening.indexOf("\n4. **"));
const block = step3.match(/```bash\n([\s\S]*?)```/)?.[1] ?? "";
// The block's lines are indented with the list item; bash doesn't mind, but the title is read back.
const title = block.match(/--title "([^"]+)"/)?.[1] ?? "";

const w = workspace();
w.profile();

function factory(name: string) {
  const F = w.init(name);
  const r = cmd("bash", ["-e", "-c", block], { cwd: F, env: w.env, merged: true });
  return { F, r, state: (id: string) => chomp(w.just(["tracker", "state", id], F).stdout), just: (...a: string[]) => w.just(a, F) };
}
const refuses = (f: ReturnType<typeof factory>) => {
  const r = f.just("loop");
  assert.notEqual(r.code, 0, `just loop ran:\n${r.stdout}`);
  has(r.stdout, "the opening isn't over");
};

describe("step 3's command block", () => {
  test("step 3 has one, filing the probe's gate with a title", () => {
    has(block, "add-unit opening/probe --gate");
    assert.ok(title, "the block's add-unit has a --title");
  });

  const f = factory("go");
  test("runs in a fresh factory", () => { assert.equal(f.r.code, 0, f.r.stdout); });
  test("the probe's gate waits on the owner", () => { assert.equal(f.state("opening/probe"), "you"); });
  test("the opening's gate waits on it, not on the owner", () => { assert.equal(f.state("opening/ready"), "waiting"); });
  test("just status: the probe's gate is what's waiting on the owner", () => {
    const line = f.just("status").stdout.split("\n").find((l) => l.includes("Waiting on you")) ?? "";
    has(line, title);
  });
  test("the loop refuses", () => { refuses(f); });
});

describe("go: the owner passes the probe", () => {
  const f = factory("pass");
  const p = f.just("pass", "opening/probe");
  test("passes", () => { assert.equal(p.code, 0, p.stdout); });
  test("the probe is done", () => { assert.equal(f.state("opening/probe"), "done"); });
  test("the opening's gate now waits on the owner", () => { assert.equal(f.state("opening/ready"), "you"); });
  test("the loop still refuses", () => { refuses(f); });
});

describe("stop: the owner parks the opening's gate, then the probe's", () => {
  const f = factory("stop");
  const p = [f.just("tracker", "park", "opening/ready", "--why", "the probe missed its mark"),
    f.just("tracker", "park", "opening/probe", "--why", "the owner said stop")];
  test("parks both", () => { for (const r of p) assert.equal(r.code, 0, r.stdout); });
  test("the opening's gate is parked", () => { assert.equal(f.state("opening/ready"), "parked"); });
  test("nothing is left waiting on the owner", () => { assert.doesNotMatch(f.just("status").stdout, /Waiting on you/); });
  test("the loop refuses, saying the owner stopped it, not to pass or reopen the gate", () => {
    refuses(f);
    const out = f.just("loop").stdout;
    has(out, "the owner stopped it");
    assert.doesNotMatch(out, /reopen|just pass/);
  });
});
