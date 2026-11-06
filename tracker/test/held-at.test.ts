// The tracker CLI end to end: held-at, the units whose sessions on a host were open at a time,
// which the morning summary asks to tie an event that names no unit to its session.
// Run: node --test tracker/test/
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { trackerRepo, ago } from "../../test/lib/index.ts";

const f = trackerRepo("repo", { FACTORY_TAG: "s1", FACTORY_EVIDENCE_MIN: "0" });
const { t, ok, setup } = f;
setup(["init", "--title", "Held at"]);
setup(["add-group", "g", "--title", "Group"]);
for (const u of ["a", "b", "c"]) setup(["add-unit", `g/${u}`, "--title", `Unit ${u}`]);
// The minute it is now, as events.log has a time.
const minute = () => new Date(Math.floor(Date.now() / 60e3) * 60e3).toISOString();
const heldAt = (host: string, at: string) => (JSON.parse(ok(["held-at", host, at, "--json"])) as { id: string }[]).map((u) => u.id).join(",");

describe("held-at", () => {
  test("a session open on the host then", () => {
    setup(["claim", "g/a"]);
    setup(["claim", "g/b"], { FACTORY_TAG: "s2", FACTORY_HOST: "otherhost" });
    assert.equal(heldAt("testhost", minute()), "g/a");
  });
  test("not one on another host", () => { assert.equal(heldAt("otherhost", minute()), "g/b"); });
  test("nothing before any claim", () => { assert.equal(heldAt("testhost", ago(2)), ""); });
  test("two lanes' sessions on one host: both, so the caller can't pick one", () => {
    setup(["claim", "g/c"], { FACTORY_TAG: "s3" });
    assert.equal(heldAt("testhost", minute()), "g/a,g/c");
  });
  test("a session that ended is open only until its last line", () => {
    setup(["done", "g/a", "--evidence", "x"]);
    assert.ok(heldAt("testhost", minute()).includes("g/a"));
    assert.ok(!heldAt("testhost", new Date(Date.now() + 3600e3).toISOString()).includes("g/a"));
  });
  test("refuses a time it can't read", () => { assert.equal(t(["held-at", "testhost", "soon"]).code, 2); });
});
