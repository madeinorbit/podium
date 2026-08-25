#!/usr/bin/env bash
# Fresh Ubuntu acceptance gate for Podium's packaged headless update path.
set -Eeuo pipefail
shopt -s inherit_errexit

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Every request in this gate goes through these helpers so a refusal names its
# URL and echoes its body. See the file header for why (POD-2731).
source "$ROOT/scripts/docker-update-e2e/http.sh"
INSTANCE="${PODIUM_UPDATE_E2E_INSTANCE:-update-e2e}"
MIN_FREE_GB="${PODIUM_UPDATE_E2E_MIN_FREE_GB:-10}"
PROVE_FAILURE="${PODIUM_UPDATE_E2E_PROVE_FAILURE:-}"
ONLY="${PODIUM_UPDATE_E2E_ONLY:-}"
HOLD="${PODIUM_UPDATE_E2E_HOLD:-0}"
HOLD_REF="${PODIUM_UPDATE_E2E_HOLD_REF:-worktree-pod-2462-update-path}"
# THE COORDINATOR'S OWN SHAPE. Defaults to `server`, which is what the scenario
# rows assert against: a server-only coordinator is the shape that exposed
# POD-2668 (the machine running the server could not update itself) and the rows
# below are written for it.
#
# `all-in-one` gives the coordinator a daemon alongside its server, which is the
# topology a real operator usually runs — one machine with both, the rest
# daemon-only. It is a DIFFERENT shape, not a better one: with a daemon present
# the coordinator becomes eligible for things a daemonless one is refused, repo
# hosting among them (POD-2700), so rows that assert a refusal on this machine
# will legitimately read differently. Use it for a hold-mode instance someone
# will drive by hand, not to make a red row green.
COORDINATOR_MODE="${PODIUM_UPDATE_E2E_COORDINATOR_MODE:-server}"
# THE DECISION LOGS ARE INFO, AND INFO WAS BEING THROWN AWAY.
#
# The coordinator already logs every convergence decision its local participant
# makes (POD-2732) and, since POD-2741, why each machine is or is not in the
# wave. Both are `log.info`, and the containers ran at the default level - so a
# run that captured `server.log` faithfully captured only WARN and above, and
# the one evidence that could explain a stalled wave was never written at all.
# Naming the namespaces rather than raising the global level keeps the capture
# readable: a full debug feed would bury these under the build.
UPDATE_LOG_SPEC="${PODIUM_UPDATE_E2E_LOG_SPEC:-server:updates=info,daemon=info}"
RUN_ID="podium-update-e2e-$(date +%s)-$$"
# KEEP THE EVIDENCE BY DEFAULT.
#
# `cleanup` deletes $WORK, and everything a red row points at lives in it - the
# operation JSON, the fleet snapshots, the per-machine decision logs. Three
# separate gate runs investigating a flaky row threw all of it away because the
# output dir is an env var somebody has to remember, and each time the only
# surviving trace was a 120-line tail in a terminal. Opting OUT is the rarer
# need, so it is the flag now.
EVIDENCE_DIR="${PODIUM_UPDATE_E2E_OUTPUT_DIR:-${TMPDIR:-/tmp}/$RUN_ID-evidence}"
LABEL="dev.podium.update-e2e.run=$RUN_ID"
IMAGE="$RUN_ID:ubuntu24"
NETWORK="$RUN_ID"
SOURCE="$RUN_ID-source"
FLEET_A="$RUN_ID-fleet-a"
FLEET_B="$RUN_ID-fleet-b"
SERVER_CONSUMER="$RUN_ID-server"
REAL_CONSUMER="$RUN_ID-real-release"
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
# THE ADDRESS THE INSTANCE HANDS OUT (POD-2767).
#
# `publicUrl` is not a label. It is the address this instance tells every other
# party to come back to: the join token embeds its ws-ified form as the daemon's
# `serverUrl`, and the browser and the desktop shell are pointed at it. So it has
# to be an address that answers from where a client actually is.
#
# It used to be `http://source:18787` — `source` being the container's NAME ON
# THE RUN'S PRIVATE DOCKER NETWORK. That resolves for a joining fleet daemon and
# nowhere else, so the first human to open a held sandbox got a URL their browser
# could not resolve and had to correct it by hand. Advertising an address only
# the advertiser can reach is the same defect that strands a real machine behind
# a NAT; here it happened to be the sandbox we point humans at.
#
# `resolve_advertised_url` picks the best address the run WAS ACTUALLY EXPOSED
# ON, and `advertised_url_reachable` is the row that will not let it drift back.
ADVERTISED_URL=""
ADVERTISED_VIA=""
NETWORK_GATEWAY=""
GATEWAY_PORT=""
# THE ONLY ORIGIN THIS SANDBOX CAN BE HONESTLY TESTED FROM (POD-2762).
#
# A service worker exists only in a secure context. Held sandboxes were reached
# over `http://100.x.y.z:<port>`, where `navigator.serviceWorker` is undefined —
# so every hands-on run of the update path had NO precache, and the offline-first
# layer the product actually ships was never once exercised. The crash that
# opened POD-2762 (four chunks refused mid-handover) is what that looks like from
# the outside. `scripts/sandbox-https.sh` fronts the published port with the
# node's real tailnet certificate; these two hold the entry it created so the
# footer can name the teardown and cleanup can take it back down.
TAILNET_HTTPS_PORT=""
TAILNET_HTTPS_URL=""
SERVER_PORT=""
REAL_PORT=""
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
  SCENARIOS=(environment resource-safety coordinator-install advertised-url server-install server-assets server-migration
    server-client-reconnect server-handover server-agent-survival server-rollback cleanup host-disk)
elif [[ "$ONLY" == real-release ]]; then
  # THE ONLY LANE THAT DOES NOT START AT CURRENT SOURCE (POD-2769).
  SCENARIOS=(environment resource-safety coordinator-install real-release-install
    real-release-pairing-refusal real-release-resolve real-release-converged cleanup host-disk)
else
  SCENARIOS=(environment resource-safety coordinator-install advertised-url fresh-install diagnostic-version fleet-join
    fleet-join-refusal version-display dev-release update-offer schema-refusal tampered-refusal
    unsigned-refusal ui-acceptance agent-survival rollout legacy-migration legacy-sigkill rollback cleanup host-disk)
fi
declare -A RESULT=()
declare -A DETAIL=()
declare -A PARENT_PID=()
declare -A PARENT_INVOCATION=()
declare -A PARENT_RESTARTS=()

# WHY THIS ROW IS RED, IN THE ROW ITSELF (POD-2747, decided in POD-2462).
#
# A permanent red with no stated cause becomes a row people skip, then a row
# people delete, and then a gap nobody remembers choosing. So the reason ships in
# the evidence string: the matrix has to say this is a DECISION, not a failure.
#
# It is red because nothing here executes product code. The migration's nine kill
# boundaries are exposed only through `deps.checkpoint`, an optional injected
# dependency on `reconcileSupervision`; all three production call sites in
# apps/cli/src/cli.ts pass either nothing or only `parentHealthy`. Driving them
# against the PACKAGED binary would therefore mean adding a kill-phase seam to
# the shipped artifact — a production seam existing solely for a test. This epic
# refused to relax the tampered-artifact refusal, the disk floor and the
# capability guard to satisfy checks; this would be the same trade with a better
# excuse, and unlike those it would ship.
#
# What makes it a limitation rather than a hole is that the behaviour beneath IS
# covered: scripts/topology-migration-live.integration.test.ts kills the
# production migrator at each boundary it can reach and passes 7/7, verified
# armed by pointing its recovery probe at a dead port (all four recovery phases
# redden). Two production boundaries — after-legacy-runtime-mask and
# after-parent-start — are covered by NOTHING, packaged or source; that gap is
# tracked separately and is cheap to close in that same vitest matrix.
#
# ONE string, used by both call sites. Two copies of a sentence drifting apart is
# the defect this row's own issue existed to fix; it is not being reintroduced
# three lines from its own explanation.
LEGACY_SIGKILL_DECIDED_RED="DECIDED RED, not a regression: no product code is reachable from this row. \
The migration's kill boundaries are exposed only through an optional injected deps.checkpoint that no \
production call site passes, so reaching them against the packaged binary needs a test-only seam in the \
shipped artifact — refused. The behaviour beneath is covered at 7/7 by \
scripts/topology-migration-live.integration.test.ts, proven armed. This row will not go green; do not \
skip it, delete it, or read it as a defect."

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
PODIUM_UPDATE_E2E_PROVE_FAILURE=canary  build a coordinator that skips the
                                      canary stage; `rollout` must go red for
                                      that reason and nothing else
