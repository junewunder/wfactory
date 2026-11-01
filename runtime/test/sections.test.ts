// The sections a loop session gets in its prompt instead of reading whole files: the spec's
// "The loop" and this machine's part of docs/machines.md (machines.ts). Run: node --test runtime/test/
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { machineSection, mdSection, mdSections } from "../src/machines.ts";

const spec = `# A factory

## Goal

Ship it.

## The loop

1. Orient.

### Notes

A subheading stays in.

\`\`\`
## not a heading in a fence
\`\`\`

## Resources

The editor.
`;

test("the loop section runs to the next heading of its level, subheadings and fences included", () => {
  const s = mdSection(spec, "The loop")!;
  assert.ok(s.startsWith("## The loop\n"));
  assert.match(s, /### Notes/);
  assert.match(s, /## not a heading in a fence/);
  assert.doesNotMatch(s, /Resources|Ship it/);
});

test("the last section runs to the end, and a missing one is null", () => {
  assert.equal(mdSection(spec, "resources"), "## Resources\n\nThe editor.");
  assert.equal(mdSection(spec, "The lo"), null);
  assert.equal(mdSection("", "The loop"), null);
});

test("a machine's section is its own, not another's or the Lanes table", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sections-"));
  const f = path.join(dir, "machines.md");
  fs.writeFileSync(f, "# Machines\n\n## Lanes\n\n| Machine |\n|---|\n| wren |\n\n## wren\n\n- **Can do:** new mods.\n\n## tern\n\n- **Can do:** the editor.\n");
  assert.equal(machineSection("wren", f), "## wren\n\n- **Can do:** new mods.");
  assert.equal(machineSection("heron", f), null);
  assert.equal(machineSection("wren", path.join(dir, "none.md")), null);
  fs.rmSync(dir, { recursive: true });
});

test("the sections a test picks, in the file's order", () => {
  const t = "## Data rules (every session)\n\nNo game data in git.\n\n## Goal\n\nShip.\n\n## The loop\n\n1. Orient.\n";
  const want = (h: string) => h === "The loop" || /\(every session\)$/.test(h);
  assert.deepEqual(mdSections(t, want), ["## Data rules (every session)\n\nNo game data in git.", "## The loop\n\n1. Orient."]);
  assert.deepEqual(mdSections(t, () => false), []);
});
