#!/usr/bin/env bash
# E2E headless self-update verification: build the headless bundle once, stage a v0.1.0
# install + a v0.1.1 tarball, serve the v0.1.1 manifest+tarball on a LOCAL port, run
# `podium update` from a COPY of the v0.1.0 install, and assert its VERSION flips 0.1.0 ->
# 0.1.1.
#
# Chain exercised: podium update -> fetch /update/<target>/x86_64/<cur> manifest -> parse
# version -> isNewer(0.1.1, 0.1.0) -> download the tarball -> extract -> atomic dir swap ->
# the install's VERSION is now 0.1.1.
#
# Isolation: everything runs in mktemp dirs on a non-live port (:8789). It NEVER touches
# the live :18787 backend or ~/.podium. The build artifact (dist-bun/headless) is rebuilt
# but that is the worktree's own build output, not a live install.
#
# SECURITY: the feed serves the tarball's real Ed25519 signature (built by build-bun.ts as
# podium-headless-<v>.tar.gz.sig, signed with the dev key). `podium update` verifies it against
# the committed pubkey BEFORE swapping. This script also exercises the TAMPER path: a feed that
# advertises a valid version but a corrupted tarball must be REJECTED (no swap).
set -uo pipefail
cd "$(dirname "$0")/.."   # worktree root
export PATH="$HOME/.cargo/bin:$PATH"

PORT="${PODIUM_HEADLESS_FEED_PORT:-8789}"
ROOT="$(pwd)"
WORK="$(mktemp -d)"
FEED_PID=""
cleanup() {
  [ -n "$FEED_PID" ] && kill "$FEED_PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# --- build the headless bundle once -----------------------------------------
echo "=== BUILD headless bundle (this is slow) $(date -Is) ==="
if [ ! -x "dist-bun/headless/podium" ] || [ "${FORCE_BUILD:-0}" = "1" ]; then
  bun run package:headless
else
  echo "=== reusing existing dist-bun/headless (set FORCE_BUILD=1 to rebuild) ==="
fi
[ -x "dist-bun/headless/podium" ] || { echo "ABORT: headless bundle missing after build"; exit 1; }

# --- stage v0.1.0 (the install under test) ----------------------------------
INSTALL_V0="$WORK/install-0.1.0"
cp -a "dist-bun/headless" "$INSTALL_V0"
printf '0.1.0\n' > "$INSTALL_V0/VERSION"
echo "=== staged v0.1.0 install at $INSTALL_V0 (VERSION=$(cat "$INSTALL_V0/VERSION")) ==="

# --- stage a v0.1.1 tarball (the update artifact the feed serves) -----------
STAGE_V1="$WORK/stage-0.1.1"
mkdir -p "$STAGE_V1"
cp -a "dist-bun/headless" "$STAGE_V1/headless"
printf '0.1.1\n' > "$STAGE_V1/headless/VERSION"
TARBALL="$WORK/podium-headless-0.1.1.tar.gz"
tar -czf "$TARBALL" -C "$STAGE_V1" headless
echo "=== staged v0.1.1 tarball $TARBALL ($(stat -c%s "$TARBALL") bytes) ==="

# Sign the tarball with the dev key (matches the committed pubkey) -> SIG (base64).
SIG="$(bun -e '
  const { readFileSync } = require("node:fs");
  const { sign } = require("node:crypto");
  const der = Buffer.from(readFileSync(process.argv[1], "utf8").trim(), "base64");
  const sig = sign(null, readFileSync(process.argv[2]), { key: der, format: "der", type: "pkcs8" });
  process.stdout.write(sig.toString("base64"));
' "$ROOT/scripts/.podium-update-dev.key" "$TARBALL")"
echo "=== signed v0.1.1 tarball (sig ${#SIG} chars) ==="

# Also stage a TAMPERED tarball (a byte appended) the bad feed will serve under the same sig.
TAMPERED="$WORK/podium-headless-0.1.1.tampered.tar.gz"
cp "$TARBALL" "$TAMPERED"
printf 'x' >> "$TAMPERED"

# --- serve the v0.1.1 manifest + tarball + signature on a local port --------
FEED_SCRIPT="$WORK/feed.ts"
cat > "$FEED_SCRIPT" <<'EOF'
import { serve } from 'bun'
import { readFileSync } from 'node:fs'
const [tarball, version, sig, portArg] = process.argv.slice(2)
const port = Number(portArg ?? 8789)
const buf = readFileSync(tarball)
serve({
  port,
  hostname: '127.0.0.1',
  fetch(req) {
    const url = new URL(req.url)
    if (url.pathname.startsWith('/update/')) {
      console.error(`[feed] manifest request: ${url.pathname} -> v${version}`)
      return Response.json({
        version,
        notes: 'headless verification build',
        pub_date: '2026-06-22T00:00:00Z',
        platforms: { 'linux-x86_64': { url: `http://127.0.0.1:${port}/artifact`, signature: sig } },
      })
    }
    if (url.pathname === '/artifact') {
      console.error(`[feed] artifact request (${buf.byteLength} bytes)`)
      return new Response(buf, { headers: { 'content-type': 'application/gzip' } })
    }
    return new Response('not found', { status: 404 })
  },
})
console.error(`headless feed v${version} on :${port}`)
EOF

run_update() { # <tarball-to-serve> ; serves under the valid SIG, runs update on a fresh copy
  local serve_tar="$1" copy="$2"
  FEED_PID=""
  bun "$FEED_SCRIPT" "$serve_tar" 0.1.1 "$SIG" "$PORT" &
  FEED_PID=$!
  sleep 1
  cp -a "$INSTALL_V0" "$copy"
  PODIUM_UPDATE_FEED="http://127.0.0.1:$PORT" PODIUM_HOME="$copy" "$copy/podium" update 2>&1 | sed 's/^/[update] /'
  kill "$FEED_PID" 2>/dev/null || true
  FEED_PID=""
  sleep 0.3
}

# --- CASE 1: valid signature -> SWAP ----------------------------------------
echo "=== CASE 1: valid signed tarball (expect SWAP) ==="
GOOD="$WORK/copy-good"
run_update "$TARBALL" "$GOOD"
GOOD_POST="$(cat "$GOOD/VERSION" 2>/dev/null || echo ABSENT)"

# --- CASE 2: tampered tarball under same sig -> REJECT (no swap) -------------
echo "=== CASE 2: tampered tarball (expect REJECT, no swap) ==="
BAD="$WORK/copy-bad"
run_update "$TAMPERED" "$BAD"
BAD_POST="$(cat "$BAD/VERSION" 2>/dev/null || echo ABSENT)"

# --- assert -----------------------------------------------------------------
echo "---- RESULT ----"
echo "good copy VERSION: 0.1.0 -> $GOOD_POST  (expect 0.1.1)"
echo "bad  copy VERSION: 0.1.0 -> $BAD_POST   (expect 0.1.0, rejected)"
if [ "$GOOD_POST" = "0.1.1" ] && [ -x "$GOOD/podium" ] && [ "$BAD_POST" = "0.1.0" ]; then
  echo "HEADLESS UPDATE VERIFIED ✓ — signed tarball SWAPPED, tampered tarball REJECTED"
  exit 0
fi
echo "HEADLESS UPDATE NOT verified — good='$GOOD_POST' (want 0.1.1), bad='$BAD_POST' (want 0.1.0)"
exit 2
