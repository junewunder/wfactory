// The tracker's git merge driver (merge-json), on files in a temp folder: entry by entry, and
// two machines' CI writes. Run: node --test tracker/test/
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cmd, has, TRACKER } from "../../test/lib/index.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-test-mj-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("FACTORY_") && k !== "NODE_TEST_CONTEXT"));
const at = (p: string) => path.join(dir, p);
const read = (p: string) => fs.readFileSync(at(p), "utf8");

// base, ours (o, which the driver writes) and theirs, as the bash suite's `echo` wrote them.
function mj(b: string, o: string, th: string, name = "tracker/groups/g.json") {
  fs.writeFileSync(at("b"), b + "\n"); fs.writeFileSync(at("o"), o + "\n"); fs.writeFileSync(at("th"), th + "\n");
  return cmd(process.execPath, [TRACKER, "merge-json", "b", "o", "th", name], { cwd: dir, env });
}

describe("the merge driver meets two machines' CI writes", () => {
  test("a retry merged with a newer failure names the old one", () => {
    const base = '{"id":"g","ci":{"steps":["drill"],"failed":{"commit":"aaa","at":"2026-10-12T01:00:00Z","evidence":"one"}},"units":[]}';
    const fail2 = '{"id":"g","ci":{"steps":["drill"],"failed":{"commit":"bbb","at":"2026-10-12T05:00:00Z","evidence":"two"}},"units":[]}';
    const retry = '{"id":"g","ci":{"steps":["drill"],"failed":{"commit":"aaa","at":"2026-10-12T01:00:00Z","evidence":"one","retry":"2026-10-12T01:00:00Z"}},"units":[]}';
    mj(base, retry, fail2, "g.json");
    has(read("o"), '"retry": "2026-10-12T01:00:00Z"');
  });
  test("next to the newer failure", () => { has(read("o"), '"at": "2026-10-12T05:00:00Z"'); });
});

describe("merge-json: the git merge driver, entry by entry", () => {
  const o = () => JSON.stringify(JSON.parse(read("o")));
  test("merge-json: separate changes merge", () => {
    const r = mj('{"units":[{"id":"a","t":1},{"id":"b","t":1}]}', '{"units":[{"id":"a","t":2},{"id":"b","t":1},{"id":"c","t":1}]}', '{"units":[{"id":"a","t":1},{"id":"d","t":1},{"id":"b","t":3}]}');
    assert.equal(r.code, 0, r.stderr);
  });
  test("by id: each side's change kept, their new entry after the one before it there", () => {
    assert.equal(JSON.stringify(JSON.parse(read("o")).units.map((u: { id: string; t: number }) => `${u.id}${u.t}`)), '["a2","d1","b3","c1"]');
  });
  test("an entry removed on one side and untouched on the other is removed", () => {
    const r = mj('{"units":[{"id":"a"},{"id":"b"}]}', '{"units":[{"id":"a"}]}', '{"units":[{"id":"a"},{"id":"b"}]}');
    assert.equal(`${r.code},${JSON.stringify(JSON.parse(read("o")).units.map((u: { id: string }) => u.id))}`, '0,["a"]');
  });
  let err = "";
  test("removed here, changed there: a clash", () => {
    const r = mj('{"units":[{"id":"a","t":1}]}', '{"units":[]}', '{"units":[{"id":"a","t":2}]}');
    err = r.stderr;
    assert.equal(r.code, 1);
  });
  test("named on stderr", () => { has(err, "[a]: removed here, changed on the other side"); });
  test("the same field changed two ways: a clash", () => {
    const r = mj('{"title":"x","n":1}', '{"title":"y","n":1}', '{"title":"z","n":1}');
    err = r.stderr;
    assert.equal(r.code, 1);
  });
  test("naming the field and both values", () => { has(err, '.title: "y" here, "z" on the other side'); });
  // `$(cat o)` drops the trailing newline the bash wrote.
  test("and ours is left as it was", () => { assert.equal(read("o").replace(/\n+$/, ""), '{"title":"y","n":1}'); });
  test("lists of plain values keep both sides' additions; keys merge", () => {
    const r = mj('{"tags":["a"]}', '{"tags":["a","b"],"k":1}', '{"tags":["c","a"],"j":2}');
    assert.equal(r.code, 0);
    assert.equal(o(), '{"tags":["c","a","b"],"k":1,"j":2}');
  });
  test("written in the tracker's own layout", () => {
    mj('{"title":"x"}', '{"title":"x","tags":["a","b"]}', '{"title":"x","units":[{"id":"a"}]}');
    assert.equal(read("o"), '{\n  "title": "x",\n  "tags": ["a", "b"],\n  "units": [\n    {\n      "id": "a"\n    }\n  ]\n}\n');
  });
  test("invalid JSON on one side: exit 1", () => {
    const r = mj('{"a":1}', "not json", '{"a":2}');
    err = r.stderr;
    assert.equal(r.code, 1);
  });
  test("saying to merge it by hand", () => { has(err, "tracker/groups/g.json isn't valid JSON on one side; merge it by hand"); });
  test("missing arguments: usage, exit 2", () => {
    assert.equal(cmd(process.execPath, [TRACKER, "merge-json", "b", "o"], { cwd: dir, env }).code, 2);
  });
});
