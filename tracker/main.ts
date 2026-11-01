#!/usr/bin/env node
// The tracker CLI: `tracker <command> [args]` (`just <command>` in a factory repo; `tracker
// --help` for the commands). Runs on Node 26, which strips the types; factory/tracker runs it
// with the deployed Node. tracker.mjs beside it is for callers that run whatever node they find.
import module from "node:module";

// Stripping the types of every module costs more than the command itself (the loop runs
// hundreds a night), so Node keeps the result in its compile cache (in the temp folder;
// NODE_COMPILE_CACHE moves it). Turned on before the modules load, hence the import below.
module.enableCompileCache();
const { run } = await import("./src/index.ts");
process.exitCode = run(process.argv.slice(2));
