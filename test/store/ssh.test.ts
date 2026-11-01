// A store over ssh (a host:path remote): the ssh the store runs (a fake here, running rsync's other
// end locally) gets BatchMode and a keepalive; a refusal or a stall fails the copy, never hangs it.
// Run: node --test test/store/
// Setup goes before a test's checks (or in an after() hook), so a failing check can't skip it.
import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { has, readOr, chomp, killPid } from "../lib/index.ts";
import { storeFactory } from "./factory.ts";

const f = storeFactory(["a", "b"]);
const { store, stamp, leases, st, write, group } = f;
const [a, b] = f.lanes;
const W = f.w.top, args = f.w.at("ssh.args"), stalled = f.w.at("ssh.stalled");
fs.mkdirSync(f.w.at("sshbin"));
fs.writeFileSync(f.w.at("sshbin/ssh"), `#!/usr/bin/env bash
echo "$*" >> "${args}"
case \${FAKESSH:-} in
  refuse) echo "Permission denied (publickey)." >&2; exit 255 ;;
  stall) echo $$ >> "${stalled}"; exec sleep 20 ;;
esac
while [ "\${1#-}" != "$1" ]; do [ "$1" = -o ] && shift; shift; done
shift; cd "${W}" && exec sh -c "$*"
`, { mode: 0o755 });
// store.sh in a lane, over the fake ssh to localhost:store (the store, under the workspace).
const sshat = (l: typeof a, cmdArgs: string[], env: NodeJS.ProcessEnv = {}) =>
  store(l, cmdArgs, { RSYNC_RSH: undefined, PATH: `${f.w.at("sshbin")}:${f.w.env.PATH}`, FACTORY_STORE: "localhost:store", ...env });
const cat = (file: string) => chomp(readOr(file));
group("s3"); group("sd8");
after(() => { for (const p of readOr(stalled).split("\n").filter(Boolean)) killPid(p, "SIGKILL"); });

describe("a store over ssh", () => {
  test("a copy back over ssh", () => {
    a.setup(["lease", "take", "s3"]);
    write(a.at("work/out/s3/s.txt"), "over ssh\n");
    const rc = sshat(a, ["up", "s3", "s3/x", "c"]).code;
    assert.equal(`${rc} ${cat(st("groups/s3/out/s.txt"))} ${stamp("s3")}`, "0 over ssh s3/x");
  });
  test("  ssh never asks for a password", () => { has(readOr(args), "-o BatchMode=yes"); });
  test("  and gives up on a store that stops answering", () => { has(readOr(args), "-o ServerAliveInterval=15 -o ServerAliveCountMax=4"); });
  test("  or never answers", () => { has(readOr(args), "-o ConnectTimeout=20"); });
  test("  and a copy down", () => {
    a.setup(["lease", "release", "s3"]);
    b.setup(["lease", "take", "s3"]);
    const rc = sshat(b, ["take", "s3", "--new"]).code;
    assert.equal(`${rc} ${cat(b.at("work/out/s3/s.txt"))}`, "0 over ssh");
  });
  test("  status reads the store over it", () => { has(sshat(b, ["status"]).stdout, "s3\t0 MB\tcurrent, leased here"); });
});

describe("ssh refused", () => {
  const refuse = { FAKESSH: "refuse" };
  test("ssh refused: the copy back fails", () => {
    write(b.at("work/out/s3/b.txt"), "b's work\n");
    assert.equal(sshat(b, ["up", "s3", "s3/y", "c"], refuse).code, 2);
  });
  test("  marked unsent, nothing stamped", () => {
    assert.ok(fs.existsSync(b.at("work/.store/groups/s3.unsent")), "not marked unsent");
    assert.equal(stamp("s3"), "s3/x");
  });
  test("  status calls the store unreachable", () => { has(sshat(b, ["status"], refuse).stdout, "s3\t0 MB\tnot current"); });
  test("  a copy down fails too", () => { assert.equal(sshat(b, ["take", "s3", "--new"], refuse).code, 2); });
  test("    leaving the copy here alone", () => { assert.ok(fs.existsSync(b.at("work/out/s3/b.txt"))); });
  test("  the lanes stopping keep the lease", () => {
    sshat(b, ["leave"], refuse);
    has(leases(), "s3=b");
  });
  let seed = { code: 0, stdout: "" };
  test("  a seed over a refusing ssh fails", () => {
    fs.mkdirSync(st("pool/sd8/out"), { recursive: true }); fs.mkdirSync(st("pool/sd8/mod"), { recursive: true });
    const r = b.run("factory/store.sh", ["seed", "sd8", "--from", "pool/sd8"], { RSYNC_RSH: undefined, PATH: `${f.w.at("sshbin")}:${f.w.env.PATH}`, FACTORY_STORE: "localhost:store", ...refuse });
    seed = { code: r.code, stdout: r.stdout };
    assert.equal(seed.code, 2);
  });
  test("    saying it can't read the store", () => { has(seed.stdout, "can't read the store"); });
});

describe("a store that stalls", () => {
  const stall = { FAKESSH: "stall", FACTORY_STORE_TIMEOUT: "2" };
  let took = 0;
  test("a store that stalls: the copy down fails", () => {
    const t0 = Date.now();
    const rc = sshat(b, ["take", "s3", "--new"], stall).code;
    took = (Date.now() - t0) / 1000;
    assert.equal(rc, 2);
  });
  test("  after the I/O timeout, not the stall", () => { assert.ok(took < 15, `${took} s`); });
  test("  so does a copy back, as soon", () => {
    const t0 = Date.now();
    const rc = sshat(b, ["up", "s3", "s3/y", "c"], stall).code;
    const s = (Date.now() - t0) / 1000;
    assert.ok(rc !== 0 && s < 15, `rc ${rc}, ${s} s`);
  });
  test("  the store back, the lanes stopping copy back", () => {
    assert.equal(sshat(b, ["leave"]).code, 0);
    assert.equal(stamp("s3"), "s3/y");
  });
  test("    and release the lease", () => { assert.ok(!leases().includes("s3=")); });
});

f.notBroken();
