#!/usr/bin/env bash
# Health probe for podium-server (ExecStart of podium-health.service, fired by
# podium-health.timer every 45s). LAST-RESORT backstop for a wedged-but-alive
# HTTP surface: the systemd watchdog (Type=notify + WatchdogSec) catches a
# stalled event loop and Restart=always catches exits, but a server whose loop
# still pets the watchdog while /health never answers is only visible from the
# outside — that is the one case this probe restarts.
#
# WHY the guards: the previous hand-installed probe fired on a timer
# uncorrelated with service start and restarted the server on a SINGLE missed
# 5s curl. During post-deploy load (bun install + typecheck + web build) the
# event loop routinely misses that deadline, so the probe was killing healthy
# freshly-booted servers on ~60% of deploys. Every guard below exists to make
# a false kill structurally impossible:
#
#   1. ActiveState guard — if podium-server is not "active", exit 0. systemd's
#      own Restart= handles starting/failed states; kicking a unit mid-restart
#      only makes things worse.
#   2. Boot-age grace — if the service entered "active" less than GRACE
#      seconds ago (default 120), exit 0. A freshly-booted server under
#      post-deploy load must never be killed. Empty/unparseable timestamp
#      also exits 0 (we cannot prove the server is old enough to judge).
#   3. Second chance — a single failed curl is never enough. Sleep, re-check
#      the guards (the server may have been restarted meanwhile — then it is
#      fresh and protected by the grace again), and only restart when BOTH
#      probes failed.
set -u

port="${PODIUM_PORT:-18787}"
unit="${PODIUM_HEALTH_UNIT:-podium-server.service}"
grace="${PODIUM_HEALTH_GRACE:-120}"          # seconds since ActiveEnterTimestamp before we may act
retry_sleep="${PODIUM_HEALTH_RETRY_SLEEP:-15}" # pause between the two probes
curl_timeout="${PODIUM_HEALTH_CURL_TIMEOUT:-10}"
url="http://localhost:${port}/health"

# Returns 0 only when the unit is active AND has been active for >= grace
# seconds. Any doubt (inactive, empty or unparseable timestamp) returns 1,
# which the caller treats as "do nothing" — never as "restart".
guards_pass() {
  local state ts entered now
  state="$(systemctl --user show "$unit" -p ActiveState --value 2>/dev/null || true)"
  [ "$state" = "active" ] || return 1
  ts="$(systemctl --user show "$unit" -p ActiveEnterTimestamp --value 2>/dev/null || true)"
  [ -n "$ts" ] || return 1
  entered="$(date -d "$ts" +%s 2>/dev/null || true)"
  [ -n "$entered" ] || return 1
  now="$(date +%s)"
  [ $(( now - entered )) -ge "$grace" ] || return 1
  return 0
}

probe() {
  curl -fsS -m "$curl_timeout" "$url" >/dev/null 2>&1
}

guards_pass || exit 0
probe && exit 0

# First probe missed — give the server a second chance before doing anything.
sleep "$retry_sleep"
# Re-check the guards: the server may have been restarted (by the watchdog,
# a redeploy, or an operator) while we slept — then it is fresh and protected.
guards_pass || exit 0
probe && exit 0

echo "podium-health: /health on :${port} failed both probes (${retry_sleep}s apart) — restarting ${unit}"
systemctl --user restart "$unit"
