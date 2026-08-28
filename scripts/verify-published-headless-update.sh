#!/usr/bin/env bash
# Verify the artifacts that were actually published by the headless release workflow.
#
# This is intentionally separate from verify-headless-update.sh: that script exercises the
# source seam with an ephemeral fixture key and a local feed. This script downloads the
# real release from GitHub and interrogates what is on the release page.
#
# TWO KINDS OF PROOF, because a Linux runner can only execute one of the four platforms:
#
#   linux-x86_64 (CASES 1-2) — the strongest proof available: RUN the shipped binary
#     against the real production signature, watch it complete a swap, then watch the
#     same binary reject a locally tampered copy.
#
#   the other three (CASE 3) — the release page must carry each bundle, its signature and
#     a SHA256SUMS line; the manifest must name every platform; each tarball must verify
#     under Podium's release key (the check `podium update` will make on that machine);
#     and each bundle must survive the shipped-bundle assertions, which for Darwin include
#     the ad-hoc code signature and its JIT entitlements.
#
# What is deliberately NOT claimed here: that a Darwin bundle EXECUTES. That needs a Mac
# and is run by hand until CI has a Mac verifier (spec section 8b; POD-2520).
set -euo pipefail

cd "$(dirname "$0")/.."

RELEASE="${1:-}"
REPO="${GITHUB_REPOSITORY:-madeinorbit/podium}"
PORT="${PODIUM_PUBLISHED_HEADLESS_PORT:-18789}"
WORK="$(mktemp -d)"
FEED_PID=""

cleanup() {
  [ -n "$FEED_PID" ] && kill "$FEED_PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ABORT: required command '$1' is missing" >&2
    exit 1
  fi
}

for command in gh jq curl cp grep mktemp python3 tar tee seq bun rcodesign sha256sum; do
  require_command "$command"
done

if [ -z "$RELEASE" ]; then
  echo "ABORT: pass the published release, for example v0.4.2 or edge" >&2
  exit 1
fi
case "$RELEASE" in
  edge) CHANNEL="edge" ;;
  v*) CHANNEL="stable" ;;
  *) echo "ABORT: published smoke only accepts edge or a v* stable release tag (got '$RELEASE')" >&2; exit 1 ;;
esac

RELEASE_DIR="$WORK/release"
mkdir -p "$RELEASE_DIR"
ARTIFACT="$RELEASE_DIR/podium-headless-linux-x64.tar.gz"
MANIFEST="$RELEASE_DIR/podium-update.json"

download_release() {
  local attempt
  for attempt in $(seq 1 12); do
    rm -f "$ARTIFACT" "$MANIFEST"
    if gh release download "$RELEASE" \
      --repo "$REPO" \
      --pattern 'podium-headless-linux-x64.tar.gz' \
      --pattern 'podium-update.json' \
      --dir "$RELEASE_DIR" \
      --clobber \
      >/dev/null 2>&1 && [ -s "$ARTIFACT" ] && [ -s "$MANIFEST" ]; then
      return 0
    fi
    echo "published assets are not visible yet (attempt $attempt/12); retrying" >&2
    sleep 5
  done
  echo "ABORT: could not download the published x64 artifact and manifest for $REPO@$RELEASE" >&2
  exit 1
}

echo "=== downloading published $CHANNEL assets for $REPO@$RELEASE ==="
download_release

TARGET_VERSION="$(jq -er '.version' "$MANIFEST")"
SIGNATURE="$(jq -er '.platforms["linux-x86_64"].signature' "$MANIFEST")"
WEB_DIGEST="$(jq -er '.artifacts.web.digest' "$MANIFEST")"
[ -n "$TARGET_VERSION" ] || { echo "ABORT: published manifest has no version" >&2; exit 1; }
[ -n "$SIGNATURE" ] || { echo "ABORT: published manifest has no x64 signature" >&2; exit 1; }
[ -n "$WEB_DIGEST" ] || { echo "ABORT: published manifest has no shared web digest" >&2; exit 1; }

echo "=== published manifest points linux-x86_64 at version $TARGET_VERSION ==="
tar -xzf "$ARTIFACT" -C "$WORK"
EXTRACTED="$WORK/headless"
[ -x "$EXTRACTED/podium" ] || { echo "ABORT: published bundle has no executable headless/podium" >&2; exit 1; }
for site in web mobile; do
  [ -f "$EXTRACTED/$site/index.html" ] || { echo "ABORT: published bundle has no $site/index.html" >&2; exit 1; }
  SITE_DIGEST="$(jq -er '.sourceSha' "$EXTRACTED/$site/podium-build.json")"
  SITE_VERSION="$(jq -er '.appVersion' "$EXTRACTED/$site/podium-build.json")"
  [ "$SITE_DIGEST" = "$WEB_DIGEST" ] || {
    echo "ABORT: published $site digest $SITE_DIGEST does not match manifest $WEB_DIGEST" >&2
    exit 1
  }
  [ "$SITE_VERSION" = "$TARGET_VERSION" ] || {
    echo "ABORT: published $site version $SITE_VERSION does not match target $TARGET_VERSION" >&2
    exit 1
  }
done

