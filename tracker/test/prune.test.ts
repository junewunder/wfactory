// The tracker CLI end to end: decisions that lapse (decide --until), and the pruning pass. prune
// --propose finds a lapsed "tonight" decision, a superseded one and one scoped too wide, and
// changes nothing; prune --apply does one through the tracker's writes, and `decisions --all`
// keeps it, marked; prune --due is the check-in offer, there only when one is due; a lane's own
// decision that only lapsed is applied without asking, the owner's words never.
// Run: node --test tracker/test/
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { trackerRepo, has, hasnt, ago } from "../../test/lib/index.ts";
import { lapseOf, parseUntil, when } from "../src/decisions.ts";

// The tag makes each write a lane's (actor "loop"), as a lane's session records it; OWNERS is an
// interactive session's, taking down the owner's words.
const f = trackerRepo("prune", { FACTORY_TAG: "worker1", FACTORY_EVIDENCE_MIN: "0" });
const OWNERS = { FACTORY_ACTOR: "session" };
const { ok, t, setup } = f;
setup(["init", "--title", "Pruning"]);
setup(["add-group", "lexer", "--title", "Lexer"]);
setup(["add-group", "docs", "--title", "Manual pages"]);
setup(["add-unit", "lexer/tokens", "--title", "Tokens"]);
setup(["add-unit", "docs/intro", "--title", "Introduction page"]);
type D = { id: string; at: string; scope?: string[]; until?: string; retired?: unknown; replaces?: string; kept?: unknown };
const decisions = (): D[] => f.json("tracker/decisions.json").decisions;
// A decision recorded `h` hours ago.
const decide = (title: string, why: string, scope: string, h: number, env: Record<string, string> = {}) => {
  const out = ok(["decide", "--title", title, "--why", why, "--scope", scope], env);
  const id = /; (d\/[^)\s]+)\)/.exec(out)![1];
  f.edit("tracker/decisions.json", (j) => { j.decisions.find((d: D) => d.id === id).at = ago(h); });
  return id;
};
const tonight = decide("Lexer work before everything tonight", "the owner, last night", "group:lexer", 48, OWNERS);
const stale = decide("Lanes stop at 22:00 for the backup window", "the backup runs from 22:00 and slows the disks", "*", 30);
const later = decide("Lanes now stop at 23:00 for the backup window", "the backup moved to 23:00 and slows the disks", "*", 20);
const wide = decide("Manual pages are written in plain words", "the readers are new to the tool", "*", 10);
const steady = decide("Tokens keep their source positions", "error messages need them", "lexer/*", 5);

