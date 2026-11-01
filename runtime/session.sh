# session.sh: sourced (a test brings it in). mem_snap and limit_hit, each one call to the
# TypeScript (src/session.ts; `main.mjs session --help`). The loop calls that itself.
_wf_main="$(dirname "$(realpath "${BASH_SOURCE[0]}")")/main.mjs"
mem_snap() { "${FACTORY_NODE:-node}" "$_wf_main" session mem-snap "$@"; }
limit_hit() { "${FACTORY_NODE:-node}" "$_wf_main" session limit-hit "$@"; }
