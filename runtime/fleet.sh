#!/usr/bin/env bash
# fleet.sh: run and watch every machine's lanes from one overseeing session (just fleet). It's
# TypeScript (src/fleet.ts; `fleet.sh --help`): this runs it on Node 26, through main.mjs.
exec "${FACTORY_NODE:-node}" "$(dirname "$(realpath "$0")")/main.mjs" fleet "$@"