describe("prune --propose", () => {
  let before = "", log = "", out = "", js: { proposals: { d: string; kind: string; other?: string; scope?: string[] }[] };
  test("lists what it would prune", () => {
    before = f.read("tracker/decisions.json"); log = f.read("tracker/log.jsonl");
    out = ok(["prune", "--propose"]);
    has(out, "3 decisions to prune");
  });
  test("  a lapsed \"tonight\" decision, with its words and the date", () => { has(out, `Lexer work before everything tonight (agent worker1, ${when(ago(48)).slice(0, 10)}; ${tonight})\n   Lapse: it says "tonight", said on `); });
  test("  the owner's words, so not one to apply unasked", () => { hasnt(out.split("2. ")[0], "without asking"); });
  test("  a superseded one, naming the later call by title", () => { has(out, `Superseded: Lanes now stop at 23:00 for the backup window (${later}), from `); });
  test("  one scoped too wide, with the narrower scope", () => { has(out, `Narrow: it's on every unit's card, and it's about Manual pages: on 1 open unit's card instead of 2`); });
  test("  each with the command that applies it", () => { has(out, `Apply: just tracker prune --apply ${wide} --narrow 'group:docs'`); });
  test("  not one still in force for good reason", () => { hasnt(out, steady); });
  test("  not the later call itself", () => { hasnt(out, `Lanes now stop at 23:00 for the backup window (agent`); });
  test("  and nothing is changed", () => { assert.equal(f.read("tracker/decisions.json"), before); assert.equal(f.read("tracker/log.jsonl"), log); });
  test("--json gives the same", () => {
    js = JSON.parse(ok(["prune", "--json"]));
    assert.deepEqual(js.proposals.map((p) => [p.d, p.kind]), [[tonight, "lapse"], [stale, "superseded"], [wide, "narrow"]]);
  });
  test("  with what each names", () => { assert.equal(js.proposals[1].other, later); assert.deepEqual(js.proposals[2].scope, ["group:docs"]); });
  test("a decision in quotes about the word isn't a lapse", () => {
    const id = decide("The owner's 'today' means that day only", "said so", "*", 40);
    hasnt(ok(["prune"]), id);
    f.edit("tracker/decisions.json", (j) => { j.decisions = j.decisions.filter((d: D) => d.id !== id); });
  });
  test("one said tonight that hasn't ended yet isn't proposed", () => {
    const id = decide("Docs first tonight", "the owner, just now", "group:docs", 0);
    hasnt(ok(["prune"]), id);
    f.edit("tracker/decisions.json", (j) => { j.decisions = j.decisions.filter((d: D) => d.id !== id); });
  });
});

describe("prune --apply, through the tracker's writes", () => {
  test("--lapse: off the unit's card", () => {
    has(ok(["show", "lexer/tokens"]), "Lexer work before everything tonight");
    ok(["prune", "--apply", tonight, "--lapse"]);
    hasnt(ok(["show", "lexer/tokens"]), "Lexer work before everything tonight");
  });
  test("  off `decisions`", () => { hasnt(ok(["decisions"]), tonight); });
  test("  and in `decisions --all`, as lapsed", () => { has(ok(["decisions", "--all"]), `${tonight}) [lapsed `); });
  test("  in the log", () => { has(ok(["log"]), "lapsed: Lexer work before everything tonight"); });
  test("--superseded-by: `decisions --all` says by what", () => {
    ok(["prune", "--apply", stale, "--superseded-by", later]);
    has(ok(["decisions", "--all"]), `${stale}) [superseded by Lanes now stop at 23:00 for the backup window (${later})]`);
  });
  test("  and the later call stays", () => { has(ok(["decisions"]), later); });
  test("--narrow: a new decision on the narrower scope replaces it", () => {
    ok(["prune", "--apply", wide, "--narrow", "group:docs"]);
    const nd = decisions().find((d) => d.replaces === wide)!;
    assert.deepEqual(nd.scope, ["group:docs"]);
  });
  test("  off the other units' cards", () => { hasnt(ok(["show", "lexer/tokens"]), "Manual pages are written"); });
  test("  on its group's", () => { has(ok(["show", "docs/intro"]), "Manual pages are written in plain words"); });
  test("  and the old one in `decisions --all`, as replaced, by title", () => { has(ok(["decisions", "--all"]), `${wide}) [replaced by Manual pages are written in plain words (${wide}-2)]`); });
  test("--in-code: retired, and `decisions --all` says where", () => {
    ok(["prune", "--apply", steady, "--in-code", "test/positions.test.ts"]);
    has(ok(["decisions", "--all"]), `${steady}) [retired: the code holds it (test/positions.test.ts)]`);
  });
  test("  --restore puts it back", () => {
    ok(["prune", "--restore", steady]);
    has(ok(["show", "lexer/tokens"]), "Tokens keep their source positions");
  });
  test("--restore of a retired one keeps the time it was to lapse", () => {
    ok(["decide", "--title", "Tokens are ASCII until the Unicode work", "--why", "w", "--scope", "lexer/*", "--until", "2999-01-01"]);
    const id = decisions().at(-1)!.id;
    ok(["prune", "--apply", id, "--in-code", "src/lexer.ts"]);
    ok(["prune", "--restore", id]);
    has(ok(["decisions"]), `${id}) [until 2999-01-02]`);
  });
  test("--narrow keeps the date it was made, and a new ID beside the old", () => {
    const nd = decisions().find((d) => d.replaces === wide)!;
    assert.equal(nd.id, `${wide}-2`);
    assert.equal(nd.at, decisions().find((d) => d.id === wide)!.at);
  });
  test("two actions at once are refused", () => { has(t(["prune", "--apply", later, "--lapse", "--in-code", "x"], {}, { merged: true }).stdout, "(got --lapse and --in-code)"); });
  test("a flag it doesn't know is refused", () => { has(t(["prune", "--aply", later], {}, { merged: true }).stdout, "prune doesn't know --aply"); });
  test("one already off the cards is refused", () => { has(t(["prune", "--apply", stale, "--lapse"], {}, { merged: true }).stdout, "already off the cards (superseded by"); });
  test("now nothing is left to propose", () => { has(ok(["prune"]), "Nothing to prune"); });
});

