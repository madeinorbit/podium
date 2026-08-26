# THE ROW THAT STARTS AT A REAL RELEASE (POD-2769).
#
# Every other row in this gate, and every sandbox anyone has ever held, starts at
# CURRENT SOURCE. The legacy-migration row looks like the exception and is not: it
# renders the three-unit layout from today's `cli-systemd` and then watches today's
# binary migrate it. That proves our IDEA of an old install migrates. The component
# that will actually perform the first hop for every existing user — THE OLD
# UPDATER — never runs in it at all.
#
# This lane installs the actual published artifact, from the actual published
# release, and lets ITS OWN updater take the new one:
#
#   1. download the real v0.1.0 tarball and verify it against the REAL baked
#      release key, which is what proves these are the published bytes;
#   2. re-anchor exactly one constant — the trust root — and prove that is the
#      only thing that moved;
#   3. install it with the REAL v0.1.0 install.sh, and let the REAL v0.1.0 code
#      write its own units, its own database, its own config;
#   4. serve a new release at the URL a `stable` install actually fetches;
#   5. let the old server resolve it, the old daemon install it, and assert the
#      machine converges onto the single-unit topology with its data intact.
#
# WHAT THE ONE DEVIATION IS, STATED RATHER THAN HIDDEN: the trust root. v0.1.0
# bakes `PODIUM_UPDATE_PUBKEY` as a module constant with no environment override,
# so a real published binary installs only artifacts signed by the production
# release key. No test has that key and none should. The substitution is a single
# 60-character base64 field inside `podium-cli`, refused unless it appears exactly
# once, and the row asserts on the measured byte delta — see patch-trust-root.ts.
# It is the same isolation the packaged-server lane performs by patching
# `update-delivery.ts` and rebuilding, applied to a real artifact instead of a
# rebuild, and it says nothing about migration, topology, schema or units, which
# are the four things this lane actually asserts on.
#
# WHY THIS LANE IS THE ONE THAT USES THE DEFAULT INSTANCE. Every other row runs a
# NAMED instance, for isolation it genuinely needs. This one must not, for two
# reasons found by running the real artifact:
#
#   - A real 0.1.0 CANNOT COMPLETE A NAMED-INSTANCE INSTALL. It materializes its
#     embedded abduco into the instance state directory before it claims that
#     directory, then refuses to adopt the now non-empty root — so the channel is
#     never persisted and every later command refuses. (Fixed in current code;
#     recorded on POD-2769 as deferred.) The default instance has no such problem,
#     and it is what a real user has.
#   - A named instance also resolves a DIFFERENT PORT (`defaultInstancePorts`
#     hashes the id), while a released install carries no `port` in its config and
#     no `PODIUM_PORT` in its units. Pinning the port with an environment variable
#     to paper over that would be reintroducing the fixture's central untruth into
#     the row written to replace it.
#
# The container is disposable, so the isolation a named instance buys is worth
# nothing here, and fidelity is worth everything.

# The released install this lane starts from. A version, not a moving pointer:
# the row's whole claim is about a specific published artifact.
REAL_RELEASE_VERSION="${PODIUM_UPDATE_E2E_REAL_RELEASE:-0.1.0}"
REAL_RELEASE_TAG="v$REAL_RELEASE_VERSION"
REAL_RELEASE_ASSET="podium-headless-linux-x64.tar.gz"
# The production trust root as v0.1.0 baked it. Committed here for the same reason
# it is committed in install.sh: it is public, and a test that cannot name the key
# it is replacing cannot prove it replaced only that.
REAL_RELEASE_PUBKEY='MCowBQYDK2VwAyEAG12/153QJI/SePyYeJQhBSbh1ZsFgkoMkwb823NiYOU='
# 54 MiB per run is a rude thing to ask of a gate that may run many times, so an
# operator may point this at a directory that already holds the release assets.
REAL_RELEASE_CACHE="${PODIUM_UPDATE_E2E_REAL_RELEASE_CACHE:-}"
REAL_TARGET_VERSION="0.2.0"
REAL_TRUST_PATCH=""
REAL_SEEDED_SESSION=""

# The default instance's own names. Deliberately NOT the gate's instance-scoped
# helpers: this lane is the default instance and nothing else.
REAL_COMMAND=/home/podium/.local/bin/podium
REAL_STATE=/home/podium/.podium
REAL_UNIT_DIR=/home/podium/.config/systemd/user
REAL_PARENT_UNIT=podium.service
real_legacy_unit() { printf 'podium-%s.service' "$1"; }

# `container_exec` pins PODIUM_INSTANCE to the gate's named instance, which is
# exactly what this lane must not be. Same shape, default instance.
real_exec() {
  docker exec --user podium --env HOME=/home/podium \
    --env "XDG_RUNTIME_DIR=/run/user/$HOST_UID" "$REAL_CONSUMER" "$@"
}

# EVERY REQUEST IN THIS LANE IS MADE INSIDE THE CONTAINER, and that is not a
# stylistic choice.
#
# A released install's units carry no `PODIUM_HOST`, so a unit-started server binds
# LOOPBACK INSIDE THE CONTAINER and the published port reaches nothing. The gate
# already knows this: `fresh_install` probes its consumer with
# `container_http_probe` throughout, and the packaged-server lane only starts
# talking to the host port after it has added an explicit `PODIUM_HOST=0.0.0.0`
# drop-in. A lane that reaches in from the host would be testing a machine
# configured differently from the one a user has — and the first row would fail
# for a reason that has nothing to do with the upgrade.
#
# The published port exists for the HUMAN in hold mode, where the drop-in is
# present, and for nothing else.
real_rpc() {
  local verb=$1 proc=$2 input=${3:-} url body=""
  url="http://127.0.0.1:18787/trpc/$proc"
  if [[ "$verb" == GET ]]; then
    [[ -z "$input" ]] || url="$url?input=$(printf %s "$input" | jq -sRr @uri)"
    container_http_request "$REAL_CONSUMER" GET "$url" || return 1
  else
    body=${input:-'{}'}
    container_http_request "$REAL_CONSUMER" POST "$url" "$body" || return 1
  fi
  if jq -e '.error' >/dev/null 2>&1 <<<"$HTTP_BODY"; then
    report_http_failure "$verb" "$url" "$body" "$HTTP_STATUS" "$HTTP_BODY" "$REAL_CONSUMER"
    return 1
  fi
  jq -c '.result.data' <<<"$HTTP_BODY"
}

