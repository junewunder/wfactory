#!/usr/bin/env bash
# profile.sh: the user's wfactory profile (path, new, check, get, machines). It's TypeScript
# (runtime/src/profile.ts; `profile.sh --help`): this runs it on Node 26, through main.mjs.
exec "${FACTORY_NODE:-node}" "$(dirname "$(realpath "$0")")/../runtime/main.mjs" profile "$@"
