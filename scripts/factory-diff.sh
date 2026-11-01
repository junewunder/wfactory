#!/usr/bin/env bash
# factory-diff.sh: whether a factory runs the deployed skill through the current stubs. It's TypeScript
# (runtime/src/stubs.ts; `factory-diff.sh --help`): this runs it on Node 26, through main.mjs.
exec "${FACTORY_NODE:-node}" "$(dirname "$(realpath "$0")")/../runtime/main.mjs" factory-diff "$@"
