#!/usr/bin/env bash
#
# deploy.sh — deploy the wfactory skill on this machine: the copy that
# every factory's stubs in factory/ run (factory/skill).
#
# Only what's pushed gets deployed. The script fetches this repo's main into a
# bare clone, extracts that commit into versions/<commit>/wfactory/ (once
# per commit), and points `current` at it. An
# edit not yet pushed, in a checkout here, never reaches running lanes. A
# running loop keeps the version it started with (factory/skill), so the
# version `current` moves away from is kept for two more days, then deleted.
# Offline, it keeps what's deployed and says so.
#
# It also brings the Node that commit pins (its runtime/node.txt: a version and
# the published SHA-256 of each build for Linux and macOS), downloaded from nodejs.org once
# per version and checked against the pin, into node/. Every stub runs that
# Node, never the system's. A commit whose Node can't be fetched isn't
# deployed: `current` stays, and it says so as if offline. A build that fails
# its checksum is deleted, and the deploy fails. A Node no version uses any more
# is deleted.
#
# A deploy that moves `current` restarts the machine's factory daemon onto it,
# if the daemon runs from this folder (main.mjs daemon --help); the lanes go on.
#
# `just fleet start` runs it (through factory/deploy) on every machine it
# starts. The first stub run on a machine with nothing deployed runs it too,
# from the installed skill.
#
# Layout (FACTORY_DEPLOY, default ~/.local/share/wfactory):
#   repo.git/                   a bare clone of this repo
#   source                      where it fetches from
#   versions/<commit>/wfactory/
#   versions/<commit>/node -> ../../node/v<version>-<os>-<arch>
#   node/v<version>-<os>-<arch>/    the Node build (bin/node): linux or darwin, x64 or arm64
#   current -> versions/<commit>
#
# Usage:
#   scripts/deploy.sh            deploy the newest pushed commit; print what changed
#   scripts/deploy.sh --status   print what's deployed, and do nothing else
#
# Environment: FACTORY_DEPLOY (the folder), FACTORY_SKILL_REPO (where to fetch
# from; default: the last source used, else the origin of the checkout this
# script is in, else the project's own URL below), FACTORY_SKILL_BRANCH
# (default main), FACTORY_NODE_DIST (where Node builds are downloaded from;
# default https://nodejs.org/dist).
#
# It runs on macOS's bash 3.2, which has no flock(1): the lock is then perl's.
#
set -euo pipefail
SELF="$(realpath "$0")"
case "${1:-}" in -h|--help) sed -n '2,/^set -e/p' "$SELF" | sed '$d; s/^# \{0,1\}//'; exit 0 ;; esac
D=${FACTORY_DEPLOY:-$HOME/.local/share/wfactory}
# Where the project lives, for a machine whose copy isn't a git checkout.
PROJECT_URL=https://github.com/junewunder/wfactory
BRANCH=${FACTORY_SKILL_BRANCH:-main}
NODE_DIST=${FACTORY_NODE_DIST:-https://nodejs.org/dist}

if [ "${1:-}" = --status ]; then
  c=$(readlink "$D/current" 2>/dev/null || true)
  [ -n "$c" ] && echo "deployed: ${c#versions/}" || echo "nothing deployed in $D"
  exit 0
fi

# A link renamed over another in one step: GNU mv's -T, macOS's -h. (A folder is only ever moved
# to where nothing is, which plain mv does on both.)
case $(uname -s) in Darwin) os=darwin; mvlink() { mv -h "$1" "$2"; } ;; *) os=linux; mvlink() { mv -T "$1" "$2"; } ;; esac

# A file's SHA-256 (older macOS has shasum only).
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }

mkdir -p "$D/versions"
# The lock is held on descriptor 9 until the script exits; flock(1) and perl's flock(2) take the
# same lock, and it stays the open file's when they exit.
exec 9>"$D/lock"
if command -v flock >/dev/null; then flock -w 300 9; else
  perl -e 'use Fcntl ":flock"; open(my $f, ">&=", 9) or exit 1; $SIG{ALRM} = sub { exit 1 }; alarm(300); flock($f, LOCK_EX) or exit 1'
fi || { echo "deploy: another deploy here is still running"; exit 2; }

src=${FACTORY_SKILL_REPO:-}
[ -n "$src" ] || src=$(cat "$D/source" 2>/dev/null || true)
# The origin of the checkout this script is in: only if it really is this repo's (a deployed
# copy has no .git, and the folder above it may be some other repo).
top=$(git -C "$(dirname "$SELF")" rev-parse --show-toplevel 2>/dev/null || true)
if [ -z "$src" ] && [ -n "$top" ] && [ "$top/scripts/deploy.sh" -ef "$SELF" ]; then
  src=$(git -C "$top" remote get-url origin 2>/dev/null || true)
fi
[ -n "$src" ] || src=$PROJECT_URL

if [ ! -d "$D/repo.git" ]; then
  git clone -q --bare "$src" "$D/repo.git.new" && mv "$D/repo.git.new" "$D/repo.git" \
    || { rm -rf "$D/repo.git.new"; echo "deploy: couldn't clone $src" >&2; exit 2; }
fi
echo "$src" > "$D/source"
note=""
git --git-dir="$D/repo.git" fetch -q "$src" "+refs/heads/$BRANCH:refs/heads/$BRANCH" 2>/dev/null \
  || note="; couldn't reach $src, so this is the last commit fetched"
sha=$(git --git-dir="$D/repo.git" rev-parse --short=12 "refs/heads/$BRANCH")
old=$(readlink "$D/current" 2>/dev/null || true)

