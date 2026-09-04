#!/usr/bin/env bash
# Restart ONE half of the p2843 pair — the manoeuvre this whole drive is about.
#
#   bash docs/evidence/pod-2843/drive-restart.sh server
#   bash docs/evidence/pod-2843/drive-restart.sh daemon
#
# Restarting one half is not the same experiment as restarting both, and the
# report says which was run. A SERVER restart rehydrates live rows with the
# daemon still holding their PTYs; a DAEMON restart reattaches the PTYs under a
# server that never lost its rows. POD-2843's report names both.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=drive-env.sh
. "$HERE/drive-env.sh"
# shellcheck source=drive-lib.sh
. "$HERE/drive-lib.sh"

half="${1:?usage: drive-restart.sh server|daemon}"
case "$half" in server|daemon) ;; *) echo "unknown half: $half" >&2; exit 1 ;; esac

echo "=== restarting $half at $(date -Is) ===" >> "$PODIUM_DRIVE_BASE/logs/$half.log"
p2843_stop "$half"
p2843_start "$half"
if [ "$half" = server ]; then p2843_wait_server; else p2843_wait_daemon; fi
echo "$half restarted"
