# GENERATED from apps/cli/src/cli-systemd.ts by scripts/render-systemd.ts.
# Do not hand-edit; rerun the renderer after changing the source.
#!/usr/bin/env bash
# Health probe for the instance-scoped server health unit. It is a last-resort backstop for
# a wedged-but-alive HTTP surface; the systemd watchdog and Restart=always cover the rest.
#
# Guards make a false kill structurally impossible:
#   1. An inactive server is left to systemd.
#   2. A server active for less than GRACE seconds is left alone during cold boot/deploy.
#   3. Two failed curls are required, with the guards checked again between them.
set -u

port="${PODIUM_PORT:-18787}"
unit="${PODIUM_HEALTH_UNIT:-podium-server.service}"
grace="${PODIUM_HEALTH_GRACE:-120}"
retry_sleep="${PODIUM_HEALTH_RETRY_SLEEP:-15}"
curl_timeout="${PODIUM_HEALTH_CURL_TIMEOUT:-10}"
url="http://localhost:${port}/health"

# Returns 0 only when the unit is active and has been active for >= grace.
# Any doubt returns 1, which the caller treats as "do nothing".
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

# First probe missed - give the server a second chance before doing anything.
sleep "$retry_sleep"
# Re-check the guards: a restart while sleeping is fresh and protected by the grace.
guards_pass || exit 0
probe && exit 0

echo "podium-health: /health on :${port} failed both probes (${retry_sleep}s apart) - restarting ${unit}"
systemctl --user restart "$unit"
