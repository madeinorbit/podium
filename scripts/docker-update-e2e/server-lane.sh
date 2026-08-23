# Packaged all-in-one server update lane.
#
# This is sourced by docker-update-e2e.sh after its generic helpers are defined.
# The source coordinator is only a build host. The update target is a separate,
# clean Ubuntu machine installed from the signed package and left all-in-one.
# It resolves an ordinary edge manifest from a run-local HTTPS origin so no
# checkout participates in the target's runtime or self-handover.

SERVER_ROLLBACK_FAILURE=""

server_rpc() {
  local verb=$1 proc=$2 input=${3:-} response url body
  url="http://127.0.0.1:$SERVER_PORT/trpc/$proc"
  if [[ "$verb" == GET ]]; then
    if [[ -n "$input" ]]; then
      response="$(curl -fsS "$url?input=$(printf %s "$input" | jq -sRr @uri)")"
    else
      response="$(curl -fsS "$url")"
    fi
  else
    body=${input:-'{}'}
    response="$(curl -fsS -H 'content-type: application/json' -d "$body" "$url")"
  fi
  if jq -e '.error' >/dev/null 2>&1 <<<"$response"; then
    jq -r '.error.json.message // .error.message // .' <<<"$response" >&2
    return 1
  fi
  jq -c '.result.data' <<<"$response"
}

server_healthy() {
  curl -fsS "http://127.0.0.1:$SERVER_PORT/version" |
    jq -e --arg id "$INSTANCE" '.instanceId==$id' >/dev/null
}

server_version_is() {
  curl -fsS "http://127.0.0.1:$SERVER_PORT/version" |
    jq -e --arg version "$1" '.appVersion==$version and
      .components.daemon.state=="connected" and
      .components.janitor.state=="running"' >/dev/null
}

server_target_is() {
  server_rpc GET updates.fleet |
    jq -e --arg target "$1" '.targetVersion==$target and .behind==1' >/dev/null
}

server_operation() {
  server_rpc GET operations.history '{"kind":"update","limit":20}' |
    jq -c --arg id "$1" '.[]|select(.id==$id)' | head -1
}

server_terminal_operation() {
  local value history
  history="$(server_rpc GET operations.history '{"kind":"update","limit":20}')" || return 1
  printf '%s\n' "$history" >"$WORK/logs/server-operation-history-latest.json" || return 1
  server_rpc GET updates.fleet >"$WORK/logs/server-rollback-fleet-latest.json" || return 1
  value="$(jq -c --arg id "$1" '.[]|select(.id==$id)' <<<"$history" | head -1)"
  [[ -n "$value" ]] &&
    jq -e '.state=="done" or .state=="failed" or .state=="cancelled"' <<<"$value" >/dev/null
}

server_crash_rollback_observed() {
  local crash_version=$1 journal
  journal="$(container_exec "$SERVER_CONSUMER" journalctl --user --no-pager -n 4000 2>/dev/null)" || return 1
  grep -Fq "intentional packaged-server crash" <<<"$journal" || return 1
  grep -Fq "successor exited before becoming healthy on $crash_version" <<<"$journal" || return 1
  grep -Fq "rolling back to .old bundle" <<<"$journal" || return 1
  printf '%s\n' "$journal" >"$WORK/logs/server-rollback-journal.log" || return 1
}

prepare_server_trust_root() {
  local private_file="$WORK/server-release-private.der" public
  openssl genpkey -algorithm ED25519 -outform DER -out "$private_file"
  SERVER_RELEASE_PRIVATE="$(base64 -w0 <"$private_file")"
  public="$(openssl pkey -inform DER -in "$private_file" -pubout -outform DER | base64 -w0)"
  SERVER_RELEASE_PUBKEY="$public"
  container_exec "$SOURCE" env PODIUM_UPDATE_E2E_RELEASE_PUBKEY="$public" bash -lc '
    cd /work/source
    bun scripts/docker-update-e2e/patch-release-key.ts packages/runtime/src/update-delivery.ts
    git add packages/runtime/src/update-delivery.ts
    git commit -m "update-e2e: isolate packaged server trust root" >/dev/null
  '
}

