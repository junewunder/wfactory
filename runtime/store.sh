#!/usr/bin/env bash
# store.sh: copy a group's data between this machine and the store, for the loop. It's TypeScript
# (src/store.ts; `store.sh --help`): this runs it on Node 26, through main.mjs.
exec "${FACTORY_NODE:-node}" "$(dirname "$(realpath "$0")")/main.mjs" store "$@"
