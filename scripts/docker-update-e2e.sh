#!/usr/bin/env bash
# Fresh Ubuntu acceptance gate for Podium's packaged headless update path.
set -Eeuo pipefail
shopt -s inherit_errexit

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTANCE="${PODIUM_UPDATE_E2E_INSTANCE:-update-e2e}"
MIN_FREE_GB="${PODIUM_UPDATE_E2E_MIN_FREE_GB:-10}"
PROVE_FAILURE="${PODIUM_UPDATE_E2E_PROVE_FAILURE:-}"
ONLY="${PODIUM_UPDATE_E2E_ONLY:-}"
HOLD="${PODIUM_UPDATE_E2E_HOLD:-0}"
HOLD_REF="${PODIUM_UPDATE_E2E_HOLD_REF:-worktree-pod-2462-update-path}"
EVIDENCE_DIR="${PODIUM_UPDATE_E2E_OUTPUT_DIR:-}"
RUN_ID="podium-update-e2e-$(date +%s)-$$"
LABEL="dev.podium.update-e2e.run=$RUN_ID"
IMAGE="$RUN_ID:ubuntu24"
NETWORK="$RUN_ID"
SOURCE="$RUN_ID-source"
FLEET_A="$RUN_ID-fleet-a"
FLEET_B="$RUN_ID-fleet-b"
SERVER_CONSUMER="$RUN_ID-server"
LEGACY="$RUN_ID-legacy"
SCHEMA_CONTROL="$RUN_ID-schema-control"
TAMPER_CONTROL="$RUN_ID-tamper-control"
JOIN_REFUSAL="$RUN_ID-join-refusal"
SEED="$RUN_ID-seed"
WORK=""
HOST_UID="$(id -u)"
HOST_GID="$(id -g)"
DOCKER_ROOT=""
ZIG_BIN=""
ZIG_ROOT=""
RCODESIGN_BIN=""
SOURCE_PORT=""
TAILNET_IP=""
TAILNET_PORT=""
SERVER_PORT=""
START_FREE=0
CLEANED=0
HOLD_READY=0
CURRENT_SCENARIO=""
BOOTSTRAP_VERSION=""
BOOTSTRAP_PUBKEY=""
JOIN_TOKEN_B=""
CLIENT_PROBE_PID=""
SERVER_RELEASE_PRIVATE=""
SERVER_RELEASE_PUBKEY=""
SERVER_TARGET_VERSION=""
SERVER_MIGRATION="20991231235959_update-e2e-packaged-server"

if [[ "$ONLY" == server ]]; then
  SCENARIOS=(environment resource-safety coordinator-install server-install server-assets server-migration
    server-client-reconnect server-handover server-agent-survival server-rollback cleanup host-disk)
else
  SCENARIOS=(environment resource-safety coordinator-install fresh-install diagnostic-version fleet-join
    fleet-join-refusal version-display dev-release update-offer schema-refusal tampered-refusal
    unsigned-refusal ui-acceptance agent-survival rollout legacy-migration legacy-sigkill rollback cleanup host-disk)
fi
declare -A RESULT=()
declare -A DETAIL=()
declare -A PARENT_PID=()
declare -A PARENT_INVOCATION=()
declare -A PARENT_RESTARTS=()
declare -A ABDUCO_PID=()

say() { printf '[update-e2e] %s\n' "$*"; }
die() { say "FATAL: $*" >&2; exit 1; }
pass() { RESULT["$1"]=PASS; DETAIL["$1"]="$2"; }
fail() { RESULT["$1"]=FAIL; DETAIL["$1"]="$2"; }
blocked() { RESULT["$1"]=BLOCKED; DETAIL["$1"]="$2"; }
resource() { RESULT["$1"]=RESOURCE; DETAIL["$1"]="$2"; }

on_error() {
  local line=$1 command=$2
  if [[ -n "$CURRENT_SCENARIO" && "${RESULT[$CURRENT_SCENARIO]:-}" != FAIL ]]; then
    fail "$CURRENT_SCENARIO" "line $line failed: $command"
  fi
}

matrix() {
  local row
  printf '\n%-21s | %-8s | %s\n' SCENARIO RESULT EVIDENCE
  printf '%-21s-+-%-8s-+-%s\n' --------------------- -------- --------------------------------
  for row in "${SCENARIOS[@]}"; do
    printf '%-21s | %-8s | %s\n' "$row" "${RESULT[$row]:-SKIP}" \
      "${DETAIL[$row]:-not reached after an earlier failure}"
  done
}

usage() {
  cat <<'EOF'
Usage: bun run test:update-e2e [--preflight]

PODIUM_UPDATE_E2E_MIN_FREE_GB=N       disk floor (default 10)
PODIUM_UPDATE_E2E_OUTPUT_DIR=PATH     preserve bounded matrix/journal evidence
PODIUM_UPDATE_E2E_PROVE_FAILURE=NAME  leave `tampered` or `schema` broken; the
                                      ordinary rollout assertion must go red
PODIUM_UPDATE_E2E_ONLY=legacy         run the packaged legacy migration row
                                      while release minting is unavailable
PODIUM_UPDATE_E2E_ONLY=server         update a packaged all-in-one server from
                                      a run-local production-shaped edge feed
PODIUM_UPDATE_E2E_PROVE_FAILURE=server-*  arm one server assertion (see docs)
PODIUM_UPDATE_E2E_PROVE_FAILURE=coordinator-participant
                                      restore the old server-only no-participant shape
PODIUM_UPDATE_E2E_ONLY=positive       run the offer, rollout, survival, and
                                      rollback path without refusal controls
PODIUM_UPDATE_E2E_HOLD=proposal       leave a release proposal pending for a
                                      human to approve and build
PODIUM_UPDATE_E2E_HOLD=published      publish a cold signed release and leave
                                      it for consumer testing (`1` alias)
PODIUM_UPDATE_E2E_HOLD_REF=REF        source ref for hold mode (defaults to the
                                      updater epic integration branch)
EOF
}

hold_enabled() { [[ "$HOLD" != 0 ]]; }
hold_at_proposal() { [[ "$HOLD" == proposal ]]; }
hold_after_publish() { [[ "$HOLD" == published || "$HOLD" == 1 ]]; }

free_bytes() {
  local worktree docker
  worktree="$(df -Pk "$ROOT" | awk 'NR == 2 { print $4 * 1024 }')"
  docker="$worktree"
  if [[ -n "$DOCKER_ROOT" ]]; then
    docker="$(df -Pk "$DOCKER_ROOT" | awk 'NR == 2 { print $4 * 1024 }')"
  fi
  if (( worktree < docker )); then printf %s "$worktree"; else printf %s "$docker"; fi
}

require_disk_margin() {
  local phase=$1 available
  available="$(free_bytes)"
  if (( available < MIN_FREE_GB * 1024 * 1024 * 1024 )); then
    resource resource-safety "disk fell below ${MIN_FREE_GB} GiB after $phase; cleanup ran and no product verdict is claimed"
    die "disk fell below ${MIN_FREE_GB} GiB after $phase; cleanup is running"
  fi
  say "disk after $phase: $(awk -v b="$available" 'BEGIN{printf "%.2f GiB free", b/1073741824}')"
}

owned_ids() { docker ps -aq --filter "label=$LABEL"; }

capture_logs() {
  mkdir -p "$WORK/logs"
  local container name
  for container in "$SOURCE" "$FLEET_A" "$FLEET_B" "$SERVER_CONSUMER" "$LEGACY" "$SCHEMA_CONTROL" "$TAMPER_CONTROL"; do
    docker inspect "$container" >/dev/null 2>&1 || continue
    name="$(docker inspect -f '{{.Config.Hostname}}' "$container")"
    docker logs --tail 4000 "$container" >"$WORK/logs/$name.log" 2>&1 || true
    docker exec "$container" sh -c "cat /tmp/podium-source.log 2>/dev/null" \
      >"$WORK/logs/$name-process.log" 2>&1 || true
    docker exec "$container" sh -c "cat /tmp/server-edge.log 2>/dev/null" \
      >"$WORK/logs/$name-edge.log" 2>&1 || true
    docker exec --user podium --env "XDG_RUNTIME_DIR=/run/user/$HOST_UID" \
      "$container" journalctl --user --no-pager -n 4000 \
      >"$WORK/logs/$name-journal.log" 2>&1 || true
    container_exec "$container" bash -c '
      shopt -s nullglob
      for file in "$1"/logs/*.log "$1"/logs/*.ndjson; do
        printf "%s\n" "--- ${file##*/} ---"
        tail -n 4000 "$file"
      done
    ' _ "$(state_path)" >"$WORK/logs/$name-structured.log" 2>&1 || true
  done
}

capture_fleet_join_diagnostics() {
  mkdir -p "$WORK/logs"
  rpc GET machines.list >"$WORK/logs/fleet-join-machines.json" 2>&1 || true
  local container label
  for container in "$FLEET_A" "$FLEET_B"; do
    label="${container##*-}"
    container_exec "$container" jq 'del(.pairCode)' "$(state_path)/config.json" \
      >"$WORK/logs/fleet-$label-config-redacted.json" 2>&1 || true
    container_exec "$container" jq \
      '{machineId,hasToken:(.token != null),hasUpdatePubkey:(.updatePubkey != null)}' \
      "$(state_path)/daemon.json" \
      >"$WORK/logs/fleet-$label-identity-redacted.json" 2>&1 || true
  done
}

cleanup() {
  local status=$?
  local objects_remain=0
  local final_free
  (( CLEANED == 0 )) || return "$status"
  CLEANED=1
  if [[ -n "$CLIENT_PROBE_PID" ]]; then
    kill "$CLIENT_PROBE_PID" >/dev/null 2>&1 || true
    wait "$CLIENT_PROBE_PID" >/dev/null 2>&1 || true
  fi
  if (( status == 0 && HOLD_READY == 1 )); then
    return 0
  fi
  set +e
  capture_logs
  if (( status != 0 )); then
    local log
    for log in "$WORK"/logs/*.log; do
      [[ -f "$log" ]] || continue
      printf '\n--- %s (last 120 lines) ---\n' "${log##*/}" >&2
      tail -n 120 "$log" >&2
    done
  fi
  docker exec "$SOURCE" sh -c '
    umount /work/source/node_modules 2>/dev/null || true
    umount /bun-cache-cow/merged 2>/dev/null || true
    rm -rf /node-modules-cow/upper /node-modules-cow/work
    rm -rf /bun-cache-cow/upper /bun-cache-cow/work /bun-cache-cow/merged
  ' \
    >/dev/null 2>&1 || true
  local ids
  ids="$(owned_ids)"
  if [[ -n "$ids" ]]; then
    # Exact IDs selected by this run's unguessable label; no foreign object or glob.
    docker rm -f $ids >/dev/null 2>&1
  fi
  docker network rm "$NETWORK" >/dev/null 2>&1
  docker image rm "$IMAGE" >/dev/null 2>&1
  if [[ -n "$(owned_ids)" ]] ||
     docker network inspect "$NETWORK" >/dev/null 2>&1 ||
     docker image inspect "$IMAGE" >/dev/null 2>&1; then
    objects_remain=1
  fi
  if [[ -n "$EVIDENCE_DIR" ]]; then
    mkdir -p "$EVIDENCE_DIR"
    cp -a "$WORK/logs" "$EVIDENCE_DIR/logs"
  fi
  rm -rf "$WORK"
  final_free="$(free_bytes)"
  if [[ -z "${RESULT[resource-safety]:-}" ]]; then
    pass resource-safety "all reached disk checkpoints stayed at or above the immutable ${MIN_FREE_GB} GiB floor"
  fi
  if (( objects_remain == 1 )); then
    fail cleanup "owned Docker objects remain"
  else
    pass cleanup "all labeled containers, the exact network, and harness image were removed"
  fi
  if (( final_free + 192 * 1024 * 1024 < START_FREE )); then
    resource host-disk "owned cleanup completed; host free space moved from $(awk -v b="$START_FREE" 'BEGIN{printf "%.2f GiB", b/1073741824}') to $(awk -v b="$final_free" 'BEGIN{printf "%.2f GiB", b/1073741824}') amid concurrent usage"
  else
    pass host-disk "host free space returned within the 192 MiB observation tolerance"
  fi
  if [[ "${RESULT[cleanup]:-}" == FAIL && "$status" == 0 ]]; then status=1; fi
  matrix
  if [[ -n "$EVIDENCE_DIR" ]]; then
    matrix >"$EVIDENCE_DIR/matrix.txt"
    say "bounded evidence kept at $EVIDENCE_DIR"
  fi
  return "$status"
}

