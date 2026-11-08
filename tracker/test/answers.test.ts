// The tracker CLI end to end: what an answer's option drops or releases, lanes-stopped,
// questions --all, answer --via, decide --by, decisions --for and the best matches, and the
// tracker as a function (run() in-process). Run: node --test tracker/test/
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { trackerRepo, has, hasnt, firstLine, cmd, ROOT } from "../../test/lib/index.ts";

const f = trackerRepo("repo", { FACTORY_TAG: "worker1", FACTORY_EVIDENCE_MIN: "0" });
const { t, ok, setup } = f;
setup(["init", "--title", "Test port"]);

type Unit = { id: string };
const unit = (id: string) => f.json(`tracker/groups/${id.split("/")[0]}.json`).units.find((u: Unit) => u.id === id);
const state = (id: string) => ok(["state", id]).replace(/\n+$/, "");
const fxOpts = ["--option", "keep | Keep the old team's | The two units are dropped | drops: mx/lcancel, mx/shield",
  "--option", "port | Port them | They go ahead | releases: mx/lcancel,mx/shield"];
const tryAsk = (title: string, keep: string) => t(["ask", "--title", title, "--context", "x", "--option", keep,
  "--option", "port | Port | y", "--default", "keep", "--blocks", "mx/lcancel"], {}, { merged: true }).stdout;