real_healthy() {
  container_http_probe "$REAL_CONSUMER" GET "http://127.0.0.1:18787/health"
}

real_data_plane_available() {
  container_http_probe "$REAL_CONSUMER" GET "http://127.0.0.1:18787/readiness" || return 1
  jq -e '.dataPlane=="available"' >/dev/null <<<"$HTTP_BODY"
}

real_version_is() {
  container_http_probe "$REAL_CONSUMER" GET "http://127.0.0.1:18787/version" || return 1
  jq -e --arg version "$1" '.appVersion==$version' >/dev/null <<<"$HTTP_BODY"
}

# ASK THE OLD SERVER TO LOOK NOW. v0.1.0 rate-limits a forced check to one feed
# request per channel per 30s and answers from its record inside that window, so
# calling this on every poll is one request, not a loop — and it turns a row that
# would otherwise wait out a daily timer into one that answers in seconds. The
# empty JSON body is required: a bodyless POST is accepted and does nothing.
real_check_now() { real_rpc POST updates.checkNow '{}' >/dev/null 2>&1 || true; }

# THE REFUSAL, READ WHERE THE OLD SERVER ACTUALLY RECORDS IT. `updates.fleet`
# reporting a null target is not evidence on its own — a feed that is merely slow
# looks identical — so the assertion is on the refusal TEXT the old resolver
# produced, which names the reason. v0.1.0 keeps it at
# `channelChecks[].outcome.reason` behind an `unavailable` status.
real_channel_check() {
  real_rpc GET updates.fleet |
    jq -r '[.channelChecks[]? | select(.channel=="stable")] | last
           | if .outcome.status=="unavailable" then .outcome.reason else "" end'
}

real_refusal_names_desktop_pairing() {
  local detail
  real_check_now
  detail="$(real_channel_check)" || return 1
  [[ -n "$detail" ]] || return 1
  printf '%s\n' "$detail" >"$WORK/logs/real-release-pairing-refusal.txt"
  grep -Fq 'desktop build for' <<<"$detail"
}

real_target_is() {
  real_check_now
  real_rpc GET updates.fleet | jq -e --arg target "$1" '.targetVersion==$target' >/dev/null
}

# The stable channel's last recorded check, as "<checkedAt> <status>".
#
# `unavailable` is how every form of "we looked and there is nothing to offer
# you" is recorded, which is precisely why the stranding is silent: the
# operator's Update surface has no target and no error, and reads as up to date.
#
# THE TIMESTAMP IS AS LOAD-BEARING AS THE STATUS, and leaving it out is what let
# the first armed run look green while proving nothing. `updates.checkNow`
# rate-limits a forced check to one feed request per channel per 30s and hands
# back the RECORDED outcome inside that window, so a poll reading only
# `.outcome.status` can be answered entirely from a record made BEFORE this row
# deleted anything. Green would then mean "we have not looked again yet" - the
# exact confusion between a stale answer and a fresh one that the defect under
# test is made of.
real_stable_check() {
  real_check_now
  real_rpc GET updates.fleet |
    jq -r '[.channelChecks[]? | select(.channel=="stable")] | last
           | "\(.checkedAt // 0) \(.outcome.status // "")"'
}

real_stable_check_status() { real_stable_check | cut -d" " -f2; }

# Recorded by the row before it mutates the feed; every later reading must be NEWER.
REAL_STABLE_CHECK_BASELINE=0

real_headless_only_is_offered() {
  local reading at status
  reading="$(real_stable_check)" || return 1
  at="${reading%% *}"
  status="${reading##* }"
  [[ -n "$at" && "$at" != 0 ]] || return 1
  # `ok` recorded AFTER the desktop manifest was deleted, never a surviving `ok`
  # from before it.
  (( at > REAL_STABLE_CHECK_BASELINE )) || return 1
  [[ "$status" == ok ]]
}

# ---------------------------------------------------------------------------
# 1. the published bytes

fetch_real_release() {
  local dir="$WORK/real-release" file
  mkdir -p "$dir"
  if [[ -n "$REAL_RELEASE_CACHE" ]]; then
    for file in "$REAL_RELEASE_ASSET" "$REAL_RELEASE_ASSET.sig" install.sh; do
      [[ -r "$REAL_RELEASE_CACHE/$file" ]] ||
        die "PODIUM_UPDATE_E2E_REAL_RELEASE_CACHE has no $file"
      cp "$REAL_RELEASE_CACHE/$file" "$dir/$file"
    done
  else
    command -v gh >/dev/null 2>&1 ||
      die "the real-release row needs gh to download $REAL_RELEASE_TAG, or a populated PODIUM_UPDATE_E2E_REAL_RELEASE_CACHE"
    gh release download "$REAL_RELEASE_TAG" -R madeinorbit/podium \
      -p "$REAL_RELEASE_ASSET" -p "$REAL_RELEASE_ASSET.sig" -p install.sh \
      -D "$dir" --clobber >"$WORK/logs/real-release-download.log" 2>&1 ||
      die "could not download the published $REAL_RELEASE_TAG assets"
  fi
  # THE ONE CHECK THAT MAKES THIS A REAL RELEASE AND NOT A FIXTURE: the bytes
  # verify against the PRODUCTION key, before anything re-anchors anything.
  printf %s "$REAL_RELEASE_PUBKEY" | base64 -d >"$dir/production.der"
  base64 -d "$dir/$REAL_RELEASE_ASSET.sig" >"$dir/production.sig"
  openssl pkeyutl -verify -pubin -inkey "$dir/production.der" -keyform DER -rawin \
    -in "$dir/$REAL_RELEASE_ASSET" -sigfile "$dir/production.sig" >/dev/null 2>&1 ||
    die "the downloaded $REAL_RELEASE_TAG artifact is NOT signed by the production release key"
  say "verified the published $REAL_RELEASE_TAG artifact against the production release key"
}