stage_current() {
  local destination="$1"
  cp -a "$EXTRACTED" "$destination"
  printf '0.0.0\n' > "$destination/VERSION"
}

run_captured() {
  local log="$1"
  shift
  local -a statuses
  set +e
  "$@" 2>&1 | tee "$log"
  statuses=("${PIPESTATUS[@]}")
  set -e
  UPDATE_EXIT="${statuses[0]}"
}

# --- CASE 1: the shipped binary accepts the real published artifact ----------
GOOD="$WORK/good"
GOOD_LOG="$WORK/good.log"
stage_current "$GOOD"
echo "=== CASE 1: production-key verification and atomic swap (expect exit 10) ==="
run_captured "$GOOD_LOG" env \
  -u PODIUM_AGENT_RELAY \
  -u PODIUM_UPDATE_FEED \
  -u PODIUM_UPDATE_SIGNING_KEY \
  PODIUM_HOME="$GOOD" \
  PODIUM_UPDATE_CHANNEL="$CHANNEL" \
  PODIUM_UPDATE_TARGET=linux-x86_64 \
  "$GOOD/podium" update

GOOD_VERSION="$(<"$GOOD/VERSION")"
if [ "$UPDATE_EXIT" -ne 10 ] || [ "$GOOD_VERSION" != "$TARGET_VERSION" ]; then
  echo "ABORT: published artifact did not complete a real update (exit=$UPDATE_EXIT, VERSION=$GOOD_VERSION)" >&2
  exit 1
fi
grep -q "updated to $TARGET_VERSION" "$GOOD_LOG" || {
  echo "ABORT: shipped updater did not report the completed published swap" >&2
  exit 1
}

# --- CASE 2: the shipped binary rejects a tampered published artifact --------
TAMPERED="$WORK/podium-headless-linux-x64.tampered.tar.gz"
cp "$ARTIFACT" "$TAMPERED"
printf 'tamper' >> "$TAMPERED"

FEED_ROOT="$WORK/feed"
MANIFEST_PATH="$FEED_ROOT/update/linux-x86_64/x86_64/0.0.0"
mkdir -p "$(dirname "$MANIFEST_PATH")"
cp "$TAMPERED" "$FEED_ROOT/artifact"
jq -n \
  --arg version "$TARGET_VERSION" \
  --arg signature "$SIGNATURE" \
  --arg url "http://127.0.0.1:$PORT/artifact" \
  '{version: $version, platforms: {"linux-x86_64": {url: $url, signature: $signature}}}' \
  > "$MANIFEST_PATH"

echo "=== CASE 2: tampered published artifact (expect exit 1 and no swap) ==="
python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$FEED_ROOT" >/dev/null 2>&1 &
FEED_PID=$!
for attempt in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:$PORT/update/linux-x86_64/x86_64/0.0.0" >/dev/null; then
    break
  fi
  sleep 0.5
done

BAD="$WORK/bad"
BAD_LOG="$WORK/bad.log"
stage_current "$BAD"
run_captured "$BAD_LOG" env \
  -u PODIUM_AGENT_RELAY \
  -u PODIUM_UPDATE_SIGNING_KEY \
  PODIUM_HOME="$BAD" \
  PODIUM_UPDATE_TARGET=linux-x86_64 \
  PODIUM_UPDATE_FEED="http://127.0.0.1:$PORT" \
  "$BAD/podium" update

BAD_VERSION="$(<"$BAD/VERSION")"
if [ "$UPDATE_EXIT" -ne 1 ] || [ "$BAD_VERSION" != '0.0.0' ]; then
  echo "ABORT: tampered published artifact was not rejected (exit=$UPDATE_EXIT, VERSION=$BAD_VERSION)" >&2
  exit 1
fi
grep -q 'signature verification FAILED' "$BAD_LOG" || {
  echo "ABORT: tampered published artifact did not reach the signature gate" >&2
  exit 1
}

# --- CASE 3: every published platform, including the ones this runner cannot run ---
#
# CASES 1 and 2 proved the linux-x86_64 bundle by running it. The other three cannot be
# executed here, so they are checked against everything that does not require running
# them. That check is its own script so it can be run against a local release directory
# during development, without a published release to download.
echo "=== CASE 3: all published platforms present, summed, signed and well-formed ==="

ALL_DIR="$WORK/all"
mkdir -p "$ALL_DIR"
gh release download "$RELEASE" --repo "$REPO" \
  --pattern 'podium-headless-*.tar.gz' \
  --pattern 'podium-headless-*.tar.gz.sig' \
  --pattern 'podium-update.json' \
  --pattern 'client-root-digest.sha256' \
  --pattern 'SHA256SUMS' \
  --dir "$ALL_DIR" --clobber >/dev/null 2>&1 || {
    echo "ABORT: could not download the full published asset set for $REPO@$RELEASE" >&2
    exit 1
  }
bash scripts/assert-release-platform-set.sh "$ALL_DIR" || exit 1

echo "PUBLISHED HEADLESS UPDATE VERIFIED — real $CHANNEL linux-x86_64 artifact SWAPPED;"
echo "tampered copy REJECTED; all four platforms published, summed, signed and asserted."
echo "NOT claimed here: macOS EXECUTION (needs a Mac — spec section 8b, POD-2520)."
