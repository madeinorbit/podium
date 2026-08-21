#!/usr/bin/env bash
# Cross-compile vendored abduco for Darwin from Linux (POD-2501 spike).
# Requires: zig, rcodesign on PATH.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/packages/pty/vendor/abduco/abduco.c"
CROSS="$ROOT/scripts/prebuilt/abduco/cross"
OUT="$ROOT/scripts/prebuilt/abduco"

command -v zig >/dev/null || { echo "need zig on PATH" >&2; exit 1; }
command -v rcodesign >/dev/null || { echo "need rcodesign on PATH" >&2; exit 1; }

mkdir -p "$CROSS" "$OUT/darwin-arm64" "$OUT/darwin-x64"

# zig's Darwin libc headers omit util.h; forkpty/openpty live in libSystem.
cat >"$CROSS/util.h" <<'EOF'
#ifndef PODIUM_SPIKE_DARWIN_UTIL_H
#define PODIUM_SPIKE_DARWIN_UTIL_H
#include <sys/types.h>
#include <termios.h>
#include <sys/ioctl.h>
pid_t forkpty(int *amaster, char *name, struct termios *termp, struct winsize *winp);
int openpty(int *amaster, int *aslave, char *name, struct termios *termp, struct winsize *winp);
int login_tty(int fd);
#endif
EOF

FLAGS=(
  -std=c99
  -D_POSIX_C_SOURCE=200809L
  -D_XOPEN_SOURCE=700
  -D_DARWIN_C_SOURCE
  -DNDEBUG
  -DVERSION='"0.6-podium"'
  -I"$CROSS"
  # Leave Mach-O header room so rcodesign can write the code-signature load command.
  -Wl,-headerpad,0x8000
)

echo "[spike] abduco -> darwin-arm64"
zig cc -target aarch64-macos-none "${FLAGS[@]}" "$SRC" -o "$OUT/darwin-arm64/abduco"
rcodesign sign "$OUT/darwin-arm64/abduco"

echo "[spike] abduco -> darwin-x64"
zig cc -target x86_64-macos-none "${FLAGS[@]}" "$SRC" -o "$OUT/darwin-x64/abduco"
rcodesign sign "$OUT/darwin-x64/abduco"

file "$OUT/darwin-arm64/abduco" "$OUT/darwin-x64/abduco"
ls -la "$OUT/darwin-arm64/abduco" "$OUT/darwin-x64/abduco"
echo "[spike] done"
