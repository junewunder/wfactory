#!/usr/bin/env bash
# loop.sh: run the factory unattended, one fresh headless session per unit. It's TypeScript
# (src/loop.ts; `loop.sh --help`): this runs it on Node 26, through main.mjs.
exec "${FACTORY_NODE:-node}" "$(dirname "$(realpath "$0")")/main.mjs" loop "$@"
