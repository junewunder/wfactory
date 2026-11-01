# machines.sh: sourced (factory/machines.sh brings it in). machine_rows, machine_get and
# expand_home read docs/machines.md's Lanes table, each one call to the TypeScript
# (src/machines.ts; `main.mjs machines --help`). The runtime's scripts call that themselves.
_wf_main="$(dirname "$(realpath "${BASH_SOURCE[0]}")")/main.mjs"
machine_rows() { "${FACTORY_NODE:-node}" "$_wf_main" machines rows; }
machine_get() { "${FACTORY_NODE:-node}" "$_wf_main" machines get "$@"; }
expand_home() { "${FACTORY_NODE:-node}" "$_wf_main" machines expand-home "$@"; }
