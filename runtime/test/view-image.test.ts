// just view-image: a smaller copy of an image for a session to Read, since a whole one goes into
// context at full size (recipes.ts). Needs ImageMagick for the copies. Run: node --test runtime/test/
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const main = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "main.ts");
const run = (cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env) => spawnSync(process.execPath, [main, "view-image", ...args], { cwd, encoding: "utf8", env });
// ImageMagick 7 is magick; 6 is convert and identify.
const im7 = !spawnSync("magick", ["-version"]).error, im = im7 ? "magick" : "convert";
const magick = im7 || !spawnSync("convert", ["-version"]).error;
const dims = (f: string) => spawnSync(im7 ? "magick" : "identify", [...(im7 ? ["identify"] : []), "-format", "%wx%h", f], { encoding: "utf8" }).stdout;

function inTmp(fn: (d: string) => void) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "wf-view-"));
  try { fn(d); } finally { fs.rmSync(d, { recursive: true, force: true }); }
}

test("view-image: a copy no bigger than --max on its longer side, in runs/view/, and its path", { skip: !magick && "ImageMagick isn't installed" }, () => inTmp((d) => {
  assert.equal(spawnSync(im, ["-size", "4000x2000", "xc:red", path.join(d, "sheet.png")]).status, 0);
  const r = run(d, ["sheet.png"]);
  assert.equal(r.status, 0, r.stderr);
  const m = /^(runs\/view\/sheet-[0-9a-f]{6}-1568\.png) \(1568x784, from 4000x2000\): Read this one\n$/.exec(r.stdout);
  assert.ok(m, r.stdout);
  assert.equal(dims(path.join(d, m[1])), "1568x784");
  assert.match(run(d, ["sheet.png", "--max", "800"]).stdout, /^runs\/view\/sheet-[0-9a-f]{6}-800\.png \(800x400, from 4000x2000\)/);
  assert.match(run(d, ["--max=800", "--", "sheet.png"]).stdout, /^runs\/view\/sheet-[0-9a-f]{6}-800\.png \(800x400/);
  // Another image of the same name, in another folder: a copy of its own.
  fs.mkdirSync(path.join(d, "b"));
  assert.equal(spawnSync(im, ["-size", "100x50", "xc:green", path.join(d, "b", "sheet.png")]).status, 0);
  const other = /^(\S+)/.exec(run(d, ["b/sheet.png"]).stdout)![1];
  assert.notEqual(other, m[1]);
  assert.equal(dims(path.join(d, m[1])), "1568x784");
  // Never bigger: a small image keeps its size.
  assert.equal(spawnSync(im, ["-size", "300x200", "xc:blue", path.join(d, "small.jpg")]).status, 0);
  assert.match(run(d, ["small.jpg"]).stdout, /^runs\/view\/small-[0-9a-f]{6}-1568\.jpg \(300x200, from 300x200\)/);
}));

test("view-image: without ImageMagick, says so and points to the tool list", () => inTmp((d) => {
  fs.writeFileSync(path.join(d, "a.png"), "not really");
  const r = run(d, ["a.png"], { ...process.env, PATH: path.join(d, "no-bin") });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ImageMagick isn't installed on this machine/);
  assert.match(r.stderr, /docs\/tools\.md/);
  assert.ok(!fs.existsSync(path.join(d, "runs")));
}));

test("view-image: refuses a missing file, a bad --max, and two images", () => inTmp((d) => {
  assert.equal(run(d, ["nope.png"]).status, 1);
  assert.equal(run(d, ["a.png", "--max", "big"]).status, 2);
  assert.equal(run(d, ["a.png", "b.png"]).status, 2);
  assert.equal(run(d, []).status, 2);
}));

// ImageMagick 6 has no magick: convert and identify (here IM 7's, called by those names).
test("view-image: with ImageMagick 6's convert and identify", { skip: !im7 && "needs ImageMagick 7 to stand in" }, () => inTmp((d) => {
  const bin = path.join(d, "bin"), real = spawnSync("bash", ["-c", "command -v magick"], { encoding: "utf8" }).stdout.trim();
  fs.mkdirSync(bin);
  for (const t of ["convert", "identify"]) fs.symlinkSync(real, path.join(bin, t));
  assert.equal(spawnSync("magick", ["-size", "2000x1000", "xc:red", path.join(d, "a.png")]).status, 0);
  const r = run(d, ["a.png"], { ...process.env, PATH: bin });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^runs\/view\/a-[0-9a-f]{6}-1568\.png \(1568x784, from 2000x1000\)/);
}));