# The Node this commit pins, fetched once per version. Not fetched: nothing of this commit is
# deployed, and an older one stays current.
nodedir=""
pin=$(git --git-dir="$D/repo.git" show "$sha:runtime/node.txt" 2>/dev/null || true)
if [ -n "$pin" ]; then
  case $(uname -m) in x86_64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; *) echo "deploy: no Node build for $(uname -m) in runtime/node.txt" >&2; exit 2 ;; esac
  nv=$(awk '$1 == "version" { print $2 }' <<<"$pin")
  sum=$(awk -v k="$os-$arch" '$1 == k { print $2 }' <<<"$pin")
  [ -n "$nv" ] && [ -n "$sum" ] || { echo "deploy: runtime/node.txt in $sha names no Node for $os-$arch" >&2; exit 2; }
  nodedir="v$nv-$os-$arch"
  if [ ! -x "$D/node/$nodedir/bin/node" ]; then
    mkdir -p "$D/node"; t=$(mktemp -d "$D/node/.new-XXXXXX")
    url="$NODE_DIST/v$nv/node-$nodedir.tar.gz"
    if ! curl -fsSL --connect-timeout 20 --max-time 900 -o "$t/node.tar.gz" "$url"; then
      rm -rf "$t"
      [ -n "$old" ] && [ "$old" != "versions/$sha" ] || { echo "deploy: couldn't reach $url, so Node $nv isn't here for $sha" >&2; exit 2; }
      echo "up to date (${old#versions/}); couldn't reach $url for Node $nv, so $sha isn't deployed"
      exit 0
    fi
    if [ "$(sha256 "$t/node.tar.gz")" != "$sum" ]; then
      rm -rf "$t"; echo "deploy: Node $nv from $url doesn't match its checksum in runtime/node.txt; deleted it, nothing deployed" >&2; exit 2
    fi
    mkdir "$t/x" && tar -xzf "$t/node.tar.gz" -C "$t/x" --strip-components=1 && [ -x "$t/x/bin/node" ] \
      || { rm -rf "$t"; echo "deploy: couldn't unpack Node $nv" >&2; exit 2; }
    rm -rf "$D/node/$nodedir"; mv "$t/x" "$D/node/$nodedir"; rm -rf "$t"
  fi
fi

if [ ! -d "$D/versions/$sha/wfactory" ]; then
  t=$(mktemp -d "$D/versions/.new-XXXXXX")
  git --git-dir="$D/repo.git" archive --prefix=wfactory/ "$sha" | tar -x -C "$t" \
    || { rm -rf "$t"; echo "deploy: couldn't extract $sha" >&2; exit 2; }
  rm -rf "$D/versions/$sha"; mv "$t" "$D/versions/$sha"
fi
[ -z "$nodedir" ] || [ "$(readlink "$D/versions/$sha/node" 2>/dev/null)" = "../../node/$nodedir" ] \
  || { ln -sfn "../../node/$nodedir" "$D/versions/$sha/node.new" && mvlink "$D/versions/$sha/node.new" "$D/versions/$sha/node"; }

if [ "$old" != "versions/$sha" ]; then
  ln -sfn "versions/$sha" "$D/current.new" && mvlink "$D/current.new" "$D/current"
  [ -z "$old" ] || [ ! -d "$D/$old" ] || touch "$D/$old/.retired"
  msg="deployed $sha${old:+ (was ${old#versions/})}"
else
  msg="up to date ($sha)"
fi
# Versions retired over two days ago, unless a process still runs one (a long loop, a long job:
# their FACTORY_SKILL names it). macOS shows no process's variables, so there it's one whose
# command line names it (a loop's main.mjs, a job's supervisor: runtime/src/os/darwin-job.ts),
# or the user's crontab, whose lines for the daemon's service run the supervisor of the copy
# that wrote them.
running() {
  if [ "$os" = linux ]; then grep -qsF "FACTORY_SKILL=$1/" /proc/[0-9]*/environ 2>/dev/null
  else
    # (Read first: a grep reading ps would see its own command line, which names the version.
    # ps failing keeps them all.)
    local a c; a=$(ps -axww -o args= 2>/dev/null) || return 0
    # (Only "no crontab" means none; one that can't be read keeps them all too.)
    c=$(crontab -l 2>&1) || case $c in *"no crontab"*) c="" ;; *) return 0 ;; esac
    case "$a
$c" in *"$1/"*) return 0 ;; *) return 1 ;; esac
  fi
}
for v in "$D"/versions/*/; do
  v=${v%/}
  [ -f "$v/.retired" ] && [ -n "$(find "$v/.retired" -mmin +2880)" ] && ! [ "$v" -ef "$D/current" ] || continue
  if running "$(readlink -f "$v")"; then continue; fi
  rm -rf "$v"
done
# Node builds no version links to any more.
for n in "$D"/node/v*/; do
  n=${n%/}; [ -d "$n" ] || continue
  for l in "$D"/versions/*/node; do [ "$(readlink "$l")" != "../../node/${n##*/}" ] || continue 2; done
  rm -rf "$n"
done
rm -rf "$D"/versions/.new-* "$D"/node/.new-* 2>/dev/null || true
# The machine's daemon, if it runs from this folder, restarts onto the new copy at once; the lanes
# are units of their own, and keep the copy each started with. (Not handed the lock: macOS's
# daemon is started from here, and would hold it for as long as it runs.)
said=""
if [ "$old" != "versions/$sha" ] && [ -f "$D/current/wfactory/runtime/main.mjs" ] && [ -x "$D/current/node/bin/node" ]; then
  said=$(FACTORY_DEPLOY="$D" "$D/current/node/bin/node" "$D/current/wfactory/runtime/main.mjs" daemon redeployed 2>/dev/null 9>&- || true)
fi
echo "$msg$note${said:+; $said}"
