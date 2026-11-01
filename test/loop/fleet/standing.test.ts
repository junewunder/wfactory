// Standing reservations (heavy.ts, `just heavy reserve`): a long-lived service the budget can't
// see otherwise (an editor the owner opened) holds its share while its process or systemd unit
// runs. On a made-up 30G machine with no reserve: the editor reserves 26G, a `just capped` job
// asking 8G waits, and runs once the editor's process exits; the same with a unit, given back at
// once by `just heavy release`; one tied to a unit goes when the unit does, and not when systemd
// can't be asked; reserving a name again replaces it; and two projects' names don't mix.
// Run: node --test test/loop/fleet/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { linuxOnly, has, hasnt, readOr, until, HOST, ROOT, killPid, systemctl, active, cmd, lastLine } from "../../lib/index.ts";
import { fleetFactory } from "./helpers.ts";

const f = fleetFactory("fstanding");
const { F, P, w, bg } = f;
Object.assign(w.env, { FACTORY_CPU_LOCKS: w.at("cpu-standing"), FACTORY_HEAVY_POLL: "0.2" });
const heavy = (args: string[] = []) => w.just(["heavy", ...args], F);
const meminfo = (totalG: number, availG: number) =>
  fs.writeFileSync(w.env.FACTORY_MEMINFO!, `MemTotal:       ${totalG * 1048576} kB\nMemAvailable:   ${availG * 1048576} kB\n`);
const noReserve = () => {
  const mf = path.join(F, "docs/machines.md");
  fs.writeFileSync(mf, readOr(mf).split("\n").map((l) => l.startsWith(`| ${HOST} |`) ? l.replace(/\| [^|]* \| [^|]* \| [^|]* \|$/, "| 99 | 0 | 0 |") : l).join("\n"));
};
// An 8G job that notes it ran (<x>.ran).
const job = (x: string) => bg("just", ["capped", "--name", x, "bash", "-c", `echo ran > ${w.at(`${x}.ran`)}`], { add: { FACTORY_MEM: "8G" } });
const ran = (x: string) => fs.existsSync(w.at(`${x}.ran`));
// Until the job says it waits for memory (iec writes 8G as 8.0G); it hasn't run.
const waitsForMemory = async (c: ReturnType<typeof bg>, x: string) => {
  await until(() => c.out().includes("memory: needs 8.0G") || c.ended(), `${x} waits for memory`);
  assert.ok(!c.ended(), c.out());
  assert.ok(!ran(x), `${x} ran`);
};
const editorUnit = `factory-${P}-editor`;
const startUnit = () => spawnSync("systemd-run", ["--user", "--unit", editorUnit, "--collect", "--quiet", "sleep", "300"], { stdio: "ignore" });

describe("a standing reservation holds its share while its process runs", () => {
  const editor = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
  editor.unref();
  after(() => { killPid(editor.pid!, "SIGKILL"); });
  test("the editor reserves 26G of a 30G budget", () => {
    meminfo(30, 30); noReserve();
    const r = heavy(["reserve", "editor", "26G", "--pid", String(editor.pid)]);
    assert.equal(r.code, 0, r.stdout);
    has(r.stdout, `26G reserved for editor, while pid ${editor.pid} runs`);
  });
  test("  just heavy lists it", () => {
    const h = heavy().stdout;
    has(h, "26G held, 4.0G free");
    has(h, `editor, a standing reservation (${path.basename(F)}, since`);
    has(h, `while pid ${editor.pid} runs, or until \`just heavy release editor\``);
  });
  let c: ReturnType<typeof bg>;
  test("a capped job asking 8G waits", async () => {
    c = job("first");
    await waitsForMemory(c, "first");
    has(c.out(), `held by editor, a standing reservation (26G, while pid ${editor.pid} runs)`);
  });
  test("  until the editor exits: the reservation goes and the job runs", async () => {
    killPid(editor.pid!, "SIGKILL");
    await until(() => ran("first"), "the job runs once the editor has exited");
    assert.equal((await c.end(30)).code, 0);
    has(heavy().stdout, "held by: nothing");
  });
});