container_exec() {
  local container=$1
  shift
  docker exec --user podium \
    --env HOME=/home/podium \
    --env "XDG_RUNTIME_DIR=/run/user/$HOST_UID" \
    --env "PODIUM_INSTANCE=$INSTANCE" \
    --env PODIUM_PORT=18787 \
    "$container" "$@"
}

wait_for() {
  local seconds=$1 label=$2
  shift 2
  local deadline=$((SECONDS + seconds)) last=""
  while (( SECONDS < deadline )); do
    if last="$("$@" 2>&1)"; then return 0; fi
    sleep 0.25
  done
  say "timeout waiting for $label; last=$last" >&2
  return 1
}

rpc() {
  local verb=$1 proc=$2 input=${3:-} response url body
  url="http://127.0.0.1:$SOURCE_PORT/trpc/$proc"
  if [[ "$verb" == GET ]]; then
    if [[ -n "$input" ]]; then
      response="$(curl -fsS "$url?input=$(printf %s "$input" | jq -sRr @uri)")"
    else
      response="$(curl -fsS "$url")"
    fi
  else
    body="$input"
    [[ -n "$body" ]] || body='{}'
    response="$(curl -fsS -H 'content-type: application/json' -d "$body" "$url")"
  fi
  if jq -e '.error' >/dev/null 2>&1 <<<"$response"; then
    jq -r '.error.json.message // .error.message // .' <<<"$response" >&2
    return 1
  fi
  jq -c '.result.data' <<<"$response"
}

start_container() {
  local name=$1
  local hostname=$2
  shift 2
  docker run -d --name "$name" --label "$LABEL" --network "$NETWORK" \
    --hostname "$hostname" --privileged --cgroupns=private \
    --tmpfs /run --tmpfs /run/lock "$@" "$IMAGE" >/dev/null
  wait_for 30 "$name systemd" docker exec "$name" systemctl is-system-running --wait >/dev/null || true
  docker exec "$name" loginctl enable-linger podium >/dev/null
  wait_for 30 "$name user manager" container_exec "$name" systemctl --user show-environment
}

prepare_image() {
  docker run -d --name "$SEED" --label "$LABEL" --hostname seed \
    -v "$ROOT/scripts/docker-update-e2e:/harness:ro" ubuntu:24.04 sleep infinity >/dev/null
  docker exec "$SEED" bash /harness/provision.sh "$HOST_UID" "$HOST_GID"
  docker commit \
    --change 'ENV container=docker' \
    --change 'STOPSIGNAL SIGRTMIN+3' \
    --change 'CMD ["/sbin/init"]' \
    "$SEED" "$IMAGE" >/dev/null
  docker rm -f "$SEED" >/dev/null
}

command_path() { printf '/home/podium/.local/bin/podium-%s' "$INSTANCE"; }
unit_name() { printf 'podium-%s.service' "$INSTANCE"; }
state_path() { printf '/home/podium/.local/state/podium/%s' "$INSTANCE"; }
install_path() { printf '/home/podium/.local/share/podium-instances/%s' "$INSTANCE"; }
manifest_path() { printf '/work/source/dist-bun/podium-update.json'; }

install_podium() {
  local container=$1 identity=PASS channel=PASS
  shift
  container_exec "$container" env PODIUM_INSTALL_BASE=http://source:8080 \
    PODIUM_INSTALL_PUBKEY="$BOOTSTRAP_PUBKEY" PODIUM_NO_MODIFY_PATH=1 \
    sh /bootstrap/install.sh --instance "$INSTANCE" --channel dev "$@"
  container_exec "$container" jq -e --arg instance "$INSTANCE" \
    '.version == 1 and .instanceId == $instance' "$(state_path)/instance.json" \
    >/dev/null 2>&1 || identity=FAIL
  container_exec "$container" jq -e '.updateChannel == "dev"' \
    "$(state_path)/config.json" >/dev/null 2>&1 || channel=FAIL
  if [[ "$identity" == FAIL || "$channel" == FAIL ]]; then
    say "installer bootstrap assertion failed: identity=$identity channel=$channel" >&2
    return 1
  fi
}
packaged_components_healthy() {
  container_exec "$1" curl -fsS http://127.0.0.1:18787/version |
    jq -e '.components.janitor.state=="running" and
      (.components.janitor.progressVersion|type=="number") and
      .components.daemon.state=="connected"' >/dev/null
}

all_in_one_participant_ready() {
  local container=$1 expected=$2
  container_exec "$container" curl -fsS \
    http://127.0.0.1:18787/trpc/updates.fleet |
    jq -e --arg expected "$expected" '
      (.result.data.json // .result.data) as $fleet |
      [$fleet.allMachines[] | select(.online == true and
        .installKind == "installed" and .version == $expected)] | length == 1' >/dev/null
}

fresh_install() {
  local container=${1:-$FLEET_A}
  install_podium "$container"
  local command unit response main_pid children roles units
  command="$(command_path)"
  unit="$(unit_name)"
  docker exec -d --user podium --env HOME=/home/podium \
    --env "XDG_RUNTIME_DIR=/run/user/$HOST_UID" --env "PODIUM_INSTANCE=$INSTANCE" \
    --env PODIUM_PORT=18787 --env PODIUM_HOST=0.0.0.0 \
    "$container" bash -lc "exec '$command' setup >>/tmp/podium-source.log 2>&1"
  wait_for 60 "fresh setup server" container_exec "$container" \
    curl -fsS http://127.0.0.1:18787/health >/dev/null
  response="$(container_exec "$container" curl -fsS -H 'content-type: application/json' \
    -d '{"publicUrl":"http://127.0.0.1:18787","mode":"all-in-one","port":18787,"acknowledgeNoPassword":true}' \
    http://127.0.0.1:18787/trpc/setup.complete)"
  ! jq -e '.error' >/dev/null 2>&1 <<<"$response"
  container_exec "$container" pkill -f 'podium-cli setup' >/dev/null 2>&1 || true
  sleep 1
  container_exec "$container" "$command" >/dev/null
  wait_for 60 "single packaged parent" container_exec "$container" \
    systemctl --user is-active --quiet "$unit"
  wait_for 60 "packaged daemon and janitor worker" packaged_components_healthy "$container"
  wait_for 60 "one all-in-one update participant" \
    all_in_one_participant_ready "$container" "$BOOTSTRAP_VERSION"
  main_pid="$(container_exec "$container" systemctl --user show "$unit" -p MainPID --value)"
  children="$(docker exec "$container" pgrep -P "$main_pid" || true)"
  children="${children//$'\n'/ }"
  roles="$(docker exec "$container" sh -lc \
    "for p in $children; do tr '\\000' ' ' </proc/\$p/cmdline; printf '\\n'; done")"
  units="$(container_exec "$container" bash -lc \
    'find "$HOME/.config/systemd/user" -maxdepth 1 -type f -name "podium*.service" -printf "%f\n"')"
  [[ "$units" == "$unit" ]]
  [[ "$(wc -w <<<"$children")" == 2 ]]
  grep -Eq '(^|[[:space:]])server([[:space:]]|$)' <<<"$roles"
  grep -Eq '(^|[[:space:]])daemon([[:space:]]|$)' <<<"$roles"
  ! grep -Eq '(^|[[:space:]])janitor([[:space:]]|$)' <<<"$roles"
  container_exec "$container" test ! -e \
    "/home/podium/.config/systemd/user/podium-$INSTANCE-janitor.service"
}

diagnostic_version() {
  local foreign=/tmp/podium-e2e-foreign-state output
  container_exec "$FLEET_A" rm -rf "$foreign"
  container_exec "$FLEET_A" mkdir -p "$foreign"
  container_exec "$FLEET_A" touch "$foreign/foreign-owner"
  if output="$(docker exec --user podium \
      --env HOME=/home/podium \
      --env "PODIUM_INSTANCE=$INSTANCE" \
      --env "PODIUM_STATE_DIR=$foreign" \
      "$FLEET_A" "$(command_path)" --version \
      2>"$WORK/logs/diagnostic-version.stderr")" &&
     [[ "$output" == "podium $BOOTSTRAP_VERSION" ]] &&
     container_exec "$FLEET_A" test ! -e "$foreign/instance.json"; then
    pass diagnostic-version "packaged --version answered exactly against a foreign root without adopting it"
  else
    fail diagnostic-version "packaged --version did not remain available against a foreign root without adopting it"
  fi
}

parent_restart_observed() {
  local container=$1 restarts
  restarts="$(container_exec "$container" systemctl --user show "$(unit_name)" -p NRestarts --value)" || return 1
  [[ "$restarts" != *[!0-9]* ]] && (( restarts > 0 ))
}

legacy_migration() {
  local container=$1 unit dir role source target leftovers command state wants
  unit="$(unit_name)"
  dir=/home/podium/.config/systemd/user
  command="$(command_path)"
  state="$(state_path)"
  wants="$dir/default.target.wants"
  container_exec "$container" systemctl --user disable --now "$unit" >/dev/null
  container_exec "$container" rm -f "$dir/$unit"
  container_exec "$container" bash -c '
    set -e
    command=$1
    state=$2
    mv "$command" "$command.e2e-real"
    {
      printf "%s\n" "#!/bin/sh"
      printf "state=%q\n" "$state"
      printf "real=%q\n" "$command.e2e-real"
      printf "%s\n" \
        "if [ \"\$1\" = parent ] && [ -e \"\$state/e2e-fail-parent\" ]; then" \
        "  echo intentional update-e2e unhealthy migration parent >&2" \
        "  exit 97" \
        "fi" \
        "exec \"\$real\" \"\$@\""
    } >"$command"
    chmod 755 "$command"
    touch "$state/e2e-fail-parent"
  ' _ "$command" "$state"
  for role in server daemon janitor; do
    source="/bootstrap/legacy/podium-$INSTANCE-$role.service"
    target="$dir/podium-$INSTANCE-$role.service"
    container_exec "$container" cp "$source" "$target"
  done
  container_exec "$container" systemctl --user daemon-reload
  container_exec "$container" systemctl --user enable --now \
    "podium-$INSTANCE-server.service" "podium-$INSTANCE-daemon.service" \
    "podium-$INSTANCE-janitor.service" >/dev/null
  wait_for 60 "unhealthy packaged parent attempt" parent_restart_observed "$container"
  for role in server daemon janitor; do
    container_exec "$container" systemctl --user is-active --quiet \
      "podium-$INSTANCE-$role.service"
    container_exec "$container" test -L "$wants/podium-$INSTANCE-$role.service"
  done
  if ! container_exec "$container" curl -fsS http://127.0.0.1:18787/health >/dev/null; then
    fail legacy-migration "legacy packaged server did not stay on configured port 18787 while the new parent was unhealthy"
    return 1
  fi
  container_exec "$container" systemctl --user is-enabled --quiet "$unit"
  container_exec "$container" bash -c '
    rm -f "$2/e2e-fail-parent"
    mv "$1.e2e-real" "$1"
  ' _ "$command" "$state"
  container_exec "$container" systemctl --user reset-failed "$unit" || true
  container_exec "$container" systemctl --user restart "$unit"
  wait_for 120 "legacy units to converge" container_exec "$container" \
    systemctl --user is-active --quiet "$unit"
  wait_for 120 "converged packaged parent health" packaged_components_healthy "$container"
  leftovers="$(container_exec "$container" bash -lc \
    "find \"$dir\" -maxdepth 1 -type f -name \"podium-$INSTANCE-*.service\" -print")"
  [[ -z "$leftovers" ]]
  container_exec "$container" systemctl --user is-enabled --quiet "$unit"
}

