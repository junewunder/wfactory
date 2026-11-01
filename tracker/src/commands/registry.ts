// Every command, by name. Each module in commands/ adds its own (`C.<name> = …`); index.ts
// loads them all.
import type { Commands } from "../types.ts";

export const C: Commands = {};
