#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

make_install() {
  local destination=$1
  mkdir -p "$destination"
  cat > "$destination/podium" <<'SH'
#!/bin/sh
printf 'legacy updater was invoked\n' >> "${PODIUM_REPAIR_INVOCATION_LOG:?}"
exit 99
SH
  chmod 755 "$destination/podium"
  printf '0.1.0\n' > "$destination/VERSION"
}

mkdir -p "$WORK/source/headless" "$WORK/state"
cat > "$WORK/source/headless/podium" <<'SH'
#!/bin/sh
echo repaired-podium
SH
chmod 755 "$WORK/source/headless/podium"
VERSION=0.1.1-dev.3+2595a90
printf '%s\n' "$VERSION" > "$WORK/source/headless/VERSION"
case "$(uname -m)" in
  x86_64|amd64) HOST_PLATFORM=linux-x86_64 ;;
  aarch64|arm64) HOST_PLATFORM=linux-aarch64 ;;
  *) echo "unsupported test architecture $(uname -m)" >&2; exit 1 ;;
esac
ARTIFACT="$WORK/podium-headless-$VERSION-$HOST_PLATFORM.tar.gz"
tar -czf "$ARTIFACT" -C "$WORK/source" headless

openssl genpkey -algorithm ed25519 -out "$WORK/instance-private.pem" 2>/dev/null
openssl pkey -in "$WORK/instance-private.pem" -pubout -outform DER \
  -out "$WORK/instance-public.der" 2>/dev/null
base64 -w0 "$WORK/instance-public.der" > "$WORK/instance-public.b64"
openssl pkeyutl -sign -inkey "$WORK/instance-private.pem" -rawin -in "$ARTIFACT" \
  -out "$WORK/signature.raw"
base64 -w0 "$WORK/signature.raw" > "$ARTIFACT.sig"

DIGEST="sha256-$(openssl dgst -sha256 -binary "$ARTIFACT" | base64 -w0)"
SIZE="$(wc -c < "$ARTIFACT" | tr -d '[:space:]')"
FINGERPRINT="SHA256:$(openssl dgst -sha256 -binary "$WORK/instance-public.der" | base64 -w0)"
cat > "$ARTIFACT.meta.json" <<JSON
{
  "version": "$VERSION",
  "platform": "$HOST_PLATFORM",
  "digest": "$DIGEST",
  "size": $SIZE,
  "keyFingerprint": "$FINGERPRINT"
}
JSON
cat > "$WORK/state/daemon.json" <<JSON
{
  "machineId": "flatblock",
  "token": "never-read",
  "updatePubkey": "$(cat "$WORK/instance-public.b64")"
}
JSON

echo '== independently verifies and swaps without invoking the legacy updater =='
INSTALL="$WORK/install"
INVOCATION_LOG="$WORK/legacy-invoked"
make_install "$INSTALL"
PODIUM_REPAIR_INVOCATION_LOG="$INVOCATION_LOG" \
  sh "$ROOT/scripts/repair-stranded-update.sh" \
  --artifact "$ARTIFACT" --state-dir "$WORK/state" --install-dir "$INSTALL"
test "$(tr -d '\n\r' < "$INSTALL/VERSION")" = "$VERSION"
test "$(tr -d '\n\r' < "$INSTALL.old/VERSION")" = 0.1.0
test ! -e "$INVOCATION_LOG"

echo '== distinguishes a wrong pin before changing the install =='
WRONG_STATE="$WORK/wrong-state"
WRONG_INSTALL="$WORK/wrong-install"
mkdir -p "$WRONG_STATE"
make_install "$WRONG_INSTALL"
openssl genpkey -algorithm ed25519 -out "$WORK/wrong-private.pem" 2>/dev/null
openssl pkey -in "$WORK/wrong-private.pem" -pubout -outform DER 2>/dev/null |
  base64 -w0 > "$WORK/wrong-public.b64"
cat > "$WRONG_STATE/daemon.json" <<JSON
{"machineId":"wrong","updatePubkey":"$(cat "$WORK/wrong-public.b64")"}
JSON
if PODIUM_REPAIR_INVOCATION_LOG="$INVOCATION_LOG" \
  sh "$ROOT/scripts/repair-stranded-update.sh" \
  --artifact "$ARTIFACT" --state-dir "$WRONG_STATE" --install-dir "$WRONG_INSTALL" \
  >"$WORK/wrong.stdout" 2>"$WORK/wrong.stderr"; then
  echo 'FAIL: repair accepted an artifact for a different pinned key' >&2
  exit 1
fi
grep -F 'wrong key' "$WORK/wrong.stderr" >/dev/null
test "$(tr -d '\n\r' < "$WRONG_INSTALL/VERSION")" = 0.1.0
test ! -e "$WRONG_INSTALL.old"

echo '== refuses an unordered source label before changing the install =='
UNORDERED_INSTALL="$WORK/unordered-install"
make_install "$UNORDERED_INSTALL"
sed "s/\"version\": \"$VERSION\"/\"version\": \"dev+2595a90\"/" \
  "$ARTIFACT.meta.json" > "$WORK/unordered.meta.json"
cp "$ARTIFACT" "$WORK/unordered"
cp "$ARTIFACT.sig" "$WORK/unordered.sig"
if PODIUM_REPAIR_INVOCATION_LOG="$INVOCATION_LOG" \
  sh "$ROOT/scripts/repair-stranded-update.sh" \
  --artifact "$WORK/unordered" --state-dir "$WORK/state" --install-dir "$UNORDERED_INSTALL" \
  >"$WORK/unordered.stdout" 2>"$WORK/unordered.stderr"; then
  echo 'FAIL: repair accepted an unordered source version' >&2
  exit 1
fi
grep -F 'not an orderable published version' "$WORK/unordered.stderr" >/dev/null
test "$(tr -d '\n\r' < "$UNORDERED_INSTALL/VERSION")" = 0.1.0
test ! -e "$UNORDERED_INSTALL.old"

echo 'repair-stranded-update.sh tests passed'