prepare_legacy_machine() {
  start_container "$LEGACY" legacy -v "$WORK/bootstrap:/bootstrap:ro"
  fresh_install "$LEGACY" >"$WORK/logs/legacy-fresh-install.log" 2>&1
}

setup_source() {
  local response
  response="$(container_exec "$SOURCE" curl -fsS -H 'content-type: application/json' \
    -d '{"publicUrl":"http://source:18787","mode":"server","port":18787,"acknowledgeNoPassword":true}' \
    http://127.0.0.1:18787/trpc/setup.complete)"
  ! jq -e '.error' >/dev/null 2>&1 <<<"$response"
}

coordinator_healthy() {
  curl -fsS "http://127.0.0.1:$SOURCE_PORT/version" |
    jq -e --arg id "$INSTANCE" '.instanceId==$id' >/dev/null
}
coordinator_down() { ! curl -fsS "http://127.0.0.1:$SOURCE_PORT/health" >/dev/null 2>&1; }

coordinator_is_installed_build() {
  curl -fsS "http://127.0.0.1:$SOURCE_PORT/version" |
    jq -e --arg id "$INSTANCE" --arg version "$BOOTSTRAP_VERSION" \
      '.instanceId==$id and .appVersion==$version and
        (.appVersion|startswith("dev+")|not)' >/dev/null
}

coordinator_participant_ready() {
  local expected=$1
  rpc GET updates.fleet |
    jq -e --arg expected "$expected" '
      [.allMachines[] | select(.name == "source" and .online == true and
        .installKind == "installed" and .version == $expected)] | length == 1' >/dev/null
}

coordinator_version_is() {
  curl -fsS "http://127.0.0.1:$SOURCE_PORT/version" |
    jq -e --arg expected "$1" '.appVersion == $expected' >/dev/null
}

launch_coordinator_setup() {
  docker exec -d --user podium --env HOME=/home/podium \
    --env "XDG_RUNTIME_DIR=/run/user/$HOST_UID" --env "PODIUM_INSTANCE=$INSTANCE" \
    --env PODIUM_PORT=18787 --env PODIUM_HOST=0.0.0.0 \
    --env PODIUM_DEV_SOURCE_ROOT=/work/source \
    --env PODIUM_NO_RELAY=1 --env PODIUM_NO_SCOPE=1 \
    --env BUN_INSTALL_CACHE_DIR=/bun-cache-cow/merged \
    "$SOURCE" bash -lc \
    "cd /work/source && exec '$(command_path)' setup >>/tmp/podium-source.log 2>&1"
}

launch_coordinator_parent() {
  local participant_env=()
  if [[ "$PROVE_FAILURE" == coordinator-participant ]]; then
    participant_env=(--env PODIUM_E2E_DISABLE_LOCAL_UPDATE_PARTICIPANT=1)
  fi
  docker exec -d --user podium --env HOME=/home/podium \
    --env "XDG_RUNTIME_DIR=/run/user/$HOST_UID" --env "PODIUM_INSTANCE=$INSTANCE" \
    --env PODIUM_PORT=18787 --env PODIUM_HOST=0.0.0.0 \
    --env PODIUM_DEV_SOURCE_ROOT=/work/source \
    --env PODIUM_DEV_ARTIFACT_BASE_URL=http://source:18787 \
    --env PODIUM_NO_RELAY=1 --env PODIUM_NO_SCOPE=1 \
    --env BUN_BIN=/home/podium/.local/bin/bun --env BUN_INSTALL_CACHE_DIR=/bun-cache-cow/merged \
    --env PODIUM_ZIG=/opt/host-tools/zig-root/zig \
    --env PODIUM_RCODESIGN=/opt/host-tools/rcodesign \
    "${participant_env[@]}" \
    "$SOURCE" bash -lc \
    "cd /work/source && exec '$(command_path)' parent --takeover >>/tmp/podium-source.log 2>&1"
}

restart_coordinator() {
  container_exec "$SOURCE" pkill -f 'podium-cli parent --takeover' >/dev/null 2>&1 || true
  wait_for 30 "coordinator to stop" coordinator_down
  launch_coordinator_parent
  wait_for 120 "coordinator to restart" coordinator_healthy
  coordinator_is_installed_build
}

unsigned_unavailable() {
  rpc GET updates.fleet |
    jq -e '.targetVersion==null and
      any(.channelChecks[]; .channel=="dev" and .outcome.status=="unavailable" and
        (.outcome.reason|test("signature|unsigned";"i")))' >/dev/null
}

schema_target_or_refusal() {
  local target=$1
  rpc GET updates.fleet |
    jq -e --arg target "$target" '.targetVersion==$target or
      any(.channelChecks[]; .channel=="dev" and .outcome.status=="unavailable" and
        (.outcome.reason|test("schema|migration|regression";"i")))' >/dev/null
}

mint_join() {
  local data command token
  data="$(rpc POST machines.pairingCode '{"podiumManaged":true}')"
  command="$(jq -r '.joinCommand // empty' <<<"$data")"
  token="$(awk '{for(i=1;i<=NF;i++) if($i=="--join") print $(i+1)}' <<<"$command")"
  if [[ -z "$token" ]]; then
    say "pair response did not contain a join token" >&2
    return 1
  fi
  printf %s "$token"
}

fleet_online() {
  rpc GET machines.list |
    jq -e '[.[] | select((.name == "fleet-a" or .name == "fleet-b") and .online)] | length == 2' >/dev/null
}

fleet_machine_online() {
  local name=$1 expected=$2
  rpc GET machines.list |
    jq -e --arg name "$name" --argjson expected "$expected" \
      'any(.[]; .name == $name and .online == $expected)' >/dev/null
}

packaged_daemon_only() {
  local container=$1 unit main_pid children roles units
  unit="$(unit_name)"
  main_pid="$(container_exec "$container" systemctl --user show "$unit" -p MainPID --value)"
  children="$(docker exec "$container" pgrep -P "$main_pid" || true)"
  children="${children//$'\n'/ }"
  roles="$(docker exec "$container" sh -lc \
    "for p in $children; do tr '\000' ' ' </proc/\$p/cmdline; printf '\n'; done")"
  units="$(container_exec "$container" bash -lc \
    'find "$HOME/.config/systemd/user" -maxdepth 1 -type f -name "podium*.service" -printf "%f\n"')"
  [[ "$main_pid" =~ ^[1-9][0-9]*$ ]]
  [[ "$units" == "$unit" ]]
  [[ "$(wc -w <<<"$children")" == 1 ]]
  grep -Eq '(^|[[:space:]])daemon([[:space:]]|$)' <<<"$roles"
  ! grep -Eq '(^|[[:space:]])(server|janitor)([[:space:]]|$)' <<<"$roles"
  container_exec "$container" jq -e '.mode == "daemon" and (.serverUrl | type == "string" and length > 0)' \
    "$(state_path)/config.json" >/dev/null
  ! container_exec "$container" curl -fsS http://127.0.0.1:18787/health >/dev/null 2>&1
}

join_fleet() {
  local token
  token="$(mint_join)"
  container_exec "$FLEET_A" "$(command_path)" setup --join "$token" --persist systemd >/dev/null
  token="$(mint_join)"
  JOIN_TOKEN_B="$token"
  install_podium "$FLEET_B" --join "$token"
  if ! wait_for 90 "two joined consumers" fleet_online; then
    capture_fleet_join_diagnostics
    fail fleet-join \
      "both packaged join commands completed, but the source did not report both daemon-only machines online"
    return 1
  fi
  packaged_daemon_only "$FLEET_A"
  packaged_daemon_only "$FLEET_B"
}

join_refusal_reports_failure() {
  local token=$1 log="$WORK/logs/fleet-join-refusal.log"
  start_container "$JOIN_REFUSAL" join-refusal -v "$WORK/bootstrap:/bootstrap:ro"
  if container_exec "$JOIN_REFUSAL" env PODIUM_INSTALL_BASE=http://source:8080 \
      PODIUM_INSTALL_PUBKEY="$BOOTSTRAP_PUBKEY" PODIUM_NO_MODIFY_PATH=1 \
      sh /bootstrap/install.sh --instance "$INSTANCE" --channel dev --join "$token" \
      >"$log" 2>&1; then
    fail fleet-join-refusal "a fresh install replaying a consumed join token exited zero"
    return 1
  fi
  grep -Eiq 'auth-failed|invalid or expired|reject|unauthorized' "$log"
  ! grep -Fq 'This machine has joined your Podium.' "$log"
  docker rm -f "$JOIN_REFUSAL" >/dev/null
}

stop_main_fleet() {
  local container name
  for container in "$FLEET_A" "$FLEET_B"; do
    container_exec "$container" systemctl --user stop "$(unit_name)"
  done
  for name in fleet-a fleet-b; do
    wait_for 30 "$name offline for isolated refusal controls" \
      fleet_machine_online "$name" false
  done
}

start_main_fleet() {
  local container name
  for container in "$FLEET_A" "$FLEET_B"; do
    container_exec "$container" systemctl --user start "$(unit_name)"
  done
  for name in fleet-a fleet-b; do
    wait_for 60 "$name restored after isolated refusal controls" \
      fleet_machine_online "$name" true
  done
}

machine_channel_is() {
  rpc GET updates.fleet |
    jq -e --arg name "$1" --arg channel "$2" \
      'any(.allMachines[]; .name==$name and .channel==$channel)' >/dev/null
}

set_machine_channel() {
  local name=$1 channel=$2 id
  id="$(rpc GET machines.list | jq -er --arg name "$name" '.[]|select(.name==$name)|.id')"
  rpc POST machines.setUpdateChannel \
    "$(jq -nc --arg id "$id" --arg channel "$channel" '{id:$id,channel:$channel}')" \
    >/dev/null
  wait_for 30 "$name pinned to $channel" machine_channel_is "$name" "$channel"
}