describe("an answer's option says what it drops or releases, and answer does exactly that", () => {
  test("ask: an option that drops must account for every blocked unit", () => {
    setup(["add-group", "mx", "--title", "Classic mechanics"]);
    for (const u of ["lcancel", "shield", "ledge"]) setup(["add-unit", `mx/${u}`, "--title", `Classic ${u}`]);
    const out = t(["ask", "--title", "Where should Faye keep the rules, first try?", "--context", "x", "--option", "keep | Keep | x | drops: mx/lcancel",
      "--option", "port | Port | y", "--default", "keep", "--blocks", "mx/lcancel", "--blocks", "mx/shield"], {}, { merged: true }).stdout;
    has(out, "it leaves out Classic shield (mx/shield)");
  });
  test("refused for a unit that doesn't exist", () => {
    has(tryAsk("Where should Faye keep the rules, second try?", "keep | Keep | x | drops: mx/nope"), "no such unit mx/nope");
  });
  test("refused for a unit both dropped and released", () => {
    has(tryAsk("Where should Faye keep the rules, third try?", "keep | Keep | x | drops: mx/lcancel | releases: mx/lcancel"), "both drops and releases");
  });
  let out = "";
  test("show prints what an option drops", () => {
    setup(["ask", "--title", "Where does Faye keep the Classic rules?", "--context", "x", ...fxOpts, "--default", "keep", "--blocks", "mx/lcancel,mx/shield", "--id", "faye-rules", "--force"]);
    out = ok(["show", "q/faye-rules"]);
    has(out, "→ drops 2 units: Classic lcancel (mx/lcancel), Classic shield (mx/shield)");
  });
  test("and what one releases", () => { has(out, "→ releases 2 units: Classic lcancel (mx/lcancel), Classic shield (mx/shield)"); });
  test("questions prints it too", () => { has(ok(["questions"]), "→ drops 2 units"); });
  let before = "";
  test("answer drops what the option drops", () => {
    before = JSON.stringify(unit("mx/ledge"));
    out = ok(["answer", "q/faye-rules", "keep"]);
    has(out, "Dropped 2 units");
  });
  test("and releases nothing", () => { has(out, "Released 0 units"); });
  test("both units are dropped", () => { assert.equal(`${state("mx/lcancel")},${state("mx/shield")}`, "dropped,dropped"); });
  test("and nothing else changes", () => { assert.equal(JSON.stringify(unit("mx/ledge")), before); });
  test("answer releases what the option releases", () => {
    setup(["reopen", "mx/lcancel"]); setup(["reopen", "mx/shield"]);
    setup(["ask", "--title", "Where does Faye keep the Classic rules, again?", "--context", "x", ...fxOpts, "--default", "keep", "--blocks", "mx/lcancel,mx/shield", "--id", "faye-rules-2", "--force"]);
    setup(["block", "mx/ledge", "--on", "q/faye-rules-2"]);
    out = ok(["answer", "q/faye-rules-2", "port"]);
    has(out, "Released 2 units");
  });
  test("and drops nothing", () => { hasnt(out, "Dropped"); });
  test("both units are ready", () => { assert.equal(`${state("mx/lcancel")},${state("mx/shield")}`, "ready,ready"); });
  test("a unit blocked later that the option doesn't name stays stuck", () => { has(state("mx/ledge"), "stuck"); });
  test("and answer says so", () => { has(out, "Stuck, because the answer doesn't say what happens to them: 1 unit: Classic ledge (mx/ledge)"); });
  test("refused: an option whose text is only a drops: field", () => {
    has(tryAsk("Where should Faye keep the rules, fourth try?", "keep | Keep | drops: group:mx"), "say what the option changes before");
  });
  test("refused: dropping a unit the question doesn't block", () => {
    has(tryAsk("Where should Faye keep the rules, fifth try?", "keep | Keep | x | drops: mx/lcancel, mx/ledge"), "which the question doesn't block");
  });
  test("a drops: selector shows only the units the question blocks", () => {
    setup(["reopen", "mx/lcancel"]); setup(["reopen", "mx/ledge"]); setup(["claim", "mx/ledge"], { FACTORY_TAG: "lane9" });
    setup(["ask", "--title", "Does the shield rule stay at all?", "--context", "x", "--option", "cut | Cut it | x | drops: group:mx", "--option", "keep | Keep it | y", "--default", "cut", "--blocks", "mx/lcancel", "--id", "mx-cut", "--force"]);
    has(ok(["show", "q/mx-cut"]), "→ drops 1 unit: Classic lcancel (mx/lcancel)");
  });
  test("and answer drops only those", () => { has(ok(["answer", "q/mx-cut", "cut"]), "Dropped 1 unit: Classic lcancel (mx/lcancel)"); });
  test("leaving a unit a lane is working on alone", () => { has(state("mx/ledge"), "doing"); });
  test("even when the question's blocks match it", () => {
    setup(["reopen", "mx/lcancel"]);
    setup(["ask", "--title", "Does the ledge rule stay at all?", "--context", "x", "--option", "cut | Cut it | x | drops: group:mx", "--option", "keep | Keep it | y", "--default", "cut", "--blocks", "group:mx", "--id", "mx-cut-2", "--force"]);
    ok(["answer", "q/mx-cut-2", "cut"]);
    has(state("mx/ledge"), "doing");
  });
  test("Released counts only units that are free", () => {
    setup(["reopen", "mx/lcancel"]); setup(["reopen", "mx/shield"]); setup(["park", "mx/shield", "--why", "test"]);
    setup(["ask", "--title", "Do the Classic rules wait for the owner?", "--context", "x", "--option", "a | A | x", "--option", "b | B | y", "--default", "a", "--blocks", "group:mx", "--id", "mx-plain", "--force"]);
    has(ok(["answer", "q/mx-plain", "a"]), "Released 1 unit: Classic lcancel (mx/lcancel)");
  });
  // ask refuses what lint would report: a question asked with it failed the project's lint on
  // main, and every lane stopped until it was asked again.
  const classicDrop = ["ask", "--title", "Should the Classic rules be dropped?", "--context", "x", "--option", "a | Drop | They are dropped", "--option", "b | Keep | x", "--default", "a", "--blocks", "mx/lcancel", "--id", "classic-drop", "--force"];
  test("ask: an option that says dropped with no drops: field is refused", () => {
    setup(["unpark", "mx/shield"]);
    const r = t(classicDrop, {}, { merged: true });
    assert.equal(r.code, 2);
    has(r.stdout, "--option a says units are dropped, but answering it drops nothing");
  });
  test("lint: such an option, on a question asked before ask refused it", () => {
    setup(classicDrop.map((x) => x.replace("They are dropped", "They stay")));
    f.edit("tracker/questions.json", (j) => { j.questions.find((q: { id: string }) => q.id === "q/classic-drop").options[0].changes = "They are dropped"; });
    has(t(["lint"], {}, { merged: true }).stdout, "q/classic-drop: option a says units are dropped, but answering it drops nothing");
  });
  after(() => {
    setup(["withdraw", "q/classic-drop", "--why", "test"]);
    for (const u of ["lcancel", "shield", "ledge"]) setup(["drop", `mx/${u}`, "--why", "test"]);
  });
});

