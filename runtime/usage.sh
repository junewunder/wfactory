#!/usr/bin/env bash
# usage.sh: how much of the plan's usage is left, from the loop's own transcripts. It's TypeScript
# (src/usage.ts; `usage.sh --help`): this runs it on Node 26, through main.mjs.
exec "${FACTORY_NODE:-node}" "$(dirname "$(realpath "$0")")/main.mjs" usage "$@"