# ---------------------------------------------------------------------------
# 2. re-anchor exactly one constant

reanchor_real_release() {
  local dir="$WORK/real-release" unpack="$WORK/real-release-unpack"
  local mirror="$WORK/bootstrap/real-release"
  rm -rf "$unpack"
  mkdir -p "$unpack" "$mirror"
  tar -xzf "$dir/$REAL_RELEASE_ASSET" -C "$unpack"
  [[ -d "$unpack/headless" ]] || die "the published artifact has no headless/ dir"
  [[ "$(cat "$unpack/headless/VERSION")" == "$REAL_RELEASE_VERSION" ]] ||
    die "the published artifact does not carry version $REAL_RELEASE_VERSION"
  REAL_TRUST_PATCH="$(bun --conditions=@podium/source \
    "$ROOT/scripts/docker-update-e2e/patch-trust-root.ts" \
    "$unpack/headless/podium-cli" "$REAL_RELEASE_PUBKEY" "$SERVER_RELEASE_PUBKEY")" ||
    die "could not re-anchor the published artifact onto the run-local trust root"
  printf '%s\n' "$REAL_TRUST_PATCH" >"$WORK/logs/real-release-trust-patch.json"
  jq -e '.occurrences==1 and .sizeUnchanged and .changedInsideConstant' \
    <<<"$REAL_TRUST_PATCH" >/dev/null ||
    die "the trust-root substitution changed more than the trust root: $REAL_TRUST_PATCH"
  tar -czf "$mirror/$REAL_RELEASE_ASSET" -C "$unpack" headless
  openssl pkeyutl -sign -inkey "$WORK/server-release-private.der" -keyform DER -rawin \
    -in "$mirror/$REAL_RELEASE_ASSET" | base64 -w0 >"$mirror/$REAL_RELEASE_ASSET.sig"
  cp "$dir/install.sh" "$mirror/install.sh"
  say "re-anchored the published artifact: $REAL_TRUST_PATCH"
}

# ---------------------------------------------------------------------------
# 3. install it the way a user did

install_real_release() {
  # THE REAL v0.1.0 INSTALLER, not this checkout's. It fetches from a mirror of
  # the published bytes and verifies them itself; PODIUM_INSTALL_PUBKEY is the
  # installer's own documented override and matches the re-anchored artifact.
  # No --instance: a real user's install is the default one.
  real_exec env \
    PODIUM_INSTALL_BASE=http://source:8080/real-release \
    PODIUM_INSTALL_PUBKEY="$SERVER_RELEASE_PUBKEY" \
    PODIUM_NO_MODIFY_PATH=1 \
    sh /bootstrap/real-release/install.sh --channel stable
  real_exec test -x "$REAL_COMMAND"
  [[ "$(real_exec "$REAL_COMMAND" --version)" == "podium $REAL_RELEASE_VERSION" ]]
  real_exec jq -e '.updateChannel == "stable"' "$REAL_STATE/config.json" >/dev/null
}

# The era's own setup flow, driven against the era's own binary. Nothing here
# renders a unit: v0.1.0's code writes them.
real_release_setup() {
  docker exec -d --user podium --env HOME=/home/podium \
    --env "XDG_RUNTIME_DIR=/run/user/$HOST_UID" --env PODIUM_HOST=0.0.0.0 \
    "$REAL_CONSUMER" bash -lc "exec '$REAL_COMMAND' setup >>/tmp/podium-source.log 2>&1"
  wait_for 120 "real $REAL_RELEASE_VERSION setup server" real_healthy
  # IN-CONTAINER, like every other setup call in this gate (`fresh_install`,
  # `setup_source`), and not through the published port. Driven from the host the
  # same mutation answers 503 `server_not_ready` with `dataPlane: blocked` — the
  # pre-setup data plane does not accept it from off-box. Everything AFTER setup
  # is answered on the published port, which is how the packaged-server lane
  # already talks to its consumer.
  container_http_request "$REAL_CONSUMER" POST \
    http://127.0.0.1:18787/trpc/setup.complete \
    "{\"publicUrl\":\"http://127.0.0.1:18787\",\"mode\":\"all-in-one\",\"port\":18787,$(setup_auth_clause)}"
  jq -e '.error' >/dev/null 2>&1 <<<"$HTTP_BODY" && return 1
  # SETUP PERSISTED THE PASSWORD, BUT THIS PROCESS CANNOT SERVE LOGIN YET.
  #
  # v0.1.0 correctly calls a mode/persistence change boot-relevant: after
  # setup.complete it reports activation_pending/restart_required and its
  # authReadinessBoundary answers 503 to /auth/login. A 503 here is not an old
  # release rejecting password setup; it is that release requiring the saved
  # config to be adopted. Restart first, then wait on the public readiness
  # contract rather than /health, which remains green while the data plane is
  # blocked.
  real_exec pkill -f 'podium-cli setup' >/dev/null 2>&1 || true
  sleep 1
  real_exec "$REAL_COMMAND" >/dev/null
  wait_for 120 "real $REAL_RELEASE_VERSION activated data plane" real_data_plane_available
  # The real consumer is its own instance too: without its own session every
  # later `/trpc` read of what it was offered answers 401.
  e2e_login "$REAL_CONSUMER" || return 1
}

# WHAT AN INSTALL OF THIS ERA REALLY LOOKS LIKE, asserted rather than assumed.
real_release_topology() {
  local role units expected=""
  # NAMED FAILURES. A silent predicate in a gate row costs a whole run to
  # diagnose: the matrix says the row went red and nothing says which of six
  # checks did it.
  for role in server daemon janitor; do
    if ! real_exec test -f "$REAL_UNIT_DIR/$(real_legacy_unit "$role")"; then
      say "real-release: $(real_legacy_unit "$role") was never written" >&2
      return 1
    fi
    if ! real_exec systemctl --user is-active --quiet "$(real_legacy_unit "$role")"; then
      say "real-release: $(real_legacy_unit "$role") is not active" >&2
      real_exec systemctl --user status --no-pager "$(real_legacy_unit "$role")" >&2 2>&1 || true
      return 1
    fi
    expected+="$(real_legacy_unit "$role")"$'\n'
  done
  units="$(real_exec bash -lc \
    "find '$REAL_UNIT_DIR' -maxdepth 1 -type f -name 'podium*.service' -printf '%f\n' | sort")"
  printf '%s\n' "$units" >"$WORK/logs/real-release-installed-units.txt"
  [[ "$units" == "$(printf '%s' "$expected" | sort)" ]]
}