prepare_server_release() {
  SERVER_TARGET_VERSION="${BOOTSTRAP_VERSION}.server.1"
  docker cp "$ROOT/scripts/docker-update-e2e/server-migration.sql" "$SOURCE:/tmp/server-migration.sql"
  container_exec "$SOURCE" env TARGET_VERSION="$SERVER_TARGET_VERSION" MIGRATION="$SERVER_MIGRATION" bash -lc '
      set -euo pipefail
      cd /work/source
      mkdir -p "apps/server/src/migrations/drizzle/$MIGRATION"
      cp /tmp/server-migration.sql     "apps/server/src/migrations/drizzle/$MIGRATION/migration.sql"
      jq --arg version "$TARGET_VERSION" ".version=\$version" package.json >package.json.new
      mv package.json.new package.json
      bun run migration:manifest
      git add package.json apps/server/src/migrations
      git commit -m "update-e2e: packaged server migration" >/dev/null
      test -z "$(git status --porcelain)"
    '
  container_exec "$SOURCE" env BUN_INSTALL_CACHE_DIR=/bun-cache-cow/merged PODIUM_APP_VERSION="$SERVER_TARGET_VERSION" PODIUM_UPDATE_SIGNING_KEY="$SERVER_RELEASE_PRIVATE" PODIUM_ZIG=/opt/host-tools/zig-root/zig PODIUM_RCODESIGN=/opt/host-tools/rcodesign bash -lc 'cd /work/source && bun scripts/release.ts --channel=edge' >"$WORK/logs/server-release-build.log" 2>&1
  require_disk_margin "packaged server release build"
  container_exec "$SOURCE" env TARGET_VERSION="$SERVER_TARGET_VERSION" bash -lc '
    set -euo pipefail
    cd /work/source/dist-bun/release
    asset=$(find . -maxdepth 1 -type f -name "podium-headless-*.tar.gz" -printf "%f\n" | head -1)
    test -n "$asset"
    jq -e --arg version "$TARGET_VERSION" ".version==\$version" podium-update.json >/dev/null
    printf "desktop fixture\n" >podium-desktop-e2e.bin
    jq -n --arg version "$TARGET_VERSION"   --arg url "https://github.com/madeinorbit/podium/releases/download/edge/podium-desktop-e2e.bin"   "{version:\$version,bridgeVersion:1,platforms:{\"linux-x86_64\":{url:\$url,signature:\"e2e-companion\"}}}"   >latest.json
  '
}

start_server_edge_feed() {
  container_exec "$SOURCE" bash -lc '
    set -euo pipefail
    mkdir -p /tmp/server-edge
    openssl req -x509 -newkey rsa:2048 -nodes -days 1   -subj "/CN=github.com"   -addext "subjectAltName=DNS:github.com"   -keyout /tmp/server-edge/key.pem -out /tmp/server-edge/cert.pem   >/dev/null 2>&1
  '
  docker exec --user root --env PODIUM_EDGE_FEED_ROOT=/work/source/dist-bun/release --env PODIUM_EDGE_FEED_CERT=/tmp/server-edge/cert.pem --env PODIUM_EDGE_FEED_KEY=/tmp/server-edge/key.pem "$SOURCE" bash -lc '
    set -e
    test -d "$PODIUM_EDGE_FEED_ROOT"
    test -r "$PODIUM_EDGE_FEED_CERT"
    test -r "$PODIUM_EDGE_FEED_KEY"
    nohup /home/podium/.local/bin/bun /work/source/scripts/docker-update-e2e/edge-feed.ts >>/tmp/server-edge.log 2>&1 </dev/null &
    echo $! >/tmp/server-edge.pid
  '
  wait_for 30 "run-local edge feed" docker exec "$SOURCE" curl -kfsS https://127.0.0.1/health >/dev/null
}

