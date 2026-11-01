// When a lane waits and when it stops: nothing to do while another machine has work (wait, tell
// the overseer it's idle, pick up a unit that lands, stop once nothing can move), and only the
// owner left (stop, don't wait). The loop is the real factory/loop.sh, in the file's lane.
// Run: node --test test/loop/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { has, hasnt } from "../../lib/index.ts";
import { laneFactory } from "./helpers.ts";

const f = laneFactory("lane-waits");
const { setup, t, events, until } = f;

describe("nothing to do while another machine has work: wait, then pick up a unit that lands", () => {
  let b: ReturnType<typeof f.loopBg>;
  test("a lane with nothing to do waits", async () => {
    setup("add-unit", "g/far", "--title", "Pinned elsewhere", "--host", "otherbox");
    b = f.loopBg(["--hours", "0.03"], { FACTORY_IDLE_TELL: "2" });
    await b.until("waiting:");
  });
  test("  and says why", () => { has(b.out(), "for another machine"); });
  test("  idle long enough, it tells the overseer", async () => { await until(() => events().includes("\tidle\t"), "an idle event"); });
  test("  then picks up a unit that lands", async () => {
    setup("add-unit", "g/two", "--title", "Unit two");
    await b.until("iteration 1: Unit two (g/two)");
  });
  test("  and stops once nothing can move", async () => {
    setup("drop", "g/far", "--why", "test");
    await b.until("every unit is done or dropped", 30);
    await b.end();
  });
});

describe("only the owner is left: stop, don't wait", () => {
  let out = "";
  test("only the owner's questions left: the lane stops", () => {
    setup("add-unit", "g/ask", "--title", "Needs the owner");
    setup("ask", "--title", "Which way should the test go?", "--context", "x", "--option", "a|A|x", "--option", "b|B|y", "--default", "a", "--blocks", "g/ask");
    out = f.loopSh(["--hours", "0.05"]).stdout;
    const qs = JSON.parse(fs.readFileSync(path.join(t("dir"), "questions.json"), "utf8")).questions;
    setup("drop", "g/ask", "--why", "test"); setup("withdraw", qs.at(-1).id, "--why", "test");
    has(out, "Only the owner's questions and gates are left");
  });
  test("  without waiting", () => { hasnt(out, "waiting:"); });
});