# THE COMPARISON THE RENDERED FIXTURE COULD NEVER MAKE. Not an assertion — the
# fixture is allowed to differ, and a row that failed on cosmetic drift would be
# deleted within a month. It is evidence: what our idea of an old install gets
# wrong, written down where the next person can read it. As of POD-2769 the
# fixture writes an `Environment=PODIUM_PORT` line real 0.1.0 never wrote, and
# omits the `--server` arguments it did — which is why the migration's port
# resolution takes a path the fixture cannot reach.
record_fixture_drift() {
  local role rendered installed out="$WORK/logs/real-release-fixture-drift.diff"
  local fixture="$WORK/bootstrap/legacy/podium-$INSTANCE-"
  : >"$out"
  for role in server daemon janitor; do
    rendered="$WORK/logs/rendered-$role.service"
    installed="$WORK/logs/installed-$role.service"
    docker cp "$REAL_CONSUMER:$REAL_UNIT_DIR/$(real_legacy_unit "$role")" "$installed" \
      >/dev/null 2>&1 || continue
    [[ -r "$fixture$role.service" ]] || continue
    # The fixture is rendered for the gate's NAMED instance; this install is the
    # default one. Normalise ONLY that difference — the unit names and the
    # instance environment line — so what is left in the diff is what the
    # renderer got wrong, not which instance each file is for.
    sed -e "s/podium-$INSTANCE/podium/g" \
      -e "s/^Environment=PODIUM_INSTANCE=$INSTANCE\$/Environment=PODIUM_INSTANCE=default/" \
      "$fixture$role.service" >"$rendered"
    printf '=== %s: rendered fixture vs what real %s wrote ===\n' \
      "$role" "$REAL_RELEASE_VERSION" >>"$out"
    diff -u "$rendered" "$installed" >>"$out" || true
  done
  say "fixture-vs-real unit drift recorded at logs/real-release-fixture-drift.diff"
}

# ---------------------------------------------------------------------------
# 4. data that has to survive

seed_real_release_data() {
  local answer
  answer="$(real_rpc POST sessions.create '{"agentKind":"shell","cwd":"/tmp"}')" || return 1
  REAL_SEEDED_SESSION="$(jq -er .sessionId <<<"$answer")" || return 1
  real_exec sqlite3 "$REAL_STATE/podium.db" \
    "CREATE TABLE real_release_probe (marker TEXT);
     INSERT INTO real_release_probe (marker) VALUES ('pre-upgrade');" >/dev/null
  real_exec sqlite3 "$REAL_STATE/podium.db" \
    "SELECT count(*) FROM real_release_probe WHERE marker='pre-upgrade';" | grep -Fx 1 >/dev/null
}

real_release_data_intact() {
  real_exec sqlite3 "$REAL_STATE/podium.db" \
    "SELECT count(*) FROM real_release_probe WHERE marker='pre-upgrade';" |
    grep -Fx 1 >/dev/null || return 1
  real_rpc GET sessions.list |
    jq -e --arg id "$REAL_SEEDED_SESSION" 'any(.[]; .sessionId==$id)' >/dev/null
}

# ---------------------------------------------------------------------------
# 5. the new release, on the URL a stable install fetches

prepare_real_target_release() {
  local release=/work/source/dist-bun/release
  arm_real_release_pairing_coupling
  container_exec "$SOURCE" env BUN_INSTALL_CACHE_DIR=/bun-cache-cow/merged \
    PODIUM_APP_VERSION="$REAL_TARGET_VERSION" \
    PODIUM_UPDATE_SIGNING_KEY="$SERVER_RELEASE_PRIVATE" \
    PODIUM_ZIG=/opt/host-tools/zig-root/zig PODIUM_RCODESIGN=/opt/host-tools/rcodesign \
    bash -lc "cd /work/source &&
      jq --arg v '$REAL_TARGET_VERSION' '.version=\$v' package.json >package.json.new &&
      mv package.json.new package.json &&
      git add package.json && git commit -m 'update-e2e: real-release target' >/dev/null &&
      bun scripts/release.ts --channel stable --tag 'v$REAL_TARGET_VERSION'" \
    >"$WORK/logs/real-release-target-build.log" 2>&1
  require_disk_margin "real-release target build"
  # THE FLAG IS NOT THE EVIDENCE. A mis-parsed `--channel` would build an EDGE
  # release whose artifacts live under `releases/download/edge/` — which this
  # lane's feed does not serve, so the old resolver 404s on the artifact HEAD and
  # refuses a target that looks fine in the manifest.
  #
  # The specific way that used to happen is gone: `--channel=stable` was silently
  # ignored by an exact-argv match, and `scripts/release.ts` now refuses an option
  # it cannot read rather than proceeding without it (POD-2800). The check stays,
  # because a mis-parse was never the only way to arrive here — a wrong tag, a
  # wrong publish dir, or a release script that changes where it points all land
  # in the same place. Check the URLs the manifest actually names.
  container_exec "$SOURCE" bash -lc "cd '$release' &&
    jq -e --arg v '$REAL_TARGET_VERSION' '.version==\$v' podium-update.json >/dev/null"
  container_exec "$SOURCE" bash -lc "cd '$release' &&
    jq -e --arg base 'https://github.com/madeinorbit/podium/releases/download/v$REAL_TARGET_VERSION/' \
      '[.artifacts.headless.platforms[].url] | length > 0 and all(startswith(\$base))' \
      podium-update.json >/dev/null" ||
    die "the target release did not name artifacts under releases/download/v$REAL_TARGET_VERSION/"
  # Every artifact the manifest names must exist in the staged dir, because v0.1.0
  # HEADs all of them and refuses the whole target on any one 404.
  container_exec "$SOURCE" bash -lc "cd '$release' &&
    for url in \$(jq -r '.artifacts.headless.platforms[].url' podium-update.json); do
      test -f \"\$(basename \"\$url\")\" || { echo \"missing \$url\" >&2; exit 1; }
    done" ||
    die "the target manifest names a headless artifact this build did not produce"
}

