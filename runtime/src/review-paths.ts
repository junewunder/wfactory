// The paths a finished unit's Evidence cites, looked up for its landing review (landing.ts hands
// the result to review.ts's reviewPrompt). 22 Nov: a reviewer said a strip folder the Evidence
// cited under work/ didn't exist, because its Glob lists files, not folders, and sent the unit back.
import fs from "node:fs";
import path from "node:path";

// The paths a card's Evidence cites (its "Evidence:" line), each looked up under root (the lane's
// clone, where the review runs) just before the review: a folder, how many entries and when it last
// changed; a file, its size and when; or not there. A word with a slash that isn't a path (a unit's
// id, a branch) is left out when its first part isn't there either, so only a path that would be
// under something that is (work/, the project's folders) or an absolute one is said to be missing.
// One line each, "" when the Evidence cites none. The reviewer has no shell, and its Glob lists
// files, not folders: this is how it knows a cited folder is there.
const MAX_PATHS = 40;
export function evidencePaths(card: string, root = "."): string {
  const lines = card.split("\n"), at = lines.findIndex((l) => /^\s*Evidence:/.test(l));
  if (at < 0) return "";
  let text = lines[at].replace(/^\s*Evidence:/, "");
  for (const l of lines.slice(at + 1)) { if (/^\S/.test(l) || /^ {1,2}[A-Z][\w' -]{0,40}:/.test(l)) break; text += `\n${l}`; }
  const seen = new Set<string>(), out: string[] = [];
  for (let w of text.split(/[\s`'"(),;<>\[\]{}]+/)) {
    w = w.replace(/[.:;,!?]+$/, "").replace(/:\d+(?:[:-]\d+)?$/, "").replace(/(.)\/+$/, "$1");
    if (!w.includes("/") || w.includes("://") || !/^[~\w./@+=-]+$/.test(w) || /^\.*\/*$/.test(w) || seen.has(w)) continue;
    seen.add(w);
    const p = w.startsWith("~/") ? path.join(process.env.HOME ?? "~", w.slice(2)) : path.resolve(root, w);
    let st: fs.Stats | null = null;
    try { st = fs.statSync(p); } catch {}
    if (!st) {
      const first = w.startsWith("/") || w.startsWith("~/") ? "" : w.replace(/^\.\//, "").split("/")[0];
      if (first && !fs.existsSync(path.resolve(root, first))) continue;
      out.push(`- ${w}: not there`);
    } else if (st.isDirectory()) {
      let n = 0; try { n = fs.readdirSync(p).length; } catch {}
      out.push(`- ${w}: a folder, ${n === 1 ? "1 entry" : `${n} entries`}, last changed ${stamp(st.mtime)}`);
    } else out.push(`- ${w}: a file, ${st.size} bytes, last changed ${stamp(st.mtime)}`);
    if (out.length >= MAX_PATHS) break;
  }
  return out.join("\n");
}
const stamp = (d: Date) => { const z = (n: number) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`; };
