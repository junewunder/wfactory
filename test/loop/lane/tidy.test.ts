// The last lane on a machine to stop runs factory/tidy, says so and records it on main (naming a
// tidy that failed); not while another lane on the machine is running. It keeps the owner's display,
// as the owner's own clean-up (#174). The loop is the real
// factory/loop.sh, in the file's lane. Run: node --test test/loop/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { has, holdLock, readOr } from "../../lib/index.ts";
import { laneFactory } from "./helpers.ts";

const f = laneFactory("lane-tidy");
const { a, w, setup, t, onMain } = f;
const tidied = w.at("tidied");
const TIDY = `#!/bin/sh\necho tidied >> "${tidied}"\necho "$DISPLAY" > "${tidied}.display"\n`;

describe("the last lane on a machine to stop runs factory/tidy", () => {
  let out = "";
  test("the last lane to stop runs factory/tidy", () => {
    onMain("factory/tidy", TIDY);
    setup("add-unit", "g/tidy", "--title", "Unit tidy");
    out = f.loopSh(["--hours", "0.05"], { DISPLAY: ":0" }).stdout;
    assert.equal(readOr(tidied), "tidied\n", out.split("\n").slice(-4).join("\n"));
  });
  test("  and says so", () => { has(out, "tidying up"); });
  // Unlike what the loop runs of the project's own: it may need the owner's desktop.
  test("  with the owner's display, from the loop's environment", () => { assert.equal(readOr(`${tidied}.display`), ":0\n"); });
  test("  and records it on main, for an overseer that can't reach a sleeping machine", () => { has(t("log", "-n", "3"), "the last lane stopped and tidied up; the machine may sleep now"); });
  test("  a factory/tidy that fails is named in the record", () => {
    onMain("factory/tidy", "#!/bin/sh\nexit 1\n");
    setup("add-unit", "g/tidy3", "--title", "Unit tidy three");
    f.loopSh(["--hours", "0.05"]);
    has(t("log", "-n", "3"), "tidied up, except: factory/tidy");
  });
  // Another lane on the machine holds its lane lock through the run.
  let records = -1, after = -1;
  test("  but not while another lane on the machine is running", async () => {
    onMain("factory/tidy", TIDY);
    fs.rmSync(tidied, { force: true });
    const other = await holdLock(path.join(a.locks, "lane-otherlane.lock"));
    setup("add-unit", "g/tidy2", "--title", "Unit tidy two");
    const count = () => t("log", "-n", "1000").split("\n").filter((l) => l.includes("the last lane stopped")).length;
    records = count();
    f.loopSh(["--hours", "0.05"]);
    after = count();
    await other.release();
    assert.ok(!fs.existsSync(tidied));
  });
  test("  nor records it", () => { assert.ok(records >= 2); assert.equal(after, records); });
});
