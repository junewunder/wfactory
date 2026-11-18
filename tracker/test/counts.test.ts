// What `status` and a unit's card count as the work: a dropped unit is no longer work to do, so
// it's out of every "N of M done". Run: node --test tracker/test/
import { describe, test } from "node:test";
import { trackerRepo, has, hasnt } from "../../test/lib/index.ts";

const f = trackerRepo("counts", { FACTORY_TAG: "worker1", FACTORY_EVIDENCE_MIN: "0" });
const { ok, setup } = f;

describe("a dropped unit isn't counted as work to do", () => {
  test("status counts the units still wanted", () => {
    setup(["init", "--title", "Test port"]);
    setup(["add-group", "pipe", "--title", "Pipeline"]);
    for (const u of ["extract", "convert", "publish"]) setup(["add-unit", `pipe/${u}`, "--title", `${u} the data`, "--check", "recorded"]);
    setup(["claim", "pipe/extract"]);
    setup(["done", "pipe/extract", "--evidence", "data.json written"]);
    setup(["drop", "pipe/publish", "--why", "nobody wants it published"]);
    has(ok(["status"]), "1 of 2 done");
  });
  test("  and so does its list of open groups", () => { has(ok(["status"]), "Pipeline (1/2)"); });
  test("  and a unit's card", () => { has(ok(["show", "pipe/convert"]), "Group: Pipeline, 1 of 2 done"); });
  test("  status --all still says how many were dropped", () => { has(ok(["status", "--all"]), "1 dropped"); });
  test("a group with every unit done or dropped is all done", () => {
    setup(["claim", "pipe/convert"]);
    setup(["done", "pipe/convert", "--evidence", "converted"]);
    const s = ok(["status"]);
    has(s, "2 of 2 done");
    hasnt(s, "of 3 done");
  });
});
