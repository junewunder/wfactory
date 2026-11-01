// The landing check's peak (#116): the loop runs it in a scope of its own with no cap, records its
// peak and run time as `just capped` does, and its next run reserves that peak plus 20% instead of
// the 4G default. The check holds about 200M, and notes the reservation it runs in. The loop is
// the real factory/loop.sh, in the file's lane, with scopes on (FACTORY_NOCAP=0).
// Run: node --test test/loop/
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { readOr } from "../../lib/index.ts";
import { laneFactory } from "./helpers.ts";

const CHECK = `#!/usr/bin/env bash
cat "$FACTORY_CPU_LOCKS/res-$FACTORY_HEAVY_RES.json" >> "$FACTORY_LOCKS/check.res"; echo >> "$FACTORY_LOCKS/check.res"
node -e 'const b = Buffer.alloc(200 * 2 ** 20, 1); setTimeout(() => b.length, 300)'
`;
const f = laneFactory("lane-peak", "lane-peak", { check: "bash check.sh", files: { "check.sh": CHECK } });
const { a, w, setup, state } = f;
const MiB = 1024 ** 2, G = 1024 ** 3;
// What each run of the check reserved, in order.
const reserved = () => readOr(path.join(a.locks, "check.res")).split("\n").filter(Boolean).map((l) => JSON.parse(l).mem as number);
// What's recorded of the check: its peaks and run times.
const history = () => {
  const h = JSON.parse(readOr(path.join(w.env.FACTORY_JOBS_HOME!, "history.json")) || "{}") as Record<string, { peaks: number[]; secs: number[] }>;
  return Object.entries(h).find(([k]) => k.endsWith("\tjust check"))?.[1] ?? { peaks: [], secs: [] };
};
const one = () => f.loopSh(["--max", "1", "--no-wait", "--hours", "0.05"], { FACTORY_NOCAP: "0" });

describe("the landing check's peak", () => {
  test("a unit lands, its landing check run for the first time", () => {
    setup("add-unit", "g/p1", "--title", "Peak one");
    const r = one();
    assert.equal(state("g/p1"), "done", r.stdout + r.stderr);
  });
  test("  it reserved the default, 4G", () => { assert.deepEqual(reserved(), [4 * G]); });
  test("  its peak is recorded: the 200M it held, and not much more", () => {
    const p = history().peaks;
    assert.equal(p.length, 1, JSON.stringify(history()));
    assert.ok(p[0] > 200 * MiB && p[0] < 1 * G, `peak ${p[0]}`);
  });
  test("  and its run time", () => { assert.equal(history().secs.length, 1); });
  test("the next unit's landing check reserves that peak plus 20%", () => {
    setup("add-unit", "g/p2", "--title", "Peak two");
    const r = one();
    assert.equal(state("g/p2"), "done", r.stdout + r.stderr);
    const p = history().peaks[0];
    assert.equal(reserved()[1], Math.ceil(p * 1.2 / MiB) * MiB);
  });
  test("  and leaves no scope behind", () => {
    const units = fs.readdirSync(`/run/user/${process.getuid!()}/systemd/transient`).filter((n) => n.startsWith(`factory-lane-peak${process.pid}-lane1-`) && n.endsWith(".scope"));
    assert.deepEqual(units, []);
  });
});
