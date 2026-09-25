#!/bin/sh
# verify-native.sh [BINARY] - drive the desktop demo headless and check
# what the engine does on a real window:
#
#   open     the window opens at x2 of the 320x176 view (640x352)
#   selftest the engine's checks pass inside the binary (--selftest)
#   move     with no key the location line of the readout holds still;
#            holding D changes it
#   report   F2, a typed note, Enter: report.json and screenshot.png land
#            under $XDG_DATA_HOME/substratic-demo/reports/, the note and the
#            location are in the JSON, the PNG is 640x352, valid (ImageMagick
#            checks its CRCs) and not blank
#   discard  F2 then Escape writes nothing and does not quit the game
#
# Its own Xvfb, its own XDG_DATA_HOME (a fresh directory under /tmp), never
# the real display. Prints one PASS/FAIL line per check, then GREEN or RED
# (exit 1), or SETUP-FAILED (exit 2) when the drive could not start.
# Run from examples/demo; needs guix.
set -u
BIN="${1:-build/dev/bin/substratic-demo}"
DISP="${DISP:-:87}"
WORK="$(mktemp -d /tmp/substratic-verify-native.XXXXXX)"
export XDG_DATA_HOME="$WORK/data"
REPORTS="$XDG_DATA_HOME/substratic-demo/reports"
FAILS=0
say() { echo "verify-native: $*"; }
pass() { say "PASS $1"; }
fail() { say "FAIL $1 ($2)"; FAILS=$((FAILS + 1)); }
setup_failed() { say "SETUP-FAILED $*"; cleanup; exit 2; }

XVFB_PID=""; GAME_PID=""
# The PID whose exe ends in $1, whose cmdline carries $2 and whose cwd is
# $3 (any, when empty). guix shell execs through wrappers, so $! is not it.
real_pid() {
  for d in /proc/[0-9]*; do
    p="${d#/proc/}"
    [ "$p" = "$$" ] && continue
    exe="$(readlink "$d/exe" 2>/dev/null || true)"
    case "$exe" in *"$1") ;; *) continue ;; esac
    tr '\0' ' ' < "$d/cmdline" 2>/dev/null | grep -q -- "$2" || continue
    [ -z "$3" ] || [ "$(readlink "$d/cwd" 2>/dev/null)" = "$3" ] || continue
    echo "$p"; return
  done
}
cleanup() {
  for p in $GAME_PID $XVFB_PID; do [ -n "$p" ] && kill "$p" 2>/dev/null; done
}
trap cleanup EXIT

[ -x "$BIN" ] || setup_failed "no binary $BIN"
[ -S "/tmp/.X11-unix/X${DISP#:}" ] && setup_failed "display $DISP is taken"

# selftest first: no window needed
if out="$(env -u DISPLAY -u WAYLAND_DISPLAY "$BIN" --selftest 2>&1)"; then
  echo "$out" | grep -q "DONE platform=desktop pass=14 fail=0 of=14" && pass selftest || fail selftest "$(echo "$out" | tail -1)"
else
  fail selftest "exit $? $(echo "$out" | grep FAIL | head -3 | tr '\n' ' ')"
fi

guix shell xorg-server -- Xvfb "$DISP" -screen 0 1400x900x24 +extension GLX -nolisten tcp > "$WORK/xvfb.log" 2>&1 &
WRAP=$!
i=0; until [ -S "/tmp/.X11-unix/X${DISP#:}" ]; do i=$((i + 1)); [ $i -gt 60 ] && setup_failed "Xvfb did not start"; sleep 1; done
XVFB_PID="$(real_pid /bin/Xvfb "Xvfb $DISP" "")"
[ -n "$XVFB_PID" ] || setup_failed "cannot attribute the Xvfb pid"

export DISPLAY="$DISP"
unset WAYLAND_DISPLAY
../../scripts/dev sh -c "cd examples/demo && exec $BIN --build verify" > "$WORK/game.log" 2>&1 &
GWRAP=$!
X="guix shell xdotool -- xdotool"
IM="guix shell imagemagick --"
i=0; XID=""
until [ -n "$XID" ]; do
  XID="$($X search --name "Substratic demo" 2>/dev/null | head -1)"
  i=$((i + 1)); [ $i -gt 90 ] && { cat "$WORK/game.log"; setup_failed "no window"; }
  sleep 1