remove_refusal_control() {
  local container=$1 name=$2
  docker logs --tail 4000 "$container" >"$WORK/logs/$name.log" 2>&1 || true
  container_exec "$container" journalctl --user --no-pager -n 4000 \
    >"$WORK/logs/$name-journal.log" 2>&1 || true
  container_exec "$container" bash -c '
    shopt -s nullglob
    for file in "$1"/logs/*.log "$1"/logs/*.ndjson; do
      printf "%s\n" "--- ${file##*/} ---"
      tail -n 4000 "$file"
    done
  ' _ "$(state_path)" >"$WORK/logs/$name-structured.log" 2>&1 || true
  docker rm -f "$container" >/dev/null
  wait_for 30 "$name offline after refusal control" fleet_machine_online "$name" false
}

prepare_schema_control() {
  local token
  start_container "$SCHEMA_CONTROL" schema-control -v "$WORK/bootstrap:/bootstrap:ro"
  fresh_install "$SCHEMA_CONTROL" >"$WORK/logs/schema-control-install.log" 2>&1
  token="$(mint_join)"
  container_exec "$SCHEMA_CONTROL" "$(command_path)" setup --join "$token" --persist systemd \
    >"$WORK/logs/schema-control-join.log" 2>&1
  wait_for 90 "schema control joined" fleet_machine_online schema-control true
  packaged_daemon_only "$SCHEMA_CONTROL"
  set_machine_channel schema-control stable
}

prepare_tamper_control() {
  local token
  start_container "$TAMPER_CONTROL" tamper-control -v "$WORK/bootstrap:/bootstrap:ro"
  token="$(mint_join)"
  install_podium "$TAMPER_CONTROL" --join "$token" >"$WORK/logs/tamper-control-install.log" 2>&1
  wait_for 90 "tamper control joined" fleet_machine_online tamper-control true
  packaged_daemon_only "$TAMPER_CONTROL"
  set_machine_channel tamper-control stable
}

proposal_ready() {
  rpc GET updates.proposal |
    jq -e '.state=="pending" and (.headSha|length>0) and (.version|length>0)' >/dev/null
}
proposal_for() {
  rpc GET updates.proposal |
    jq -e --arg head "$1" '.state=="pending" and .headSha==$head' >/dev/null
}
approve_release() {
  local proposal_log=$1 response_log=$2 proposal response
  if [[ -s "$proposal_log" ]]; then
    proposal="$(<"$proposal_log")"
  else
    proposal="$(rpc GET updates.proposal)"
    printf "%s\n" "$proposal" >"$proposal_log"
  fi
  response="$(rpc POST updates.approveProposal "$(jq -c '{headSha,version}' <<<"$proposal")")"
  printf "%s\n" "$response" >"$response_log"
  [[ "$response" == null ]]
}
published() { container_exec "$SOURCE" test -s "$(manifest_path)"; }
target_version() { rpc GET updates.fleet | jq -r '.targetVersion // empty'; }
copy_manifest_out() { docker cp "$SOURCE:$(manifest_path)" "$1"; }
copy_manifest_in() {
  docker cp "$1" "$SOURCE:$(manifest_path)"
  docker exec "$SOURCE" chown "$HOST_UID:$HOST_GID" "$(manifest_path)"
}
artifact_for() {
  container_exec "$SOURCE" bash -lc \
    "find /work/source/dist-bun -maxdepth 1 -type f -name '*$1*linux-x86_64*.tar.gz' -print -quit"
}

operation() {
  rpc GET operations.history '{"kind":"update","limit":20}' |
    jq -c --arg id "$1" '.[]|select(.id==$id)' | head -1
}
terminal_operation() {
  local value
  value="$(operation "$1")"
  [[ -n "$value" ]] &&
    jq -e '.state=="done" or .state=="failed" or .state=="cancelled"' <<<"$value" >/dev/null
}
start_update() { rpc POST updates.start '{"surface":"settings"}'; }

ui_probe() {
  local mode=$1 target=$2 screenshot=$3
  PODIUM_UPDATE_E2E_ORIGIN="http://127.0.0.1:$SOURCE_PORT" \
    PODIUM_UPDATE_E2E_UI_MODE="$mode" PODIUM_UPDATE_E2E_TARGET="$target" \
    PODIUM_UPDATE_E2E_SCREENSHOT="$screenshot" \
    bun --conditions=@podium/source "$ROOT/scripts/docker-update-e2e/ui-update.ts"
}

capture_parent_state() {
  local container unit pid invocation restarts
  unit="$(unit_name)"
  for container in "$FLEET_A" "$FLEET_B"; do
    pid="$(container_exec "$container" systemctl --user show "$unit" -p MainPID --value)"
    invocation="$(container_exec "$container" systemctl --user show "$unit" -p InvocationID --value)"
    restarts="$(container_exec "$container" systemctl --user show "$unit" -p NRestarts --value)"
    [[ "$pid" =~ ^[1-9][0-9]*$ && -n "$invocation" && "$restarts" =~ ^[0-9]+$ ]]
    PARENT_PID["$container"]="$pid"
    PARENT_INVOCATION["$container"]="$invocation"
    PARENT_RESTARTS["$container"]="$restarts"
  done
}

self_handovers_complete() {
  local container unit old_pid new_pid invocation restarts
  unit="$(unit_name)"
  for container in "$FLEET_A" "$FLEET_B"; do
    old_pid="${PARENT_PID[$container]}"
    new_pid="$(container_exec "$container" systemctl --user show "$unit" -p MainPID --value)"
    invocation="$(container_exec "$container" systemctl --user show "$unit" -p InvocationID --value)"
    restarts="$(container_exec "$container" systemctl --user show "$unit" -p NRestarts --value)"
    [[ "$new_pid" =~ ^[1-9][0-9]*$ && "$new_pid" != "$old_pid" ]] || return 1
    ! docker exec "$container" kill -0 "$old_pid" >/dev/null 2>&1 || return 1
    [[ "$invocation" == "${PARENT_INVOCATION[$container]}" ]] || return 1
    [[ "$restarts" == "${PARENT_RESTARTS[$container]}" ]] || return 1
  done
}

installed_versions_are() {
  local expected=$1 container
  for container in "$FLEET_A" "$FLEET_B"; do
    [[ "$(container_exec "$container" cat "$(install_path)/VERSION")" == "$expected" ]] ||
      return 1
  done
}

installed_version_is() {
  [[ "$(container_exec "$1" cat "$(install_path)/VERSION")" == "$2" ]]
}

negative_refusal() {
  local old=$1 pattern=$2 container=$3 started id value
  started="$(start_update)" || return 1
  id="$(jq -er .operationId <<<"$started")" || return 1
  wait_for 150 "refusal operation" terminal_operation "$id" || return 1
  value="$(operation "$id")" || return 1
  printf '%s\n' "$value" >"$WORK/logs/${CURRENT_SCENARIO}-operation.json" || return 1
  jq -e '.state=="failed"' <<<"$value" >/dev/null || return 1
  grep -Eiq "$pattern" <<<"$value" || return 1
  jq -e --arg name "$(docker inspect -f '{{.Config.Hostname}}' "$container")" \
    '([.steps[]?.places[]?.name] | unique) == [$name]' \
    <<<"$value" >/dev/null || return 1
  installed_version_is "$container" "$old"
}

schema_refusal() {
  local original=$1 old=$2 container=$3 broken="$WORK/schema.json" target
  target="$(jq -er .version "$original")" || return 1
  local original_count broken_count
  original_count="$(jq -e '.schema.migrations | length' "$original")" || return 1
  (( original_count > 0 )) || return 1
  jq '.schema.migrations=(.schema.migrations[0:-1])' "$original" >"$broken" || return 1
  broken_count="$(jq -e '.schema.migrations | length' "$broken")" || return 1
  (( broken_count + 1 == original_count )) || return 1
  cp "$broken" "$WORK/logs/schema-refusal-manifest.json" || return 1
  copy_manifest_in "$broken" || return 1
  restart_coordinator || return 1
  if ! wait_for 60 "schema target or named resolver refusal" schema_target_or_refusal "$target"; then
    rpc GET updates.fleet >"$WORK/logs/schema-refusal-fleet.json" 2>&1 || true
    return 1
  fi
  rpc GET updates.fleet >"$WORK/logs/schema-refusal-fleet.json" || return 1
  wait_for 60 "schema control reconnected on its stable pin" \
    fleet_machine_online schema-control true || return 1
  installed_version_is "$container" "$old" || return 1
  set_machine_channel schema-control dev || return 1
  if jq -e --arg target "$target" '.targetVersion==$target' \
      "$WORK/logs/schema-refusal-fleet.json" >/dev/null; then
    [[ "$PROVE_FAILURE" == schema ]] && return 0
    negative_refusal "$old" 'schema|migration|regression' "$container"
  else
    installed_version_is "$container" "$old"
  fi
}

unsigned_refusal() {
  local original=$1 old=$2 broken="$WORK/unsigned.json"
  jq -e '.artifacts.headless.platforms["linux-x86_64"].signature | type == "string" and length > 0' \
    "$original" >/dev/null || return 1
  jq 'del(.artifacts.headless.platforms["linux-x86_64"].signature)' "$original" >"$broken" || return 1
  jq -e '.artifacts.headless.platforms["linux-x86_64"] | has("signature") | not' \
    "$broken" >/dev/null || return 1
  cp "$broken" "$WORK/logs/unsigned-refusal-manifest.json" || return 1
  copy_manifest_in "$broken" || return 1
  restart_coordinator || return 1
  if ! wait_for 60 "unsigned feed refusal" unsigned_unavailable; then
    rpc GET updates.fleet >"$WORK/logs/unsigned-refusal-fleet.json" 2>&1 || true
    return 1
  fi
  rpc GET updates.fleet >"$WORK/logs/unsigned-refusal-fleet.json" || return 1
  installed_versions_are "$old"
}

tampered_refusal() {
  local artifact=$1 old=$2 container=$3 before after
  wait_for 60 "tamper control reconnected on its stable pin" \
    fleet_machine_online tamper-control true || return 1
  before="$(container_exec "$SOURCE" sha256sum "$artifact" | awk '{print $1}')" || return 1
  container_exec "$SOURCE" bash -lc "printf x >>'$artifact'" || return 1
  after="$(container_exec "$SOURCE" sha256sum "$artifact" | awk '{print $1}')" || return 1
  [[ -n "$before" && -n "$after" && "$before" != "$after" ]] || return 1
  installed_version_is "$container" "$old" || return 1
  set_machine_channel tamper-control dev || return 1
  [[ "$PROVE_FAILURE" == tampered ]] && return 0
  negative_refusal "$old" 'digest|signature|tamper|corrupt' "$container"
}