configure_server_edge_feed() {
  local source_ip dropin
  source_ip="$(docker inspect -f "{{(index .NetworkSettings.Networks \"$NETWORK\").IPAddress}}" "$SOURCE")"
  container_exec "$SOURCE" cat /tmp/server-edge/cert.pem >"$WORK/server-edge-ca.pem"
  docker cp "$WORK/server-edge-ca.pem" "$SERVER_CONSUMER:/usr/local/share/ca-certificates/update-e2e.crt"
  docker exec "$SERVER_CONSUMER" update-ca-certificates >/dev/null
  docker exec "$SERVER_CONSUMER" sh -c "printf '%s github.com\n' '$source_ip' >>/etc/hosts"
  dropin="/home/podium/.config/systemd/user/$(unit_name).d"
  container_exec "$SERVER_CONSUMER" mkdir -p "$dropin"
  container_exec "$SERVER_CONSUMER" bash -lc "printf '[Service]\nEnvironment=NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/update-e2e.crt\nEnvironment=PODIUM_HOST=0.0.0.0\n' >'$dropin/edge-feed.conf'"
  container_exec "$SERVER_CONSUMER" systemctl --user daemon-reload
  container_exec "$SERVER_CONSUMER" systemctl --user restart "$(unit_name)"
  wait_for 120 "packaged server restart on edge" server_healthy
  server_rpc POST setup.setChannel '{"channel":"edge"}' >/dev/null
  wait_for 60 "packaged server edge target" server_target_is "$SERVER_TARGET_VERSION"
}

server_parent_facts() {
  local prefix=$1 unit pid invocation restarts
  unit="$(unit_name)"
  pid="$(container_exec "$SERVER_CONSUMER" systemctl --user show "$unit" -p MainPID --value)" || return 1
  invocation="$(container_exec "$SERVER_CONSUMER" systemctl --user show "$unit" -p InvocationID --value)" || return 1
  restarts="$(container_exec "$SERVER_CONSUMER" systemctl --user show "$unit" -p NRestarts --value)" || return 1
  [[ "$pid" =~ ^[1-9][0-9]*$ && -n "$invocation" && "$restarts" =~ ^[0-9]+$ ]] || return 1
  printf -v "${prefix}_PID" %s "$pid" || return 1
  printf -v "${prefix}_INVOCATION" %s "$invocation" || return 1
  printf -v "${prefix}_RESTARTS" %s "$restarts" || return 1
}

server_packaged_tree() {
  local unit pid children roles units
  unit="$(unit_name)"
  pid="$(container_exec "$SERVER_CONSUMER" systemctl --user show "$unit" -p MainPID --value)"
  children="$(docker exec "$SERVER_CONSUMER" pgrep -P "$pid" || true)"
  children="${children//$'\n'/ }"
  roles="$(docker exec "$SERVER_CONSUMER" sh -lc "for p in $children; do tr '\\000' ' ' </proc/\$p/cmdline; printf '\\n'; done")"
  units="$(container_exec "$SERVER_CONSUMER" bash -lc 'find "$HOME/.config/systemd/user" -maxdepth 1 -type f -name "podium*.service" -printf "%f\n"')"
  [[ "$units" == "$unit" && "$(wc -w <<<"$children")" == 2 ]]
  grep -Eq '(^|[[:space:]])server([[:space:]]|$)' <<<"$roles"
  grep -Eq '(^|[[:space:]])daemon([[:space:]]|$)' <<<"$roles"
  ! grep -Fq /work/source <<<"$roles"
}

start_server_shell() {
  local answer id
  answer="$(server_rpc POST sessions.create '{"agentKind":"shell","cwd":"/tmp"}')"
  id="$(jq -er .sessionId <<<"$answer")"
  printf %s "$id"
}

server_shell_live() {
  server_rpc GET sessions.list |
    jq -e --arg id "$1" 'any(.[];.sessionId==$id and .status=="live")' >/dev/null
}

server_abduco_pid() {
  local id=$1 listing line pid
  listing="$(abduco_listing "$SERVER_CONSUMER")"
  line="$(grep -F -- "-$id" <<<"$listing" | head -1)"
  [[ "$line" == \** ]]
  pid="$(cut -f3 <<<"$line" | xargs)"
  [[ "$pid" =~ ^[1-9][0-9]*$ ]]
  docker exec "$SERVER_CONSUMER" kill -0 "$pid" >/dev/null
  printf %s "$pid"
}

server_assets_match() {
  local version="$1" current_web="$WORK/logs/server-current-web.json"
  local current_mobile="$WORK/logs/server-current-mobile.json"
  curl -fsS "http://127.0.0.1:$SERVER_PORT/podium-build.json" >"$current_web" || return 1
  curl -fsS "http://127.0.0.1:$SERVER_PORT/mobile/podium-build.json" >"$current_mobile" || return 1
  jq -e --arg version "$version" '.appVersion==$version and (.sourceSha|length)>0' "$current_web" >/dev/null || return 1
  jq -e --arg version "$version" '.appVersion==$version and (.sourceSha|length)>0' "$current_mobile" >/dev/null || return 1
  [[ "$(jq -r .sourceSha "$current_web")" == "$(jq -r .sourceSha "$current_mobile")" ]] || return 1
  [[ "$(jq -r .sourceSha "$current_web")" !=  "$(jq -r .baselineWeb.sourceSha "$WORK/logs/server-client-ready.json")" ]] || return 1
}

server_migration_applied() {
  container_exec "$SERVER_CONSUMER" sqlite3 "$(state_path)/podium.db" "SELECT (SELECT count(*) FROM __drizzle_migrations WHERE name='$SERVER_MIGRATION') || ':' ||
            (SELECT count(*) FROM update_e2e_server_probe WHERE marker='packaged-server');" |
    grep -Fx '1:1' >/dev/null
}

server_self_handover() {
  server_parent_facts SERVER_AFTER || return 1
  [[ "$SERVER_AFTER_PID" != "$SERVER_BEFORE_PID" ]] || return 1
  ! docker exec "$SERVER_CONSUMER" kill -0 "$SERVER_BEFORE_PID" >/dev/null 2>&1 || return 1
  [[ "$SERVER_AFTER_INVOCATION" == "$SERVER_BEFORE_INVOCATION" ]] || return 1
  [[ "$SERVER_AFTER_RESTARTS" == "$SERVER_BEFORE_RESTARTS" ]] || return 1
}

server_wire_reconnected() {
  local digest=$1
  server_rpc GET machines.list |
    jq -e --arg version "$SERVER_TARGET_VERSION" --arg digest "$digest" 'any(.[];.online and .appVersion==$version and .wireSchemaDigest==$digest)' >/dev/null
}

server_client_reconnected() {
  local result="$WORK/logs/server-client-result.json" digest
  [[ -s "$result" ]] &&
    jq -e '.postReconnectFrames>0 and .closed>.initialClosed and
      .sockets>.initialSockets and
      (.current.wireSchemaDigest|type=="string" and length>0) and
      .web.wireSchemaDigest==.current.wireSchemaDigest and
      .mobile.wireSchemaDigest==.current.wireSchemaDigest' "$result" >/dev/null || return 1
  digest="$(jq -er .current.wireSchemaDigest "$result")" || return 1
  server_wire_reconnected "$digest" || return 1
}

arm_server_failure() {
  case "$PROVE_FAILURE" in
    server-assets)
      container_exec "$SERVER_CONSUMER" bash -lc     "printf '{\"appVersion\":\"broken\"}\n' >'$(install_path)/web/podium-build.json'"
      curl -fsS "http://127.0.0.1:$SERVER_PORT/podium-build.json" >"$WORK/logs/server-assets-armed.json"
      jq -e '.appVersion=="broken"' "$WORK/logs/server-assets-armed.json" >/dev/null
      ;;
    server-migration)
      container_exec "$SERVER_CONSUMER" sqlite3 "$(state_path)/podium.db"     "DELETE FROM __drizzle_migrations WHERE name='$SERVER_MIGRATION';"
      ;;
    server-handover)
      container_exec "$SERVER_CONSUMER" systemctl --user restart "$(unit_name)"
      wait_for 60 "deliberate external restart" server_healthy
      ;;
    server-agent)
      docker exec "$SERVER_CONSUMER" kill "$SERVER_ABDUCO_PID"
      ;;
  esac
}