describe("when a decision's words end", () => {
  // At a fixed moment, local time: 09:00 on 2026-03-10.
  const at = (h: number, m = 0) => new Date(2026, 2, 10, h, m).toISOString();
  const end = (title: string, h: number) => { const l = lapseOf({ id: "d/x", title, why: "", by: "x", at: at(h) }); return l && new Date(l.until).toString(); };
  test("\"tonight\" said in the morning: the next day at noon, after the night", () => { assert.equal(end("Docs first tonight", 9), new Date(2026, 2, 11, 12).toString()); });
  test("\"tonight\" said in the small hours: noon that day (the night under way)", () => { assert.equal(end("Docs first tonight", 0, ), new Date(2026, 2, 10, 12).toString()); });
  test("\"today\": midnight", () => { assert.equal(end("Publish today's fighters", 9), new Date(2026, 2, 11).toString()); });
  test("a last call: the next noon", () => { assert.equal(end("Last call on the laptop at 17:55", 18), new Date(2026, 2, 11, 12).toString()); });
  test("a clock time alone isn't one", () => { assert.equal(end("Lanes stop at 22:00", 9), null); });
  test("words in quotes, with an apostrophe in them, aren't", () => { assert.equal(end("The owner's 'don't upload today' meant that day", 9), null); });
});

describe("--until's forms", () => {
  const from = new Date(2026, 2, 10, 9);
  test("a date: the end of that day", () => { assert.equal(new Date(parseUntil("2026-03-12", from)).toString(), new Date(2026, 2, 13).toString()); });
  test("a time: the next time the clock reads it", () => { assert.equal(new Date(parseUntil("18:00", from)).toString(), new Date(2026, 2, 10, 18).toString()); assert.equal(new Date(parseUntil("08:00", from)).toString(), new Date(2026, 2, 11, 8).toString()); });
  test("a date and time, one-digit hour", () => { assert.equal(new Date(parseUntil("2026-03-12T9:30", from)).toString(), new Date(2026, 2, 12, 9, 30).toString()); });
  test("in UTC", () => { assert.equal(parseUntil("2026-03-12T18:00Z", from), "2026-03-12T18:00:00Z"); });
  for (const bad of ["2026-02-31", "25:00", "12:60", "soon", "2026-03-12T24:00"]) test(`refused: ${bad}`, () => { assert.throws(() => parseUntil(bad, from), /--until needs a date/); });
});

describe("a repeat: merge", () => {
  let first = "", again = "";
  test("--propose: the later one repeats the earlier, on the same units", () => {
    first = decide("Error messages name the file and the line", "readers fix it faster", "lexer/*", 30);
    again = decide("Error messages name the file and the line number", "readers fix it faster", "lexer/*", 10);
    has(ok(["prune"]), `Merge: it repeats Error messages name the file and the line (${first}), from `);
  });
  test("--merge-into: `decisions --all` says into what", () => {
    ok(["prune", "--apply", again, "--merge-into", first]);
    has(ok(["decisions", "--all"]), `${again}) [merged into Error messages name the file and the line (${first})]`);
    has(ok(["decisions"]), first);
  });
});

