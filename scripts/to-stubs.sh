#!/usr/bin/env bash
# to-stubs.sh: switch a factory from copies of the loop's scripts to the stubs. It's TypeScript
# (runtime/src/stubs.ts; `to-stubs.sh --help`): this runs it on Node 26, through main.mjs.
exec "${FACTORY_NODE:-node}" "$(dirname "$(realpath "$0")")/../runtime/main.mjs" to-stubs "$@"