describe("ask: a question that leaves the asker's own unit out of what it blocks", () => {
  // A candidate departure from the reference: a unit of its own, which needs the one that found
  // it, and a question that blocks only that, so the finding unit goes on.
  let out = "";
  test("tells the session to carry on with its unit", () => {
    setup(["add-group", "cd", "--title", "Candidates"]);
    setup(["add-unit", "cd/work", "--title", "Build the dash"]);
    ok(["claim", "cd/work"]);
    setup(["add-unit", "cd/turn", "--title", "Turnaround: the owner's call", "--needs", "cd/work", "--tags", "taste"]);
    out = ok(["ask", "--title", "Keep the reference's slow turnaround?", "--context", "x", "--option", "ref | The reference's | built to match",
      "--option", "def | The default | nothing more", "--default", "def", "--blocks", "cd/turn", "--scope", "cd/turn"]);
    has(out, "Build the dash (cd/work) isn't one of them: carry on with it.");
  });
  test("and its unit stays claimed", () => { assert.equal(state("cd/work"), "doing"); });
  test("while the candidate waits on the owner", () => { assert.equal(state("cd/turn"), "you"); });
  test("a question that blocks the asker's unit still says to stop", () => {
    has(ok(["ask", "--title", "Which dash speed for the work unit?", "--context", "x", "--option", "a | Fast | x", "--option", "b | Slow | y",
      "--default", "a", "--blocks", "cd/work"]), "stop this unit here");
  });
  after(() => { for (const u of ["cd/work", "cd/turn"]) setup(["drop", u, "--why", "test"]); });
});

describe("lanes-stopped: the last lane's record, for an overseer that can't reach the machine", () => {
  test("lanes-stopped logs that the machine tidied", () => {
    ok(["lanes-stopped"]);
    has(ok(["log", "-n", "1"]), "testhost: the last lane stopped and tidied up; the machine may sleep now");
  });
  test("with what failed", () => {
    ok(["lanes-stopped", "--failed", "copying back and releasing its leases, factory/tidy"]);
    has(ok(["log", "-n", "1"]), "tidied up, except: copying back and releasing its leases, factory/tidy;");
  });
});

// q/faye-rules was answered and q/classic-drop withdrawn above.
describe("questions --all", () => {
  test("questions leaves out answered ones", () => { hasnt(ok(["questions"]), "Where does Faye keep the Classic rules?"); });
  let out = "";
  test("questions --all includes them", () => {
    out = ok(["questions", "--all"]);
    has(out, "Where does Faye keep the Classic rules? (q/faye-rules)");
  });
  test("with the answer", () => { has(out, "Answered "); });
  test("and withdrawn ones", () => { has(out, "Withdrawn "); });
});