PODIUM_UPDATE_E2E_ONLY=legacy         run the packaged legacy migration row
                                      while release minting is unavailable
PODIUM_UPDATE_E2E_ONLY=server         update a packaged all-in-one server from
                                      a run-local production-shaped edge feed
PODIUM_UPDATE_E2E_ONLY=real-release   install the REAL published 0.1.0 artifact and
                                      let ITS OWN updater take a new release
PODIUM_UPDATE_E2E_REAL_RELEASE=X.Y.Z  which published release to start from (0.1.0)
PODIUM_UPDATE_E2E_REAL_RELEASE_CACHE=PATH
                                      a directory already holding that release's
                                      tarball, .sig and install.sh (skips gh)
PODIUM_UPDATE_E2E_PROVE_FAILURE=real-release-migration
                                      break the topology migration's one write;
                                      real-release-converged must go red for it
PODIUM_UPDATE_E2E_PROVE_FAILURE=server-*  arm one server assertion (see docs)
PODIUM_UPDATE_E2E_PROVE_FAILURE=coordinator-participant
                                      restore the old server-only no-participant shape
PODIUM_UPDATE_E2E_PROVE_FAILURE=advertised-url
                                      complete setup with the container-internal
                                      `http://source:18787` again; `advertised-url`
                                      must go red for that reason and nothing else
PODIUM_UPDATE_E2E_ONLY=positive       run the offer, rollout, survival, and
                                      rollback path without refusal controls
PODIUM_UPDATE_E2E_HOLD=proposal       leave a release proposal pending for a
                                      human to approve and build
PODIUM_UPDATE_E2E_HOLD=published      publish a cold signed release and leave
                                      it for consumer testing (`1` alias)
PODIUM_UPDATE_E2E_HOLD=real-release   leave a REAL published 0.1.0 install standing
                                      with the new release offered to it, to drive
                                      the upgrade by hand (needs ONLY=real-release)
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
  for container in "$SOURCE" "$FLEET_A" "$FLEET_B" "$SERVER_CONSUMER" "$REAL_CONSUMER" "$LEGACY" "$SCHEMA_CONTROL" "$TAMPER_CONTROL"; do
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
  # A run that is NOT holding leaves nothing behind, and the serve entry is the
  # one object here that is not a container: it is machine-wide config that
  # would otherwise survive as a proxy onto a port nothing listens on.
  stop_https_front
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

# THE GATE STOPS WATCHING BEFORE THE PRODUCT STOPS TRYING (POD-2747).
#
# `UPDATE_STEP_MACHINES.silenceMs` is `machineDeliverySilenceMs` (the daemon's
# download timeout, 5 min) plus `machineSilenceMarginMs` (2 min) — seven minutes,
# armed by the engine rather than aged when someone reads `fleet()`. On breach
# the engine does not merely re-check: it marks the step stalled, re-enters
# `ensure`, and REISSUES GRANTS. A wave can therefore look completely dead for
# seven minutes and then complete normally, on its own.
#
# Every operation wait in this gate is DELIBERATELY shorter than that, and they
# stay that way. A fleet update that converges only because the stall deadline
# gave up and retried has failed, and a gate that waited past the budget would go
# green on precisely that defect — lengthening these to clear a red would turn a
# race into a slower race and hide the bug the red is pointing at.
#
# What was missing is that the timeout never SAID so. "did not reach a terminal
# state within 300s" reads as "the wave is dead", and a reader — human or agent —
# had no way to tell that from "we stopped watching at 300s of a 420s budget the
# product was still working through". That ambiguity cost this epic hours. Note
# the 300s waits equal the download timeout exactly: they were sized from one
# half of the budget and the margin was missed.
UPDATE_MACHINES_SILENCE_BUDGET_S=$((5 * 60 + 2 * 60))
say_watch_budget() {
  local waited=$1
  (( waited < UPDATE_MACHINES_SILENCE_BUDGET_S )) || return 0
  say "NOTE: this gave up after ${waited}s, INSIDE the product's ${UPDATE_MACHINES_SILENCE_BUDGET_S}s machines-step silence budget. On breach the engine marks the step stalled, re-enters ensure and REISSUES GRANTS, so a wave that looks dead here can still converge on its own. This red means the wave did not converge PROMPTLY — which is the assertion — and NOT that the product would never have recovered. Do not lengthen this wait to clear it: past ${UPDATE_MACHINES_SILENCE_BUDGET_S}s the row would go green on a stalled wave that only recovered by retry." >&2
}

rpc() {
  local verb=$1 proc=$2 input=${3:-} url body=""
  url="http://127.0.0.1:$SOURCE_PORT/trpc/$proc"
  if [[ "$verb" == GET ]]; then
    [[ -z "$input" ]] || url="$url?input=$(printf %s "$input" | jq -sRr @uri)"
    http_request GET "$url" || return 1
  else
    body="$input"
    [[ -n "$body" ]] || body='{}'
    http_request POST "$url" "$body" || return 1
  fi
  # A 2xx carrying a tRPC error is a refusal too, and names itself the same way.
  if jq -e '.error' >/dev/null 2>&1 <<<"$HTTP_BODY"; then
    report_http_failure "$verb" "$url" "$body" "$HTTP_STATUS" "$HTTP_BODY"
    return 1
  fi
  jq -c '.result.data' <<<"$HTTP_BODY"
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
  container_http_probe "$1" GET http://127.0.0.1:18787/version || return 1
  jq -e '.components.janitor.state=="running" and
    (.components.janitor.progressVersion|type=="number") and
    .components.daemon.state=="connected"' >/dev/null <<<"$HTTP_BODY"
}

