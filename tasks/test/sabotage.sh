#!/bin/sh
# sabotage.sh - prove each gate in tasks/test/ can fail: for every gate, one
# unplanted CONTROL run through the same copy path (must be green), then one
# run per plant, each in its own scratch copy of the package (package.sgl +
# tasks/), each checked to have LANDED (the planted file differs from the
# original by exactly the one replaced line) before its verdict is believed.
# A plant must turn its gate red.
#
#   sh tasks/test/sabotage.sh [GATE...]     (default: every gate)
#
# GATES: tree-manifest r2 publish check-site cloudflare-setup no-deletes declarations stage-modes.
# tree-manifest and r2 compare against a game's sh originals: set
# SH_GAME=<a game checkout with scripts/tree-manifest and scripts/test-r2-s3>
# and SH_TREE=<a staged or built tree> for them, or they are SKIPPED (said
# loudly, never counted as passed). Last line is VERDICT; exit 0 only if every
# control was green and every plant went red.
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)          # tasks/
PKG=$(cd "$HERE/.." && pwd)                     # the package root
W=$(mktemp -d "${TMPDIR:-/tmp}/substratic-sabotage.XXXXXX")
trap 'rm -rf "$W"' EXIT
N=0; BAD=0; SKIP=0

copy() { rm -rf "$W/pkg"; mkdir -p "$W/pkg"; cp "$PKG/package.sgl" "$W/pkg/"; cp -r "$HERE" "$W/pkg/tasks"; }

run_gate() {   # gate -> rc; output in $W/out
  T="$W/pkg/tasks"
  case "$1" in
    tree-manifest) (cd /tmp && TASKS="$T" sigil "$T/test/test-tree-manifest.sgl" "$SH_GAME/scripts/tree-manifest" "$SH_TREE") > "$W/out" 2>&1 ;;
    r2) (cd /tmp && sh "$SH_GAME/scripts/test-r2-s3" "$T/test/r2-s3-sigil") > "$W/out" 2>&1 ;;
    publish|check-site) (cd /tmp && TASKS="$T" sigil "$T/test/test-publish.sgl") > "$W/out" 2>&1 ;;
    cloudflare-setup) (cd /tmp && TASKS="$T" sigil "$T/test/test-cloudflare-setup.sgl") > "$W/out" 2>&1 ;;
    no-deletes) (cd /tmp && TASKS="$T" sigil "$T/test/test-no-deletes.sgl") > "$W/out" 2>&1 ;;
    declarations) (cd /tmp && sigil "$T/test/test-declarations.sgl") > "$W/out" 2>&1 ;;
    stage-modes) (cd /tmp && TASKS="$T" sigil "$T/test/test-stage-modes.sgl") > "$W/out" 2>&1 ;;
  esac
}

needs_game() { case "$1" in tree-manifest|r2) [ -n "${SH_GAME:-}" ] && [ -n "${SH_TREE:-}" ] ;; *) true ;; esac; }

control() {    # gate
  N=$((N+1)); copy; run_gate "$1"; rc=$?
  if [ $rc = 0 ]; then echo "PASS control $1: green unplanted ($(tail -1 "$W/out"))"
  else echo "FAIL control $1: rc $rc unplanted: $(tail -1 "$W/out")"; BAD=$((BAD+1)); fi
}

plant() {      # gate name file from to [expect: a FAIL line must contain this]
  N=$((N+1)); copy; F="$W/pkg/tasks/$3"
  awk -v from="$4" -v to="$5" '{ i=index($0, from); if (i && !done) { $0 = substr($0,1,i-1) to substr($0, i+length(from)); done=1 } print }' "$HERE/$3" > "$F"
  D=$(diff "$HERE/$3" "$F" | grep -c '^[<>]')
  if [ "$D" != 2 ]; then echo "FAIL plant $1/$2: DID NOT LAND in $3 (diff lines $D)"; BAD=$((BAD+1)); return; fi
  run_gate "$1"; rc=$?
  if [ $rc = 0 ]; then echo "FAIL plant $1/$2: the gate stayed GREEN with the plant in"; BAD=$((BAD+1))
  elif [ -n "${6:-}" ] && ! grep '^FAIL' "$W/out" | grep -qF -- "$6"; then
    echo "FAIL plant $1/$2: red, but not on the check it targets ('$6'): $(grep -m1 '^FAIL' "$W/out" || tail -1 "$W/out")"; BAD=$((BAD+1))
  else echo "PASS plant $1/$2: red ($(grep -m1 -F -- "${6:-FAIL}" "$W/out" || grep -m1 '^FAIL' "$W/out" || tail -1 "$W/out"))"; fi
}

