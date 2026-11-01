// The shell scripts the fleet runs on a machine, here or over ssh (each runs in that machine's
// shell, so it stays a script), and the overseer's journal they read there.
import { SSH_OPTS } from "../../tracker/src/net.ts";

// git that reaches origin, bounded as tracker/src/net.ts bounds the tracker's and landing's: on a
// dead connection ssh's defaults wait forever, and the fleet's start waits with them. ssh gets
// net.ts's connect timeout and keepalives after the project's own command (GIT_SSH_COMMAND, else
// core.sshCommand, else ssh; one that isn't OpenSSH's is left as it is), and git a timeout(1)
// as the backstop (FACTORY_GIT_TIMEOUT seconds, else 300), which kills its ssh with it. Takes
// git's arguments (-C <dir> first, if any); a command that timed out says so and exits 124. It
// runs in a subshell, so its variables don't reach the script around it.
export const NETGIT = `netgit() (
    d=.; [ "$1" != -C ] || d=$2
    b=\${GIT_SSH_COMMAND:-$(git -C "$d" config core.sshCommand 2>/dev/null)}
    [ -n "$b" ] || [ -z "\${GIT_SSH:-}" ] || b="'$GIT_SSH'"
    p=$(printf '%s' "\${b:-ssh}" | sed -e "s/^'\\([^']*\\)'.*/\\1/" -e t -e 's/[[:space:]].*//' -e "s/[\\"']//g" | sed 's|.*/||')
    s=\${FACTORY_GIT_TIMEOUT:-300}; t=; to=$(command -v timeout || command -v gtimeout)
    if [ -n "$to" ]; then t="$to -k 10 $s"; if [ -t 0 ] || [ -t 2 ]; then t="$to --foreground -k 10 $s"; fi; fi
    case $p in
      ssh|ssh.exe) GIT_SSH_COMMAND="\${b:-ssh} ${SSH_OPTS}" $t git "$@" ;;
      *) $t git "$@" ;;
    esac
    r=$?; [ $r -ne 124 ] || echo "git: no answer from the remote in $s s; gave up" >&2; exit $r
  )
`;
// The skill on a machine: the checkout Claude reads (~/.claude/skills/wfactory), pulled
// when it's clean and on its main. It runs there, so it's a script that machine's shell runs.
export const PULL_SKILL = `${NETGIT}    d=$(readlink -f "\${FACTORY_SKILL_CHECKOUT:-$HOME/.claude/skills/wfactory}" 2>/dev/null)
    top=$(git -C "$d" rev-parse --show-toplevel 2>/dev/null) || { echo "not a git checkout ($d): not updated"; exit 0; }
    b=$(git -C "$top" rev-parse --abbrev-ref HEAD); was=$(git -C "$top" rev-parse --short HEAD)
    case $b in main|master) ;; *) echo "on branch $b in $top: not updated"; exit 0 ;; esac
    [ -z "$(git -C "$top" status --porcelain -uno)" ] || { echo "$top has changes: not updated"; exit 0; }
    netgit -C "$top" pull -q --ff-only 2>/dev/null || { echo "$top could not fast-forward (offline, or commits origin lacks): not updated"; exit 0; }
    now=$(git -C "$top" rev-parse --short HEAD)
    [ "$was" = "$now" ] && echo "up to date ($now)" || echo "updated $was → $now"
  `;
