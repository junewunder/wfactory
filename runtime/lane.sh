#!/usr/bin/env bash
# lane.sh: the checkout a lane runs in, made on first use. It's TypeScript (src/lane.ts;
# `lane.sh --help`): this runs it on Node 26, through main.mjs.
exec "${FACTORY_NODE:-node}" "$(dirname "$(realpath "$0")")/main.mjs" lane "$@"