create_shells() {
  local machines ids='[]' machine answer
  machines="$(rpc GET machines.list)"
  for machine in $(jq -r '.[]|select(.name=="fleet-a" or .name=="fleet-b")|.id' <<<"$machines"); do
    answer="$(rpc POST sessions.create \
      "$(jq -nc --arg id "$machine" '{agentKind:"shell",cwd:"/tmp",machineId:$id}')")"
    ids="$(jq -c --arg id "$(jq -r .sessionId <<<"$answer")" '.+[$id]' <<<"$ids")"
  done
  printf %s "$ids"
}
shells_live() {
  rpc GET sessions.list |
    jq -e --argjson ids "$1" \
      '[$ids[] as $id|any(.[];.sessionId==$id and .status=="live")]|all' >/dev/null
}
abduco_listing() {
  local container=$1 socket_dir listing
  socket_dir="$(container_exec "$container" find /tmp -maxdepth 1 -type d -name "pd-*" -print -quit)"
  [[ -n "$socket_dir" ]] || socket_dir="$(state_path)/runtime/abduco"
  if ! listing="$(container_exec "$container" env "ABDUCO_SOCKET_DIR=$socket_dir" \
      "$(state_path)/bin/abduco" 2>>"$WORK/logs/abduco-state.log")"; then
    return 1
  fi
  printf "%s socket=%s\n%s\n" "$container" "$socket_dir" "$listing" \
    >>"$WORK/logs/abduco-state.log"
  printf %s "$listing"
}
capture_abduco_state() {
  local ids=$1 container listing id line pid found=0 expected
  expected="$(jq length <<<"$ids")"
  for container in "$FLEET_A" "$FLEET_B"; do
    listing="$(abduco_listing "$container")"
    for id in $(jq -r ".[]" <<<"$ids"); do
      line="$(grep -F -- "-$id" <<<"$listing" | head -1 || true)"
      [[ -n "$line" ]] || continue
      [[ "$line" == \** ]]
      pid="$(cut -f3 <<<"$line" | xargs)"
      [[ "$pid" =~ ^[1-9][0-9]*$ ]]
      docker exec "$container" kill -0 "$pid"
      ABDUCO_PID["$container:$id"]="$pid"
      (( found += 1 ))
    done
  done
  [[ "$found" == "$expected" ]]
}
abduco_sessions_survived() {
  local ids=$1 container listing id line pid old found=0 expected
  expected="$(jq length <<<"$ids")"
  for container in "$FLEET_A" "$FLEET_B"; do
    listing="$(abduco_listing "$container")" || return 1
    for id in $(jq -r ".[]" <<<"$ids"); do
      old="${ABDUCO_PID[$container:$id]:-}"
      [[ -n "$old" ]] || continue
      line="$(grep -F -- "-$id" <<<"$listing" | head -1 || true)"
      [[ -n "$line" && "$line" == \** ]] || return 1
      pid="$(cut -f3 <<<"$line" | xargs)"
      [[ "$pid" == "$old" ]] || return 1
      docker exec "$container" kill -0 "$pid" || return 1
      (( found += 1 ))
    done
  done
  [[ "$found" == "$expected" ]]
}


reported_versions_are() {
  rpc GET updates.fleet |
    jq -e --arg v "$1" \
      '[.machines[]|select(.name=="source" or .name=="fleet-a" or .name=="fleet-b")|
        select(.online and .version==$v)]|length==3' >/dev/null
}

rollout() {
  local target=$1 old=$2 id=$3 deadline snapshot staged saw_canary=0 value summary last_summary=""
  deadline=$((SECONDS+300))
  while (( SECONDS < deadline )); do
    snapshot="$(rpc GET updates.fleet)" || { sleep 0.1; continue; }
    printf '%s\n' "$snapshot" >"$WORK/logs/rollout-last-fleet.json"
    summary="$(jq -c '[.machines[] | select(.name=="source" or .name=="fleet-a" or .name=="fleet-b") | {name,version,state,online}]' <<<"$snapshot")"
    if [[ "$summary" != "$last_summary" ]]; then
      printf '%s\n' "$summary" >>"$WORK/logs/rollout-transitions.ndjson"
      last_summary="$summary"
    fi
    staged="$(jq -r --arg old "$old" --arg target "$target" '
      ([.machines[] | select((.name=="source" or .name=="fleet-a" or .name=="fleet-b") and
        (.state=="granted" or .state=="downloading" or .state=="restarting"))] | length) == 1 and
      ([.machines[] | select((.name=="source" or .name=="fleet-a" or .name=="fleet-b") and
        .state=="current" and .version==$old)] | length) == 2 and
      ([.machines[] | select((.name=="source" or .name=="fleet-a" or .name=="fleet-b") and
        .version==$target)] | length) == 0' <<<"$snapshot")"
    [[ "$staged" == true ]] && saw_canary=1
    terminal_operation "$id" && break
    sleep 0.1
  done
  value="$(operation "$id")"
  printf '%s\n' "$value" >"$WORK/logs/rollout-operation.json"
  jq -e '.state=="done"' <<<"$value" >/dev/null
  (( saw_canary == 1 ))
  wait_for 120 "both on-disk versions" installed_versions_are "$target"
  wait_for 120 "coordinator on-disk version" installed_version_is "$SOURCE" "$target"
  wait_for 120 "coordinator served version" coordinator_version_is "$target"
  wait_for 120 "both reported versions" reported_versions_are "$target"
  wait_for 120 "two self-handovers without systemd restart" self_handovers_complete
}

crash_artifact() {
  local manifest=$1 artifact=$2 unpack="$WORK/crash" key="$WORK/private.der"
  local bundle="$WORK/crash.tar.gz" metadata="$WORK/crash.meta.json"
  local signature digest size
  mkdir -p "$unpack"
  docker cp "$SOURCE:$artifact" "$bundle"
  docker cp "$SOURCE:$artifact.meta.json" "$metadata"
  tar -xzf "$bundle" -C "$unpack"
  printf '#!/bin/sh\necho intentional update-e2e successor crash >&2\nexit 97\n' \
    >"$unpack/headless/podium"
  chmod 755 "$unpack/headless/podium"
  tar -czf "$bundle.new" -C "$unpack" headless
  mv "$bundle.new" "$bundle"
  container_exec "$SOURCE" jq -r .privateKey "$(state_path)/update-signing-key.json" |
    base64 -d >"$key"
  openssl pkeyutl -sign -inkey "$key" -keyform DER -rawin \
    -in "$bundle" -out "$WORK/crash.sig"
  signature="$(base64 -w0 "$WORK/crash.sig")"
  digest="sha256-$(openssl dgst -sha256 -binary "$bundle" | base64 -w0)"
  size="$(stat -c %s "$bundle")"
  printf '%s\n' "$signature" >"$WORK/crash.sig.b64"
  jq --arg digest "$digest" --argjson size "$size" \
    '.digest=$digest|.size=$size' "$metadata" >"$metadata.new"
  mv "$metadata.new" "$metadata"
  jq --arg signature "$signature" --arg digest "$digest" \
    '.artifacts.headless.platforms["linux-x86_64"].signature=$signature|
     .artifacts.headless.platforms["linux-x86_64"].digest=$digest' \
    "$manifest" >"$manifest.new"
  mv "$manifest.new" "$manifest"
  docker cp "$bundle" "$SOURCE:$artifact"
  docker cp "$WORK/crash.sig.b64" "$SOURCE:$artifact.sig"
  docker cp "$metadata" "$SOURCE:$artifact.meta.json"
  docker exec "$SOURCE" chown "$HOST_UID:$HOST_GID" \
    "$artifact" "$artifact.sig" "$artifact.meta.json"
  verify_signed_manifest "$manifest" "$bundle"
}

rollback() {
  local prior=$1 prior_manifest=$2 manifest="$WORK/rollback.json" target artifact started id value
  local head proposal container sentinel=".update-e2e-rollback-sentinel"
  for container in "$FLEET_A" "$FLEET_B"; do
    container_exec "$container" sh -c "printf %s '$prior' >'$(install_path)/$sentinel'"
  done
  container_exec "$SOURCE" bash -lc \
    'cd /work/source &&
     printf "%s\n" "migration-free rollback release" >update-e2e-rollback-marker.txt &&
     git add update-e2e-rollback-marker.txt &&
     git commit -m "update e2e crash target"' >/dev/null
  head="$(container_exec "$SOURCE" git -C /work/source rev-parse --short=7 HEAD)"
  wait_for 30 "rollback release proposal" proposal_for "$head"
  approve_release "$WORK/logs/release-proposal-rollback.json" \
    "$WORK/logs/release-approval-rollback.json"
  proposal="$(<"$WORK/logs/release-proposal-rollback.json")"
  jq -e --arg head "$head" '(.headSha[0:7]) as $short |
    .state=="pending" and .headSha==$head and
    (.version|test("\\.dev\\.[1-9][0-9]*\\+[0-9a-f]{7}$")) and
    (.version|endswith("+\($short)"))' <<<"$proposal" >/dev/null
  copy_manifest_out "$manifest"
  jq -e --slurpfile previous "$prior_manifest" '.schema == $previous[0].schema' \
    "$manifest" >/dev/null
  target="$(jq -r .version "$manifest")"
  [[ "$target" == "$(jq -r .version <<<"$proposal")" ]]
  [[ "$target" != "$prior" ]]
  artifact="$(artifact_for "$target")"
  crash_artifact "$manifest" "$artifact"
  copy_manifest_in "$manifest"
  restart_coordinator
  wait_for 30 "crashing target offer" target_is "$target"
  wait_for 60 "rollback fleet reconnect" reported_versions_are "$prior"
  verify_served_crash_artifact "$manifest" "$FLEET_A"
  started="$(start_update)"
  printf '%s\n' "$started" >"$WORK/logs/rollback-start.json"
  id="$(jq -r .operationId <<<"$started")"
  wait_for 300 "rollback operation" terminal_operation "$id"
  value="$(operation "$id")"
  printf '%s\n' "$value" >"$WORK/logs/rollback-operation.json"
  rpc GET updates.fleet >"$WORK/logs/rollback-terminal-fleet.json"
  jq -e '.state=="failed"' <<<"$value" >/dev/null
  grep -Eiq 'rollback|rolled back|stuck|health|successor' <<<"$value"
  wait_for 120 "old bundle restored" installed_versions_are "$prior"
  for container in "$FLEET_A" "$FLEET_B"; do
    [[ "$(container_exec "$container" cat "$(install_path)/$sentinel")" == "$prior" ]]
    container_exec "$container" test ! -e "$(install_path).old"
  done
  container_exec "$FLEET_A" systemctl --user is-active --quiet "$(unit_name)"
  container_exec "$FLEET_B" systemctl --user is-active --quiet "$(unit_name)"
  rpc GET updates.fleet |
    jq -e '[.machines[]|select(.name=="fleet-a" or .name=="fleet-b")|
      select(.state=="stuck" or .state=="rejected")]|length>=1' >/dev/null
}

target_is() { [[ "$(target_version)" == "$1" ]]; }

verify_signed_manifest() {
  local manifest=$1 artifact=$2 signature public
  signature="$(jq -r '.artifacts.headless.platforms["linux-x86_64"].signature' "$manifest")"
  public="$(container_exec "$SOURCE" jq -r .publicKey \
    "$(state_path)/update-signing-key.json")"
  printf %s "$signature" | base64 -d >"$WORK/manifest.sig"
  printf %s "$public" | base64 -d >"$WORK/manifest.pub"
  openssl pkeyutl -verify -pubin -inkey "$WORK/manifest.pub" -keyform DER -rawin \
    -in "$artifact" -sigfile "$WORK/manifest.sig" >/dev/null
}

