// project.json private_words: tracker writes reach origin at once, so one that adds a word on the
// list is refused and leaves nothing behind. Run: node --test tracker/test/
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { trackerRepo, has, cmd, TRACKER } from "../../test/lib/index.ts";

const f = trackerRepo("repo");
const { setup, ok } = f;
setup(["init", "--title", "Private words"]);
setup(["add-group", "g", "--title", "Group"]);
setup(["add-unit", "g/a", "--title", "First unit"]);
const words = path.join(f.top, "words.txt");
fs.writeFileSync(words, "# a comment\n\nsecretname\n192.0.2.\n");
const project = path.join(f.dir, "tracker/project.json");
const setList = (l: string[]) => fs.writeFileSync(project, JSON.stringify({ ...JSON.parse(fs.readFileSync(project, "utf8")), private_words: l }, null, 2) + "\n");
setList(["$NOT_SET_HERE/words.txt", words]);
f.git("add", "-A"); f.git("commit", "-qm", "tracker");
const bare = path.join(f.top, "origin.git");
f.git("clone", "-q", "--bare", f.dir, bare);
f.git("remote", "add", "origin", bare);
const onOrigin = () => cmd("git", ["--git-dir", bare, "log", "--format=%s", "main"], { cwd: f.top, env: f.env }).stdout;
const run = (a: string[]) => cmd(process.execPath, [TRACKER, ...a], { cwd: f.dir, env: f.env });

describe("private_words", () => {
  test("a write without one lands", () => {
    ok(["note", "g/a", "An ordinary note"]);
    has(onOrigin(), "An ordinary note");
  });
  test("a write with one is refused, whatever its case, and nothing lands", () => {
    const before = onOrigin();
    const r = run(["note", "g/a", "Seen on SecretName today"]);
    assert.notEqual(r.code, 0);
    has(r.stderr, "private word");
    assert.equal(onOrigin(), before);
    assert.ok(!run(["show", "g/a"]).stdout.includes("SecretName"));
  });
  test("the next write after a refusal lands", () => {
    ok(["note", "g/a", "Said another way"]);
    has(onOrigin(), "Said another way");
  });
  test("every text field is covered, a title too", () => {
    const r = run(["add-unit", "g/b", "--title", "At 192.0.2.7"]);
    assert.notEqual(r.code, 0);
    has(r.stderr, "private word");
    assert.ok(!onOrigin().includes("192.0.2"));
  });
  test("with the list missing here, a write is refused rather than unchecked", () => {
    fs.renameSync(words, `${words}.gone`);
    const before = onOrigin();
    const r = run(["note", "g/a", "Unchecked note"]);
    fs.renameSync(`${words}.gone`, words);
    assert.notEqual(r.code, 0);
    has(r.stderr, "no list of private words");
    assert.equal(onOrigin(), before);
  });
});
