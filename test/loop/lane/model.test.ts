// The model and effort each session runs with (--model, $FACTORY_MODEL, a unit's own; --effort,
// $FACTORY_EFFORT), and --dry-run: the next unit and the command, and nothing run or claimed. The
// loop is the real factory/loop.sh, in the file's lane. Run: node --test test/loop/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { has, hasnt, lines, readOr } from "../../lib/index.ts";
import { laneFactory } from "./helpers.ts";

const f = laneFactory("lane-model");
const { a, setup, state, seen, events, proj } = f;
const args = () => seen("args.seen");
const one = (add: NodeJS.ProcessEnv = {}, more: string[] = []) => f.loopSh(["--max", "1", "--no-wait", "--hours", "0.05", ...more], add).stdout;

describe("the model and effort: --model, $FACTORY_MODEL, a unit's own; --effort, $FACTORY_EFFORT", () => {
  let out = "";
  test("no model given: the CLI's default", () => {
    setup("add-unit", "g/m1", "--title", "Model one");
    one();
    hasnt(args(), "--model");
  });
  test("  and no effort", () => { hasnt(args(), "--effort"); });
  test("--model: each session runs on it", () => {
    setup("add-unit", "g/m2", "--title", "Model two");
    out = one({}, ["--model", "sonnet", "--effort", "high"]);
    has(args(), "--model sonnet");
  });
  test("  and the loop says so", () => { has(out, "iteration 1: Model two (g/m2) (session "); });
  test("  (the model in the line)", () => { has(out, ", sonnet)"); });
  test("--effort", () => { has(args(), "--effort high"); });
  test("a unit's own model wins over the loop's", () => {
    setup("add-unit", "g/m3", "--title", "Model three", "--model", "haiku");
    out = one({ FACTORY_MODEL: "opus", FACTORY_EFFORT: "low" });
    has(args(), "--model haiku");
  });
  test("  and the loop says so", () => { has(out, ", haiku)"); });
  test("$FACTORY_EFFORT", () => { has(args(), "--effort low"); });
  test("$FACTORY_MODEL", () => {
    setup("add-unit", "g/m4", "--title", "Model four");
    one({ FACTORY_MODEL: "opus" });
    has(args(), "--model opus");
  });
});

describe("tracker/project.json's session_tools", () => {
  test("a project adds tools (a name that isn't one is ignored)", () => {
    proj((p) => { p.session_tools = ["Skill", "Bash", "no such; tool"]; });
    a.git("pull", "-q", "--rebase", "origin", "main");
    setup("add-unit", "g/m5", "--title", "Model five");
    one();
    has(args(), "WebSearch,ToolSearch,Skill --allowedTools");
    proj((p) => { delete p.session_tools; });
    a.git("pull", "-q", "--rebase", "origin", "main");
  });
});

describe("--dry-run: the next unit and the command, and nothing run or claimed", () => {
  let out = "", code = -1, before: number[] = [];
  const counts = () => [lines(readOr(a.at("runs/index.tsv"))), lines(events())];
  test("--dry-run exits 0", () => {
    setup("add-unit", "g/dry", "--title", "Dry unit");
    before = counts();
    const r = f.loopSh(["--dry-run", "--model", "sonnet", "--effort", "max"]);
    out = r.stdout; code = r.code;
    assert.equal(code, 0);
  });
  test("  it shows the next unit's card", () => { has(out, "Next: Dry unit (g/dry)"); });
  test("  and the command each session runs", () => { has(out, `--unit factory-${path.basename(a.dir)}-<tag> -- claude -p --permission-mode auto --output-format stream-json --verbose`); });
  test("  with the model", () => { has(out, "--model sonnet --settings runs/inbox/<tag>/settings.json"); });
  test("  and the effort", () => { has(out, "--effort max"); });
  test("  with the system prompt in a file", () => { has(out, "--append-system-prompt-file runs/inbox/<tag>/system.md"); });
  test("  and the prompt for the spec on stdin", () => {
    has(out, "< runs/inbox/<tag>/prompt.md");
    has(out, "prompt.md: factory/prompt.md for docs/factory.md");
  });
  test("  the unit isn't claimed", () => { assert.equal(state("g/dry"), "ready"); });
  test("  no iteration", () => { hasnt(out, "iteration"); });
  test("  nothing in runs/index.tsv or the events", () => { assert.ok(before[0] > 0 && before[1] > 0); assert.deepEqual(counts(), before); });
});
