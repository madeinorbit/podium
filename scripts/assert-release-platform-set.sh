#!/usr/bin/env bash
# Assert a release directory carries EVERY headless platform, correctly.
#
# Runs against a downloaded release (the published smoke does exactly that) or against a
# local `dist-bun/release` produced by `bun scripts/release.ts --prepare-cross` plus a
# manifest build — which is what makes it possible to find a packaging mistake before a
# release page exists rather than after.
#
# For each platform it proves, without needing to EXECUTE the binary:
#   - the tarball and its .sig are present and non-empty
#   - SHA256SUMS covers the exact bytes that are there
#   - the manifest names the platform, points at that asset, and advertises the same
#     signature that shipped beside it
#   - the tarball verifies under Podium's release key — the check `podium update` will
#     make on the target machine, run with the same primitive
#   - the bundle survives the shipped-bundle assertions (architecture, embedded helper,
#     and for Darwin the ad-hoc code signature and its JIT entitlements)
#   - the VERSION inside agrees with the manifest
#
# And, across platforms, that the manifest declares EXACTLY the published set: an extra
# key is an artifact nobody summed, a missing one is a machine that can never update.
#
# Usage: scripts/assert-release-platform-set.sh <release-dir> [--pubkey <base64-spki-der>]
#
# `--pubkey` names a non-release publisher key: the development host signs its own bundles
# with the dev key, and asserting over a dev release directory is a real use, not a test
# hack. The published smoke never passes it, so that path always checks the release key.
set -euo pipefail

cd "$(dirname "$0")/.."
export PATH="${HOME}/.local/bin:${HOME}/.cargo/bin:${PATH}"

DIR=""
PUBKEY_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --pubkey) PUBKEY_ARGS=(--pubkey "${2:-}"); shift 2 ;;
    *) DIR="$1"; shift ;;
  esac
done
[ -n "$DIR" ] && [ -d "$DIR" ] || { echo "ABORT: pass the release directory (got '$DIR')" >&2; exit 1; }

fail() { echo "ABORT: $*" >&2; exit 1; }

# platform:asset-infix. Kept in step with scripts/build-bun.ts BUN_TARGETS; the manifest
# comparison below fails loudly if the two ever drift.
PLATFORMS="linux-x86_64:linux-x64 linux-aarch64:linux-arm64 darwin-aarch64:darwin-arm64 darwin-x86_64:darwin-x64"

MANIFEST="$DIR/podium-update.json"
[ -s "$MANIFEST" ] || fail "no podium-update.json in $DIR"
[ -s "$DIR/SHA256SUMS" ] || fail "no SHA256SUMS in $DIR"

TARGET_VERSION="$(jq -er '.version' "$MANIFEST")" || fail "manifest has no version"
TARGET_SOURCE="$(jq -er '.artifacts.web.digest' "$MANIFEST")" \
  || fail "manifest has no approved client source commit"
CLIENT_ROOT_DIGEST_FILE="$DIR/client-root-digest.sha256"
[ -s "$CLIENT_ROOT_DIGEST_FILE" ] \
  || fail "release has no out-of-band fresh-client root digest"
CLIENT_ROOT_DIGEST="$(tr -d '\n' < "$CLIENT_ROOT_DIGEST_FILE")"
[[ "$CLIENT_ROOT_DIGEST" =~ ^[0-9a-f]{64}$ ]] \
  || fail "release fresh-client root digest is not a SHA-256 hex digest"

MANIFEST_PLATFORMS="$(jq -r '.artifacts.headless.platforms | keys[]' "$MANIFEST" | sort | tr '\n' ' ')"
EXPECTED_PLATFORMS="$(for pair in $PLATFORMS; do echo "${pair%%:*}"; done | sort | tr '\n' ' ')"
[ "$MANIFEST_PLATFORMS" = "$EXPECTED_PLATFORMS" ] \
  || fail "manifest declares [$MANIFEST_PLATFORMS], expected exactly [$EXPECTED_PLATFORMS]"
echo "manifest version $TARGET_VERSION declares exactly: $MANIFEST_PLATFORMS"

# Reference abduco helpers, rebuilt from the vendored source at THIS commit. They are what
# makes "the right architecture's helper is inside the shipped binary" checkable rather
# than assumed — without them the embedded-helper check could only be waived, and a waived
# check reads as a pass. Content-addressed, so a warm cache makes this a no-op.
bun scripts/abduco-cross.ts >/dev/null || fail "could not build the reference abduco helpers"
ABDUCO_HASH="$(bun -e 'import{abducoSourceHash}from"./scripts/abduco-cross.ts";console.log(abducoSourceHash().slice(0,16))')"

for pair in $PLATFORMS; do
  platform="${pair%%:*}"
  asset="podium-headless-${pair##*:}.tar.gz"
  echo "--- $platform ($asset) ---"
  [ -s "$DIR/$asset" ] || fail "the release is missing $asset"
  [ -s "$DIR/$asset.sig" ] || fail "the release is missing $asset.sig"

  SUM_LINE="$(grep -F "  $asset" "$DIR/SHA256SUMS" || true)"
  [ -n "$SUM_LINE" ] || fail "SHA256SUMS has no line for $asset"
  WANT_SUM="${SUM_LINE%% *}"
  GOT_SUM="$(sha256sum "$DIR/$asset" | cut -d' ' -f1)"
  [ "$WANT_SUM" = "$GOT_SUM" ] \
    || fail "$asset does not match SHA256SUMS (published=$WANT_SUM actual=$GOT_SUM)"

  URL="$(jq -er --arg p "$platform" '.artifacts.headless.platforms[$p].url' "$MANIFEST")"
  case "$URL" in
    *"/$asset") : ;;
    *) fail "manifest url for $platform is $URL, which does not name $asset" ;;
  esac
  MANIFEST_SIG="$(jq -er --arg p "$platform" '.artifacts.headless.platforms[$p].signature' "$MANIFEST")"
  FILE_SIG="$(tr -d '\n' < "$DIR/$asset.sig")"
  [ "$MANIFEST_SIG" = "$FILE_SIG" ] \
    || fail "manifest signature for $platform differs from the published $asset.sig — one of the two is from a different build"

  bun scripts/verify-headless-signature.ts "$DIR/$asset" "$MANIFEST_SIG" "${PUBKEY_ARGS[@]+"${PUBKEY_ARGS[@]}"}" || exit 1

  bash scripts/assert-headless-bundle.sh "$DIR/$asset" "$platform" \
    --source-commit "$TARGET_SOURCE" \
    --client-root-digest "$CLIENT_ROOT_DIGEST" \
    --abduco "dist-bun/abduco-cache/${platform}-${ABDUCO_HASH}" || exit 1

  BUNDLE_VERSION="$(tar -xzOf "$DIR/$asset" headless/VERSION | tr -d '\n')"
  [ "$BUNDLE_VERSION" = "$TARGET_VERSION" ] \
    || fail "$asset carries VERSION $BUNDLE_VERSION, manifest says $TARGET_VERSION"
  echo "OK: $platform present, summed, signed, verified and well-formed at $TARGET_VERSION"
done

echo "=== ALL PLATFORMS VERIFIED at $TARGET_VERSION ==="
echo "NOT claimed here: that a Darwin bundle EXECUTES — that needs a Mac (spec section 8b, POD-2520)."