describe("a later call that builds on an earlier one isn't proposed as replacing it", () => {
  let base = "";
  test("its why names the earlier and says \"now\"", () => {
    base = decide("Lexer errors keep the source line", "users need the line to fix it", "lexer/*", 30);
    decide("Lexer warnings keep the source line too", `the same rule as {d:${base.slice(2)}}; the reporter now shows it`, "lexer/*", 10);
    hasnt(ok(["prune"]), base);
  });
});

describe("--keep, as `decisions` shows it", () => {
  test("--keep … code: `decisions` says so, for whoever reads them for the code", () => {
    const id = decisions().find((d) => d.id.startsWith("d/lexer-errors-keep"))!.id;
    ok(["prune", "--keep", id, "code"]);
    has(ok(["decisions"]), `${id}) [kept: not held by the code]`);
  });
  test("an unknown kind is refused", () => { has(t(["prune", "--keep", later, "soon"], {}, { merged: true }).stdout, "needs what the owner kept it through"); });
});

describe("prune --apply --lapse <date>", () => {
  test("a date given straight after --lapse is its until", () => {
    ok(["decide", "--title", "Docs wait for review", "--why", "w", "--scope", "docs/*"]);
    const id = decisions().at(-1)!.id;
    ok(["prune", "--apply", id, "--lapse", "2999-01-01"]);
    has(ok(["decisions"]), `${id}) [until 2999-01-02]`);
  });
});

describe("decide --until", () => {
  test("a time to come: on the card, and `decisions` says until when", () => {
    ok(["decide", "--title", "Docs wait for the lexer", "--why", "w", "--scope", "docs/*", "--until", "2999-01-01"]);
    has(ok(["show", "docs/intro"]), "Docs wait for the lexer");
    has(ok(["decisions"]), "[until 2999-01-02]");
  });
  test("one passed: off the card", () => {
    ok(["decide", "--title", "Docs paused for the morning", "--why", "w", "--scope", "docs/*", "--until", "2000-01-01T09:00"]);
    hasnt(ok(["show", "docs/intro"]), "Docs paused for the morning");
  });
  test("  and lapsed in `decisions --all`", () => { has(ok(["decisions", "--all"]), "Docs paused for the morning (agent worker1"); has(ok(["decisions", "--all"]), "[lapsed 2000-01-01 09:00]"); });
  test("a time it can't read is refused", () => { has(t(["decide", "--title", "x y z", "--why", "w", "--scope", "*", "--until", "soon"], {}, { merged: true }).stdout, "--until needs a date"); });
});