GATES="${*:-tree-manifest r2 publish check-site cloudflare-setup no-deletes declarations stage-modes}"
for g in $GATES; do
  if ! needs_game "$g"; then echo "SKIPPED $g: set SH_GAME and SH_TREE"; SKIP=$((SKIP+1)); continue; fi
  control "$g"
  case "$g" in
    tree-manifest)
      plant $g unsorted substratic/tasks/manifest.sgl '(values (list-sort string<? files) (reverse odd))' '(values files (reverse odd))'
      plant $g symlinks-accepted substratic/tasks/manifest.sgl '(else (set! odd (cons (path dir r) odd)))' '(else #t)'
      plant $g imports-accepted substratic/tasks/manifest.sgl '(regex-search import-pattern (read-text (path fdir f)))' '#f'
      plant $g no-at-prefix substratic/tasks/manifest.sgl '"  @functions/"' '"  functions/"' ;;
    r2)
      plant $g any-404-is-absent substratic/tasks/r2.sgl '((and (equal? (car res) "404") (equal? (cdr res) "NoSuchKey")) 3)' '((equal? (car res) "404") 3)'
      plant $g token-on-argv substratic/tasks/r2.sgl '-K - ,(str (api-base)' '-H ,(str "Authorization: Bearer " (credential-token cred)) ,(str (api-base)' ;;
    publish)
      plant $g put-on-any-failed-read substratic/tasks/r2.sgl '(else (fail "get" bucket key res))' '(else 3)'
      plant $g no-read-back-compare publish-web.sgl '(unless (ok? ($? cmp -s ,wasm-file ,back))' '(unless #t'
      plant $g no-redaction publish-web.sgl '(log (redact cred (stdout-of r))))' '(log (stdout-of r)))'
      plant $g gate-set-not-compared publish-web.sgl '(unless (equal? (list-sort string<? (map cdr gates)) (list-sort string<? expected))' '(unless #t'
      plant $g wrangler-gets-real-home publish-web.sgl '(cons "HOME" home)' '(cons "HOME_UNUSED" home)'
      plant $g locked-agent-proceeds substratic/tasks/credentials.sgl "(when (eq? state 'locked)" '(when #f' ;;
    check-site)
      plant $g manifest-leg-always-ok check-site.sgl '(manifest-ok (and got (equal? got want)))' '(manifest-ok #t)'
      plant $g noindex-leg-off checks/check-site.mjs 'if (/noindex/.test(r.robots)) noidx++; else bad(' 'if (true) noidx++; else bad('
      plant $g arm-crash-ignored checks/check-site.mjs 'else if (r.status !== 0) { armFailed = true;' 'else if (false) { armFailed = true;'
      plant $g fetched-leg-off checks/check-site.mjs 'asked.has(want) && other.length === 0' 'true' ;;
    cloudflare-setup)
      plant $g replaces-foreign-records cloudflare-setup.sgl '(unless (or (null? existing)' '(unless (or #t (null? existing)'
      plant $g no-deployment-check cloudflare-setup.sgl '(unless (and deploys (> (array-length deploys) 0))' '(unless #t'
      plant $g unknown-bucket-created cloudflare-setup.sgl '((no) (wrangler! "r2" "bucket" "create" bucket)' '((no unknown) (wrangler! "r2" "bucket" "create" bucket)'
      plant $g token-on-argv cloudflare-setup.sgl '-K - ,@verb' '-H ,(str "Authorization: Bearer " (credential-token cred)) ,@verb' ;;
    no-deletes)
      plant $g a-delete-in-publish publish-web.sgl '(say "R2 holds the verified wasm at ~a (read back, identical)" key)' '($? curl -X DELETE ,key) (say "R2 holds the verified wasm at ~a (read back, identical)" key)' ;;
    stage-modes)
      plant $g hook-outputs-unchecked stage-web.sgl '(unless (file? (path dir o)) (refuse "the stage hook wrote no ~a" o))' '#t' 'writes no declared output'
      plant $g untracked-inputs-allowed stage-web.sgl '(unless (null? untracked)' '(unless #t' 'untracked file in the hook'
      plant $g noindex-404-unchecked checks/check-site.mjs '{ n++; bad("indexable", "404.html does not ask not to be indexed"); }' '{ }' '404 that does not ask noindex'
      plant $g staged-dirty-allowed publish-web.sgl '(unless (equal? (manifest-header-ref manifest "clean") "yes")' '(unless #t' 'staged from tracked changes'
      plant $g other-build-allowed publish-web.sgl '(when (and m (not (equal? (match-group m 1) head)))' '(when #f' 'runner build of another commit' ;;
    declarations)
      plant $g unknown-entry-key ../package.sgl 'usage: "DIR")' 'usage: "DIR" requires: (curl))'
      plant $g reserved-name ../package.sgl '(tree-manifest' '(build' ;;
  esac
done
echo "VERDICT: $((N-BAD))/$N controls green and plants red ($SKIP gates SKIPPED)"
# a skipped gate is not a passed one: it counts against the verdict unless
# the caller said skipping is fine (ALLOW_SKIP=1)
[ "$BAD" = 0 ] && { [ "$SKIP" = 0 ] || [ "${ALLOW_SKIP:-0}" = 1 ]; }