verify_served_crash_artifact() {
  local manifest=$1 container=$2 archive="$WORK/served-crash.tar.gz"
  local script="$WORK/logs/rollback-served-podium.sh" url
  url="$(jq -r '.artifacts.headless.platforms["linux-x86_64"].url' "$manifest")"
  container_exec "$container" curl -fsSL "$url" >"$archive"
  verify_signed_manifest "$manifest" "$archive"
  tar -xOf "$archive" headless/podium >"$script"
  grep -Fq 'intentional update-e2e successor crash' "$script"
  grep -Fq 'exit 97' "$script"
}

print_hold_access() {
  local tailnet
  if [[ -n "$TAILNET_IP" && -n "$TAILNET_PORT" ]]; then
    tailnet="Tailnet UI: http://$TAILNET_IP:$TAILNET_PORT"
  else
    tailnet="Tailnet UI: unavailable; Tailscale did not expose an IPv4 address when this hold started"
  fi
  cat <<EOF
Host-only UI: http://127.0.0.1:$SOURCE_PORT
$tailnet
Diagnostic entry: $(if [[ -n "$TAILNET_IP" && -n "$TAILNET_PORT" ]]; then
  printf 'http://%s:%s/?e2e=1&activation=first-task' "$TAILNET_IP" "$TAILNET_PORT"
else
  printf 'http://127.0.0.1:%s/?e2e=1&activation=first-task' "$SOURCE_PORT"
fi)
  A cold server-only coordinator has no local coding harness. Open this update-only
  entry and press "Finish setup" to bypass agent selection, exactly as the automated
  updater probe does. This does not verify agent onboarding.
Authentication: none; this isolated coordinator explicitly acknowledges no password.
EOF
}

