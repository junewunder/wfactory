#!/bin/bash
# lane-bash.sh <bash arguments…>: the shell a lane session's Bash tool runs (the loop sets
# CLAUDE_CODE_SHELL to it; the CLI only takes a path with "bash" or "zsh" in it). It is plain
# /bin/bash, whatever the owner's own shell is, with two changes:
#
# - Stdin is /dev/null. The CLI gives each command an open stdin that never ends, and adds
#   `< /dev/null` itself only when the command has no heredoc and nothing it takes for a `<`
#   redirect (a quoted `\|<\|` in a grep pattern counts). A stray read, such as `grep pat $d`
#   with an empty $d, then sat out the 10-minute Bash limit; now it reads nothing and ends.
# - No aliases. The CLI takes a snapshot of the shell's setup (it sources ~/.bashrc) and
#   sources it before every command; this puts `unalias -a` in it after the shell's own
#   aliases, so the system's or the owner's (`ls` as eza, `grep` with flags) never reach a
#   session. What the CLI adds after them stays: its `rg` alias where there's no rg, and
#   its functions (the pkill guard).
#
# The PATH is still the owner's: bash's rc files don't build what the owner's shell does
# (cargo from rustup, a pinned Java, pnpm), and lanes start with systemd's bare PATH. So the
# snapshot ends by exporting the PATH the owner's shell ($FACTORY_OWNER_SHELL, else the login
# shell in passwd) sets up interactively, then whatever else the session's PATH has. If that
# shell can't say within 30 seconds, the snapshot keeps bash's PATH and stderr says so.
#
# Commands see SHELL=/bin/bash, not this script, so what they start keeps its stdin.
# Bash rather than TypeScript (docs/goal-ts.md, "Decided"): it is the shell, run for every
# command a session runs.
set -e
export SHELL=/bin/bash
snap=""
for a in "$@"; do
  case $a in SNAPSHOT_FILE=*) snap=${a#SNAPSHOT_FILE=}; snap=${snap%%$'\n'*} ;; esac
done
[ -n "$snap" ] || exec /bin/bash "$@" < /dev/null
# The run that takes the snapshot: let it finish, then drop the shell's aliases, before the
# CLI's own part (from "# Check for rg availability"), or at the end if that isn't there.
rc=0; /bin/bash "$@" < /dev/null || rc=$?
if [ ! -f "$snap" ]; then
  echo "lane-bash.sh: no snapshot at $snap, so the shell's aliases and bash's PATH stay" >&2
  exit "$rc"
fi
awk '!done && /^# Check for rg availability/ { print "unalias -a 2>/dev/null || true"; done = 1 }
     { print } END { if (!done) print "unalias -a 2>/dev/null || true" }' "$snap" > "$snap.tmp" && mv -f "$snap.tmp" "$snap"
own=${FACTORY_OWNER_SHELL:-$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f7)}
# (macOS has no getent: its directory service has the login shell.)
[ -n "$own" ] || own=$(dscl . -read "/Users/$(id -un)" UserShell 2>/dev/null | sed -n 's/^UserShell: //p')
case ${own##*/} in
  ""|lane-bash.sh) path="" ;;
  *) path=$(timeout 30 "$own" -i -c 'printf "\nFACTORY_PATH=%s\n" "$PATH"' < /dev/null 2>/dev/null | sed -n 's/^FACTORY_PATH=//p' | tail -n 1) || true ;;
esac
if [ -n "$path" ]; then
  IFS=: read -ra mine <<< "$PATH"
  for d in "${mine[@]}"; do case ":$path:" in *":$d:"*) ;; *) [ -z "$d" ] || path="$path:$d" ;; esac; done
  printf 'export PATH=%q\n' "$path" >> "$snap"
else
  echo "lane-bash.sh: no PATH from the owner shell (${own:-none found}), so the session has the PATH bash sets up" >&2
fi
exit "$rc"