// "No uploads that day" was still a standing park two days later: an answer, a run and a park
// end when the owner's words say.
describe("answer --until, --for-run, and decide --park", () => {
  const state = (id: string) => ok(["state", id]).trim();
  const setUntil = (id: string, until: string) => f.edit("tracker/decisions.json", (j) => { j.decisions.find((d: D) => d.id === id).until = until; });
  test("answer --until: the answer holds until then", () => {
    setup(["add-group", "up", "--title", "Uploads"]);
    for (const u of ["fenn", "mira", "kael"]) setup(["add-unit", `up/${u}`, "--title", `Upload ${u}'s pack`, "--tags", "upload"]);
    setup(["ask", "--title", "Which mirror do the uploads use?", "--context", "x", "--option", "a | The old one | y", "--option", "b | The new one | z", "--default", "a", "--blocks", "up/fenn", "--scope", "up/*", "--id", "mirror"]);
    const out = ok(["answer", "q/mirror", "a", "--until", "2999-01-01"]);
    has(out, "[until 2999-01-02]");
    assert.equal(decisions().find((d) => d.id === "d/mirror")!.until, new Date(2999, 0, 2).toISOString().replace(/\.\d+Z$/, "Z"));
  });
  test("--for-run: until the run's stop time, in a lane's session", () => {
    const end = Math.trunc(Date.now() / 1000) + 3 * 3600;
    ok(["decide", "--title", "Uploads go to the old mirror tonight", "--why", "w", "--scope", "up/*", "--for-run"], { FACTORY_DEADLINE: String(end) });
    assert.equal(decisions().at(-1)!.until, new Date(end * 1000).toISOString().replace(/\.\d+Z$/, "Z"));
  });
  test("  refused outside one, saying to give --until", () => {
    const r = t(["decide", "--title", "Uploads wait for this run", "--why", "w", "--scope", "up/*", "--for-run"], { FACTORY_DEADLINE: undefined }, { merged: true });
    assert.equal(r.code, 2); has(r.stdout, "--for-run needs the run's stop time");
  });
  test("  and with --until too", () => {
    has(t(["decide", "--title", "Uploads wait", "--why", "w", "--scope", "up/*", "--for-run", "--until", "18:00"], { FACTORY_DEADLINE: "2000000000" }, { merged: true }).stdout, "give one");
  });
  let out = "";
  test("decide --park parks the units in its scope", () => {
    out = ok(["decide", "--title", "No uploads today", "--why", "the owner said so", "--scope", "tag:upload", "--until", "2999-01-01", "--park"]);
    has(out, "Parked 3 units: Upload fenn's pack (up/fenn), Upload mira's pack (up/mira), Upload kael's pack (up/kael)");
    assert.equal(state("up/mira"), "parked");
  });
  test("  saying they come back when it lapses", () => { has(out, "they come back when the decision lapses (2999-01-02) or is replaced or retired"); });
  test("  and they aren't offered", () => { hasnt(ok(["next"]), "up/"); });
  test("once it lapses they're back, with nothing run", () => {
    setUntil("d/no-uploads-today", "2000-01-01T00:00:00Z");
    assert.equal(state("up/mira"), "ready");
  });
  test("  and off its cards", () => { hasnt(ok(["show", "up/mira"]), "No uploads today"); });
  test("a decision replacing one that parked lists the units it frees", () => {
    setUntil("d/no-uploads-today", "2999-01-02T00:00:00Z");
    assert.equal(state("up/kael"), "parked");
    out = ok(["decide", "--title", "Uploads are fine again", "--why", "the mirror is back", "--replaces", "d/no-uploads-today"]);
    has(out, "Released 3 parked units: Upload fenn's pack (up/fenn), Upload mira's pack (up/mira), Upload kael's pack (up/kael)");
    assert.equal(state("up/kael"), "ready");
  });
  test("so does pruning one", () => {
    ok(["decide", "--title", "Kael's pack waits for the art", "--why", "w", "--scope", "up/kael", "--park"]);
    assert.equal(state("up/kael"), "parked");
    has(ok(["prune", "--apply", "d/kael-s-pack-waits-for-the-art", "--lapse"]), "Released 1 parked unit: Upload kael's pack (up/kael)");
  });
  test("a unit with a record of its own isn't parked, and keeps it", () => {
    setup(["block", "up/mira", "--why", "the mirror's key is missing"]);
    out = ok(["decide", "--title", "No mirror work tonight", "--why", "w", "--scope", "up/mira", "--until", "2999-01-01", "--park"]);
    has(out, "Not parked, as each is in progress, interrupted, broken, stuck or waiting on a question");
    has(out, "Upload mira's pack (up/mira): stuck");
    has(ok(["show", "up/mira"]), "the mirror's key is missing");
  });
  test("a park the owner made by hand stays", () => {
    setup(["park", "up/fenn", "--why", "the owner set it aside"]);
    ok(["decide", "--title", "Fenn's upload waits a day", "--why", "w", "--scope", "up/fenn", "--until", "2000-01-01T00:00", "--park"]);
    assert.equal(state("up/fenn"), "parked");
  });
});

