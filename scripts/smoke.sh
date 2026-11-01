#!/usr/bin/env bash
# smoke.sh: the install's smoke test, a toy factory of five small units worked by one lane. It's
# TypeScript (runtime/src/smoke.ts; `smoke.sh --help`): this runs it on Node 26, through main.mjs.
exec "${FACTORY_NODE:-node}" "$(dirname "$(realpath "$0")")/../runtime/main.mjs" smoke "$@"
