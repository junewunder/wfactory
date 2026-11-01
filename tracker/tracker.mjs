#!/usr/bin/env node
// tracker.mjs: the tracker (main.ts beside it) for callers that run whatever `node` they find.
// A factory whose factory/tracker stub came before the TypeScript tracker runs
// `node <skill>/tracker/tracker.mjs`, and on Debian that node is 18 or 20, which can't run
// TypeScript: ../runtime/launch.mjs runs main.ts on Node 26. A factory's stubs refreshed
// (scripts/to-stubs.sh) run main.ts themselves; once every factory's are, this file can go.
import { launch } from "../runtime/launch.mjs";
await launch(new URL("./main.ts", import.meta.url), "tracker");