all_in_one_participant_ready() {
  local container=$1 expected=$2
  container_http_probe "$container" GET http://127.0.0.1:18787/trpc/updates.fleet ||
    return 1
  jq -e --arg expected "$expected" '
      (.result.data.json // .result.data) as $fleet |
      [$fleet.allMachines[] | select(.online == true and
        .installKind == "installed" and .version == $expected)] | length == 1' \
    >/dev/null <<<"$HTTP_BODY"
}

fresh_install() {
  local container=${1:-$FLEET_A}
  install_podium "$container"
  local command unit main_pid children roles units
  command="$(command_path)"
  unit="$(unit_name)"
  docker exec -d --user podium --env HOME=/home/podium \
    --env "XDG_RUNTIME_DIR=/run/user/$HOST_UID" --env "PODIUM_INSTANCE=$INSTANCE" \
    --env PODIUM_PORT=18787 --env PODIUM_HOST=0.0.0.0 \
    "$container" bash -lc "exec '$command' setup >>/tmp/podium-source.log 2>&1"
  wait_for 60 "fresh setup server" \
    container_http_probe "$container" GET http://127.0.0.1:18787/health
  container_http_request "$container" POST \
    http://127.0.0.1:18787/trpc/setup.complete \
    '{"publicUrl":"http://127.0.0.1:18787","mode":"all-in-one","port":18787,"acknowledgeNoPassword":true}'
  ! jq -e '.error' >/dev/null 2>&1 <<<"$HTTP_BODY"
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
  if ! container_http_request "$container" GET http://127.0.0.1:18787/health; then
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

# THE LADDER, MOST USEFUL ANSWER FIRST (POD-2767).
#
# Every rung is an address that answers from BOTH sides: from outside the run,
# where the human's browser and the desktop shell are, and from inside the run's
# own network, where the joining fleet daemons are. Both halves are load-bearing
# and neither is incidental — the join token embeds the ws-ified `publicUrl` as
# each daemon's `serverUrl`, so a rung that only the outside can reach breaks the
# fleet exactly as thoroughly as `http://source:18787` broke the browser. All
# three rungs were measured from a container and from the host before this went
# in; the row below re-measures the chosen one on every run.
#
# 1. THE TAILNET HTTPS FRONT, and it is first on purpose. It is the only rung
#    that is a TRUSTED SECURE ORIGIN, and a service worker is defined only in a
#    secure context — so it is the only address where the precache, the offline
#    shell and the reload handshake exist AT ALL (POD-2762), and the only one the
#    macOS desktop webview will accept. The plain-HTTP rungs below are not a
#    slightly worse URL for the same product; they are a different product.
#    A TRAP WORTH KNOWING BEFORE IT COSTS AN HOUR: probe this front's `/daemon`
#    with plain `curl` and it answers 502, which reads as "websockets do not
#    survive the proxy" and would condemn this rung. They do. `serve` negotiates
#    h2, and an HTTP/1.1 Upgrade sent over h2 is what gets refused; `curl
#    --http1.1` against the same URL returns `101 Switching Protocols`. Every
#    client that matters here — the daemon's `ws`, and a browser opening a
#    WebSocket — handshakes over HTTP/1.1, so the join is unaffected.
# 2. The host's tailnet address. Still reachable from every device on the
#    tailnet, just without the secure context. This is where a host that has
#    Tailscale but no working `serve` lands.
# 3. The run's own docker gateway. The host owns that address and every container
#    on this run's network routes to it, so it always exists: no Tailscale, no
#    account, nobody's particular machine. It is reachable from THIS host only,
#    which is the honest answer for a run that was never exposed any further.
#
# The tailnet name is read from the node itself and the gateway from the network
# this run just created. No hostname belonging to any person appears here, and a
# fixture that only worked on one person's machine would not be a fixture.
resolve_advertised_url() {
  if [[ "$PROVE_FAILURE" == advertised-url ]]; then
    # The deliberate control: the exact value that shipped before POD-2767.
    ADVERTISED_URL="http://source:18787"
    ADVERTISED_VIA="the source container's name on this run's private docker network (deliberate control)"
    return 0
  fi
  if [[ -n "$TAILNET_HTTPS_URL" ]]; then
    ADVERTISED_URL="$TAILNET_HTTPS_URL"
    ADVERTISED_VIA="this node's own tailnet HTTPS front, a trusted secure origin"
    return 0
  fi
  if [[ -n "$TAILNET_IP" && -n "$TAILNET_PORT" ]]; then
    ADVERTISED_URL="http://$TAILNET_IP:$TAILNET_PORT"
    ADVERTISED_VIA="this host's tailnet address; plain HTTP, so no service worker"
    return 0
  fi
  if [[ -n "$NETWORK_GATEWAY" && -n "$GATEWAY_PORT" ]]; then
    ADVERTISED_URL="http://$NETWORK_GATEWAY:$GATEWAY_PORT"
    ADVERTISED_VIA="this run's own docker gateway; plain HTTP, reachable from this host only"
    return 0
  fi
  # Nothing exposed this run anywhere. Say so and keep the old value, so the row
  # below reddens on the real defect instead of the run dying before it prints a
  # matrix — but do NOT let the value pass itself off as a considered choice.
  ADVERTISED_URL="http://source:18787"
  ADVERTISED_VIA=""
  say "this run was exposed on no address reachable from outside its container network" >&2
}

setup_source() {
  [[ -n "$ADVERTISED_URL" ]] || die "setup_source ran before the advertised address was resolved"
  container_http_request "$SOURCE" POST \
    http://127.0.0.1:18787/trpc/setup.complete \
    "{\"publicUrl\":\"$ADVERTISED_URL\",\"mode\":\"$COORDINATOR_MODE\",\"port\":18787,\"acknowledgeNoPassword\":true}" ||
    return 1
  ! jq -e '.error' >/dev/null 2>&1 <<<"$HTTP_BODY"
}

# THE ROW THAT WILL NOT LET IT DRIFT BACK (POD-2767).
#
# Twenty-one rows watched this gate and not one asked whether the address the
# instance HANDS OUT is an address anybody can reach, so a coordinator advertised
# a name that resolved on its own private network and nowhere else for as long as
# the harness existed. The first person to notice was a human who had to retype
# the URL by hand.
#
# Two decisions make this row mean something rather than agree with itself:
#
# It reads the address back FROM THE INSTANCE (`setup.info` — what the machine
# says about itself) rather than from `$ADVERTISED_URL`. Asserting the value this
# script just sent would only prove the script remembers its own variable; the
# question is what the instance now tells clients.
#
# It fetches that address FROM THE HOST, outside the container network. Fetching
# it from inside is what made the old value look fine: `http://source:18787`
# answers perfectly from within the run and is unreachable from everywhere a
# client actually is.
#
# The loopback check is not belt-and-braces either. `http://127.0.0.1:<mapped>`
# would answer this row's fetch from the host and is exactly as useless to every
# other client as `http://source:18787` was, so the fetch alone would call the
# same class of defect green.
advertised_url_reachable() {
  local advertised host
  if ! rpc GET setup.info >"$WORK/logs/advertised-url.json"; then
    fail advertised-url \
      "the coordinator would not say what address it advertises; raw response: logs/advertised-url.json"
    return 1
  fi
  advertised="$(jq -r '.publicUrl // empty' <"$WORK/logs/advertised-url.json")"
  if [[ -z "$advertised" ]]; then
    fail advertised-url \
      "setup completed but the coordinator advertises no address at all; raw response: logs/advertised-url.json"
    return 1
  fi
  host="${advertised#*://}"
  host="${host%%/*}"
  if [[ "$host" == \[*\]* ]]; then
    # An IPv6 literal is bracketed, so the port is not simply "after the colon";
    # cutting at the first colon would leave `[` and the check below would never
    # fire for `http://[::1]:<port>`.
    host="${host%%\]*}]"
  else
    host="${host%%:*}"
  fi
  # `0.0.0.0` belongs here and is the least obvious member: on Linux curl dials
  # it as localhost, so an instance advertising the address it BOUND rather than
  # the one it is reached at would answer this row's fetch and reach nobody.
  if [[ "$host" == localhost || "$host" == 127.* || "$host" == 0.0.0.0 ||
    "$host" == '[::1]' ]]; then
    fail advertised-url \
      "the coordinator advertises $advertised — a loopback address, which answers here and reaches no client anywhere else"
    return 1
  fi
  if ! http_request GET "$advertised/version"; then
    fail advertised-url \
      "the coordinator advertises $advertised, and that address did not answer /version from the host — outside its container network is where every real client is"
    return 1
  fi
  printf '%s\n' "$HTTP_BODY" >"$WORK/logs/advertised-url-fetch.json"
  if ! jq -e --arg id "$INSTANCE" '.instanceId==$id' >/dev/null <<<"$HTTP_BODY"; then
    fail advertised-url \
      "$advertised answered from the host but as a different instance than $INSTANCE; raw response: logs/advertised-url-fetch.json"
    return 1
  fi
  pass advertised-url \
    "the coordinator advertises $advertised ($ADVERTISED_VIA), and that exact address answered /version as $INSTANCE when fetched from the host, outside the run's container network"
}

coordinator_healthy() {
  http_probe GET "http://127.0.0.1:$SOURCE_PORT/version" || return 1
  jq -e --arg id "$INSTANCE" '.instanceId==$id' >/dev/null <<<"$HTTP_BODY"
}
coordinator_down() { ! http_probe GET "http://127.0.0.1:$SOURCE_PORT/health"; }

coordinator_parent_registered() {
  container_exec "$SOURCE" bash -lc '
    record="$1/run/parent.pid"
    pid="$(jq -er '\''select(.role == "parent") | .pid'\'' "$record")"
    kill -0 "$pid"
    tr "\0" " " <"/proc/$pid/cmdline" | grep -Eq "(^| )parent( |$)"
  ' _ "$(state_path)"
}

# THE COORDINATOR DOES NOT STAY ON THE BOOTSTRAP VERSION (POD-2747).
#
# The coordinator updates itself in the wave like any other machine: after
# `rollout`, `source` reports the rolled-out version alongside fleet-a and
# fleet-b. Pinning this to $BOOTSTRAP_VERSION was therefore a precondition with
# an expiry date, and `restart_coordinator` carried it into every caller. It
# survived because the only caller downstream of a successful update is
# `rollback`, and `rollback` aborted at its version-grammar assertion long
# before reaching it — so the stale pin was never once executed.
#
# The version is a parameter and the caller names it. What stays unconditional
# is the part that has no expiry: the coordinator answered as an INSTALLED
# build and did not fall back to running from the checkout.
coordinator_is_installed_build() {
  local expected=${1:-$BOOTSTRAP_VERSION}
  http_request GET "http://127.0.0.1:$SOURCE_PORT/version" || return 1
  jq -e --arg id "$INSTANCE" --arg version "$expected" \
    '.instanceId==$id and .appVersion==$version and
      (.appVersion|startswith("dev+")|not)' >/dev/null <<<"$HTTP_BODY"
}

coordinator_participant_ready() {
  local expected=$1
  rpc GET updates.fleet |
    jq -e --arg expected "$expected" '
      [.allMachines[] | select(.name == "source" and .online == true and
        .installKind == "installed" and .version == $expected)] | length == 1' >/dev/null
}

coordinator_version_is() {
  http_probe GET "http://127.0.0.1:$SOURCE_PORT/version" || return 1
  jq -e --arg expected "$1" '.appVersion == $expected' >/dev/null <<<"$HTTP_BODY"
}

launch_coordinator_setup() {
  docker exec -d --user podium --env HOME=/home/podium \
    --env "XDG_RUNTIME_DIR=/run/user/$HOST_UID" --env "PODIUM_INSTANCE=$INSTANCE" \
    --env PODIUM_PORT=18787 --env PODIUM_HOST=0.0.0.0 \
    --env PODIUM_DEV_SOURCE_ROOT=/work/source \
    --env PODIUM_NO_RELAY=1 --env PODIUM_NO_SCOPE=1 \
    --env PODIUM_LOG="$UPDATE_LOG_SPEC" \
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
    --env PODIUM_LOG="$UPDATE_LOG_SPEC" \
    --env BUN_BIN=/home/podium/.local/bin/bun --env BUN_INSTALL_CACHE_DIR=/bun-cache-cow/merged \
    --env PODIUM_ZIG=/opt/host-tools/zig-root/zig \
    --env PODIUM_RCODESIGN=/opt/host-tools/rcodesign \
    "${participant_env[@]}" \
    "$SOURCE" bash -lc \
    "cd /work/source && exec '$(command_path)' parent --takeover >>/tmp/podium-source.log 2>&1"
}

restart_coordinator() {
  # The version the coordinator is expected to come back on. Defaults to the
  # bootstrap build, which is right for every caller that runs before the wave;
  # `rollback` runs after it and names the rolled-out version instead.
  local expected=${1:-$BOOTSTRAP_VERSION}
  container_exec "$SOURCE" pkill -f 'podium-cli parent --takeover' >/dev/null 2>&1 || true
  wait_for 30 "coordinator to stop" coordinator_down
  launch_coordinator_parent
  wait_for 120 "coordinator to restart" coordinator_healthy
  wait_for 30 "restarted coordinator parent registry" coordinator_parent_registered
  coordinator_is_installed_build "$expected"
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
  ! container_http_probe "$container" GET http://127.0.0.1:18787/health
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

# THE HEAD/VERSION IDENTITY CONTRACT, WRITTEN ONCE (POD-2747).
#
# Publisher mints are the flat `X.Y.Z-dev.N+sha` form. Grammar alone is not the
# safety contract: the build metadata must still name this exact HEAD.
#
# This lived as two copies, and they drifted — one tested the version against
# `\.dev\.`, a DOT before `dev`, where the mint has a HYPHEN. The correct copy
# was fixed 37 minutes after both were written and the other was missed, which
# is the expensive shape of a half-applied change: the surviving copy looks
# deliberate. Two rows assert this contract, so it gets one implementation.
#
# `expected` is optional. Omitted, the proposal is checked for internal
# consistency — the version names the headSha the proposal itself reports.
# Given, the headSha must also equal that value, which is how a caller pins the
# proposal to a commit it just made. It is compared whole: a truncating slice
# hides which half of the comparison is wrong, and `rev-parse --short=7` can
# return MORE than seven characters when the prefix is ambiguous.
proposal_identity_holds() {
  local proposal=$1 expected=${2:-}
  jq -e --arg expected "$expected" '.headSha as $head |
    .state=="pending" and ($head|test("^[0-9a-f]{7}$")) and
    (.version|test("^[0-9]+\\.[0-9]+\\.[0-9]+-dev\\.[1-9][0-9]*\\+[0-9a-f]{7}$")) and
    (.version|endswith("+\($head)")) and
    ($expected=="" or $head==$expected)' <<<"$proposal" >/dev/null
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
# `canceled`, one L: TERMINAL_OPERATION_STATES in
# packages/protocol/src/operation/operation.ts. The `cancelled` this replaces
# matched no state the server can produce, so a canceled operation was waited
# out to the full timeout instead of being read as the outcome it already was.
terminal_operation() {
  local value
  value="$(operation "$1")"
  [[ -n "$value" ]] &&
    jq -e '.state=="done" or .state=="failed" or .state=="canceled"' <<<"$value" >/dev/null
}

# No update operation is in flight. `updates.start` does not refuse a second
# caller — it hands back the one already running (`alreadyRunning`, see
# startUpdateOperation in apps/server/src/modules/updates/trpc.ts) — so a
# scenario that starts one while a previous operation is still going does not
# get an operation of its own. It silently inherits the previous scenario's.
no_update_in_flight() {
  rpc GET operations.history '{"kind":"update","limit":20}' |
    jq -e '[.[]|select((.state|IN("done","failed","canceled"))|not)]|length==0' >/dev/null
}

# THE OPERATION THIS SCENARIO STARTED, AND NOTHING ELSE.
#
# Waiting for the fleet to be quiet before starting is the wait this harness was
# missing. Without it one operation that outlives a scenario's patience is
# adopted by every scenario after it: the next refusal waits out the SAME stuck
# operation, and the UI's Update click returns its id to `rollout`, which then
# grades a wave that was never its own. That is how two unrelated rows came to
# fail and pass together.
#
# `alreadyRunning` is asserted as well as waited for. The wait can only lose a
# race the server can still resolve in our favour, and a silently adopted
# operation must never again read as this scenario's result.
start_update() {
  local started
  # 420s is the product's own bound, not a number tuned until this went green:
  # UPDATE_STEP_DEADLINES[machines] is machineDeliverySilenceMs (the daemon's
  # download timeout) plus machineSilenceMarginMs (2 min) in
  # apps/server/src/modules/updates/operation.ts. An operation that has not
  # settled by then is a genuine stall, and saying so is the point.
  if ! wait_for 420 "no update operation in flight" no_update_in_flight; then
    dump_update_operations "${CURRENT_SCENARIO}-inflight-before-start"
    say "refusing to start: an earlier update operation is still running" >&2
    return 1
  fi
  started="$(rpc POST updates.start '{"surface":"settings"}')" || return 1
  if jq -e '.alreadyRunning == true' >/dev/null 2>&1 <<<"$started"; then
    printf '%s\n' "$started" >"$WORK/logs/${CURRENT_SCENARIO}-adopted-operation.json"
    say "updates.start returned an already-running operation; not adopting it" >&2
    return 1
  fi
  printf %s "$started"
}

# WHAT THE OPERATION WAS ACTUALLY DOING WHEN WE GAVE UP.
#
# A refusal that times out used to leave nothing behind but the word "timeout".
# The step states, and the per-place convergence state and detail, are the only
# things that can say whether a machine was never granted, is still downloading,
# or answered and was not heard — so they are written out before the row fails.
dump_update_operations() {
  local label=$1
  rpc GET operations.history '{"kind":"update","limit":20}' \
    >"$WORK/logs/$label-operations.json" 2>&1 || true
  rpc GET updates.fleet >"$WORK/logs/$label-fleet.json" 2>&1 || true
}

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

# WHY THIS ROW WENT RED, IN ITS OWN WORDS.
#
# Every `return 1` below used to be reported by the same sentence about an offer
# that had, in the runs that produced it, been made correctly. A row that names
# the wrong cause is worse than a row that names none: it sends the next reader
# to the wrong subsystem. Each refusal is now recorded where it happens.
refusal_reason() {
  printf '%s\n' "$1" >"$WORK/logs/${CURRENT_SCENARIO}-failure-reason.txt"
  return 1
}

refusal_failure_detail() {
  local scenario=$1 reason="$WORK/logs/$1-failure-reason.txt"
  if [[ -s "$reason" ]]; then
    tr -d '\n' <"$reason"
    return 0
  fi
  printf %s "$scenario failed before it recorded a reason"
}

negative_refusal() {
  local old=$1 pattern=$2 started id value container name expected='[]' stuck
  shift 2
  if ! started="$(start_update)"; then
    refusal_reason "no update operation of this scenario's own could be started; an earlier operation was still running, or the server refused a new one"
    return 1
  fi
  if ! id="$(jq -er .operationId <<<"$started")"; then
    refusal_reason "updates.start returned no operation id"
    return 1
  fi
  if ! wait_for 150 "refusal operation" terminal_operation "$id"; then
    dump_update_operations "${CURRENT_SCENARIO}-stalled"
    # The stuck step and the place holding it open — the two facts that separate
    # "never granted" from "granted and still downloading" from "answered and
    # not heard". Guessing between those is what cost this suite its credibility.
    # `deferred` is the plan's own record of WHY a machine was left out of the
    # wave — `offline` or `cannot-take-delivery`, decided in planUpdateOperation
    # and carried on the operation. It was always there and never read; printing
    # it is what turns "target was not offered" into a machine and a reason.
    stuck="$(operation "$id" |
      jq -r '([.steps[]? | select(.state=="running" or .state=="stalled") |
        "\(.id)=\(.state)[\([.places[]? | "\(.name // .id):\(.state // "?")\(if .detail then " (" + .detail + ")" else "" end)"] | join(", "))]"] | join("; ")) as $running |
        ([.deferred[]? | "\(.name // .id) left out of the wave (\(.reason))"] | join("; ")) as $left |
        [(if ($running | length) > 0 then $running else "no running step" end),
         (if ($left | length) > 0 then $left else empty end)] | join("; ")' 2>/dev/null || true)"
    say_watch_budget 150
    refusal_reason "the update operation did not reach a terminal state within 150s; stuck at ${stuck:-unknown}"
    return 1
  fi
  if ! value="$(operation "$id")"; then
    refusal_reason "the terminal operation could not be read back from operations.history"
    return 1
  fi
  printf '%s\n' "$value" >"$WORK/logs/${CURRENT_SCENARIO}-operation.json" || return 1
  if ! jq -e '.state=="failed"' <<<"$value" >/dev/null; then
    refusal_reason "the hostile input produced a $(jq -r '.state // "stateless"' <<<"$value") operation instead of a refusal"
    return 1
  fi
  if ! grep -Eiq "$pattern" <<<"$value"; then
    refusal_reason "the operation failed but named no $pattern reason: $(jq -r '.error.detail // .error.message // "no error detail"' <<<"$value")"
    return 1
  fi
  for container in "$@"; do
    name="$(docker inspect -f '{{.Config.Hostname}}' "$container")" || return 1
    expected="$(jq -c --arg name "$name" '. + [$name]' <<<"$expected")" || return 1
  done
  # POD-2668 made the installed coordinator a real member of the dev wave. The
  # refusal controls therefore owe an exact two-place assertion: the local
  # participant and the disposable control, with the ordinary fleet pinned
  # away. Accepting merely "some named failure" here would let the security
  # control pass without proving which installs consumed the hostile input.
  if ! jq -e --argjson expected "$expected" \
      '([.steps[]?.places[]?.name] | unique) == ($expected | unique)' \
      <<<"$value" >/dev/null; then
    refusal_reason "the refusal named the wrong installs: expected $(jq -c <<<"$expected"), got $(jq -c '[.steps[]?.places[]?.name] | unique' <<<"$value")"
    return 1
  fi
  for container in "$@"; do
    if ! installed_version_is "$container" "$old"; then
      refusal_reason "$(docker inspect -f '{{.Config.Hostname}}' "$container") did not stay on $old after refusing the hostile input"
      return 1
    fi
  done
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
    # THE ONLY PLACE ENTITLED TO SAY THE TARGET WAS NOT OFFERED. Every other
    # exit from this scenario now says what actually happened instead of
    # inheriting this sentence.
    refusal_reason "the broken manifest neither produced the target nor a named resolver refusal within 60s: $(jq -r '[.channelChecks[]? | select(.channel=="dev") | .outcome.reason] | last // "the dev channel check reported no reason"' "$WORK/logs/schema-refusal-fleet.json" 2>/dev/null || true)"
    return 1
  fi
  rpc GET updates.fleet >"$WORK/logs/schema-refusal-fleet.json" || return 1
  if ! wait_for 60 "schema control reconnected on its stable pin" \
      fleet_machine_online schema-control true; then
    refusal_reason "schema-control did not come back online within 60s of the coordinator restart, so it could never be offered anything"
    return 1
  fi
  if ! installed_version_is "$container" "$old"; then
    refusal_reason "schema-control was not on $old before the hostile input was offered"
    return 1
  fi
  if ! set_machine_channel schema-control dev; then
    refusal_reason "schema-control could not be pinned to dev"
    return 1
  fi
  if jq -e --arg target "$target" '.targetVersion==$target' \
      "$WORK/logs/schema-refusal-fleet.json" >/dev/null; then
    [[ "$PROVE_FAILURE" == schema ]] && return 0
    negative_refusal "$old" 'schema|migration|regression' "$SOURCE" "$container"
  else
    installed_version_is "$SOURCE" "$old" &&
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
  installed_versions_are "$old" &&
    installed_version_is "$SOURCE" "$old"
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
  negative_refusal "$old" 'digest|signature|tamper|corrupt' "$SOURCE" "$container"
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
# THE BASELINE IS A FILE BECAUSE A SUBSHELL CANNOT DISCARD A FILE (POD-2747).
#
# `wait_for` runs its predicate as `last="$("$@" 2>&1)"`, so everything the
# predicate assigns belongs to a command-substitution subshell that exits one
# line later. `capture_abduco_state` is the ONE predicate that records state, and
# two of its three call sites go through `wait_for` — including the re-capture
# before the handover, which is the one that runs whenever the shells had to be
# re-created. So the recorded masters were thrown away, `abduco_sessions_survived`
# found no PID to compare against, counted nothing, and reported the survival
# lost while the journal showed both masters still attached on their original
# PIDs straight through the successor swap. The row was red for the harness's own
# bookkeeping, never for the product.
#
# The same reason the array failed is the reason the guards below say `|| return
# 1` out loud: with the function called as an `if`/`wait_for` condition, errexit
# is suppressed for its whole body, so a bare `[[ … ]]` decides nothing and
# execution simply walks on to the next line.
abduco_baseline() { printf %s "$WORK/logs/abduco-baseline.tsv"; }
capture_abduco_state() {
  local ids=$1 container listing id line pid found=0 expected baseline
  baseline="$(abduco_baseline)"
  expected="$(jq length <<<"$ids")"
  : >"$baseline.new"
  for container in "$FLEET_A" "$FLEET_B"; do
    listing="$(abduco_listing "$container")" || return 1
    for id in $(jq -r ".[]" <<<"$ids"); do
      line="$(grep -F -- "-$id" <<<"$listing" | head -1 || true)"
      [[ -n "$line" ]] || continue
      [[ "$line" == \** ]] || return 1
      pid="$(cut -f3 <<<"$line" | xargs)"
      [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
      docker exec "$container" kill -0 "$pid" || return 1
      printf '%s\t%s\t%s\n' "$container" "$id" "$pid" >>"$baseline.new"
      (( found += 1 ))
    done
  done
  # Publish only a COMPLETE baseline: a half-captured file would let the survival
  # check compare the masters it happened to see and call that a survival.
  [[ "$found" == "$expected" ]] || return 1
  mv "$baseline.new" "$baseline"
}
abduco_sessions_survived() {
  local ids=$1 container listing id line pid old recorded found=0 expected baseline
  baseline="$(abduco_baseline)"
  expected="$(jq length <<<"$ids")"
  # A missing baseline is a failure to REPORT, not a comparison to skip. The row
  # claims these EXACT masters survived; with nothing recorded there is no claim
  # to make, and reading that as "nothing to check" is precisely how the lost
  # baseline came out looking like lost sessions.
  if [[ ! -s "$baseline" ]]; then
    say "no abduco master baseline was captured, so survival cannot be judged" >&2
    return 1
  fi
  if [[ "$(wc -l <"$baseline")" != "$expected" ]]; then
    say "abduco baseline holds $(wc -l <"$baseline") masters, expected $expected" >&2
    return 1
  fi
  for container in "$FLEET_A" "$FLEET_B"; do
    listing="$(abduco_listing "$container")" || return 1
    while IFS=$'\t' read -r recorded id old; do
      [[ "$recorded" == "$container" ]] || continue
      line="$(grep -F -- "-$id" <<<"$listing" | head -1 || true)"
      [[ -n "$line" && "$line" == \** ]] || return 1
      pid="$(cut -f3 <<<"$line" | xargs)"
      [[ "$pid" == "$old" ]] || return 1
      docker exec "$container" kill -0 "$pid" || return 1
      (( found += 1 ))
    done <"$baseline"
  done
  [[ "$found" == "$expected" ]]
}


reported_versions_are() {
  rpc GET updates.fleet |
    jq -e --arg v "$1" \
      '[.machines[]|select(.name=="source" or .name=="fleet-a" or .name=="fleet-b")|
        select(.online and .version==$v)]|length==3' >/dev/null
}

# READ THE RECORD, DO NOT WATCH FOR THE MOMENT (POD-2754).
#
# This row's claim is that exactly one machine converged before the rest. It
# used to prove that by SAMPLING `updates.fleet` every hundred milliseconds and
# setting a flag if a sample happened to catch the fleet with one machine in
# flight and two still on the old version. That is a transient state, and a
# sampling observer cannot prove a transient fact: when the update ran fast the
# window closed before the first sample landed, the flag stayed zero, and a
# perfectly gated wave was failed for it. The row read FAIL, PASS, FAIL, PASS,
# FAIL across this epic with no product change between several of those runs,
# and POD-2747 measured it flipping about one run in three.
#
# Sampling faster, retrying, or slowing the product down would all have left the
# race in place. So the product now WRITES THE WAVE DOWN: every round of grants
# it issued, what each granted, and every machine it held back with the reason
# (`details.waveRounds`, see `wave.ts`). The canary stage stopped being a moment
# somebody had to be looking at and became a fact in the finished operation.
#
# WHAT MAKES THIS PASS, and every clause is load bearing:
#
#  - the FIRST round of this operation's wave ran under the `canary` gate. A
#    wave that widened from the start has no first canary round at all;
#  - it granted EXACTLY ONE machine. Two is the un-gated wave this row exists to
#    catch;
#  - and it HELD at least one other machine `canary-gated` — eligible, and kept
#    back only because nothing had proved the bundle yet. Without this clause a
#    single-machine fleet would pass a row about ordering between machines;
#  - and a later round GRANTED every machine that first round held, which is the
#    widening. A canary that gated forever is not a rollout.
canary_gated_wave_holds() {
  jq -e '
    (.details.waveRounds // []) as $rounds |
    ($rounds[0] // {}) as $first |
    ($first.held // [] | map(select(.reason=="canary-gated") | .id)) as $gated |
    ([$rounds[] | .granted[]? | .id] | unique) as $everGranted |
    ($rounds | length) > 0 and
    $first.gate == "canary" and
    ($first.granted | length) == 1 and
    ($gated | length) > 0 and
    ($gated - $everGranted | length) == 0
  ' <<<"$1" >/dev/null
}

rollout() {
  local target=$1 id=$2 deadline snapshot value summary last_summary=""
  deadline=$((SECONDS+300))
  while (( SECONDS < deadline )); do
    snapshot="$(rpc GET updates.fleet)" || { sleep 0.1; continue; }
    printf '%s\n' "$snapshot" >"$WORK/logs/rollout-last-fleet.json"
    summary="$(jq -c '[.machines[] | select(.name=="source" or .name=="fleet-a" or .name=="fleet-b") | {name,version,state,online}]' <<<"$snapshot")"
    if [[ "$summary" != "$last_summary" ]]; then
      printf '%s\n' "$summary" >>"$WORK/logs/rollout-transitions.ndjson"
      last_summary="$summary"
    fi
    # Still sampled, and no longer ASSERTED ON: the transition log is how a
    # human reads back what the fleet did, and it costs nothing to keep. What it
    # cannot do is decide the row.
    terminal_operation "$id" && break
    sleep 0.1
  done
  value="$(operation "$id")"
  printf '%s\n' "$value" >"$WORK/logs/rollout-operation.json"
  # An unfinished wave used to fail as a bare `jq -e` with a line number. Say
  # which step is holding it and on which machine, because the answer decides
  # whether this row is about the rollout at all — the id can belong to an
  # operation an earlier scenario started (see the wait before UI acceptance).
  if ! jq -e '.state=="done"' <<<"$value" >/dev/null; then
    dump_update_operations rollout-not-done
    say "rollout operation $id is $(jq -r '.state // "missing from operations.history"' <<<"$value"), not done; steps: $(jq -c '[.steps[]? | {id, state, places: [.places[]? | {name, state, detail}]}]' <<<"$value" 2>/dev/null || printf 'unreadable')" >&2
    say_watch_budget 300
    return 1
  fi
  jq -c '.details.waveRounds // []' <<<"$value" >"$WORK/logs/rollout-wave-rounds.json"
  if ! canary_gated_wave_holds "$value"; then
    # The rounds ARE the diagnosis, so the matrix says what they were rather
    # than a line number. `fail` first, because `on_error` will not overwrite a
    # row that has already said something specific about itself.
    local rounds
    # NAMES, not machine ids. The record carries both; a row that reds at 3am
    # is read by a person, and "fleet-a, fleet-b, source" is the sentence that
    # says what happened where a line of UUIDs says nothing.
    rounds="$(jq -c '[.details.waveRounds[]? |
      {gate,
       granted: [.granted[] | .name // .id],
       held: [.held[] | "\(.name // .id):\(.reason)"]}]' <<<"$value" 2>/dev/null ||
      printf 'unreadable')"
    fail rollout "the update finished, and its wave was not gated on a canary: rounds $rounds (raw: logs/rollout-wave-rounds.json)"
    say "rollout did not gate its wave on a canary; rounds: $rounds" >&2
    return 1
  fi
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

# ASSERT THE CODE, NOT THE SENTENCE (POD-2747).
#
# This row used to grep the whole operation JSON for
# `rollback|rolled back|stuck|health|successor`. The operation says exactly the
# right thing and says it better than that: code `machine-update-not-confirmed`,
# whose contract in operation.ts is "it restarted and came back on the wrong
# version — it is UP, the boot itself is what reported this", carrying the
# message "fleet-a took this update but did not come back on the new version,
# and is running again on the version it had". That is this row's outcome
# described precisely, in prose containing none of the five words. Pinned to
# vocabulary, the assertion would break when the copy improved and pass a
# regression that kept the wording.
#
# Prose is the wrong surface for a gate — POD-2741 lost a day to "target was not
# offered" firing while the offer was perfectly healthy. The codes are a closed
# set built for exactly this question, so match one.
#
# ONE code, not an alternation. `machine-artifact-rejected` here would mean the
# crash bundle failed verification instead of crashing on boot — that is
# tampered-refusal's outcome, and it must never read as this row passing.
rollback_outcome_holds() {
  jq -e '.state=="failed" and .error.code=="machine-update-not-confirmed"' \
    <<<"$1" >/dev/null
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
  # The same contract `dev-release` asserts, pinned additionally to the commit
  # this row just made. One implementation, so the two cannot drift again.
  proposal_identity_holds "$proposal" "$head"
  copy_manifest_out "$manifest"
  jq -e --slurpfile previous "$prior_manifest" '.schema == $previous[0].schema' \
    "$manifest" >/dev/null
  target="$(jq -r .version "$manifest")"
  [[ "$target" == "$(jq -r .version <<<"$proposal")" ]]
  [[ "$target" != "$prior" ]]
  artifact="$(artifact_for "$target")"
  crash_artifact "$manifest" "$artifact"
  copy_manifest_in "$manifest"
  # $prior, not the bootstrap build: the wave already moved the coordinator onto
  # it, which is the same expectation the fleet-reconnect wait below asserts for
  # `source` two lines down.
  restart_coordinator "$prior"
  wait_for 30 "crashing target offer" target_is "$target"
  wait_for 60 "rollback fleet reconnect" reported_versions_are "$prior"
  verify_served_crash_artifact "$manifest" "$FLEET_A"
  started="$(start_update)"
  printf '%s\n' "$started" >"$WORK/logs/rollback-start.json"
  id="$(jq -r .operationId <<<"$started")"
  if ! wait_for 300 "rollback operation" terminal_operation "$id"; then
    dump_update_operations rollback-stalled
    say_watch_budget 300
    return 1
  fi
  value="$(operation "$id")"
  printf '%s\n' "$value" >"$WORK/logs/rollback-operation.json"
  rpc GET updates.fleet >"$WORK/logs/rollback-terminal-fleet.json"
  if ! rollback_outcome_holds "$value"; then
    say "rollback operation ended $(jq -r '.state // "stateless"' <<<"$value")/$(jq -r '.error.code // "no code"' <<<"$value"), expected failed/machine-update-not-confirmed; it said: $(jq -r '.error.message // "no message"' <<<"$value"); raw: logs/rollback-operation.json" >&2
    return 1
  fi
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
  download_from_container "$container" "$url" "$archive"
  verify_signed_manifest "$manifest" "$archive"
  tar -xOf "$archive" headless/podium >"$script"
  grep -Fq 'intentional update-e2e successor crash' "$script"
  grep -Fq 'exit 97' "$script"
}

# THE HOLD URL DECIDED WHICH PRODUCT GOT TESTED (POD-2762).
#
# Everything a held sandbox is for — the update path, the handover, the reload —
# runs differently depending on whether the page has a service worker, and a
# service worker exists ONLY in a secure context. Handing out
# `http://100.x.y.z:<port>` therefore did not merely look shabbier than HTTPS;
# it silently removed the precache, so every lazy chunk went to the network and
# a handover could refuse one mid-flight. Nobody chose that configuration and
# nobody was told they were in it.
#
# So the hold now brings its own HTTPS front up, and this is a best-effort step
# on purpose: a host with no tailnet, or one where `serve` is unavailable, still
# gets a usable sandbox. What it must never do is fail silently — if the front
# does not come up, the access block says so and says what is missing from the
# run, rather than printing a plain URL as though it were equivalent.
# Idempotent because the front is now raised BEFORE setup rather than at the
# hold (POD-2767): the address the instance advertises is chosen from it, so it
# has to exist before `setup.complete`, and the hold points still call this in
# case that early attempt found no tailnet.
start_https_front() {
  [[ -z "$TAILNET_HTTPS_URL" ]] || return 0
  [[ -n "$SOURCE_PORT" ]] || return 0
  local line
  if ! line="$("$ROOT/scripts/sandbox-https.sh" up "$SOURCE_PORT" 2>&1)"; then
    say "https front unavailable: $(tail -n 1 <<<"$line")"
    return 0
  fi
  TAILNET_HTTPS_URL="$(sed -n 's/^HTTPS front: //p' <<<"$line")"
  TAILNET_HTTPS_PORT="${TAILNET_HTTPS_URL##*:}"
  say "https front: $TAILNET_HTTPS_URL -> 127.0.0.1:$SOURCE_PORT"
}

stop_https_front() {
  [[ -n "$TAILNET_HTTPS_PORT" ]] || return 0
  "$ROOT/scripts/sandbox-https.sh" down "$TAILNET_HTTPS_PORT" >/dev/null 2>&1 || true
  TAILNET_HTTPS_PORT=""
  TAILNET_HTTPS_URL=""
}

print_hold_access() {
  local tailnet secure
  if [[ -n "$TAILNET_IP" && -n "$TAILNET_PORT" ]]; then
    tailnet="Plain-HTTP tailnet UI: http://$TAILNET_IP:$TAILNET_PORT"
  else
    tailnet="Plain-HTTP tailnet UI: unavailable; Tailscale did not expose an IPv4 address when this hold started"
  fi
  if [[ -n "$TAILNET_HTTPS_URL" ]]; then
    secure="Secure UI (USE THIS): $TAILNET_HTTPS_URL
  The only origin where the service worker registers, so it is the only one
  where the precache, the offline shell and the reload handshake are under
  test at all. The plain-HTTP URLs below are a DIFFERENT configuration: no
  service worker, no precache, every lazy chunk straight to the network.
  Remove this front when you tear the run down: scripts/sandbox-https.sh down $TAILNET_HTTPS_PORT"
  else
    secure="Secure UI: NONE — this hold has no HTTPS front, so navigator.serviceWorker
  is undefined on every URL below and nothing offline-first is being exercised.
  Bring one up with: scripts/sandbox-https.sh up $SOURCE_PORT"
  fi
  cat <<EOF
$secure
Advertised address: $ADVERTISED_URL
  What this instance hands OUT — the origin a joining machine is told to dial and
  the one the desktop shell is pointed at. It is $ADVERTISED_VIA, and the
  \`advertised-url\` row fetched it from the host before this block printed
  (POD-2767). If it does not match the secure URL above, the run fell back a rung.
Host-only UI: http://127.0.0.1:$SOURCE_PORT
$tailnet
Diagnostic entry: $(if [[ -n "$TAILNET_HTTPS_URL" ]]; then
  printf '%s/?e2e=1&activation=first-task' "$TAILNET_HTTPS_URL"
elif [[ -n "$TAILNET_IP" && -n "$TAILNET_PORT" ]]; then
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
  docker ps -aq --filter 'label=$LABEL' | xargs -r docker rm -f && docker network rm '$NETWORK' && docker image rm '$IMAGE' && rm -rf -- '$WORK'$(
  if [[ -n "$TAILNET_HTTPS_PORT" ]]; then
    printf '\n\nThe HTTPS front is machine-wide config and OUTLIVES the containers, so it is a\nseparate line — and it names one port, never a reset, because this host serves\nother things (the live instance among them) on the same mechanism:\n  scripts/sandbox-https.sh down %s' "$TAILNET_HTTPS_PORT"
  fi)

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
    "$PROVE_FAILURE" == tampered || "$PROVE_FAILURE" == canary ||
    "$PROVE_FAILURE" == server-assets ||
    "$PROVE_FAILURE" == coordinator-participant ||
    "$PROVE_FAILURE" == advertised-url ||
    "$PROVE_FAILURE" == server-migration || "$PROVE_FAILURE" == server-client ||
    "$PROVE_FAILURE" == server-handover || "$PROVE_FAILURE" == server-agent ||
    "$PROVE_FAILURE" == server-rollback ||
    "$PROVE_FAILURE" == real-release-migration ]] || die "unknown deliberate failure control"
  [[ -z "$ONLY" || "$ONLY" == legacy || "$ONLY" == positive || "$ONLY" == server ||
    "$ONLY" == real-release ]] ||
    die "focused lane must be legacy, positive, server, or real-release"
  # The real-release control only exists inside its own lane; arming it anywhere
  # else would mutate a host no row is watching and report nothing.
  [[ "$PROVE_FAILURE" != real-release-migration || "$ONLY" == real-release ]] ||
    die "PROVE_FAILURE=real-release-migration needs PODIUM_UPDATE_E2E_ONLY=real-release"
  [[ -z "$ONLY" || -z "$PROVE_FAILURE" ||
    ( "$ONLY" == server && "$PROVE_FAILURE" == server-* ) ||
    ( "$ONLY" == real-release && "$PROVE_FAILURE" == real-release-* ) ]] ||
    die "failure controls require the complete matrix"
  [[ "$HOLD" == 0 || "$HOLD" == 1 || "$HOLD" == proposal || "$HOLD" == published ||
    "$HOLD" == real-release ]] ||
    die "hold mode must be 0, proposal, published, real-release, or the published alias 1"
  # THE ONE HOLD THAT IS A FOCUSED LANE, because the thing being held IS the lane:
  # a machine that starts at a real released install. It cannot be reached from the
  # complete matrix, which has no such machine in it.
  if [[ "$HOLD" == real-release ]]; then
    [[ "$ONLY" == real-release ]] ||
      die "hold mode real-release needs PODIUM_UPDATE_E2E_ONLY=real-release"
    [[ -z "$PROVE_FAILURE" ]] ||
      die "hold mode cannot be combined with a deliberate-red control"
  elif hold_enabled && [[ -n "$ONLY" || -n "$PROVE_FAILURE" ]]; then
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
  # The bottom rung of the advertised-address ladder (POD-2767). The host owns
  # this address and every container on this network routes to it, so publishing
  # the coordinator here gives the run one address both sides can reach on any
  # machine — no Tailscale, no account, nobody's particular hostname.
  NETWORK_GATEWAY="$(docker network inspect "$NETWORK" |
    jq -r 'first(.[0].IPAM.Config[]? | .Gateway // empty |
      select(test("^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+$"))) // empty')"

  local repo_root candidate
  local -a source_ports=(-p "127.0.0.1::18787")
  if [[ -n "$NETWORK_GATEWAY" ]]; then
    source_ports+=(-p "$NETWORK_GATEWAY::18787")
  fi
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
  if [[ -n "$NETWORK_GATEWAY" ]]; then
    GATEWAY_PORT="$(docker inspect "$SOURCE" |
      jq -r --arg ip "$NETWORK_GATEWAY" '.[0].NetworkSettings.Ports["18787/tcp"][] |
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

  if [[ "$ONLY" == server || "$ONLY" == real-release ]]; then
    prepare_server_trust_root
  fi

  # BEFORE THE BOOTSTRAP BUILD, because the coordinator that plans the wave is
  # the one this build installs. Arming after it would leave the running product
  # unchanged and prove nothing (POD-2754).
  if [[ "$PROVE_FAILURE" == canary ]]; then
    docker cp "$ROOT/scripts/docker-update-e2e/skip-canary.ts" \
      "$SOURCE:/work/source/scripts/docker-update-e2e/skip-canary.ts"
    # COMMITTED, not just written. The development publisher refuses to build a
    # `dev+<sha>` artifact from a checkout that does not match its own HEAD —
    # rightly, since the bytes would not be the commit they claim to be — so an
    # arming control that only edited the file failed `dev-release` and never
    # reached the row it was arming.
    container_exec "$SOURCE" bash -lc \
      'cd /work/source && bun --conditions=@podium/source \
        scripts/docker-update-e2e/skip-canary.ts &&
       git add -A &&
       git commit -m "update e2e: a coordinator that skips the canary stage"' \
      >"$WORK/logs/skip-canary.log" 2>&1
    say "$(grep skip-canary: "$WORK/logs/skip-canary.log" | head -1)"
    container_exec "$SOURCE" bash -lc \
      'cd /work/source && test -z "$(git status --porcelain)"' ||
      die "the canary control left /work/source dirty"
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
  # Both before `setup_source`, and in this order: the address the instance is
  # about to advertise is chosen from whatever the run was actually exposed on,
  # and the HTTPS front is the rung we want it to land on (POD-2767).
  start_https_front
  resolve_advertised_url
  setup_source
  container_exec "$SOURCE" bash -lc \
    "jq 'del(.persistence)' '$(state_path)/config.json' >'$(state_path)/config.json.new' &&
     mv '$(state_path)/config.json.new' '$(state_path)/config.json'"
  container_exec "$SOURCE" pkill -f 'podium-cli setup' >/dev/null 2>&1 || true
  wait_for 30 "coordinator setup server to stop" coordinator_down
  launch_coordinator_parent
  wait_for 120 "installed coordinator" coordinator_healthy
  wait_for 30 "installed coordinator parent registry" coordinator_parent_registered
  http_get "http://127.0.0.1:$SOURCE_PORT/version" \
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

  # Straight after the coordinator is a real installed build and before anything
  # joins it, because what it advertises is what a joining daemon will be handed
  # (POD-2767). Red here stops the run the way `coordinator-install` does: an
  # instance nobody can reach is not a base to test an update path on, and a hold
  # that reached this point would be handing a human the broken URL again.
  CURRENT_SCENARIO=advertised-url
  advertised_url_reachable || exit 1
  # Handed back at once. `on_error` reddens whatever row is CURRENT, and the
  # next assignment is far below the two fleet `start_container` calls — so a
  # container that dies at boot was landing on this row's name with this row's
  # evidence string replaced by a line number. A row must never absorb a failure
  # from a fixture it does not own; that is how a green row starts looking flaky
  # and a real defect gets read as somebody else's.
  CURRENT_SCENARIO=""

  rpc POST setup.setChannel '{"channel":"dev"}' >/dev/null
  # The checkout is the publisher source via PODIUM_DEV_SOURCE_ROOT; it must
  # NOT be registered as a hosted repo. The sandbox coordinator is server-only
  # (POD-2668), and POD-2700 structurally refuses `repos.add` onto a machine
  # that runs no daemon — a refusal this harness would otherwise trip over.

  if [[ "$ONLY" == server ]]; then
    run_server_lane
    CURRENT_SCENARIO=""
    return 0
  fi

  if [[ "$ONLY" == real-release ]]; then
    run_real_release_lane
    CURRENT_SCENARIO=""
    return 0
  fi

  # These two containers ARE the fresh-install fixture, so the row owns their
  # boot as well as their behaviour: a fleet container that dies before systemd
  # comes up is a fresh-install failure and should say so, not arrive as an
  # unattributed line number.
  CURRENT_SCENARIO=fresh-install
  start_container "$FLEET_A" fleet-a -v "$WORK/bootstrap:/bootstrap:ro"
  start_container "$FLEET_B" fleet-b -v "$WORK/bootstrap:/bootstrap:ro"

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
    fail legacy-sigkill "$LEGACY_SIGKILL_DECIDED_RED"
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
  if ! proposal_identity_holds "$proposal"; then
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
    start_https_front
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
  http_get "http://127.0.0.1:$SOURCE_PORT/version" \
    >"$WORK/logs/version-after-release.json"
  rpc GET updates.fleet >"$WORK/logs/fleet-after-release.json"
  require_disk_margin "development release build"
  pass dev-release "approved HEAD/version proposal was consumed and produced the matching signed pulled-feed manifest"
  wait_for 30 "update offer" target_is "$target"
  if hold_after_publish; then
    wait_for 60 "held fleet online" fleet_online
    installed_versions_are "$BOOTSTRAP_VERSION"
    require_disk_margin "held development release"
    start_https_front
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
      detail="$(refusal_failure_detail schema-refusal)"
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
        fail tampered-refusal "$(refusal_failure_detail tampered-refusal)"
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
  # THE WAIT THE ROLLOUT ROW WAS MISSING. The refusal scenarios above leave a
  # real operation behind, and `updates.start` joins a running one rather than
  # refusing — so clicking Update while one is still going hands `rollout` an
  # operation that belongs to a negative control. Wait for the fleet to be
  # quiet, then the click can only produce an operation of its own.
  if ! wait_for 420 "no update operation in flight before UI acceptance" no_update_in_flight; then
    dump_update_operations ui-acceptance-inflight-before-click
    say "an earlier update operation is still running as UI acceptance begins" >&2
  fi
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
  rollout "$target" "$operation_id"
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
  pass rollout "the operation recorded a first wave round that granted one canary and held the rest for it, then a later round that granted every machine it held; two self-handovers without a systemd restart; both installed and reported versions reached the target"
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
  fail legacy-sigkill "$LEGACY_SIGKILL_DECIDED_RED"

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
source "$ROOT/scripts/docker-update-e2e/real-release-lane.sh"

# Run only when executed, so the helpers above can be sourced and tested on their
# own. When this file IS the program, BASH_SOURCE[0] and $0 are the same path.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
