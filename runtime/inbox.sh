#!/usr/bin/env bash
# inbox.sh: a lane's inbox, what the factory says to a session that's already running. It's TypeScript
# (src/inbox.ts; `inbox.sh --help`): this runs it on Node 26, through main.mjs.
exec "${FACTORY_NODE:-node}" "$(dirname "$(realpath "$0")")/main.mjs" inbox "$@"
