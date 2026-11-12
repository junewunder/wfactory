// The fleet's small helpers: lines, files, times as people write them.
import fs from "node:fs";
import { platform } from "./os.ts";
import { ymdHm } from "./sys.ts";

export const lines = (s: string) => s.split("\n").filter((l) => l !== "");
export const cat = (f: string) => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } };
export const gb = (b: number) => `${(b / 2 ** 30).toFixed(1)} GB`;
// $(…): the output without its trailing newlines.
export const chomp = (s: string) => s.replace(/\n+$/, "");
// A stream's lines: without the newline that ends its last.
export const chomp1 = (s: string) => s.replace(/\n$/, "");
export const say = (s: string) => process.stdout.write(s + "\n");

// A time as people write it ("09:00", "tomorrow 9am", "-24 hours"; os.ts, readTime), in epoch
// seconds: null if it can't be read.
export const date = (when: string) => when.replace(/ /g, "") ? platform.readTime(when) : null;
// The same as `date`'s %F %H:%M (2026-10-27 09:00): null if it can't be read.
export const dateHm = (when: string) => { const t = date(when); return t === null ? null : ymdHm(new Date(t * 1000)); };
// A stop time as people write it ("09:00", "9am", "tomorrow 9am"), in epoch seconds: a time of
// day already past today means tomorrow's. "past" for any other time in the past, null for none.
export function timeAt(at: string, now: number): number | "past" | null {
  const t = at !== "now" ? date(at) : null;
  if (t === null) return null;
  if (t > now) return t;
  if (!/^[0-9]{1,2}(:[0-9]{2})? ?(am|pm)?$/.test(at.toLowerCase())) return "past";
  const tm = date(`tomorrow ${at}`) ?? 0;
  return tm > now && tm <= now + 86400 ? tm : "past";
}
export const isDir = (d: string) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } };

// A `question` event's question: the ID its message ends with ("Title (q/slug)"), else null.
export const questionOf = (l: string) => {
  const f = l.split("\t");
  return f[3] === "question" ? /\(([^()\s]+)\)$/.exec(f[4] ?? "")?.[1] ?? null : null;
};
// Event lines with each question told once. The questions file is main's, shared by every lane,
// so every lane logs a question it finds open after its unit that wasn't before it (loop-unit.ts):
// one question asked by any session is a `question` line in each lane's log, on every machine.
// Which lane asked, if any, is no help (an interactive session or the owner's own `just ask` can
// ask while the lanes run), so the overseer, who reads every lane's log, drops the repeats: a
// question line whose question is in `told` or on an earlier line here. The ones kept go into
// `told`. Other lines pass as they are.
export function firstQuestions(ls: string[], told = new Set<string>()): string[] {
  return ls.filter((l) => {
    const q = questionOf(l);
    if (q === null) return true;
    if (told.has(q)) return false;
    told.add(q);
    return true;
  });
}
