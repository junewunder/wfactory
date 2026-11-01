// Where the machine lacks flock(1) or setsid(1) (macOS), the suites' stand-ins for them (bin/) go
// on PATH, after the system's own folders, for what the tests run to hold a lock as another lane
// would, or to leave a process in a session of its own. The runtime itself never runs either
// (src/os.ts).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), "bin");
const has = (c: string) => (process.env.PATH ?? "").split(":").some((d) => { try { fs.accessSync(path.join(d || ".", c), fs.constants.X_OK); return true; } catch { return false; } });
if (!has("flock") || !has("setsid")) process.env.PATH = `${process.env.PATH ?? ""}:${bin}`;
