#!/usr/bin/env bash
# capped-step.sh <command…>: the step `just capped` (src/capped.ts) runs inside the memory-capped
# scope, around the command. Once the command ends, the scope's cgroup still holds the kernel's
# counts (oom: times the scope reached its cap; oom_kill: its processes killed by any
# out-of-memory kill, the machine's too) and the peak, and this appends them to
# $FACTORY_CAPPED_STATE, then "done".
#
# For now, the one piece of runtime logic left in bash (docs/goal-ts.md, "Decided"): whatever
# runs here counts against the job's cap, and Node needs about 15 MB of it, bash almost none.
# Builtins only: after a kill the scope may still be full (a tmpfs), and a fork can fail.
set +e; "$@"; rc=$?
{
  cg=""; while IFS= read -r l; do [ "${l#0::}" = "$l" ] || cg=${l#0::}; done < /proc/self/cgroup
  while read -r k v; do case $k in oom|oom_kill) echo "$k $v" ;; esac; done < "/sys/fs/cgroup$cg/memory.events"
  read -r v < "/sys/fs/cgroup$cg/memory.peak" && echo "peak $v"
  echo done   # last: the step can itself be killed partway, while the scope is still full
} >> "${FACTORY_CAPPED_STATE:-/dev/null}" 2>/dev/null
exit "$rc"