prepare_crashing_server_release() {
  local release=/work/source/dist-bun/release artifact crash_version
  local bundle="$WORK/server-crash.tar.gz" unpack="$WORK/server-crash"
  crash_version="${SERVER_TARGET_VERSION}.crash.1"
  artifact="$(container_exec "$SOURCE" bash -lc "jq -r '.artifacts.headless.platforms[\"linux-x86_64\"].url|split(\"/\")|last' '$release/podium-update.json'")"
  docker cp "$SOURCE:$release/$artifact" "$bundle"
  mkdir -p "$unpack"
  tar -xzf "$bundle" -C "$unpack"
  printf '%s\n' "$crash_version" >"$unpack/headless/VERSION"
  printf '#!/bin/sh\necho intentional packaged-server crash >&2\nexit 97\n' >"$unpack/headless/podium"
  chmod 755 "$unpack/headless/podium"
  tar -czf "$bundle.new" -C "$unpack" headless
  local signature digest
  signature="$(openssl pkeyutl -sign -inkey "$WORK/server-release-private.der" -keyform DER -rawin -in "$bundle.new" | base64 -w0)"
  digest="sha256-$(openssl dgst -sha256 -binary "$bundle.new" | base64 -w0)"
  docker cp "$bundle.new" "$SOURCE:$release/$artifact"
  container_exec "$SOURCE" env VERSION="$crash_version" SIGNATURE="$signature" DIGEST="$digest" bash -lc "
      cd '$release'
      jq --arg version \"\$VERSION\" --arg signature \"\$SIGNATURE\" --arg digest \"\$DIGEST\" '
        .version=\$version |
        .platforms[\"linux-x86_64\"].signature=\$signature |
        .artifacts.headless.platforms[\"linux-x86_64\"].signature=\$signature |
        .artifacts.headless.platforms[\"linux-x86_64\"].digest=\$digest
      ' podium-update.json >podium-update.json.new
      mv podium-update.json.new podium-update.json
    "
  container_exec "$SOURCE" chown "$HOST_UID:$HOST_GID" "$release/$artifact"
  printf %s "$crash_version"
}

server_rollback() {
  local crash_version operation id value
  SERVER_ROLLBACK_FAILURE="the crashing packaged-server release could not be prepared"
  crash_version="$(prepare_crashing_server_release)" || return 1
  container_exec "$SERVER_CONSUMER" systemctl --user restart "$(unit_name)" || return 1
  wait_for 120 "packaged server restart before rollback" server_version_is "$SERVER_TARGET_VERSION" || return 1
  wait_for 60 "crashing server target" server_target_is "$crash_version" || return 1
  operation="$(server_rpc POST updates.start '{"surface":"settings"}')" || return 1
  id="$(jq -er .operationId <<<"$operation")" || return 1
  printf '%s\n' "$operation" >"$WORK/logs/server-rollback-start.json" || return 1
  SERVER_ROLLBACK_FAILURE="the packaged server did not durably observe its crashing successor and .old rollback"
  wait_for 180 "crash and .old rollback transition" server_crash_rollback_observed "$crash_version" || return 1
  SERVER_ROLLBACK_FAILURE="the packaged server did not restore .old after its proven successor crash"
  wait_for 300 "packaged server rollback recovery" server_version_is "$SERVER_TARGET_VERSION" || return 1
  SERVER_ROLLBACK_FAILURE="the restored packaged server did not settle the rollback operation terminal"
  wait_for 60 "rollback operation terminal" server_terminal_operation "$id" || return 1
  value="$(server_operation "$id")" || return 1
  [[ -n "$value" ]] || return 1
  printf '%s\n' "$value" >"$WORK/logs/server-rollback-operation.json" || return 1
  SERVER_ROLLBACK_FAILURE="the terminal rollback operation did not report a named failure"
  jq -e '.state=="failed"' <<<"$value" >/dev/null || return 1
  grep -Eiq 'rollback|rolled back|restor|crash|health|successor' <<<"$value" || return 1
  if [[ "$PROVE_FAILURE" == server-rollback ]]; then
    container_exec "$SERVER_CONSUMER" sh -c "printf broken >'$(install_path)/VERSION'" || return 1
    SERVER_ROLLBACK_FAILURE="deliberate server-rollback mutation made the restored VERSION invalid"
  fi
  installed_version_is "$SERVER_CONSUMER" "$SERVER_TARGET_VERSION" || return 1
  container_exec "$SERVER_CONSUMER" test -d "$(install_path)" || return 1
  container_exec "$SERVER_CONSUMER" test ! -e "$(install_path).old" || return 1
  server_migration_applied || return 1
  SERVER_ROLLBACK_FAILURE=""
}

run_server_lane() {
  CURRENT_SCENARIO=server-install
  start_container "$SERVER_CONSUMER" server -p "127.0.0.1::18787" -v "$WORK/bootstrap:/bootstrap:ro"
  SERVER_PORT="$(docker inspect "$SERVER_CONSUMER" |
    jq -r '.[0].NetworkSettings.Ports["18787/tcp"][0].HostPort')"
  fresh_install "$SERVER_CONSUMER" >"$WORK/logs/server-install.log" 2>&1
  server_packaged_tree
  pass server-install "a fresh packaged all-in-one install owns the server, database, local daemon, and janitor worker with no checkout in its process tree"

  CURRENT_SCENARIO=environment
  prepare_server_release
  start_server_edge_feed
  configure_server_edge_feed
  pass environment "the packaged server resolved a signed release through the unmodified production edge feed and baked release trust root"

  local shell_id browser_ready="$WORK/logs/server-client-ready.json"
  local browser_result="$WORK/logs/server-client-result.json" started id operation
  local break_client=0
  shell_id="$(start_server_shell)"
  wait_for 60 "packaged server shell" server_shell_live "$shell_id"
  SERVER_ABDUCO_PID="$(server_abduco_pid "$shell_id")"
  server_parent_facts SERVER_BEFORE
  [[ "$PROVE_FAILURE" == server-client ]] && break_client=1
  PODIUM_UPDATE_E2E_BREAK_CLIENT="$break_client" PODIUM_UPDATE_E2E_ORIGIN="http://127.0.0.1:$SERVER_PORT" PODIUM_UPDATE_E2E_TARGET="$SERVER_TARGET_VERSION" PODIUM_UPDATE_E2E_READY_FILE="$browser_ready" PODIUM_UPDATE_E2E_RESULT_FILE="$browser_result" bun --conditions=@podium/source "$ROOT/scripts/docker-update-e2e/server-client.ts" >"$WORK/logs/server-client.stdout" 2>"$WORK/logs/server-client.stderr" &
  CLIENT_PROBE_PID=$!
  wait_for 120 "connected packaged web client" test -s "$browser_ready"

  started="$(server_rpc POST updates.start '{"surface":"settings"}')"
  id="$(jq -er .operationId <<<"$started")"
  printf '%s\n' "$started" >"$WORK/logs/server-update-start.json"
  wait_for 360 "packaged server update operation" server_terminal_operation "$id"
  operation="$(server_operation "$id")"
  printf '%s\n' "$operation" >"$WORK/logs/server-update-operation.json"
  jq -e '.state=="done"' <<<"$operation" >/dev/null
  wait_for 180 "packaged server target version" server_version_is "$SERVER_TARGET_VERSION"
  local client_ok=0
  if wait "$CLIENT_PROBE_PID"; then client_ok=1; fi
  CLIENT_PROBE_PID=""

  arm_server_failure

  CURRENT_SCENARIO=server-assets
  if server_assets_match "$SERVER_TARGET_VERSION"; then
    pass server-assets   "fresh web and phone build stamps moved with the packaged server and agree on target version and source"
  else
    fail server-assets "served web or phone assets did not move with the packaged server"
  fi
  CURRENT_SCENARIO=server-migration
  if server_migration_applied; then
    pass server-migration   "the packaged server opened its database and recorded and materialized the target migration exactly once"
  else
    fail server-migration "the target database migration was not both recorded and materialized"
  fi
  CURRENT_SCENARIO=server-client-reconnect
  if (( client_ok == 1 )) && server_client_reconnected; then
    pass server-client-reconnect   "a real browser WebSocket and the local daemon reconnected to the target server and agreed on its version"
  else
    fail server-client-reconnect "browser or local daemon did not reconnect to the target server"
  fi
  CURRENT_SCENARIO=server-handover
  if server_self_handover; then
    pass server-handover   "the packaged server parent self-handed over inside one systemd invocation"
  else
    fail server-handover "the packaged server did not self-handover without systemd"
  fi
  CURRENT_SCENARIO=server-agent-survival
  if server_shell_live "$shell_id" &&
     [[ "$(server_abduco_pid "$shell_id")" == "$SERVER_ABDUCO_PID" ]]; then
    pass server-agent-survival   "the exact attached abduco shell master PID survived; no Codex or Claude agent CLI is installed in the clean container"
  else
    fail server-agent-survival "the packaged server update lost or replaced its attached abduco shell master"
  fi

  if [[ -n "$PROVE_FAILURE" && "$PROVE_FAILURE" != server-rollback ]]; then
    local expected_control="$PROVE_FAILURE"
    case "$expected_control" in
      server-client) expected_control=server-client-reconnect ;;
      server-agent) expected_control=server-agent-survival ;;
    esac
    if [[ "${RESULT[$expected_control]:-}" != FAIL ]]; then
      fail "$expected_control" "deliberate $PROVE_FAILURE mutation did not make its assertion go red"
    fi
    CURRENT_SCENARIO=""
    return 1
  fi

  CURRENT_SCENARIO=server-rollback
  if server_rollback; then
    pass server-rollback   "a migration-free crashing server bundle restored .old and reported the failed update"
  else
    fail server-rollback "${SERVER_ROLLBACK_FAILURE:-the packaged server rollback boundary failed}"
    return 1
  fi
  require_disk_margin "packaged server update and rollback"
  local row
  for row in server-install server-assets server-migration server-client-reconnect server-handover server-agent-survival server-rollback; do
    [[ "${RESULT[$row]:-}" != FAIL ]] || return 1
  done
}