describe("answer --via, decide --by owner, decisions --for", () => {
  const decisions = () => f.json("tracker/decisions.json").decisions;
  test("answer --via records the thread on the decision", () => {
    setup(["add-group", "dv", "--title", "Decisions"]); setup(["add-unit", "dv/a", "--title", "Decided unit"]);
    setup(["ask", "--title", "Which shade of green for the decided unit?", "--context", "x", "--option", "a | Lime | x", "--option", "b | Moss | y", "--default", "a", "--blocks", "dv/a", "--id", "dv-green", "--force"]);
    ok(["answer", "q/dv-green", "b", "--via", "thread-42"]);
    assert.equal(decisions().find((d: { question?: string }) => d.question === "q/dv-green").via, "thread-42");
  });
  test("and on the answer", () => {
    assert.equal(f.json("tracker/questions.json").questions.find((q: { id: string }) => q.id === "q/dv-green").answer.via, "thread-42");
  });
  test("and in the log, as the owner's", () => {
    const last = JSON.parse(f.read("tracker/log.jsonl").replace(/\n+$/, "").split("\n").at(-1)!);
    assert.equal([last.actor, last.via].join(","), "owner,thread-42");
  });
  test("without --via, the session's tag", () => {
    f.tryIn(["answer", "q/faye-rules-2", "port"]);
    assert.equal(decisions().find((d: { question?: string }) => d.question === "q/faye-rules").via, "worker1");
  });
  test("decide --by owner records the owner's decision", () => {
    ok(["decide", "--title", "Decided unit stays square", "--why", "the owner said so in chat", "--scope", "dv/a", "--by", "owner"]);
    assert.equal(decisions().at(-1).by, "owner");
  });
  test("shown as the owner's", () => { has(ok(["show", "dv/a"]), "Decided unit stays square (the owner)"); });
  test("any other --by is the session", () => {
    ok(["decide", "--title", "Decided unit is shiny", "--why", "an agent's call", "--scope", "dv/a", "--by", "someone"]);
    assert.equal(decisions().at(-1).by, "worker1");
  });
  let out = "";
  test("decisions --for lists the ones that apply to a unit", () => {
    // The bash suite ran this where no such decision existed, so "and not others" couldn't fail:
    // here there is one, scoped to other units.
    setup(["decide", "--title", "Jabs use the new jab timing", "--why", "it reads better in game", "--scope", "*/jab"]);
    out = ok(["decisions", "--for", "dv/a"]);
    has(out, "Decided unit stays square");
  });
  test("in full", () => { has(out, "  Why: the owner said so in chat"); });
  test("and not others", () => { hasnt(out, "Jabs use the new jab timing"); });
  test("newest first", () => { has(firstLine(out), "- Decided unit is shiny"); });
  test("decisions leaves out replaced ones", () => {
    setup(["decide", "--title", "Decided unit is matte", "--why", "changed mind", "--scope", "dv/a", "--replaces", "d/decided-unit-is-shiny"]);
    hasnt(ok(["decisions"]), "Decided unit is shiny (");
  });
  test("--all includes them", () => { has(ok(["decisions", "--all"]), "[replaced by Decided unit is matte (d/decided-unit-is-matte)]"); });
  // A project's check reads these to hold an oracle's exceptions to the owner's standing calls.
  type Shown = { by: string; in_force: boolean; ended: { kind: string; by?: string; text: string } | null };
  const shown = (id: string): Shown => JSON.parse(ok(["show", id, "--json"]));
  test("show --json on a decision: the owner's, still standing", () => {
    const d = shown("d/decided-unit-stays-square");
    assert.deepEqual([d.by, d.in_force, d.ended], ["owner", true, null]);
  });
  test("show --json on a replaced decision says what replaced it", () => {
    const d = shown("d/decided-unit-is-shiny");
    assert.deepEqual([d.in_force, d.ended?.kind, d.ended?.by], [false, "replaced", "d/decided-unit-is-matte"]);
  });
  test("and says it in words", () => { assert.equal(shown("d/decided-unit-is-shiny").ended?.text, "replaced by Decided unit is matte (d/decided-unit-is-matte)"); });
  test("and an agent's decision is the session's", () => { assert.equal(shown("d/decided-unit-is-matte").by, "worker1"); });
  test("an answer's decision names its question and thread", () => {
    const id = decisions().find((d: { question?: string }) => d.question === "q/dv-green").id;
    const d = JSON.parse(ok(["show", id, "--json"]));
    assert.deepEqual([d.by, d.question, d.via], ["owner", "q/dv-green", "thread-42"]);
  });
  test("a lapsed decision isn't in force", () => {
    const j = f.json("tracker/decisions.json");
    j.decisions.push({ id: "d/dv-lapsed", title: "Decided unit is round for now", why: "a while", by: "owner", at: "2026-01-01T00:00:00Z", scope: ["dv/a"], until: "2026-01-02T00:00:00Z" });
    f.write("tracker/decisions.json", JSON.stringify(j, null, 2) + "\n");
    const d = shown("d/dv-lapsed");
    assert.deepEqual([d.in_force, d.ended?.kind], [false, "lapsed"]);
  });
  test("show --json on a decision that doesn't exist fails", () => {
    const r = t(["show", "d/no-such-call", "--json"], {}, { merged: true });
    assert.notEqual(r.code, 0);
    has(r.stdout, "no decision d/no-such-call");
  });
  test("decisions --all --json lists every one, ended ones included", () => {
    const all: (Shown & { id: string })[] = JSON.parse(ok(["decisions", "--all", "--json"]));
    assert.deepEqual(["d/decided-unit-stays-square", "d/decided-unit-is-shiny", "d/dv-lapsed"].map((id) => all.find((d) => d.id === id)?.in_force), [true, false, false]);
  });
  test("and without --all, only those in force", () => {
    const now: { id: string }[] = JSON.parse(ok(["decisions", "--json"]));
    assert.ok(now.some((d) => d.id === "d/decided-unit-stays-square") && !now.some((d) => d.id === "d/decided-unit-is-shiny"));
  });
  test("and with --for too", () => {
    const out = ok(["decisions", "--all", "--for", "dv/a"]);
    has(out, "[replaced by Decided unit is matte (d/decided-unit-is-matte)]");
    hasnt(out, "Jabs use the new jab timing");
  });
  // More than 40 matches: the best one prints first, and isn't cut off.
  test("decisions <words> with more than 40 matches prints the best first", () => {
    setup(["decide", "--title", "Park lanes keep their flag", "--why", "the best match", "--scope", "dv/a"]);
    const j = f.json("tracker/decisions.json");
    for (let i = 0; i < 45; i++) j.decisions.push({ id: "d/weak-park-" + i, title: "Weak park match number " + i, why: "only one word", by: "worker1", at: new Date().toISOString().replace(/\.\d+Z$/, "Z"), scope: ["dv/a"] });
    f.write("tracker/decisions.json", JSON.stringify(j, null, 2) + "\n");
    out = ok(["decisions", "park", "flag"]);
    has(firstLine(out), "- Park lanes keep their flag");
  });
  const items = () => out.split("\n").filter((l) => l.startsWith("- "));
  test("and 40 of them", () => { assert.equal(items().length, 40); });
  test("equal matches in the order recorded", () => {
    has(items()[1], "- Weak park match number 0 ");
  });
  after(() => {
    setup(["drop", "dv/a", "--why", "test"]);
  });
});

describe("the tracker as a function: run() in-process, twice, with an environment of its own", () => {
  let out = "";
  test("run() in-process runs one command after another", () => {
    out = cmd(process.execPath, ["--input-type=module", "-e", `
const { run } = await import(process.argv[1]);
const env = { ...process.env, FACTORY_TAG: "inproc" };
const a = run(["show", "dv"], { env }), b = run(["state", "dv/a"], { env });
console.log(\`codes \${a} \${b}; LOOP \${"LOOP" in env ? "set" : "unset"}\`);`, path.join(ROOT, "tracker", "src", "index.ts")],
    { cwd: f.dir, env: f.env, merged: true }).stdout;
    has(out, "codes 0 0");
  });
  test("show <group> leaves the caller's environment alone", () => { has(out, "LOOP unset"); });
  test("printing what the CLI prints", () => { has(out, "Decisions (dv): 1 dropped"); });
});