describe("prune --due: the check-in offer", () => {
  test("nothing to prune: no offer", () => { assert.equal(ok(["prune", "--due"]), ""); });
  test("  not even with a card over prune_at", () => {
    f.edit("tracker/project.json", (p) => { p.prune_at = 0; });
    assert.equal(ok(["prune", "--due"]), "");
    has(ok(["prune", "--due", "--json"]), '"why":"an open unit\'s card carries');
  });
  test("due when a card carries more than prune_at decisions", () => {
    decide("Docs first tonight, the owner said", "the owner", "group:docs", 30, OWNERS);
    f.edit("tracker/project.json", (p) => { p.prune_at = 2; });
    const o = ok(["prune", "--due"]);
    assert.match(o, /^Check-in due \(an open unit's card carries \d+ decisions, over 2\): 1 decision to prune/);
    has(o, "Docs first tonight, the owner said");
  });
  // The owner may keep many, or say not now: the card stays over prune_at.
  test("  not again after a check-in, though the card is still over", () => {
    ok(["prune", "--checked-in"]);
    assert.equal(ok(["prune", "--due"]), "");
  });
  test("  until a card carries more than it did then", () => {
    ok(["decide", "--title", "Every page uses the house style", "--why", "w", "--scope", "*"]);
    assert.match(ok(["prune", "--due"]), /^Check-in due \(an open unit's card carries \d+ decisions, over 2\)/);
  });
  test("--keep: not proposed again for that", () => {
    const d = decisions().find((x) => x.id.startsWith("d/docs-first-tonight"))!.id;
    ok(["prune", "--keep", d, "lapse"]);
    hasnt(ok(["prune"]), d);
    assert.equal(ok(["prune", "--due"]), "", "nothing left for the owner");
    f.edit("tracker/project.json", (p) => { delete p.prune_at; delete p.checkin_most; });
    f.edit("tracker/decisions.json", (j) => { delete j.decisions.find((x: D) => x.id === d).kept; });
  });
  test("due after checkin_days days with a run since the last check-in", () => {
    f.edit("tracker/project.json", (p) => { delete p.prune_at; p.checkin_at = ago(24 * 4); });
    assert.equal(ok(["prune", "--due"]), "", "no unit claimed since: no run");
    setup(["claim", "lexer/tokens"]);
    has(ok(["prune", "--due"]), "Check-in due (4 days of runs since the last check-in");
  });
  test("--checked-in: not due again", () => {
    ok(["prune", "--checked-in"]);
    assert.equal(ok(["prune", "--due"]), "");
  });
});

describe("prune --apply-unasked: a lane's own lapsed decisions, never the owner's words", () => {
  let lane = "", overseer = "", out = "";
  test("applies the lane's", () => {
    lane = decide("Skip the slow lexer fuzz tonight", "the run is short", "lexer/*", 40, { FACTORY_ACTOR: "loop", FACTORY_TAG: "lane0001" });
    overseer = decide("Lexer before docs tonight, the owner says", "the owner, in chat", "lexer/*", 40, { FACTORY_ACTOR: "oversee", FACTORY_TAG: "ov000001" });
    out = ok(["prune", "--apply-unasked"]);
    has(out, "Skip the slow lexer fuzz tonight");
  });
  test("  and lists them for the report", () => { has(out, "Lapsed without asking (1 lane's own decision, for the report"); });
  test("  it's lapsed", () => { has(ok(["decisions", "--all"]), `${lane}) [lapsed `); });
  test("  the one the overseer recorded stays, for the owner", () => { hasnt(out, overseer); has(ok(["decisions"]), overseer); });
});