// Then the deploy, by that (just pulled) checkout's deploy.sh: not through the factory's stub,
// which a remote checkout may not have yet.
export const DEPLOY = `"\${FACTORY_SKILL_CHECKOUT:-$HOME/.claude/skills/wfactory}/scripts/deploy.sh"`;
// The checkout itself stays on main for the owner and the overseer: brought up to date if it's clean.
export const PULL_CHECKOUT = `${NETGIT}[ "$(git rev-parse --abbrev-ref HEAD)" = main ] && [ -z "$(git status --porcelain -uno)" ] && netgit pull -q --ff-only origin main`;
// The lane's clone runs the loop as it is on origin's main.
export const PULL_LANE = `${NETGIT}netgit fetch -q origin main && { [ "$(git rev-parse --abbrev-ref HEAD)" != main ] || git merge -q --ff-only FETCH_HEAD; } 2>/dev/null`;
// The overseer's journal on the machine it runs on: date, machine, overseer, what it noted.
export const JOURNAL = "runs/oversee.log";
// A lane's last loop line, and whether a restart waits for its unit to end. (A start's header
// line counts: the last run's stop isn't this one's.)
// Then the running session's transcript, if one runs: this machine's clock, when the transcript
// was last written, and its name (runs/<started>-<tag>.jsonl).
export const LAST_LINE = `grep -E " loop: |^==== " runs/loop.log 2>/dev/null | grep -vE "loop:   |sync: |loop: (git|tracker): " | tail -1; [ ! -f runs/.restart ] || echo RESTART
  c=runs/inbox/current; if [ -f "$c/tag" ]; then t=$(cat "$c/tag"); for f in runs/*-"$t".jsonl; do [ -f "$f" ] && echo "SESSION $(date +%s) $(if [ "$(uname)" = Darwin ]; then stat -f %m "$f"; else stat -c %Y "$f"; fi) \${f#runs/}"; done; fi; true`;
// The machines file may give the checkout as ~/…: expanded there, not here.
export const TIDY_LANE = `d=$0; case $d in "~/"*) d=$HOME/\${d#"~/"} ;; "~") d=$HOME ;; esac; [ ! -d "$d" ] || (cd "$d" && factory/oversee.sh tidy $1)`;
// The lane clones beside a checkout, and one removed once it's no lane's (past the machines file's
// count): only when no loop runs in it (its runs/.loop.lock, which every loop there holds), the
// daemon has no record of a lane there (one to start again, or bring back), and it
// holds nothing committed, changed or stashed that origin lacks. Its runs/ (logs, transcripts) and
// what git ignores there go with it.
export const CLONES = `for c in "$PWD"-lane*; do [ -d "$c/.git" ] && echo "$c"; done; true`;
// flock -n 9 in a shell, where there's no flock(1) (macOS) by perl's flock(2) on the same open
// file: the lock stays the shell's when either exits.
export const LOCK9 = `if command -v flock >/dev/null; then flock -n 9; else perl -MFcntl=:flock -e 'open(my $f, ">&=", 9) or exit 1; flock($f, LOCK_EX | LOCK_NB) or exit 1'; fi`;
export const DROP_CLONE = `${NETGIT}c=$0; cd "$c" || exit 0
  mkdir -p runs && exec 9>>runs/.loop.lock && ${LOCK9} || { echo "$c: an orphaned lane clone a loop is running in: left alone"; exit 0; }
  h=\${FACTORY_DAEMON_HOME:-\${XDG_STATE_HOME:-$HOME/.local/state}/wfactory}
  for r in "$h/lanes/factory-$1.json" "$h/lanes/factory-$1-"*.json; do [ ! -e "$r" ] || { echo "$c: an orphaned lane clone the machine's daemon will start a lane in: left alone"; exit 0; }; done
  [ -z "$(git status --porcelain 2>/dev/null)" ] || { echo "$c: an orphaned lane clone with changes of its own: left alone"; exit 0; }
  [ -z "$(git stash list 2>/dev/null)" ] || { echo "$c: an orphaned lane clone with stashed changes: left alone"; exit 0; }
  netgit fetch -q origin 2>/dev/null
  u=$(git for-each-ref --format='%(refname:short)' refs/heads | while read -r b; do [ -z "$(git rev-list -n 1 "$b" --not --remotes=origin 2>/dev/null)" ] || printf '%s ' "$b"; done)
  [ -z "$u" ] || { echo "$c: an orphaned lane clone with commits origin lacks (on $u): left alone"; exit 0; }
  cd .. && rm -rf "$c" && echo "removed $c: an orphaned lane clone (its lane is past docs/machines.md's count)"`;
export const TIDY_MACHINE = `if [ -x factory/tidy ]; then timeout 300 factory/tidy && echo "factory/tidy: done"; else echo "(no factory/tidy here)"; fi`;
