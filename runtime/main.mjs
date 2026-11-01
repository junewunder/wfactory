#!/usr/bin/env node
// main.mjs: the runtime's commands (main.ts beside it) on Node 26, from any node (launch.mjs).
import { launch } from "./launch.mjs";
await launch(new URL("./main.ts", import.meta.url), "factory");
