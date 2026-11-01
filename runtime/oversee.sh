#!/usr/bin/env bash
# oversee.sh: run a lane's loop detached, for an overseeing session to watch (just oversee). It's
# TypeScript (src/oversee.ts; `oversee.sh --help`): this runs it on Node 26, through main.mjs.
exec "${FACTORY_NODE:-node}" "$(dirname "$(realpath "$0")")/main.mjs" oversee "$@"
