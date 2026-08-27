#!/usr/bin/env bash
# Verify the three pins and the arm actually bound by the running pair.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
<<<<<<< HEAD
<<<<<<< HEAD
REPO="$(cd "$HERE/../../.." && pwd)"
=======
REPO="$(cd "$HERE/../.." && pwd)"
>>>>>>> fd5cc091a (docs(evidence): add opencode ten-cell drive)
=======
REPO="$(cd "$HERE/../../.." && pwd)"
>>>>>>> 1f531c6cc (docs(evidence): fix opencode rig root path)
source "$HERE/drive-env.sh"

: "${P2919_CODE_PIN:?P2919_CODE_PIN must name the committed rig code}"
code_sha="$(git -C "$REPO" rev-parse "$P2919_CODE_PIN")"
code_short="$(git -C "$REPO" rev-parse --short=7 "$code_sha")"
want_driver="${P2919_EXPECTED_DRIVER:-opencode-server}"
want_family="${P2919_EXPECTED_FAMILY:-server}"

proc_env() {
  local pid="$1" key="$2" pair
  while IFS= read -r -d '' pair; do
    case "$pair" in "$key"=*) printf '%s' "${pair#*=}"; return 0;; esac
  done <"/proc/$pid/environ"
  return 1
}
pid_cwd() { readlink "/proc/$1/cwd"; }
check_pid() {
  local name="$1" pidfile="$PODIUM_DRIVE_BASE/$1.pid" sha_file="$PODIUM_DRIVE_BASE/$1.sha"
  local pid="$(cat "$pidfile")" sha="$(cat "$sha_file")" cwd
  cwd="$(pid_cwd "$pid")"
  [ "$(basename "$(readlink "/proc/$pid/exe")")" = bun ]
  [ "$sha" = "$code_sha" ]
  [ "$cwd" = "$REPO" ]
  printf '%s\t%s\t%s\t%s\n' "$name" "$pid" "$cwd" "$sha"
}

IFS=$'\t' read -r _ server_pid server_cwd server_sha < <(check_pid server)
IFS=$'\t' read -r _ daemon_pid daemon_cwd daemon_sha < <(check_pid daemon)
bundle="$(curl -fsS "http://$PODIUM_HOST:$PODIUM_PORT/podium-build.json")"
bundle_short="$(printf '%s' "$bundle" | sed -n 's/.*"sourceSha"[[:space:]]*:[[:space:]]*"\([^\"]*\)".*/\1/p')"
[ "$bundle_short" = "$code_short" ]

actual_contract="$(proc_env "$daemon_pid" PODIUM_RUNTIME_CONTRACT || true)"
actual_streaming="$(proc_env "$daemon_pid" PODIUM_CHAT_STREAMING || true)"
actual_driver="$(proc_env "$daemon_pid" PODIUM_RUNTIME_DRIVER || true)"
[ "$actual_contract" = "1" ]
[ "$actual_streaming" = "1" ]
if [ "$want_family" = terminal ]; then
  [ "$actual_driver" = generic-pty ]
else
  [ -z "$actual_driver" ]
fi

printf 'PINJSON {"codeSha":"%s","codeShort":"%s","server":{"pid":%s,"cwd":"%s","sha":"%s"},"daemon":{"pid":%s,"cwd":"%s","sha":"%s"},"bundleSourceSha":"%s","expectedDriver":"%s","expectedFamily":"%s","actualRuntimeDriver":"%s","contract":"%s","streaming":"%s"}\n' \
  "$code_sha" "$code_short" "$server_pid" "$server_cwd" "$server_sha" "$daemon_pid" "$daemon_cwd" "$daemon_sha" \
  "$bundle_short" "$want_driver" "$want_family" "$actual_driver" "$actual_contract" "$actual_streaming"
printf 'server pid=%s cwd=%s sha=%s\n' "$server_pid" "$server_cwd" "${server_sha:0:12}"
printf 'daemon pid=%s cwd=%s sha=%s\n' "$daemon_pid" "$daemon_cwd" "${daemon_sha:0:12}"
echo "bundle sourceSha=$bundle_short expected=$code_short"
echo "daemon runtime driver=${actual_driver:-unset} expected=${want_driver} family=${want_family}"
