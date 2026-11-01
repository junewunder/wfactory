#!/usr/bin/env bash
# long.sh: run a long job detached and memory-capped, and wait on it (just long). It's TypeScript
# (src/long.ts; `long.sh --help`): this runs it on Node 26, through main.mjs.
exec "${FACTORY_NODE:-node}" "$(dirname "$(realpath "$0")")/main.mjs" long "$@"