# The desktop companion, written at a DIVERGENT version on purpose the first
# time. v0.1.0 refuses a target whose desktop manifest does not carry the exact
# same version, on every channel, including a headless Linux server that will
# never run a shell — so the row proves the refusal fires before it proves the
# upgrade works. Without this the row could pass while being wired to nothing.
write_real_desktop_manifest() {
  local version=$1 release=/work/source/dist-bun/release
  container_exec "$SOURCE" env VERSION="$version" TAG="v$REAL_TARGET_VERSION" bash -lc "
    set -euo pipefail
    cd '$release'
    printf 'desktop fixture\n' >podium-desktop-e2e.bin
    jq -n --arg version \"\$VERSION\" \
      --arg url \"https://github.com/madeinorbit/podium/releases/download/\$TAG/podium-desktop-e2e.bin\" \
      '{version:\$version,bridgeVersion:1,platforms:{\"linux-x86_64\":{url:\$url,signature:\"e2e-companion\"}}}' \
      >latest.json
  "
}

start_real_release_feed() {
  # SERVE WITH THE HOST'S FEED SCRIPT, NOT THE SOURCE CHECKOUT'S.
  #
  # `/work/source` is whatever ref the run selected — HEAD normally, but
  # `HOLD_REF` in hold mode — so the copy of `edge-feed.ts` in there is not
  # necessarily the one this lane was written against. It bit exactly that way:
  # a hold run served the epic branch's feed, which only knows the rolling `edge`
  # directory, so every stable URL 404'd and the old resolver reported
  # "release manifest returned HTTP 404" instead of the pairing refusal. The row
  # was right to stay red — it requires the SPECIFIC refusal — but the cause had
  # nothing to do with the product. The harness travels with the harness.
  docker cp "$ROOT/scripts/docker-update-e2e/edge-feed.ts" \
    "$SOURCE:/tmp/real-release-feed.ts"
  container_exec "$SOURCE" bash -lc '
    set -euo pipefail
    mkdir -p /tmp/server-edge
    openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=github.com" \
      -addext "subjectAltName=DNS:github.com" \
      -keyout /tmp/server-edge/key.pem -out /tmp/server-edge/cert.pem >/dev/null 2>&1
  '
  # BOTH STABLE PATHS. A stable install fetches its manifests through
  # `releases/latest/download/`, and the manifest it gets back names artifacts
  # under `releases/download/<tag>/`. Serving only one of those tests half a hop.
  docker exec --user root \
    --env PODIUM_EDGE_FEED_ROOT=/work/source/dist-bun/release \
    --env PODIUM_EDGE_FEED_CERT=/tmp/server-edge/cert.pem \
    --env PODIUM_EDGE_FEED_KEY=/tmp/server-edge/key.pem \
    --env "PODIUM_EDGE_FEED_PREFIXES=/madeinorbit/podium/releases/latest/download/,/madeinorbit/podium/releases/download/v$REAL_TARGET_VERSION/" \
    "$SOURCE" bash -lc '
      set -e
      test -d "$PODIUM_EDGE_FEED_ROOT"
      nohup /home/podium/.local/bin/bun /tmp/real-release-feed.ts \
        >>/tmp/server-edge.log 2>&1 </dev/null &
      echo $! >/tmp/server-edge.pid
    '
  wait_for 30 "run-local release feed" edge_feed_healthy
}

