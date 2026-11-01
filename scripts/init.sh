#!/usr/bin/env bash
# init.sh: lay down the factory layer in a new or existing project. It's TypeScript
# (runtime/src/init.ts; `init.sh --help`): this runs it on Node 26, through main.mjs.
exec "${FACTORY_NODE:-node}" "$(dirname "$(realpath "$0")")/../runtime/main.mjs" init "$@"
