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
# NOTE: the headless tarball uses an UNSIGNED manifest — `podium update` does its own
# version check only. Signing the headless tarball (minisign, like the desktop AppImage)
# is a later hardening step.
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

# --- serve the v0.1.1 manifest + tarball on a local port --------------------
FEED_SCRIPT="$WORK/feed.ts"
cat > "$FEED_SCRIPT" <<'EOF'
import { serve } from 'bun'
import { readFileSync } from 'node:fs'
const [tarball, version, portArg] = process.argv.slice(2)
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
        platforms: { 'linux-x86_64': { url: `http://127.0.0.1:${port}/artifact`, signature: '' } },
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
bun "$FEED_SCRIPT" "$TARBALL" 0.1.1 "$PORT" &
FEED_PID=$!
sleep 1
echo "=== FEED up (pid $FEED_PID) on :$PORT ==="
curl -fsS "http://127.0.0.1:$PORT/update/linux-x86_64/x86_64/0.1.0" | head -c 300; echo

# --- run `podium update` from a COPY of the v0.1.0 install -------------------
COPY="$WORK/copy-under-test"
cp -a "$INSTALL_V0" "$COPY"
PRE="$(cat "$COPY/VERSION")"
echo "=== RUN podium update (copy VERSION pre=$PRE) ==="
PODIUM_UPDATE_FEED="http://127.0.0.1:$PORT" PODIUM_HOME="$COPY" "$COPY/podium" update 2>&1 | sed 's/^/[update] /'
POST="$(cat "$COPY/VERSION" 2>/dev/null || echo ABSENT)"

# --- assert -----------------------------------------------------------------
echo "---- RESULT ----"
echo "copy VERSION: $PRE -> $POST"
if [ "$POST" = "0.1.1" ] && [ -x "$COPY/podium" ]; then
  echo "HEADLESS UPDATE VERIFIED ✓ (v0.1.0 -> v0.1.1) — podium update swapped the bundle"
  exit 0
fi
echo "HEADLESS UPDATE NOT verified — VERSION is '$POST' (expected 0.1.1)"
exit 2