done
GAME_PID="$(real_pid /substratic-demo "--build verify" "$(pwd)")"
sleep 3

geo="$($X getwindowgeometry "$XID" | awk '/Geometry/ {print $2}')"
[ "$geo" = "640x352" ] && pass "open 640x352" || fail open "geometry $geo"

# The readout's second line (y 13..20 at text scale 1) is the location:
# region, room, cell, position. The first line carries the tick, which
# changes every frame, so it is left out. Control: with no key held the
# location line holds still; then holding D changes it.
line2() { $IM convert "$1" -crop 640x8+0+13 +repage -format '%#' info:-; }
$X windowfocus --sync "$XID" key F1
sleep 1
$IM import -window "$XID" "$WORK/still-1.png"
sleep 1
$IM import -window "$XID" "$WORK/still-2.png"
[ "$(line2 "$WORK/still-1.png")" = "$(line2 "$WORK/still-2.png")" ] && pass "move control (no key, the location line holds still)" || fail move "the location line changed with no key held"
$X windowfocus --sync "$XID" keydown d; sleep 1.5; $X keyup d
sleep 1
$IM import -window "$XID" "$WORK/after.png"
[ "$(line2 "$WORK/still-2.png")" != "$(line2 "$WORK/after.png")" ] && pass "move (holding D changed the location line)" || fail move "the location line did not change"

# F2, a note, Enter
$X windowfocus --sync "$XID" key F2
sleep 1
$X windowfocus --sync "$XID" type --delay 250 "the gem is stuck"
$X windowfocus --sync "$XID" key Return
t0=$(date +%s)
i=0; until ls "$REPORTS"/*/report.json >/dev/null 2>&1; do i=$((i + 1)); [ $i -gt 90 ] && break; sleep 1; done
say "the save took $(( $(date +%s) - t0 ))s"
sleep 1
dirs="$(ls "$REPORTS" 2>/dev/null | wc -l)"
if [ "$dirs" -eq 1 ]; then
  R="$REPORTS/$(ls "$REPORTS")"
  if [ -f "$R/report.json" ]; then
    note="$(guix shell jq -- jq -r .note "$R/report.json")"
    room="$(guix shell jq -- jq -r .location.room "$R/report.json")"
    [ "$note" = "the gem is stuck" ] && pass "report note" || fail "report note" "note '$note'"
    [ "$room" = "x0y0" ] || [ "$room" = "x1y0" ] && pass "report location ($room)" || fail "report location" "room '$room'"
  else
    fail report "no report.json in $R"
  fi
  if [ -f "$R/screenshot.png" ]; then
    idn="$($IM identify -regard-warnings -format '%wx%h %[fx:mean]' "$R/screenshot.png" 2>&1)"
    size="${idn%% *}"; mean="${idn##* }"
    [ "$size" = "640x352" ] && pass "screenshot 640x352, valid" || fail screenshot "identify: $idn"
    awk "BEGIN { exit !($mean > 0.02) }" && pass "screenshot not blank (mean $mean)" || fail screenshot "mean $mean"
  else
    fail screenshot "no screenshot.png"
  fi
else
  fail report "$dirs report directories under $REPORTS"
fi

# F2 then Escape: nothing written, the game still running
$X windowfocus --sync "$XID" key F2
sleep 1
$X windowfocus --sync "$XID" key Escape
sleep 2
after="$(ls "$REPORTS" 2>/dev/null | wc -l)"
[ "$after" -eq 1 ] && pass "discard writes nothing" || fail discard "$after report directories"
[ -n "$GAME_PID" ] && kill -0 "$GAME_PID" 2>/dev/null && pass "discard does not quit" || fail discard "the game is gone"

say "artifacts in $WORK"
if [ "$FAILS" -eq 0 ]; then say GREEN; exit 0; else say "RED ($FAILS)"; exit 1; fi
