#!/usr/bin/env bash
# heavy.sh: the machine's heavy jobs: its memory budget, its heavy-job slots, how jobs ended. It's TypeScript
# (src/heavy.ts; `heavy.sh --help`): this runs it on Node 26, through main.mjs.
exec "${FACTORY_NODE:-node}" "$(dirname "$(realpath "$0")")/main.mjs" heavy "$@"