point_real_release_at_feed() {
  local source_ip dropin
  source_ip="$(docker inspect -f "{{(index .NetworkSettings.Networks \"$NETWORK\").IPAddress}}" "$SOURCE")"
  container_exec "$SOURCE" cat /tmp/server-edge/cert.pem >"$WORK/real-release-ca.pem"
  docker cp "$WORK/real-release-ca.pem" \
    "$REAL_CONSUMER:/usr/local/share/ca-certificates/update-e2e.crt"
  docker exec "$REAL_CONSUMER" update-ca-certificates >/dev/null
  docker exec "$REAL_CONSUMER" sh -c "printf '%s github.com\n' '$source_ip' >>/etc/hosts"
  # v0.1.0 runs a unit per role; the server is the one that resolves the target.
  dropin="$REAL_UNIT_DIR/$(real_legacy_unit server).d"
  real_exec mkdir -p "$dropin"
  real_exec bash -lc \
    "printf '[Service]\nEnvironment=NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/update-e2e.crt\nEnvironment=PODIUM_HOST=0.0.0.0\n' >'$dropin/real-release-feed.conf'"
  real_exec systemctl --user daemon-reload
  real_exec systemctl --user restart "$(real_legacy_unit server)"
  wait_for 120 "real $REAL_RELEASE_VERSION server on the run-local feed" real_healthy
}

# THE SANDBOX THAT STARTS AT A REAL RELEASE.
#
# Every sandbox anyone has held starts at current source, which is why the
# old-to-new hop has never been driven by hand. This one stops with a REAL
# published install standing, its data seeded, and the new release already
# offered to it — so the next move is the same click a user would make.
print_real_release_hold_instructions() {
  cat <<EOF

MANUAL REAL-RELEASE UPGRADE READY — OBJECTS PERSIST UNTIL TORN DOWN

This machine is a REAL published $REAL_RELEASE_TAG install. It was verified against
the production release key, installed by its own installer, and its own code wrote
its own three systemd units. One constant differs from the published bytes: the
baked trust root, so this run can sign the release it offers.
  trust-root substitution: $REAL_TRUST_PATCH

Installed: $REAL_RELEASE_VERSION (default instance, channel stable)
Offered:   $REAL_TARGET_VERSION, through the stable feed URL a released install fetches
Seeded:    one shell session and a real_release_probe row, both of which must survive

UI: http://127.0.0.1:$REAL_PORT

Drive it by hand:
  1. Open Settings -> Updates. The offer is already there.
  2. Accept it. The FIRST HOP IS PERFORMED BY THE OLD UPDATER — that is the point
     of this sandbox and the one thing no other fixture exercises.
  3. Watch the three units become one:
       docker exec -u podium $REAL_CONSUMER \
         find $REAL_UNIT_DIR -maxdepth 1 -name 'podium*.service' -printf '%f\n'
     It should end as $REAL_PARENT_UNIT alone.
  4. Check the data survived:
       docker exec -u podium $REAL_CONSUMER \
         sqlite3 $REAL_STATE/podium.db 'SELECT * FROM real_release_probe;'

To watch it refuse instead, put the desktop manifest back on a different version
(this is POD-2789, and it is what a headless-only release looks like to this install):
  docker exec $SOURCE bash -lc "cd /work/source/dist-bun/release &&
    jq '.version=\"$REAL_RELEASE_VERSION\"' latest.json >l && mv l latest.json"
  curl -sS -X POST -H 'content-type: application/json' -d '{}' \
    http://127.0.0.1:$REAL_PORT/trpc/updates.checkNow | jq .

Run label: $LABEL
Scratch directory: $WORK

Container shells:
  docker exec -it $REAL_CONSUMER bash
  docker exec -it $SOURCE bash

One-line teardown (only this run's labeled containers, exact network, image, and scratch):
  docker ps -aq --filter 'label=$LABEL' | xargs -r docker rm -f && docker network rm '$NETWORK' && docker image rm '$IMAGE' && rm -rf -- '$WORK'

These objects deliberately remain running and consume disk until that teardown succeeds.
EOF
}

# ---------------------------------------------------------------------------
# arming

# RESTORE THE COUPLING POD-2794 REMOVED, in the source the target build compiles.
#
# Armed BEFORE `prepare_real_target_release`, because what it changes is the
# 0.2.0 binary the upgraded machine will be running — and that machine is the one
# `real-release-headless-only` interrogates. It cannot disturb the two rows above
# it: those are answered by v0.1.0's OWN resolver, inside the released artifact,
# which no edit to this checkout can reach.
#
# The substitution is asserted to hit exactly one site, for the same reason
# patch-trust-root.ts asserts its byte delta: a control that silently matched
# nothing would leave the row green and be read as the row being unarmable.
arm_real_release_pairing_coupling() {
  [[ "$PROVE_FAILURE" == real-release-pairing-coupled ]] || return 0
  local report
  # WITH THE HOST'S SCRIPT AND THROUGH A LOGIN SHELL, for the two reasons this
  # lane already learned the hard way. `container_exec` runs `docker exec`
  # directly, so `bun` is not on PATH without `-l`; and the copy of any harness
  # script inside `/work/source` is whatever ref the run selected, not
  # necessarily the one this control was written against.
  docker cp "$ROOT/scripts/docker-update-e2e/couple-desktop-pairing.ts" \
    "$SOURCE:/tmp/couple-desktop-pairing.ts"
  report="$(container_exec "$SOURCE" bash -lc \
    'bun /tmp/couple-desktop-pairing.ts \
       /work/source/apps/server/src/modules/updates/release-target.ts')" ||
    die "could not arm the pairing coupling: the condition it rewrites has moved"
  printf '%s\n' "$report" >"$WORK/logs/real-release-pairing-coupling.json"
  jq -e '.occurrences==1 and .coupled and .decoupledGone and .bytesRemoved>0' \
    <<<"$report" >/dev/null ||
    die "the pairing coupling did not land as expected: $report"
  say "armed: the resolver consults latest.json unconditionally again ($report), so a release with no desktop build must retract the headless target"
}

arm_real_release_failure() {
  case "$PROVE_FAILURE" in
    real-release-migration)
      # BREAK THE MIGRATION, AND ONLY THE MIGRATION.
      #
      # A directory at the parent unit's exact path. `observeTopology` lists units
      # with `readdirSync`, which does not care about file type, so the migration
      # sees a parent that is already PRESENT, skips `write-parent`, and fails at
      # `enable-parent` when systemd is asked to enable a directory. The throw is
      # caught where cli.ts kicks the migration off ("topology reconcile failed"),
      # so the legacy server keeps serving and the units never converge — which is
      # the distinction that matters: the row must go red because the MIGRATION
      # failed, not because the machine fell over. Nothing else is touched.
      real_exec mkdir -p "$REAL_UNIT_DIR/$REAL_PARENT_UNIT"
      real_exec test -d "$REAL_UNIT_DIR/$REAL_PARENT_UNIT"
      say "armed: the parent unit path is a directory, so the migration sees a parent already present and fails to enable it"
      ;;
  esac
}

real_release_converged() {
  local role units
  units="$(real_exec bash -lc \
    "find '$REAL_UNIT_DIR' -maxdepth 1 -type f -name 'podium*.service' -printf '%f\n' | sort")"
  printf '%s\n' "$units" >"$WORK/logs/real-release-converged-units.txt"
  [[ "$units" == "$REAL_PARENT_UNIT" ]] || return 1
  for role in server daemon janitor; do
    real_exec test ! -e "$REAL_UNIT_DIR/$(real_legacy_unit "$role")" || return 1
  done
  real_exec systemctl --user is-active --quiet "$REAL_PARENT_UNIT" || return 1
  real_exec systemctl --user is-enabled --quiet "$REAL_PARENT_UNIT" || return 1
  real_version_is "$REAL_TARGET_VERSION"
}

# ---------------------------------------------------------------------------

run_real_release_lane() {
  local started id operation detail

  CURRENT_SCENARIO=real-release-install
  fetch_real_release
  reanchor_real_release
  start_container "$REAL_CONSUMER" real-release -p "127.0.0.1::18787" \
    -v "$WORK/bootstrap:/bootstrap:ro"
  REAL_PORT="$(docker inspect "$REAL_CONSUMER" |
    jq -r '.[0].NetworkSettings.Ports["18787/tcp"][0].HostPort')"
  install_real_release >"$WORK/logs/real-release-install.log" 2>&1
  real_release_setup >>"$WORK/logs/real-release-install.log" 2>&1
  wait_for 120 "real $REAL_RELEASE_VERSION server" real_healthy
  if ! real_release_topology; then
    fail real-release-install \
      "the published $REAL_RELEASE_TAG artifact did not stand up its era's three-unit layout; the named check is in the run output"
    return 1
  fi
  if ! real_version_is "$REAL_RELEASE_VERSION"; then
    fail real-release-install \
      "the installed machine did not report appVersion $REAL_RELEASE_VERSION; body: $HTTP_BODY"
    return 1
  fi
  record_fixture_drift
  pass real-release-install \
    "the published $REAL_RELEASE_TAG artifact verified against the PRODUCTION release key, installed through its own installer with one re-anchored trust-root constant ($(jq -r .changedBytes <<<"$REAL_TRUST_PATCH") bytes of $(jq -r .bytes <<<"$REAL_TRUST_PATCH")), and $REAL_RELEASE_VERSION's own code wrote its era's three-unit layout"

  CURRENT_SCENARIO=real-release-pairing-refusal
  prepare_real_target_release
  write_real_desktop_manifest "$REAL_RELEASE_VERSION"
  start_real_release_feed
  point_real_release_at_feed
  seed_real_release_data ||
    { fail real-release-install "the real $REAL_RELEASE_VERSION install could not record pre-upgrade data"; return 1; }
  # THE FEED IS REACHING IT, PROVEN SEPARATELY. Without this the refusal row's own
  # failure message offers two hypotheses — "the feed is not reaching it or the
  # refusal moved" — and distinguishes neither, which is how a harness fault reads
  # as a product finding.
  if ! wait_for 60 "the spoofed stable feed from the consumer" \
      container_http_probe "$REAL_CONSUMER" GET \
      "https://github.com/madeinorbit/podium/releases/latest/download/podium-update.json"; then
    container_http_capture "$REAL_CONSUMER" GET \
      "https://github.com/madeinorbit/podium/releases/latest/download/podium-update.json" || true
    printf '%s\n' "$HTTP_STATUS $HTTP_BODY" >"$WORK/logs/real-release-feed-probe.txt"
    fail real-release-pairing-refusal \
      "the run-local stable feed never served podium-update.json to the consumer, so nothing downstream is a statement about the old resolver; see logs/real-release-feed-probe.txt"
    return 1
  fi
  if wait_for 120 "the old resolver's refusal" real_refusal_names_desktop_pairing; then
    pass real-release-pairing-refusal \
      "with the desktop manifest at a different version the real $REAL_RELEASE_VERSION resolver refused the whole target, naming the desktop pairing — the stranding POD-2789 records, reproduced by the old code itself"
  else
    real_rpc GET updates.fleet >"$WORK/logs/real-release-refusal-fleet.json" 2>&1 || true
    fail real-release-pairing-refusal \
      "the real $REAL_RELEASE_VERSION resolver did not name the desktop pairing; it said: $(real_channel_check)"
    return 1
  fi

  CURRENT_SCENARIO=real-release-resolve
  write_real_desktop_manifest "$REAL_TARGET_VERSION"
  if ! wait_for 180 "real $REAL_RELEASE_VERSION target" real_target_is "$REAL_TARGET_VERSION"; then
    # WHY IT DID NOT ARRIVE, recorded before the row goes red. A timeout with no
    # captured reason costs a whole gate run to diagnose — this one already did.
    real_rpc GET updates.fleet >"$WORK/logs/real-release-resolve-fleet.json" 2>&1 || true
    real_channel_check >"$WORK/logs/real-release-resolve-refusal.txt" 2>&1 || true
    container_exec "$SOURCE" bash -lc \
      "cd /work/source/dist-bun/release && jq -c '{version, urls: [.artifacts.headless.platforms[].url]}' podium-update.json; cat latest.json" \
      >"$WORK/logs/real-release-resolve-served-manifests.json" 2>&1 || true
    say "the old resolver refused: $(cat "$WORK/logs/real-release-resolve-refusal.txt" 2>/dev/null)" >&2
    fail real-release-resolve \
      "the real $REAL_RELEASE_VERSION resolver never offered $REAL_TARGET_VERSION; its own refusal is in logs/real-release-resolve-refusal.txt"
    return 1
  fi
  pass real-release-resolve \
    "the real $REAL_RELEASE_VERSION resolver read a paired release through the stable feed URL a released install actually fetches, and offered $REAL_TARGET_VERSION"

  if [[ "$HOLD" == real-release ]]; then
    # KEEP THE UI REACHABLE ACROSS THE VERY HOP THIS SANDBOX EXISTS TO WATCH.
    #
    # The drop-in that makes this machine reachable from the host sits on the
    # SERVER unit, and the upgrade retires that unit — so without this the human
    # loses the UI at the exact moment they click Update, which reads as the
    # upgrade having broken the machine. A released install's units carry no
    # PODIUM_HOST, so the parent would otherwise bind loopback inside the
    # container. systemd applies a drop-in written before its unit exists, and
    # `.service.d` is not a `.service`, so the migration's own unit listing does
    # not see it.
    real_exec mkdir -p "$REAL_UNIT_DIR/$REAL_PARENT_UNIT.d"
    real_exec bash -lc \
      "printf '[Service]\nEnvironment=NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/update-e2e.crt\nEnvironment=PODIUM_HOST=0.0.0.0\n' >'$REAL_UNIT_DIR/$REAL_PARENT_UNIT.d/sandbox.conf'"
    real_exec systemctl --user daemon-reload
    require_disk_margin "held real-release sandbox"
    print_real_release_hold_instructions
    CURRENT_SCENARIO=""
    HOLD_READY=1
    return 0
  fi

  arm_real_release_failure

  CURRENT_SCENARIO=real-release-converged
  started="$(real_rpc POST updates.start '{"surface":"settings"}')"
  id="$(jq -er .operationId <<<"$started")"
  printf '%s\n' "$started" >"$WORK/logs/real-release-update-start.json"
  wait_for 480 "the real $REAL_RELEASE_VERSION install to converge" real_release_converged || true
  operation="$(real_rpc GET operations.history '{"kind":"update","limit":20}' |
    jq -c --arg id "$id" '.[]|select(.id==$id)' | head -1)" || true
  printf '%s\n' "${operation:-}" >"$WORK/logs/real-release-update-operation.json"
  if real_release_converged && real_release_data_intact; then
    pass real-release-converged \
      "a real published $REAL_RELEASE_VERSION install, upgraded BY ITS OWN UPDATER, converged onto the single-unit topology with its pre-upgrade session and database rows intact"
  else
    fail real-release-converged \
      "the real $REAL_RELEASE_VERSION install did not converge onto one unit with its data intact; see logs/real-release-converged-units.txt"
    [[ -z "$PROVE_FAILURE" ]] && return 1
  fi

  # SCOPED TO THE CONTROLS THAT ACTUALLY TARGET CONVERGENCE.
  #
  # This read `-n "$PROVE_FAILURE"` while `real-release-migration` was the only
  # control there was, so "a control is armed" and "convergence must go red" were
  # the same statement. They stopped being the same the moment a second control
  # arrived: `real-release-pairing-coupled` breaks the RESOLVER on a later row and
  # leaves convergence correctly green, and the unscoped check called that green
  # a failure — reddening a row that had done its job, and skipping the row the
  # control was actually arming. A deliberate-failure control has to name the row
  # it targets, or every new control silently indicts an old row.
  if [[ "$PROVE_FAILURE" == real-release-migration &&
    "${RESULT[real-release-converged]:-}" != FAIL ]]; then
    fail real-release-converged \
      "deliberate $PROVE_FAILURE mutation unexpectedly produced a green convergence"
    return 1
  fi

  # THE OTHER HALF OF THE STORY (POD-2794), asked of the machine this lane just
  # built. It is now running CURRENT code, and it got there along the real
  # upgrade path rather than by being installed from source — so it is the
  # honest consumer for the question the pairing-refusal row above leaves open:
  # once an install is off v0.1.0, does a release with NO desktop build reach it?
  #
  # Deleting the served `latest.json` is the entire mutation, and it is the real
  # shape of a headless-only release: a dev-driven mint publishes the headless
  # payload and never runs a darwin builder, so the desktop manifest is simply
  # not there. Before POD-2794 the resolver fetched it unconditionally and the
  # 404 retracted the whole target — recorded as the channel having nothing,
  # which an operator reads as being up to date. That is the silence.
  #
  # This row is deliberately NOT a version bump. Building a second release in the
  # container costs another full build and another disk margin for no extra
  # claim: what is under test is whether the resolve SURVIVES a missing desktop
  # manifest, and the check outcome says that directly. A `targetVersion`
  # assertion could not, because the machine is already on that version and
  # "offered it again" and "offered nothing" look identical from there.
  CURRENT_SCENARIO=real-release-headless-only
  # THE BASELINE, TAKEN BEFORE THE FEED MOVES. Everything this row concludes has
  # to come from a check recorded after the deletion; without this the 30s forced-
  # check window can answer the whole poll from the record made a moment ago.
  REAL_STABLE_CHECK_BASELINE="$(real_stable_check | cut -d' ' -f1)"
  printf 'baseline %s\n' "$REAL_STABLE_CHECK_BASELINE" \
    >"$WORK/logs/real-release-headless-only-baseline.txt"
  container_exec "$SOURCE" bash -lc "rm -f /work/source/dist-bun/release/latest.json"
  # PROVE THE MUTATION LANDED BEFORE BELIEVING THE GREEN. If the feed kept
  # serving latest.json — from a cache, or because the release dir moved — the
  # row would pass while testing nothing at all.
  if container_http_probe "$REAL_CONSUMER" GET \
      "https://github.com/madeinorbit/podium/releases/latest/download/latest.json"; then
    fail real-release-headless-only \
      "the feed still serves latest.json after it was deleted, so this row would be green without testing anything"
    return 1
  fi
  # ALWAYS captured, pass or fail. The first armed run produced a green row and no
  # evidence at all, so there was nothing to read afterwards but the verdict.
  real_rpc GET updates.fleet >"$WORK/logs/real-release-headless-only-fleet.json" 2>&1 || true
  if wait_for 150 "a headless-only release to be offered" real_headless_only_is_offered; then
    real_rpc GET updates.fleet >"$WORK/logs/real-release-headless-only-fleet.json" 2>&1 || true
    pass real-release-headless-only \
      "with NO desktop manifest published at all, the upgraded install still resolved the stable target — the missing shell no longer retracts the headless offer"
  else
    real_rpc GET updates.fleet >"$WORK/logs/real-release-headless-only-fleet.json" 2>&1 || true
    # WHY it refused, not just that it did. Under the deliberate control this is
    # the whole evidence: the row has to go red naming the desktop manifest, not
    # merely go red.
    detail="$(real_channel_check)"
    printf '%s\n' "$detail" >"$WORK/logs/real-release-headless-only-refusal.txt"
    fail real-release-headless-only \
      "a release with no desktop build was not offered; the channel check said: ${detail:-<no reason recorded>}"
    [[ "$PROVE_FAILURE" == real-release-pairing-coupled ]] || return 1
  fi
  if [[ "$PROVE_FAILURE" == real-release-pairing-coupled ]]; then
    if [[ "${RESULT[real-release-headless-only]:-}" != FAIL ]]; then
      fail real-release-headless-only \
        "the restored pairing coupling unexpectedly left the headless-only row green, so that row cannot be proving what it claims"
      return 1
    fi
    # Red is not enough on its own — it must be red for THIS cause. A container
    # that merely fell over would also produce a red row.
    if ! grep -Fq 'desktop manifest' "$WORK/logs/real-release-headless-only-refusal.txt"; then
      fail real-release-headless-only \
        "the row went red under the restored coupling but did not name the desktop manifest; it said: $(cat "$WORK/logs/real-release-headless-only-refusal.txt" 2>/dev/null)"
      return 1
    fi
    say "the restored coupling turned the headless-only row red, naming the desktop manifest — the row is armed"
    return 1
  fi

  require_disk_margin "real-release upgrade"
  CURRENT_SCENARIO=""
  [[ -z "$PROVE_FAILURE" ]] || return 1
}
