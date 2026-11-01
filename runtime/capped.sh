#!/usr/bin/env bash
# capped.sh: run a command in a memory-capped systemd scope (just capped). It's TypeScript
# (src/capped.ts; `capped.sh --help`): this runs it on Node 26, through main.mjs.
exec "${FACTORY_NODE:-node}" "$(dirname "$(realpath "$0")")/main.mjs" capped "$@"
