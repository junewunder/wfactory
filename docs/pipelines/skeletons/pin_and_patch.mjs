// The pin and patch shape: fetch, pin, patch, verify. An upstream file pinned by hash, plus a
// committed recipe of changes.
//
// A skeleton to copy into a factory once and then own (docs/pipelines/README.md).
//   node pin_and_patch.mjs build <id> <out dir>   apply patches/<id>/recipe.json
//   node pin_and_patch.mjs check <id> <file>      is <file> exactly what the recipe makes?
//
// patches/<id>/recipe.json (in git, one folder per entry):
//   { "source": { "path": "inputs/<id>.bin", "sha256": "…" },
//     "why": "what the patch fixes, in a line",
//     "ops": [ { "op": "replace", "at": 1234, "from": "0a0b", "to": "0c0d" },
//              { "op": "bsdiff", "file": "fix.bsdiff" } ] }
// The source is fetched into inputs/ (not in git) by its own step.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

// The one layer of polymorphism: the kinds of change, one function each, keyed
// by `op`. A new entry never adds code here; a new kind of change adds one op.
const OPS = {
  // Same-length bytes at an offset, refused unless the old bytes are there.
  replace(buf, op) {
    const from = Buffer.from(op.from, "hex"), to = Buffer.from(op.to, "hex");
    if (from.length !== to.length) throw new Error(`replace at ${op.at}: from and to differ in length`);
    if (!buf.subarray(op.at, op.at + from.length).equals(from)) throw new Error(`replace at ${op.at}: the bytes there aren't ${op.from}`);
    to.copy(buf, op.at);
    return buf;
  },
  // The last resort for a fix made in a GUI: a binary delta from the output of
  // the ops before it to the fixed file. It pins that exact output, so an
  // earlier op that changes breaks it, and the drill shows that.
  bsdiff(buf, op, dir) {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), "patch-"));
    fs.writeFileSync(path.join(t, "in"), buf);
    execFileSync("bspatch", [path.join(t, "in"), path.join(t, "out"), path.join(dir, op.file)]);
    const out = fs.readFileSync(path.join(t, "out"));
    fs.rmSync(t, { recursive: true });
    return out;
  },
};

function build(id) {
  const dir = path.join("patches", id);
  const recipe = JSON.parse(fs.readFileSync(path.join(dir, "recipe.json"), "utf8"));
  let buf = fs.readFileSync(recipe.source.path);
  // A recipe applies only to the exact file it was made against.
  const got = sha256(buf);
  if (got !== recipe.source.sha256) throw new Error(`${id}: ${recipe.source.path} is ${got}, the recipe pins ${recipe.source.sha256}`);
  for (const op of recipe.ops) {
    if (!OPS[op.op]) throw new Error(`${id}: no op '${op.op}' (known: ${Object.keys(OPS).join(", ")})`);
    buf = OPS[op.op](buf, op, dir);
  }
  return buf;
}

const [cmd, id, arg] = process.argv.slice(2);
if (cmd === "build") {
  const buf = build(id);
  fs.mkdirSync(arg, { recursive: true });
  const name = path.basename(JSON.parse(fs.readFileSync(path.join("patches", id, "recipe.json"), "utf8")).source.path);
  fs.writeFileSync(path.join(arg, name), buf);
  // The run record `just rebuildable` reads: which recipe made which file, and its hash.
  fs.writeFileSync(path.join(arg, `${name}.made.json`), JSON.stringify({ recipe: id, sha256: sha256(buf) }) + "\n");
} else if (cmd === "check") {
  // What `just rebuildable` asks of an installed or shipped copy.
  const want = sha256(build(id)), have = sha256(fs.readFileSync(arg));
  if (want !== have) {
    console.error(`${arg}: not what patches/${id} makes (a change made by hand? put it in the recipe)`);
    process.exit(1);
  }
} else {
  console.error("usage: pin_and_patch.mjs build <id> <out dir> | check <id> <file>");
  process.exit(2);
}
