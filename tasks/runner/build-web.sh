#!/usr/bin/env bash
# build-web.sh - runs ON AN AZOTH RUNNER, in ~/work, for substratic's
# build-remote task. Fixed text, never generated: every variable part is an
# argument. Ported from the games' build-remote runner script, with the
# game's name and web config as arguments.
#
#   bash remote.sh FULL-SHA SIGIL-VERSION WEB(0|1) RELEASE(0|1) APP WEB-CONFIG
#
# Needs ~/work/src.bundle, ~/work/tests, ~/work/commands, ~/work/outputs.
# Writes ~/work/out/: the logs, web/ (the web build, when WEB=1) and
# web.complete (the full sha, written only after a checked copy), outputs/.
# Exit: 0 all green; 1 a test, a command or an output copy failed; 2 a build
# failed; 125 refused or SETUP-FAILED.
set -uo pipefail
cd "$HOME/work"
FULL=$1; SIGIL_V=$2; WEB=$3; RELEASE=${4:-0}; APP=$5; WEBCFG=$6
case "$APP" in ""|*[!a-z0-9-]*) echo "SETUP-FAILED: bad app name '$APP'"; exit 125 ;; esac
case "$WEBCFG" in ""|*[!a-z0-9-]*) echo "SETUP-FAILED: bad web config '$WEBCFG'"; exit 125 ;; esac
mkdir -p out
t() { date +%s; }
T0=$(t)
echo "remote: runner nproc=$(nproc) load=$(cut -d' ' -f1-3 /proc/loadavg)"
git clone --quiet src.bundle checkout || { echo "SETUP-FAILED: clone"; exit 125; }
git -C checkout checkout --quiet "$FULL" || { echo "SETUP-FAILED: checkout $FULL"; exit 125; }
[ "$(git -C checkout rev-parse HEAD)" = "$FULL" ] || { echo "SETUP-FAILED: checkout is not $FULL"; exit 125; }
"$HOME/.sigil/bin/sigil" cli use "$SIGIL_V" >/dev/null 2>&1 || { echo "SETUP-FAILED: sigil cli use $SIGIL_V"; exit 125; }
export PATH="$HOME/.sigil/bin:$PATH"
# The runner's login environment carries the system profile's header paths;
# zig's stdatomic.h include_next then finds the system C++ stdatomic.h and
# every native C compile fails ('bits/c++config.h' file not found; measured
# at 63cd7d3, every test and the release build). A local shell does not set
# them. Build without them, as sigil's release-build.sh does for its android
# cross build (scripts/dev sets CPATH itself).
echo "remote: inherited include paths: C_INCLUDE_PATH='${C_INCLUDE_PATH:-}' CPLUS_INCLUDE_PATH='${CPLUS_INCLUDE_PATH:-}' CPATH='${CPATH:-}'"
unset C_INCLUDE_PATH CPLUS_INCLUDE_PATH OBJC_INCLUDE_PATH CPATH
echo "remote: sigil $(sigil --version 2>&1 | sed 's/\x1b\[[0-9;]*m//g')"
cd checkout
clean() {  # refuse when the checkout is no longer exactly the commit
  local d; d=$(git status --porcelain --untracked-files=no)
  if [ -n "$d" ]; then
    echo "REFUSED ($1): tracked changes in the runner's checkout:"; printf '%s\n' "$d" | sed 's/^/  /'
    git diff | head -40 | sed 's/^/  | /'
    exit 125
  fi
}
T1=$(t); sigil deps install > ../out/deps.log 2>&1 || { echo "BUILD-FAILED: deps install (out/deps.log)"; tail -20 ../out/deps.log; exit 2; }
clean "after deps install"
T2=$(t); echo "remote: deps install $((T2-T1))s"
guix shell -m manifest.scm -- true > ../out/guix.log 2>&1 || { echo "SETUP-FAILED: guix shell -m manifest.scm (out/guix.log)"; tail -20 ../out/guix.log; exit 125; }
T3=$(t); echo "remote: guix environment $((T3-T2))s"
RC=0
if [ "$WEB" = 1 ]; then
  scripts/dev sigil build --config "$WEBCFG" > ../out/build.log 2>&1; brc=$?
  T4=$(t); echo "remote: web build rc=$brc $((T4-T3))s"
  [ $brc -eq 0 ] || { echo "BUILD-FAILED rc=$brc (out/build.log)"; tail -30 ../out/build.log; exit 2; }
  grep -a -q 'OPTIMIZE' ../out/build.log || { echo "BUILD-FAILED: no OPTIMIZE step in the log (wasm-opt missing?)"; exit 2; }
  clean "after the web build"
  echo "remote: wasm $(stat -c %s "build/web/$APP.wasm") bytes sha256 $(sha256sum "build/web/$APP.wasm" | cut -c1-16)"
fi
while IFS= read -r f; do
  [ -n "$f" ] || continue
  Ta=$(t)
  echo "=== TEST $f"
  scripts/dev sigil test --sgl "$f" < /dev/null 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -E '✓|✗|passed|failed|Error|error:' ; r=${PIPESTATUS[0]}
  echo "=== TEST-RESULT rc=$r $(( $(t) - Ta ))s $f"
  [ $r -eq 0 ] || RC=1
done < ../tests
clean "after the tests"
if [ "$RELEASE" = 1 ]; then
  Tr=$(t); env -u DISPLAY scripts/dev sigil build --config release > ../out/release.log 2>&1; brc=$?
  echo "remote: release build rc=$brc $(( $(t) - Tr ))s"
  [ $brc -eq 0 ] || { echo "BUILD-FAILED rc=$brc (out/release.log)"; tail -30 ../out/release.log; exit 2; }
  clean "after the release build"
  echo "remote: release binary sha256 $(sha256sum "build/release/bin/$APP" | cut -c1-16)"
fi
while IFS= read -r c; do
  [ -n "$c" ] || continue
  Tc=$(t)
  echo "=== COMMAND $APP $c"
  # the arguments split on spaces, as documented, and never glob-expanded
  read -r -a argv <<< "$c"
  env -u DISPLAY scripts/dev "./build/release/bin/$APP" "${argv[@]}" < /dev/null 2>&1; r=$?
  echo "=== COMMAND-RESULT rc=$r $(( $(t) - Tc ))s $c"
  [ $r -eq 0 ] || RC=1
done < ../commands
clean "after the commands"
while IFS= read -r o; do
  [ -n "$o" ] || continue
  if [ ! -e "$o" ]; then echo "remote: output $o: not there"
  elif mkdir -p "../out/outputs/$(dirname "$o")" && cp -r "$o" "../out/outputs/$o"; then echo "remote: output $o"
  else echo "remote: output $o: COPY-FAILED"; RC=1; fi
done < ../outputs
if [ "$WEB" = 1 ]; then
  mkdir -p ../out/web
  if tar -C build/web --exclude=./native --exclude=./bin --exclude=./.sigil-package-cache -cf - . | tar -C ../out/web -xf -; then
    printf '%s\n' "$FULL" > ../out/web.complete
  else
    echo "STAGING-FAILED: could not copy build/web to out/web"; RC=2
  fi
fi
echo "remote: total $(( $(t) - T0 ))s"
exit $RC
