#!/usr/bin/env bash
# Verify server, daemon, and served-web spawn pins before every runtime cell.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=drive-env.sh
source "$HERE/drive-env.sh"

fail() { echo "REFUSED: $*" >&2; exit 2; }
short="$(git -C "$PODIUM_DRIVE_REPO" rev-parse --short=7 "$POD2920_PIN")"

check_process() {
  local name="$1" pid sha cwd exe
  pid="$(cat "$PODIUM_DRIVE_BASE/$name.pid" 2>/dev/null)" || fail "missing $name pid"
  sha="$(cat "$PODIUM_DRIVE_BASE/$name.sha" 2>/dev/null)" || fail "missing $name spawn sha"
  kill -0 "$pid" 2>/dev/null || fail "$name pid $pid is not alive"
  cwd="$(readlink -f "/proc/$pid/cwd")"
  exe="$(basename "$(readlink -f "/proc/$pid/exe")")"
  [ "$exe" = bun ] || fail "$name pid $pid is $exe, expected bun"
  [ "$cwd" = "$PODIUM_DRIVE_REPO" ] || fail "$name cwd is $cwd"
  [ "$sha" = "$POD2920_PIN" ] || fail "$name spawned at $sha"
  printf '%s\t%s\t%s\t%s\n' "$name" "$pid" "$cwd" "$sha"
}

IFS=$'\t' read -r _ server_pid server_cwd server_sha < <(check_process server)
IFS=$'\t' read -r _ daemon_pid daemon_cwd daemon_sha < <(check_process daemon)
web_sha="$(cat "$PODIUM_DRIVE_BASE/web.sha" 2>/dev/null)" || fail "missing full served-web pin"
[ "$web_sha" = "$POD2920_PIN" ] || fail "served web recorded at $web_sha"

stamp="$(curl -fsS "http://$PODIUM_HOST:$PODIUM_PORT/podium-build.json")" || fail "served web stamp unavailable"
served_short="$(printf '%s' "$stamp" | sed -n 's/.*"sourceSha"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
[ "$served_short" = "$short" ] || fail "served web stamp is $served_short, expected $short"

# Evidence commits may advance HEAD between the two cells. Runtime code may not.
git -C "$PODIUM_DRIVE_REPO" diff --quiet "$POD2920_PIN" HEAD -- apps packages scripts tests \
  || fail "runtime source differs from the exact proof pin"

printf 'PINJSON {"pin":"%s","server":{"pid":%s,"spawnSha":"%s","cwd":"%s"},"daemon":{"pid":%s,"spawnSha":"%s","cwd":"%s"},"servedWeb":{"spawnSourceSha":"%s","servedStamp":"%s"},"instance":"%s"}\n' \
  "$POD2920_PIN" "$server_pid" "$server_sha" "$server_cwd" "$daemon_pid" "$daemon_sha" "$daemon_cwd" "$web_sha" "$served_short" "$PODIUM_INSTANCE"
