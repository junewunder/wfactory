// The profile: no loop while it has placeholders; the agent CLI it names is the one each session
// runs, and its absence is said. The loop is the real factory/loop.sh, in the file's lane.
// Run: node --test test/loop/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test } from "node:test";
import fs from "node:fs";
import { has } from "../../lib/index.ts";
import { laneFactory } from "./helpers.ts";

const f = laneFactory("lane-profile");
const { w, setup } = f;
const profile = w.env.WFACTORY_PROFILE!, saved = fs.readFileSync(profile, "utf8");
const restore = () => fs.writeFileSync(profile, saved);
const agent = (cli: string) => fs.writeFileSync(profile, saved.replace(/^\| agent \| claude \|$/m, `| agent | ${cli} |`));
setup("add-unit", "g/p", "--title", "Profile unit");

describe("the profile: no loop while it has placeholders; the agent CLI it names", () => {
  test("a profile with placeholders: the loop refuses", () => {
    fs.appendFileSync(profile, "- **Name:** <fill: your name>\n");
    const out = f.loopSh(["--hours", "0.01"]).stdout;
    restore();
    has(out, "still has <fill: …> placeholders");
  });
  test("the loop starts the profile's agent CLI", () => {
    agent("claude-ok");
    const out = f.loopSh(["--dry-run"]).stdout;
    restore();
    has(out, "-- claude-ok -p");
  });
  test("  and says so when it's missing", () => {
    agent("no-such-agent");
    const out = f.loopSh(["--hours", "0.01"]).stdout;
    restore();
    has(out, "the agent CLI (no-such-agent, the profile's `agent`) not found");
  });
});