print_hold_footer() {
  local candidate=$1 rollback
  if git -C "$ROOT" merge-base --is-ancestor 4a8c7afda "$candidate" ||
     git -C "$ROOT" cherry "$candidate" 4a8c7afda | grep -q '^- 4a8c7afda'; then
    rollback="packaged rollback fix 4a8c7afda is included"
  else
    rollback="KNOWN RED: packaged rollback will still refuse because 4a8c7afda is not in the selected source ref"
  fi
  cat <<EOF
Source ref: $HOLD_REF ($candidate)
Rollback status: $rollback
Run label: $LABEL
Scratch directory: $WORK

Container shells:
  docker exec -it $SOURCE bash
  docker exec -it $FLEET_A bash
  docker exec -it $FLEET_B bash

One-line teardown (only this run's labeled containers, exact network, image, and scratch):
  docker ps -aq --filter 'label=$LABEL' | xargs -r docker rm -f && docker network rm '$NETWORK' && docker image rm '$IMAGE' && rm -rf -- '$WORK'

These objects deliberately remain running and consume disk until that teardown command succeeds.
Hold mode is diagnostic and never substitutes for the full matrix or deliberate-red controls.
EOF
}

print_proposal_hold_instructions() {
  local proposal=$1 candidate=$2
  cat <<EOF

MANUAL DEVELOPMENT RELEASE PROPOSAL READY — NOTHING HAS BEEN BUILT OR PUBLISHED
EOF
  print_hold_access
  cat <<EOF
Fleet: fleet-a and fleet-b are paired, online, and still on $BOOTSTRAP_VERSION.
Pending proposal: $(jq -r '.version' <<<"$proposal")
Proposal HEAD: $(jq -r '.headSha' <<<"$proposal")
Proposal branch: $(jq -r '.branch' <<<"$proposal")
Commits shown since the running source: $(jq -r '.commits | length' <<<"$proposal")
Added migrations: $(jq -r '.addedMigrations | length' <<<"$proposal")

Manual path:
  1. Open the coordinator UI (use the diagnostic entry if onboarding asks for agents).
  2. Open Settings -> Updates and review the pending development release.
  3. Approve it there. That human action starts the heavy build and publication.
  4. Watch the Building and publishing state and its logs.
  5. After the offer appears, accept it from the same Update panel.

The bootstrap package used to create the cold machines was built automatically.
The proposed development release has not been built; only your approval starts it.
EOF
  print_hold_footer "$candidate"
}

print_published_hold_instructions() {
  local target=$1 candidate=$2
  cat <<EOF

MANUAL COLD UPDATE TOPOLOGY READY — OBJECTS PERSIST UNTIL TORN DOWN
EOF
  print_hold_access
  cat <<EOF
Fleet: fleet-a and fleet-b are already paired, online, and still on $BOOTSTRAP_VERSION.
Published offer: $target
EOF
  print_hold_footer "$candidate"
}

main() {
  local preflight=0
  case "${1:-}" in
    --help|-h) usage; exit 0 ;;
    --preflight) preflight=1 ;;
    '') ;;
    *) usage >&2; exit 2 ;;
  esac
  [[ "$INSTANCE" != default ]] || die "instance must not be default"
  [[ "$INSTANCE" =~ ^[a-z][a-z0-9-]{0,31}$ ]] || die "invalid instance '$INSTANCE'"
  (( HOST_UID != 0 )) || die "run as a non-root host user"
  [[ "$MIN_FREE_GB" =~ ^[0-9]+$ ]] || die "disk floor must be a whole number of GiB"
  if hold_at_proposal; then
    (( MIN_FREE_GB >= 4 )) || die "proposal hold disk floor cannot be lower than 4 GiB"
  elif [[ "$ONLY" == server ]]; then
    (( MIN_FREE_GB >= 2 )) || die "packaged-server disk floor cannot be lower than 2 GiB"
  else
    (( MIN_FREE_GB >= 10 )) || die "disk floor cannot be lower than 10 GiB"
  fi
  [[ -z "$PROVE_FAILURE" || "$PROVE_FAILURE" == schema ||
    "$PROVE_FAILURE" == tampered || "$PROVE_FAILURE" == server-assets ||
    "$PROVE_FAILURE" == coordinator-participant ||
    "$PROVE_FAILURE" == server-migration || "$PROVE_FAILURE" == server-client ||
    "$PROVE_FAILURE" == server-handover || "$PROVE_FAILURE" == server-agent ||
    "$PROVE_FAILURE" == server-rollback ]] || die "unknown deliberate failure control"
  [[ -z "$ONLY" || "$ONLY" == legacy || "$ONLY" == positive || "$ONLY" == server ]] ||
    die "focused lane must be legacy, positive, or server"
  [[ -z "$ONLY" || -z "$PROVE_FAILURE" ||
    ( "$ONLY" == server && "$PROVE_FAILURE" == server-* ) ]] ||
    die "failure controls require the complete matrix"
  [[ "$HOLD" == 0 || "$HOLD" == 1 || "$HOLD" == proposal || "$HOLD" == published ]] ||
    die "hold mode must be 0, proposal, published, or the published alias 1"
  if hold_enabled && [[ -n "$ONLY" || -n "$PROVE_FAILURE" ]]; then
    die "hold mode cannot be combined with focused or deliberate-red lanes"
  fi
  bash -n "$ROOT/scripts/docker-update-e2e/provision.sh"
  local tool
  for tool in awk df docker; do
    command -v "$tool" >/dev/null 2>&1 || die "missing command '$tool'"
  done
  docker info >/dev/null
  DOCKER_ROOT="$(docker info --format '{{.DockerRootDir}}')"
  START_FREE="$(free_bytes)"
  if (( START_FREE < MIN_FREE_GB * 1024 * 1024 * 1024 )); then
    printf 'REFUSED: update gate needs %s GiB free; only %.2f GiB is available.\n' \
      "$MIN_FREE_GB" "$(awk -v b="$START_FREE" 'BEGIN{print b/1073741824}')" >&2
    printf 'No Docker object was created. Free disk; do not lower the floor merely to force this shared host.\n' >&2
    exit 78
  fi
  for tool in base64 bun curl git jq mktemp openssl rcodesign realpath stat tar zig; do
    command -v "$tool" >/dev/null 2>&1 || die "missing command '$tool'"
  done
  docker image inspect ubuntu:24.04 >/dev/null 2>&1 || die "missing base image ubuntu:24.04"
  [[ -d "$ROOT/node_modules" ]] || die "worktree node_modules is missing"
  local dependency_root
  dependency_root="$(realpath "$ROOT/node_modules/@podium/protocol" 2>/dev/null)" ||
    die "worktree @podium/protocol link is missing"
  case "$dependency_root" in
    "$ROOT"/*) ;;
    *) die "worktree dependency escaped into another checkout: $dependency_root" ;;
  esac
  ZIG_BIN="$(realpath "$(command -v zig)")"
  ZIG_ROOT="$(dirname "$ZIG_BIN")"
  [[ -x "$ZIG_ROOT/zig" && -d "$ZIG_ROOT/lib" ]] || die "incomplete Zig installation at $ZIG_ROOT"
  RCODESIGN_BIN="$(realpath "$(command -v rcodesign)")"
  if (( preflight == 1 )); then
    say "preflight passed for named instance $INSTANCE"
    exit 0
  fi

  WORK="$(mktemp -d "${TMPDIR:-/tmp}/$RUN_ID.XXXXXX")"
  mkdir -p "$WORK/logs" "$WORK/bootstrap" "$WORK/cache/upper" \
    "$WORK/cache/work" "$WORK/cache/merged" "$WORK/node-modules/upper" \
    "$WORK/node-modules/work"
  trap cleanup EXIT
  trap 'on_error "$LINENO" "$BASH_COMMAND"' ERR
  trap 'exit 130' INT
  trap 'exit 143' TERM
  say "run=$RUN_ID instance=$INSTANCE label=$LABEL"

  prepare_image
  require_disk_margin "image preparation"
  docker network create --label "$LABEL" "$NETWORK" >/dev/null

  local repo_root candidate
  local -a source_ports=(-p "127.0.0.1::18787")
  repo_root="$(dirname "$(git -C "$ROOT" rev-parse --git-common-dir)")"
  if hold_enabled; then
    candidate="$(git -C "$ROOT" rev-parse "$HOLD_REF^{commit}")"
    if command -v tailscale >/dev/null 2>&1; then
      TAILNET_IP="$(tailscale ip -4 2>/dev/null | sed -n '1p')"
    fi
    if [[ "$TAILNET_IP" =~ ^100\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      source_ports+=(-p "$TAILNET_IP::18787")
    else
      TAILNET_IP=""
    fi
  else
    candidate="$(git -C "$ROOT" rev-parse HEAD)"
  fi
  docker run -d --name "$SOURCE" --label "$LABEL" --network "$NETWORK" \
    --hostname source --privileged --cgroupns=private --tmpfs /run --tmpfs /run/lock \
    "${source_ports[@]}" -v "$repo_root:/input:ro" \
    -v "$WORK/bootstrap:/bootstrap" \
    -v "${HOME}/.bun/bin/bun:/home/podium/.local/bin/bun:ro" \
    -v "${HOME}/.bun/install/cache:/bun-cache-lower:ro" \
    -v "$WORK/cache:/bun-cache-cow" \
    -v "$ROOT/node_modules:/node-modules-lower:ro" \
    -v "$WORK/node-modules:/node-modules-cow" \
    -v "$ZIG_ROOT:/opt/host-tools/zig-root:ro" \
    -v "$RCODESIGN_BIN:/opt/host-tools/rcodesign:ro" "$IMAGE" >/dev/null
  docker exec "$SOURCE" mount -t overlay overlay \
    -o lowerdir=/bun-cache-lower,upperdir=/bun-cache-cow/upper,workdir=/bun-cache-cow/work \
    /bun-cache-cow/merged
  container_exec "$SOURCE" sh -lc 'touch /bun-cache-cow/merged/.podium-write-probe &&
    rm /bun-cache-cow/merged/.podium-write-probe &&
    test ! -e /bun-cache-lower/.podium-write-probe'
  wait_for 30 "source systemd" docker exec "$SOURCE" systemctl is-system-running --wait >/dev/null || true
  docker exec "$SOURCE" loginctl enable-linger podium >/dev/null
  wait_for 30 "source user manager" container_exec "$SOURCE" systemctl --user show-environment
  docker exec "$SOURCE" /opt/host-tools/zig-root/zig version >/dev/null
  docker exec "$SOURCE" sh -c '
    printf "int main(void) { return 0; }\n" |
      /opt/host-tools/zig-root/zig cc -target x86_64-linux-musl -x c - \
        -o /tmp/podium-zig-probe
    /tmp/podium-zig-probe
    status=$?
    rm -f /tmp/podium-zig-probe
    exit $status
  '
  docker exec "$SOURCE" /opt/host-tools/rcodesign --version >/dev/null
  SOURCE_PORT="$(docker inspect "$SOURCE" |
    jq -r '.[0].NetworkSettings.Ports["18787/tcp"][] |
      select(.HostIp=="127.0.0.1") | .HostPort')"
  if [[ -n "$TAILNET_IP" ]]; then
    TAILNET_PORT="$(docker inspect "$SOURCE" |
      jq -r --arg ip "$TAILNET_IP" '.[0].NetworkSettings.Ports["18787/tcp"][] |
        select(.HostIp==$ip) | .HostPort')"
  fi

  container_exec "$SOURCE" bash -lc \
    "git clone --local --shared /input /work/source &&
     cd /work/source && git checkout -b update-e2e-source '$candidate' &&
     git config user.name update-e2e && git config user.email update-e2e@invalid" \
    >"$WORK/logs/source-install.log" 2>&1
  docker exec "$SOURCE" mkdir -p /work/source/node_modules
  docker exec "$SOURCE" mount -t overlay overlay \
    -o lowerdir=/node-modules-lower,upperdir=/node-modules-cow/upper,workdir=/node-modules-cow/work \
    /work/source/node_modules
  container_exec "$SOURCE" bash -lc \
    'touch /work/source/node_modules/.podium-write-probe
     rm /work/source/node_modules/.podium-write-probe
     test ! -e /node-modules-lower/.podium-write-probe
     resolved=$(realpath /work/source/node_modules/@podium/runtime)
     case "$resolved" in /work/source/*) ;; *) echo "dependency escaped: $resolved" >&2; exit 1;; esac'

  if [[ "$ONLY" == server ]]; then
    prepare_server_trust_root
  fi

  local bootstrap_private
  bootstrap_private="$(openssl genpkey -algorithm ED25519 -outform DER | base64 -w0)"
  BOOTSTRAP_PUBKEY="$(printf %s "$bootstrap_private" | base64 -d |
    openssl pkey -inform DER -pubout -outform DER | base64 -w0)"
  BOOTSTRAP_VERSION="$(git -C "$ROOT" show "$candidate:package.json" | jq -r .version)"
  container_exec "$SOURCE" env BUN_INSTALL_CACHE_DIR=/bun-cache-cow/merged \
    PODIUM_APP_VERSION="$BOOTSTRAP_VERSION" PODIUM_UPDATE_SIGNING_KEY="$bootstrap_private" \
    PODIUM_ZIG=/opt/host-tools/zig-root/zig PODIUM_RCODESIGN=/opt/host-tools/rcodesign \
    bash -lc 'cd /work/source && bun run package:headless --target=bun-linux-x64' \
    >"$WORK/logs/bootstrap-build.log" 2>&1
  require_disk_margin "bootstrap package build"
  container_exec "$SOURCE" bash -lc \
    'asset=$(find /work/source/dist-bun -type f -name "podium-headless-*.tar.gz" -print -quit)
     test -n "$asset"
     cp "$asset" /bootstrap/podium-headless-linux-x64.tar.gz
     cp "$asset.sig" /bootstrap/podium-headless-linux-x64.tar.gz.sig
     cp /work/source/install.sh /bootstrap/install.sh'
  local legacy_renderer_added=0
  if ! container_exec "$SOURCE" test -f \
      /work/source/scripts/docker-update-e2e/render-legacy-units.ts; then
    legacy_renderer_added=1
    container_exec "$SOURCE" mkdir -p /work/source/scripts/docker-update-e2e
    docker cp "$ROOT/scripts/docker-update-e2e/render-legacy-units.ts" \
      "$SOURCE:/work/source/scripts/docker-update-e2e/render-legacy-units.ts"
  fi
  container_exec "$SOURCE" bash -lc \
    "cd /work/source && bun --conditions=@podium/source \
      scripts/docker-update-e2e/render-legacy-units.ts '$INSTANCE' /bootstrap/legacy"
  if (( legacy_renderer_added == 1 )); then
    container_exec "$SOURCE" rm \
      /work/source/scripts/docker-update-e2e/render-legacy-units.ts
    container_exec "$SOURCE" rmdir /work/source/scripts/docker-update-e2e || true
    [[ -z "$(container_exec "$SOURCE" git -C /work/source status --porcelain)" ]]
  fi
  docker exec -d "$SOURCE" busybox httpd -f -p 8080 -h /bootstrap

  CURRENT_SCENARIO=coordinator-install
  install_podium "$SOURCE" >"$WORK/logs/coordinator-install.log" 2>&1
  launch_coordinator_setup
  wait_for 120 "coordinator setup server" coordinator_healthy
  setup_source
  container_exec "$SOURCE" bash -lc \
    "jq 'del(.persistence)' '$(state_path)/config.json' >'$(state_path)/config.json.new' &&
     mv '$(state_path)/config.json.new' '$(state_path)/config.json'"
  container_exec "$SOURCE" pkill -f 'podium-cli setup' >/dev/null 2>&1 || true
  wait_for 30 "coordinator setup server to stop" coordinator_down
  launch_coordinator_parent
  wait_for 120 "installed coordinator" coordinator_healthy
  curl -fsS "http://127.0.0.1:$SOURCE_PORT/version" \
    >"$WORK/logs/coordinator-version.json"
  wait_for 120 "server-only coordinator participant" coordinator_participant_ready "$BOOTSTRAP_VERSION"
  if coordinator_is_installed_build; then
    pass coordinator-install \
      "coordinator runs the installed $BOOTSTRAP_VERSION build and its one parent-backed participant reports source online, installed, and versioned"
  else
    fail coordinator-install \
      "coordinator did not report the installed $BOOTSTRAP_VERSION build; raw response: logs/coordinator-version.json"
    exit 1
  fi
  rpc POST setup.setChannel '{"channel":"dev"}' >/dev/null
  rpc POST repos.add '{"path":"/work/source"}' >"$WORK/logs/source-repo-add.json"
  rpc GET repos.list >"$WORK/logs/source-repos.json"
  jq -e 'index("/work/source") != null' "$WORK/logs/source-repos.json" >/dev/null

  if [[ "$ONLY" == server ]]; then
    run_server_lane
    CURRENT_SCENARIO=""
    return 0
  fi

  start_container "$FLEET_A" fleet-a -v "$WORK/bootstrap:/bootstrap:ro"
  start_container "$FLEET_B" fleet-b -v "$WORK/bootstrap:/bootstrap:ro"

  CURRENT_SCENARIO=fresh-install
  fresh_install "$FLEET_A" >"$WORK/logs/fresh-install.log" 2>&1
  pass fresh-install "install.sh claimed identity and dev channel, then yielded one parent, server+daemon children, a running in-server janitor, and no janitor process/unit"

  CURRENT_SCENARIO=diagnostic-version
  diagnostic_version

  CURRENT_SCENARIO=fleet-join
  join_fleet
  pass fleet-join "two fresh packaged daemon-only parents had one daemon child, no local server, and appeared online"

  if ! hold_enabled; then
    CURRENT_SCENARIO=fleet-join-refusal
    join_refusal_reports_failure "$JOIN_TOKEN_B"
    pass fleet-join-refusal "a fresh packaged install replaying a consumed credential exited nonzero, named authentication refusal, and printed no join success"
  fi

  CURRENT_SCENARIO=environment
  local container helper
  for container in "$SOURCE" "$FLEET_A" "$FLEET_B"; do
    container_exec "$container" sh -lc 'command -v gzip >/dev/null'
  done
  helper="$(container_exec "$SOURCE" sh -lc \
    'find /work/source/dist-bun/abduco-cache -type f -name "linux-x86_64-*" -print -quit')"
  [[ -n "$helper" ]]
  container_exec "$SOURCE" test -x "$helper"
  container_exec "$SOURCE" "$helper" -v >/dev/null
  for container in "$FLEET_A" "$FLEET_B"; do
    container_exec "$container" test -x "$(state_path)/bin/abduco"
    container_exec "$container" "$(state_path)/bin/abduco" -v >/dev/null
  done
  container_exec "$SOURCE" sh -lc \
    'test -n "$(find /work/source/apps/mobile/dist -type f -name "*.gz" -print -quit)"'
  coordinator_healthy
  pass environment "setup is complete; built and packaged abduco execute, gzip is present, and mobile assets are precompressed"

  if [[ "$ONLY" == legacy ]]; then
    prepare_legacy_machine
    CURRENT_SCENARIO=legacy-migration
    legacy_migration "$LEGACY" >"$WORK/logs/legacy-migration.log" 2>&1
    pass legacy-migration "packaged three-unit layout stayed fully armed through an unhealthy parent and then converged"
    CURRENT_SCENARIO=legacy-sigkill
    fail legacy-sigkill "packaged per-transition SIGKILL coverage is not implemented; source-injected checkpoint evidence remains rejected"
    exit 1
  fi

  if [[ "$ONLY" != positive ]] && ! hold_enabled; then
    CURRENT_SCENARIO=environment
    prepare_schema_control
    prepare_tamper_control
    installed_version_is "$SCHEMA_CONTROL" "$BOOTSTRAP_VERSION"
    installed_version_is "$TAMPER_CONTROL" "$BOOTSTRAP_VERSION"
    pass environment \
      "setup is complete; packaged helpers execute and both refusal controls are joined, old, and pinned away from dev before publication"
  fi

  CURRENT_SCENARIO=dev-release
  wait_for 30 "development release proposal" proposal_ready
  local proposal response detail proposal_log="$WORK/logs/release-proposal-initial.json"
  proposal="$(rpc GET updates.proposal)"
  printf "%s\n" "$proposal" >"$proposal_log"
  # Publisher mints are the flat `X.Y.Z-dev.N+sha` form. Grammar alone is not
  # the safety contract: the build metadata must still name this exact HEAD.
  if ! jq -e '.headSha as $head |
    .state=="pending" and ($head|test("^[0-9a-f]{7}$")) and
    (.version|test("^[0-9]+\\.[0-9]+\\.[0-9]+-dev\\.[1-9][0-9]*\\+[0-9a-f]{7}$")) and
    (.version|endswith("+\($head)"))' <<<"$proposal" >/dev/null; then
    fail dev-release "proposal did not satisfy the HEAD/version identity contract; raw payload: logs/release-proposal-initial.json"
    exit 1
  fi
  if hold_at_proposal; then
    wait_for 60 "held fleet online" fleet_online
    installed_versions_are "$BOOTSTRAP_VERSION"
    if published; then
      fail dev-release "proposal hold published a development manifest before human approval"
      exit 1
    fi
    require_disk_margin "held pending release proposal"
    print_proposal_hold_instructions "$proposal" "$candidate"
    CURRENT_SCENARIO=""
    HOLD_READY=1
    return 0
  fi
  if ! approve_release "$WORK/logs/release-proposal-initial.json" \
      "$WORK/logs/release-approval-initial.json"; then
    response="$(<"$WORK/logs/release-approval-initial.json")"
    detail="$(jq -r 'if type=="object" then (.failure.logs // .failure.message // empty) else empty end' \
      <<<"$response" 2>/dev/null | tr "\n" " " | cut -c1-600 || true)"
    if [[ -z "$detail" ]]; then detail="approval mutation did not return the documented null success response"; fi
    fail dev-release "$detail; proposal: logs/release-proposal-initial.json; response: logs/release-approval-initial.json"
    exit 1
  fi
  wait_for 360 "published development feed" published

  local original="$WORK/original.json" artifact_copy="$WORK/original.tar.gz"
  local target artifact
  copy_manifest_out "$original"
  cp "$original" "$WORK/logs/published-manifest-initial.json"
  target="$(jq -r .version "$original")"
  [[ "$target" == "$(jq -r .version <<<"$proposal")" ]]
  artifact="$(artifact_for "$target")"
  [[ -n "$artifact" ]]
  docker cp "$SOURCE:$artifact" "$artifact_copy"
  verify_signed_manifest "$original" "$artifact_copy"
  curl -fsS "http://127.0.0.1:$SOURCE_PORT/version" \
    >"$WORK/logs/version-after-release.json"
  rpc GET updates.fleet >"$WORK/logs/fleet-after-release.json"
  require_disk_margin "development release build"
  pass dev-release "approved HEAD/version proposal was consumed and produced the matching signed pulled-feed manifest"
  wait_for 30 "update offer" target_is "$target"
  if hold_after_publish; then
    wait_for 60 "held fleet online" fleet_online
    installed_versions_are "$BOOTSTRAP_VERSION"
    require_disk_margin "held development release"
    print_published_hold_instructions "$target" "$candidate"
    CURRENT_SCENARIO=""
    HOLD_READY=1
    return 0
  fi
  CURRENT_SCENARIO=agent-survival
  local shells="[]" shells_ready=0
  if shells="$(create_shells)" &&
     wait_for 60 "durable shells" shells_live "$shells" &&
     wait_for 60 "attached abduco masters" capture_abduco_state "$shells"; then
    shells_ready=1
  else
    blocked agent-survival \
      "BLOCKED-BY-SESSIONS: real packaged sessions did not become live with captured abduco masters; rollout continues without a survival claim"
  fi

  CURRENT_SCENARIO=update-offer
  if ui_probe offer "$target" "$WORK/logs/update-offer-before-controls.png" \
      >"$WORK/logs/update-offer-before-controls.json" \
      2>"$WORK/logs/update-offer-before-controls.stderr"; then
    pass update-offer "the pristine UI rendered the target version and exposed Update Podium before any negative control"
  else
    fail update-offer "the pristine UI offer was not rendered; screenshot, stdout, and stderr are preserved"
  fi


  CURRENT_SCENARIO=version-display
  if ui_probe versions "$BOOTSTRAP_VERSION" "$WORK/logs/version-display-before.png" \
      >"$WORK/logs/version-display-before.json" \
      2>"$WORK/logs/version-display-before.stderr"; then
    pass version-display "baseline UI versions match the packaged source and both fleet machines"
  else
    fail version-display \
      "baseline UI version probe failed; screenshot, stdout, and stderr are preserved; product rows continue"
  fi

  if [[ "$ONLY" == positive ]]; then
    blocked schema-refusal "diagnostic positive lane intentionally omitted refusal mutations"
    blocked unsigned-refusal "diagnostic positive lane intentionally omitted refusal mutations"
    blocked tampered-refusal "diagnostic positive lane intentionally omitted refusal mutations"
  else
    CURRENT_SCENARIO=schema-refusal
    set_machine_channel fleet-a stable
    set_machine_channel fleet-b stable
    if schema_refusal "$original" "$BOOTSTRAP_VERSION" "$SCHEMA_CONTROL"; then
      pass schema-refusal "a proven one-entry migration removal was named and refused on the isolated schema-bearing install before either install changed"
    else
      if [[ -s "$WORK/logs/schema-refusal-operation.json" ]]; then
        detail="$(jq -r '.error.detail // .error.message // "schema operation failed without a named refusal"' \
          "$WORK/logs/schema-refusal-operation.json" 2>/dev/null || true)"
      else
        detail="$(jq -r '[.channelChecks[]? | select(.channel=="dev") | .outcome.reason] | last // "target was not offered and no named schema refusal was reported"' \
          "$WORK/logs/schema-refusal-fleet.json" 2>/dev/null || true)"
      fi
      fail schema-refusal "$detail; raw fleet evidence: logs/schema-refusal-fleet.json"
    fi
    set_machine_channel schema-control stable
    remove_refusal_control "$SCHEMA_CONTROL" schema-control
    if [[ "$PROVE_FAILURE" == schema ]]; then
      say "deliberate schema break remains; rollout must go red"
    else
      copy_manifest_in "$original"
      restart_coordinator
      wait_for 60 "restored signed target" target_is "$target"
    fi

    if [[ "$PROVE_FAILURE" != schema ]]; then
      CURRENT_SCENARIO=unsigned-refusal
      if unsigned_refusal "$original" "$BOOTSTRAP_VERSION"; then
        pass unsigned-refusal "cold resolver named and refused a proven removal of the artifact signature while both installs stayed old"
      else
        fail unsigned-refusal "unsigned manifest did not produce a named resolver refusal while both installs stayed old"
      fi
      copy_manifest_in "$original"
      restart_coordinator
      wait_for 60 "restored signed target" target_is "$target"

      CURRENT_SCENARIO=tampered-refusal
      if tampered_refusal "$artifact" "$BOOTSTRAP_VERSION" "$TAMPER_CONTROL"; then
        if [[ "$PROVE_FAILURE" != tampered ]]; then
          pass tampered-refusal "a byte mutation with a changed digest was named and refused on a disposable old install"
        fi
      else
        fail tampered-refusal "mutated artifact bytes did not produce a named digest/signature refusal on the disposable old install"
      fi
      set_machine_channel tamper-control stable
      remove_refusal_control "$TAMPER_CONTROL" tamper-control
      if [[ "$PROVE_FAILURE" == tampered ]]; then
        say "deliberate byte corruption remains; rollout must go red"
      else
        docker cp "$artifact_copy" "$SOURCE:$artifact"
        docker exec "$SOURCE" chown "$HOST_UID:$HOST_GID" "$artifact"
        restart_coordinator
        wait_for 60 "restored artifact target" target_is "$target"
      fi
    fi
    CURRENT_SCENARIO=rollout
    installed_versions_are "$BOOTSTRAP_VERSION"
    set_machine_channel fleet-a dev
    set_machine_channel fleet-b dev
    installed_versions_are "$BOOTSTRAP_VERSION"
  fi


  CURRENT_SCENARIO=agent-survival
  if (( shells_ready == 0 )) || ! shells_live "$shells" ||
     ! capture_abduco_state "$shells"; then
    shells_ready=0
    if shells="$(create_shells)" &&
       wait_for 60 "fresh durable shells before handover" shells_live "$shells" &&
       wait_for 60 "fresh attached abduco masters before handover" capture_abduco_state "$shells"; then
      shells_ready=1
    else
      blocked agent-survival \
        "BLOCKED-BY-SESSIONS: durable shells could not be re-established immediately before handover"
    fi
  fi

  CURRENT_SCENARIO=ui-acceptance
  capture_parent_state
  local ui_accept operation_id started
  if ui_accept="$(ui_probe accept "$target" "$WORK/logs/update-offer.png" 2>"$WORK/logs/update-accept.stderr")" &&
     operation_id="$(jq -er .operationId <<<"$ui_accept")"; then
    pass ui-acceptance "the human UI accepted the offered target and returned its update operation"
  else
    fail ui-acceptance "UI acceptance failed; screenshot and stderr are preserved; direct RPC continues the wave evidence"
    started="$(start_update)"
    operation_id="$(jq -er .operationId <<<"$started")"
  fi
  CURRENT_SCENARIO=rollout
  rollout "$target" "$BOOTSTRAP_VERSION" "$operation_id"
  CURRENT_SCENARIO=version-display
  if ui_probe versions "$target" "$WORK/logs/version-display.png" \
      >"$WORK/logs/version-display.json" 2>"$WORK/logs/version-display.stderr"; then
    if [[ "${RESULT[version-display]:-}" == PASS ]]; then
      pass version-display \
        "baseline and post-update UI versions match the packaged source and both fleet machines"
    fi
  else
    fail version-display \
      "post-update UI version probe failed; screenshot, stdout, and stderr are preserved"
  fi
  CURRENT_SCENARIO=rollout
  require_disk_margin "canary and widening rollout"
  pass rollout "exactly one in-flight canary preceded widening to two self-handovers without a systemd restart; both installed and reported versions reached the target"
  if (( shells_ready == 1 )); then
    CURRENT_SCENARIO=agent-survival
    if wait_for 60 "durable shells after handover" shells_live "$shells" &&
       wait_for 60 "same abduco masters reattached after handover" \
         abduco_sessions_survived "$shells"; then
      pass agent-survival \
        "real remote shells stayed live and retained the exact attached abduco master PIDs across self-handover"
    else
      fail agent-survival \
        "real remote shells or their exact attached abduco master PIDs did not survive self-handover"
    fi
  fi
  if [[ -n "$PROVE_FAILURE" ]]; then
    fail rollout "deliberate broken input unexpectedly produced a green rollout"
    exit 1
  fi

  CURRENT_SCENARIO=legacy-sigkill
  fail legacy-sigkill "source-backed migration evidence was rejected; per-transition packaged SIGKILL coverage is not implemented"

  prepare_legacy_machine
  CURRENT_SCENARIO=legacy-migration
  legacy_migration "$LEGACY" >"$WORK/logs/legacy-migration.log" 2>&1
  pass legacy-migration "packaged three-unit layout stayed fully armed through an unhealthy parent and then converged"

  CURRENT_SCENARIO=rollback
  rollback "$target" "$original"
  require_disk_margin "rollback"
  pass rollback "migration-free crashing canary restored .old-only sentinels; both installs stayed prior and one reported stuck"

  CURRENT_SCENARIO=""
  [[ "${RESULT[diagnostic-version]:-}" != FAIL && "${RESULT[legacy-sigkill]:-}" != FAIL ]] || exit 1
}

source "$ROOT/scripts/docker-update-e2e/server-lane.sh"
main "$@"
