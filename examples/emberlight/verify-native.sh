#!/bin/sh
# verify-native.sh [BINARY] - drive Emberlight on the desktop, headless, and
# check what the engine does on a real window:
#
#   open     the window opens at x3 of the 256x144 room (768x432)
#   round    Space starts round 1 (the game says so)
#   report   F2, a typed note, Enter: report.json and screenshot.png land
#            under $XDG_DATA_HOME/emberlight/reports/; the note, the phase and
#            the moth's position are in the JSON; the PNG is 768x432, valid
#            (ImageMagick checks its CRCs) and not blank
#   still    a second report with no input between: the moth has not moved
#            (the control for the next check)
#   move     holding D, then a third report: the moth is further right
#   store    P changes the palette, and the store's palette file says moon
#   discard  F2 then Escape writes nothing and does not quit
#
# Its own Xvfb, its own XDG_DATA_HOME (a fresh directory under /tmp), never
# the real display. One PASS/FAIL line per check, then GREEN or RED (exit 1),
# or SETUP-FAILED (exit 2). Run from examples/emberlight; needs guix.
set -u
BIN="${1:-build/dev/bin/emberlight}"
DISP="${DISP:-:88}"
WORK="$(mktemp -d /tmp/emberlight-verify-native.XXXXXX)"
export XDG_DATA_HOME="$WORK/data"
DATA="$XDG_DATA_HOME/emberlight"
REPORTS="$DATA/reports"
FAILS=0
say() { echo "verify-native: $*"; }
pass() { say "PASS $1"; }
fail() { say "FAIL $1 ($2)"; FAILS=$((FAILS + 1)); }
setup_failed() { say "SETUP-FAILED $*"; cleanup; exit 2; }

XVFB_PID=""; GAME_PID=""
# The PID whose exe ends in $1, whose cmdline carries $2 and whose cwd is $3
# (any, when empty). guix shell execs through wrappers, so $! is not it.
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

guix shell xorg-server -- Xvfb "$DISP" -screen 0 1400x900x24 +extension GLX -nolisten tcp > "$WORK/xvfb.log" 2>&1 &
i=0; until [ -S "/tmp/.X11-unix/X${DISP#:}" ]; do i=$((i + 1)); [ $i -gt 60 ] && setup_failed "Xvfb did not start"; sleep 1; done
XVFB_PID="$(real_pid /bin/Xvfb "Xvfb $DISP" "")"
[ -n "$XVFB_PID" ] || setup_failed "cannot attribute the Xvfb pid"

export DISPLAY="$DISP"
unset WAYLAND_DISPLAY
../../scripts/dev sh -c "cd examples/emberlight && exec $BIN --build verify" > "$WORK/game.log" 2>&1 &
X="guix shell xdotool -- xdotool"
IM="guix shell imagemagick --"
JQ="guix shell jq -- jq"
i=0; XID=""
until [ -n "$XID" ]; do
  XID="$($X search --name "^Emberlight$" 2>/dev/null | head -1)"
  i=$((i + 1)); [ $i -gt 90 ] && { cat "$WORK/game.log"; setup_failed "no window"; }
  sleep 1
done
GAME_PID="$(real_pid /emberlight "--build verify" "$(pwd)")"
sleep 3

geo="$($X getwindowgeometry "$XID" | awk '/Geometry/ {print $2}')"
[ "$geo" = "768x432" ] && pass "open 768x432" || fail open "geometry $geo"

$X windowfocus --sync "$XID" key space
sleep 1
grep -q "emberlight: round 1" "$WORK/game.log" && pass "round (Space started round 1)" || fail round "no round line"

# A report: F2, a note typed slowly (the window polls keys once a frame),
# Enter; waits for report.json and prints the directory.
report() {
  before="$(ls "$REPORTS" 2>/dev/null | wc -l)"
  $X windowfocus --sync "$XID" key F2
  sleep 1
  $X windowfocus --sync "$XID" type --delay 250 "$1"
  $X windowfocus --sync "$XID" key Return
  i=0
  while [ "$(ls "$REPORTS" 2>/dev/null | wc -l)" -le "$before" ] || [ ! -f "$REPORTS/$(ls "$REPORTS" | sort | tail -1)/report.json" ]; do
    i=$((i + 1)); [ $i -gt 30 ] && return 1; sleep 1
  done
  echo "$REPORTS/$(ls "$REPORTS" | sort | tail -1)"
}
mx() { $JQ -r '.location.moth[0]' "$1/report.json"; }

R1="$(report "first")" || fail report "no report.json"
if [ -n "${R1:-}" ]; then
  note="$($JQ -r .note "$R1/report.json")"; phase="$($JQ -r .location.phase "$R1/report.json")"
  [ "$note" = "first" ] && pass "report note" || fail "report note" "note '$note'"
  [ "$phase" = "play" ] && pass "report phase (play)" || fail "report phase" "$phase"
  idn="$($IM identify -regard-warnings -format '%wx%h %[fx:mean]' "$R1/screenshot.png" 2>&1)"
  [ "${idn%% *}" = "768x432" ] && pass "screenshot 768x432, valid" || fail screenshot "identify: $idn"
  awk "BEGIN { exit !(${idn##* } > 0.01) }" && pass "screenshot not blank (mean ${idn##* })" || fail screenshot "mean ${idn##* }"
  sleep 1
  R2="$(report "second")" || fail still "no second report"
  [ -n "${R2:-}" ] && [ "$(mx "$R1")" = "$(mx "$R2")" ] && pass "still (no input, moth at x $(mx "$R1") both times)" || fail still "x $(mx "$R1") then $(mx "${R2:-$R1}")"
  $X windowfocus --sync "$XID" keydown d; sleep 1.5; $X keyup d
  sleep 1
  R3="$(report "third")" || fail move "no third report"
  [ -n "${R3:-}" ] && awk "BEGIN { exit !($(mx "$R3") > $(mx "$R2") + 10) }" && pass "move (D carried the moth from x $(mx "$R2") to $(mx "$R3"))" || fail move "x $(mx "$R2") then $(mx "${R3:-$R2}")"
fi

$X windowfocus --sync "$XID" key p
sleep 1
[ "$(cat "$DATA/palette.sgl" 2>/dev/null)" = "moon" ] && pass "store (P stored palette moon)" || fail store "palette file: '$(cat "$DATA/palette.sgl" 2>/dev/null)'"

n="$(ls "$REPORTS" 2>/dev/null | wc -l)"
$X windowfocus --sync "$XID" key F2
sleep 1
$X windowfocus --sync "$XID" key Escape
sleep 2
[ "$(ls "$REPORTS" 2>/dev/null | wc -l)" -eq "$n" ] && pass "discard writes nothing" || fail discard "a report was written"
[ -n "$GAME_PID" ] && kill -0 "$GAME_PID" 2>/dev/null && pass "discard does not quit" || fail discard "the game is gone"

$IM import -window "$XID" "$WORK/last.png" 2>/dev/null
say "artifacts in $WORK"
if [ "$FAILS" -eq 0 ]; then say GREEN; exit 0; else say "RED ($FAILS)"; exit 1; fi
