// memory/MEMORY.md is made from the memory files' frontmatter, so two branches
// that each add a memory never clash over the index: `title` (else the name),
// `hook` (else the description) and `open: true` for the Open section.
import fs from "node:fs";
import path from "node:path";
import { ctx } from "../ctx.ts";
import { cap, die, writeAtomic } from "../text.ts";
import { C } from "./registry.ts";

function frontmatter(text: string) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  const fm: Record<string, string> = {};
  if (m) for (const l of m[1].split("\n")) { const kv = l.match(/^([A-Za-z_]+):\s*(.*)$/); if (kv) fm[kv[1]] = kv[2].replace(/^(["'])(.*)\1$/, "$2"); }
  return fm;
}
export function memoryIndex(dir: string) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "MEMORY.md").sort();
  const known: { title: string; line: string }[] = [], open: { title: string; line: string }[] = [];
  for (const f of files) {
    const fm = frontmatter(fs.readFileSync(path.join(dir, f), "utf8"));
    const title = fm.title || cap((fm.name || f.replace(/\.md$/, "")).replace(/[-_]/g, " "));
    const hook = fm.hook || fm.description || "";
    (fm.open === "true" ? open : known).push({ title, line: `- [${title}](${f})${hook ? " — " + hook : ""}` });
  }
  const by = (a: { title: string }, b: { title: string }) => a.title.localeCompare(b.title);
  return ["# Memory index", "", "One line per file: a link and a few words. The fact lives in the file, not here.",
    "Made from each file's frontmatter (`title`, `hook`, `open: true`) by `just memory`; don't edit it by hand.", "",
    ...known.sort(by).map((x) => x.line), ...(known.length ? [""] : []),
    "## Open", "", "Unsettled investigations, one per file with `open: true` and the next step in its hook.",
    "Drop the flag in the session that settles it.", ...(open.length ? [""] : []), ...open.sort(by).map((x) => x.line), ""].join("\n");
}
C.memory = (a) => {
  const dir = path.join(ctx.ROOT, "memory");
  if (!fs.existsSync(dir)) die("no memory/ here");
  const want = memoryIndex(dir), f = path.join(dir, "MEMORY.md");
  const have = fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
  if (a.includes("--check")) { if (have === want) { console.log("memory/MEMORY.md is current"); return 0; } console.error("memory/MEMORY.md is out of date: `just memory` rebuilds it"); return 1; }
  if (have !== want) { writeAtomic(f, want); console.log("rebuilt memory/MEMORY.md"); } else console.log("memory/MEMORY.md is current");
  return 0;
};
