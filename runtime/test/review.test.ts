// review.ts on its own: reading a review's verdict from its transcript, the reviewer's model, and
// its prompt. (test/branches/review.test.ts runs the review through the loop.) Run: node --test runtime/test/
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tempDir } from "../../test/lib/index.ts";
import path from "node:path";
import { reviewModel, reviewPrompt, verdictOf } from "../src/review.ts";

const d = tempDir("review-");
const transcript = (...lines: unknown[]) => { const f = path.join(d, `t${Math.random()}.jsonl`); fs.writeFileSync(f, lines.map((l) => typeof l === "string" ? l : JSON.stringify(l)).join("\n") + "\n"); return f; };
const result = (o: object) => ({ type: "result", is_error: false, ...o });

test("a verdict: the result's structured output", () => {
  assert.deepEqual(verdictOf(transcript({ type: "system" }, result({ structured_output: { verdict: "pass", findings: [] } }))), { verdict: "pass" });
  assert.deepEqual(verdictOf(transcript(result({ structured_output: { verdict: "fix", findings: ["a.ts:1: wrong", " ", "b.ts:2: also"] } }))), { verdict: "fix", findings: "- a.ts:1: wrong\n- b.ts:2: also" });
});
test("  else JSON in the result's text", () => {
  assert.deepEqual(verdictOf(transcript(result({ result: 'Here it is: {"verdict":"fix","findings":["c.ts:3: off by one"]} done' }))), { verdict: "fix", findings: "- c.ts:3: off by one" });
});
test("  a fix naming none is still a fix", () => {
  const v = verdictOf(transcript(result({ structured_output: { verdict: "fix", findings: [" "] } })));
  assert.equal(v?.verdict, "fix");
  assert.match((v as { findings: string }).findings, /named none/);
});
test("  none to be had: no result, an error, text that isn't one", () => {
  assert.equal(verdictOf(transcript({ type: "system" })), null);
  assert.equal(verdictOf(transcript(result({ is_error: true, structured_output: { verdict: "pass", findings: [] } }))), null);
  assert.equal(verdictOf(transcript(result({ result: "looks fine to me" }))), null);
  assert.equal(verdictOf(transcript(result({ structured_output: { verdict: "maybe", findings: [] } }))), null);
  assert.equal(verdictOf(path.join(d, "missing.jsonl")), null);
});

test("the reviewer's model: review_model, else the lane's", () => {
  assert.equal(reviewModel({ review_model: "opus" }, "sonnet"), "opus");
  assert.equal(reviewModel({}, "sonnet"), "sonnet");
  assert.equal(reviewModel(null, ""), "");
  assert.equal(reviewModel({ review_model: "bad model; rm" }, "sonnet"), "sonnet");
});

test("its prompt: the card, the standards and the diff; a long diff is left in its file", () => {
  const r = { unit: "g/a", title: "Unit a (g/a)", card: "Next: Unit a (g/a)\n", diff: "+one line\n", standards: "Name things plainly.\n" };
  const p = reviewPrompt(r, "/x/diff.patch");
  for (const s of ["Unit a (g/a)", "Next: Unit a (g/a)", "Name things plainly.", "+one line"]) assert.ok(p.includes(s), s);
  assert.ok(!p.includes("/x/diff.patch"));
  assert.ok(!reviewPrompt({ ...r, standards: "" }, "/x/diff.patch").includes("CODING_STANDARDS.md"));
  const big = reviewPrompt({ ...r, diff: "+x\n".repeat(60_000) }, "/x/diff.patch");
  assert.ok(big.includes("/x/diff.patch") && big.length < 10_000);
});

test("  the evidence is held to the card's check, whatever the diff", () => {
  const p = reviewPrompt({ unit: "g/a", title: "Unit a (g/a)", card: "  Evidence: the soak wasn't reproduced\n", diff: "+x\n", standards: "" }, "/x/diff.patch");
  assert.match(p, /Hold it to the card's check/);
  assert.match(p, /split off into another unit/);
});
test("  other groups' builds the branch changes, when there are any", () => {
  const r = { unit: "g/a", title: "Unit a (g/a)", card: "c\n", diff: "+x\n", standards: "" };
  const p = reviewPrompt({ ...r, affected: "marth\tchanged its build: fbx (grabs.py)" }, "/x/diff.patch");
  assert.ok(p.includes("marth\tchanged its build: fbx (grabs.py)"));
  assert.match(p, /built or checked for at least one of them/);
  assert.ok(!reviewPrompt(r, "/x/diff.patch").includes("changes the build of these groups"));
  assert.ok(!reviewPrompt({ ...r, affected: " \n" }, "/x/diff.patch").includes("changes the build of these groups"));
});