describe("one tied to a systemd unit", linuxOnly("a unit systemd runs"), () => {
  after(() => { systemctl("stop", editorUnit); });
  test("the editor's unit reserves 26G", async () => {
    startUnit();
    await until(() => active(`${editorUnit}.service`), "the editor's unit runs");
    const r = heavy(["reserve", "editor", "26G", "--unit", `${editorUnit}.service`]);
    assert.equal(r.code, 0, r.stdout);
  });
  let c: ReturnType<typeof bg>;
  test("a capped job asking 8G waits", async () => {
    c = job("second");
    await waitsForMemory(c, "second");
  });
  test("  reserved again under the same name, it's replaced, not added to", () => {
    assert.equal(heavy(["reserve", "editor", "26g", "--unit", `${editorUnit}.service`]).code, 0);
    const h = heavy().stdout;
    assert.equal(h.split("\n").filter((l) => /^ +[0-9.]+[KMG] +editor, a standing reservation/.test(l)).length, 1, h);
    has(h, "26G held");
  });
  test("  kept when systemd can't be asked", () => {
    fs.mkdirSync(w.at("deafshim"), { recursive: true });
    const real = lastLine(cmd("bash", ["-c", "command -v systemctl"], { cwd: w.top, env: w.env }).stdout);
    fs.writeFileSync(w.at("deafshim/systemctl"), `#!/usr/bin/env bash\ncase "$*" in *" show "*) exit 1 ;; *) exec ${real} "$@" ;; esac\n`, { mode: 0o755 });
    has(w.just(["heavy"], F, { PATH: `${w.at("deafshim")}:${w.env.PATH}` }).stdout, "editor, a standing reservation");
    has(heavy().stdout, "editor, a standing reservation");
  });
  test("  just heavy release frees it at once", async () => {
    const r = heavy(["release", "editor"]);
    assert.equal(r.code, 0, r.stdout);
    await until(() => ran("second"), "the job runs once the reservation is given back");
    assert.equal((await c.end(30)).code, 0);
    assert.ok(active(`${editorUnit}.service`), "the editor still runs");
  });
  test("  a second release says there's none", () => {
    const r = heavy(["release", "editor"]);
    assert.equal(r.code, 1);
    has(r.stdout, "no standing reservation named editor here");
  });
  test("reserved again, it goes when the unit stops", async () => {
    assert.equal(heavy(["reserve", "editor", "26G", "--unit", `${editorUnit}.service`]).code, 0);
    c = job("third");
    await waitsForMemory(c, "third");
    systemctl("stop", editorUnit);
    await until(() => ran("third"), "the job runs once the editor's unit has stopped");
    assert.equal((await c.end(30)).code, 0);
    hasnt(heavy().stdout, "standing");
  });
});

describe("two projects' names don't mix", () => {
  // Project foo's "bar-editor" and project foo-bar's "editor", on the same machine.
  const inProject = (proj: string, args: string[]) => {
    const d = w.at(`projects/${proj}`);
    fs.mkdirSync(d, { recursive: true });
    return cmd(process.execPath, [path.join(ROOT, "runtime/main.mjs"), "heavy", ...args], { cwd: d, env: { ...w.env, PWD: d }, merged: true });
  };
  test("each reserves its own", () => {
    assert.equal(inProject("foo", ["reserve", "bar-editor", "1G", "--pid", String(process.pid)]).code, 0);
    assert.equal(inProject("foo-bar", ["reserve", "editor", "2G", "--pid", String(process.pid)]).code, 0);
    const h = heavy().stdout;
    has(h, "bar-editor, a standing reservation (foo,");
    has(h, "editor, a standing reservation (foo-bar,");
  });
  test("  and one's release leaves the other's", () => {
    assert.equal(inProject("foo-bar", ["release", "editor"]).code, 0);
    const h = heavy().stdout;
    has(h, "bar-editor, a standing reservation (foo,");
    hasnt(h, "(foo-bar,");
    assert.equal(inProject("foo", ["release", "bar-editor"]).code, 0);
  });
});

describe("what it refuses", () => {
  test("nothing to tie it to", () => {
    const r = heavy(["reserve", "editor", "26G"]);
    assert.equal(r.code, 2);
    has(r.stdout, "usage: just heavy reserve");
  });
  test("a process that isn't running", () => {
    const r = heavy(["reserve", "editor", "26G", "--pid", "999999999"]);
    assert.equal(r.code, 1);
    has(r.stdout, "no process 999999999 is running");
  });
  test("a unit that isn't running", () => {
    const r = heavy(["reserve", "editor", "26G", "--unit", `${editorUnit}-none.service`]);
    assert.equal(r.code, 1);
    has(r.stdout, "isn't running");
  });
  test("a size that isn't one", () => {
    const r = heavy(["reserve", "editor", "lots", "--pid", String(process.pid)]);
    assert.equal(r.code, 1);
    has(r.stdout, "not a size");
  });
  test("  and none of them is kept", () => { has(heavy().stdout, "held by: nothing"); });
});
