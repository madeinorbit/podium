#!/usr/bin/env bash
# E2E headless self-update verification: build the headless bundle once, stage a v0.1.0
# install + a v0.1.1 tarball, serve the v0.1.1 manifest+tarball on a LOCAL port, exercise
# the updater from a COPY of the v0.1.0 install, and assert its VERSION flips 0.1.0 -> 0.1.1.
#
# Chain exercised: podium update -> fetch /update/<target>/x86_64/<cur> manifest -> parse
# version -> isNewer(0.1.1, 0.1.0) -> download the tarball -> extract -> atomic dir swap ->
# the install's VERSION is now 0.1.1.
#
# Isolation: everything runs in mktemp dirs on a non-live port (:8789). It NEVER touches
# the live :18787 backend or ~/.podium. The build artifact (dist-bun/headless) is rebuilt
# but that is the worktree's own build output, not a live install.
#
# SECURITY: the feed serves a real Ed25519 signature. The valid-swap arm uses the updater's
# documented pubkeyB64 test seam because this checkout does not have the gitignored development
# signing key; it still exercises the real download -> verify -> extract -> atomic-swap logic.
# The TAMPER arm deliberately launches the shipped compiled `podium` binary, which must reject
# the fixture tarball against its committed production key and leave the install untouched.
# This split means the script no longer claims compiled-binary success for a valid update when
# the matching production private key is unavailable, while retaining compiled fail-closed
# coverage.
set -euo pipefail
cd "$(dirname "$0")/.."   # worktree root
export PATH="$HOME/.cargo/bin:$PATH"

PORT="${PODIUM_HEADLESS_FEED_PORT:-8789}"
ROOT="$(pwd)"
WORK="$(mktemp -d)"
FEED_PID=""
DEV_KEY="$ROOT/scripts/.podium-update-dev.key"
RUNNER_SCRIPT="$WORK/run-update.ts"
cleanup() {
  [ -n "$FEED_PID" ] && kill "$FEED_PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ABORT: required command '$1' is missing; the headless update verifier cannot run" >&2
    exit 1
  fi
}

for command in bun cp grep mktemp sed stat tar tee; do
  require_command "$command"
done

if [ -n "${PODIUM_AGENT_RELAY:-}" ]; then
  echo "=== PODIUM_AGENT_RELAY is set; isolated update children will run with PODIUM_AGENT_RELAY unset ==="
else
  echo "=== PODIUM_AGENT_RELAY is unset ==="
fi

if [ -f "$DEV_KEY" ]; then
  echo "=== $DEV_KEY is present; using an ephemeral fixture key anyway ==="
else
  echo "=== $DEV_KEY is absent; using an ephemeral fixture key (the gitignored key is not required) ==="
fi

# Generate a key only for this fixture. The private half stays in WORK and is never committed;
# the source runner receives the public half through runUpdate's explicit test seam.
FIXTURE_KEY="$WORK/fixture-signing.key"
FIXTURE_PUBKEY="$WORK/fixture-signing.pub"
if ! bun -e '
  const { generateKeyPairSync } = require("node:crypto");
  const { writeFileSync } = require("node:fs");
  const [privatePath, publicPath] = process.argv.slice(1);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  writeFileSync(privatePath, privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"));
  writeFileSync(publicPath, publicKey.export({ type: "spki", format: "der" }).toString("base64"));
' "$FIXTURE_KEY" "$FIXTURE_PUBKEY"; then
  echo "ABORT: could not generate the ephemeral Ed25519 fixture key; neither $DEV_KEY nor PODIUM_UPDATE_SIGNING_KEY can provide the test key" >&2
  exit 1
fi
SIGNING_KEY="$(<"$FIXTURE_KEY")"
PUBKEY="$(<"$FIXTURE_PUBKEY")"
[ -n "$SIGNING_KEY" ] || { echo "ABORT: generated fixture key file $FIXTURE_KEY is empty" >&2; exit 1; }
[ -n "$PUBKEY" ] || { echo "ABORT: generated fixture public-key file $FIXTURE_PUBKEY is empty" >&2; exit 1; }

# This runner intentionally imports the production updater source rather than editing or
# recompiling the committed production public-key constant. It uses the existing pubkeyB64 seam
# while keeping PODIUM_HOME pointed at the staged install, so the real swap path is exercised.
cat > "$RUNNER_SCRIPT" <<'EOF'
import { pathToFileURL } from 'node:url'

const source = process.env.PODIUM_UPDATE_SOURCE
const feed = process.env.PODIUM_UPDATE_FEED
const pubkey = process.env.PODIUM_UPDATE_TEST_PUBKEY
if (!source) throw new Error('PODIUM_UPDATE_SOURCE is required by the headless update fixture runner')
if (!feed) throw new Error('PODIUM_UPDATE_FEED is required by the headless update fixture runner')
if (!pubkey) throw new Error('PODIUM_UPDATE_TEST_PUBKEY is required by the headless update fixture runner')

const { runUpdate } = await import(pathToFileURL(source).href)
await runUpdate(feed, pubkey, () => false)
EOF

# --- build the headless bundle once -----------------------------------------
echo "=== BUILD headless bundle (this is slow) $(date -Is) ==="
if [ ! -x "dist-bun/headless/podium" ] || [ "${FORCE_BUILD:-0}" = "1" ]; then
  if ! bun run package:headless; then
    echo "ABORT: headless bundle build failed; check the build prerequisites and $DEV_KEY (the fixture signer is ephemeral)" >&2
    exit 1
  fi
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

# Sign the tarball with the ephemeral fixture key -> SIG (base64).
if ! SIG="$(bun -e '
  const { readFileSync } = require("node:fs");
  const { sign } = require("node:crypto");
  const der = Buffer.from(readFileSync(process.argv[1], "utf8").trim(), "base64");
  const sig = sign(null, readFileSync(process.argv[2]), { key: der, format: "der", type: "pkcs8" });
  process.stdout.write(sig.toString("base64"));
' "$FIXTURE_KEY" "$TARBALL")"; then
  echo "ABORT: could not sign the fixture tarball with the ephemeral key; check $FIXTURE_KEY" >&2
  exit 1
fi
[ -n "$SIG" ] || { echo "ABORT: fixture signing produced an empty signature" >&2; exit 1; }
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

run_update() { # <tarball-to-serve> <copy> <source|compiled> <expected-exit>
  local serve_tar="$1" copy="$2" mode="$3" expected_exit="$4"
  local log="$WORK/update-$mode.log"
  FEED_PID=""
  bun "$FEED_SCRIPT" "$serve_tar" 0.1.1 "$SIG" "$PORT" &
  FEED_PID=$!
  sleep 1
  cp -a "$INSTALL_V0" "$copy"
  local -a command=(
    env
    -u PODIUM_AGENT_RELAY
    -u PODIUM_UPDATE_SIGNING_KEY
    "PODIUM_UPDATE_FEED=http://127.0.0.1:$PORT"
    "PODIUM_HOME=$copy"
  )
  if [ "$mode" = "source" ]; then
    command+=(
      "PODIUM_UPDATE_SOURCE=$ROOT/apps/cli/src/podium-update.ts"
      "PODIUM_UPDATE_TEST_PUBKEY=$PUBKEY"
      bun
      --conditions=@podium/source
      "$RUNNER_SCRIPT"
    )
  elif [ "$mode" = "compiled" ]; then
    command+=("$copy/podium" update)
  else
    echo "ABORT: unknown headless update runner '$mode'" >&2
    return 1
  fi
  local -a statuses
  set +e
  "${command[@]}" 2>&1 | tee "$log" | sed 's/^/[update] /'
  statuses=("${PIPESTATUS[@]}")
  set -e
  local actual_exit="${statuses[0]}"
  kill "$FEED_PID" 2>/dev/null || true
  FEED_PID=""
  sleep 0.3
  if [ "$actual_exit" -ne "$expected_exit" ]; then
    echo "ABORT: $mode update child exited $actual_exit (expected $expected_exit); check PODIUM_AGENT_RELAY and PODIUM_UPDATE_FEED handling" >&2
    return 1
  fi
  if [ "$mode" = "source" ] && ! grep -q 'updated to 0.1.1' "$log"; then
    echo "ABORT: source update child did not report a completed swap; check PODIUM_UPDATE_TEST_PUBKEY and $ROOT/apps/cli/src/podium-update.ts" >&2
    return 1
  fi
  if [ "$mode" = "compiled" ] && ! grep -q 'signature verification FAILED' "$log"; then
    echo "ABORT: compiled tamper child did not reach the signature gate; check PODIUM_AGENT_RELAY and PODIUM_UPDATE_FEED" >&2
    return 1
  fi
}

# --- CASE 1: valid signature -> SWAP ----------------------------------------
echo "=== CASE 1: valid signed tarball via runUpdate pubkey seam (expect SWAP) ==="
GOOD="$WORK/copy-good"
run_update "$TARBALL" "$GOOD" source 10
GOOD_POST="$(cat "$GOOD/VERSION" 2>/dev/null || echo ABSENT)"

# --- CASE 2: tampered tarball under same sig -> REJECT (no swap) -------------
echo "=== CASE 2: tampered tarball via compiled podium (expect REJECT, no swap) ==="
BAD="$WORK/copy-bad"
run_update "$TAMPERED" "$BAD" compiled 1
BAD_POST="$(cat "$BAD/VERSION" 2>/dev/null || echo ABSENT)"

# --- assert -----------------------------------------------------------------
echo "---- RESULT ----"
echo "good copy VERSION: 0.1.0 -> $GOOD_POST  (expect 0.1.1)"
echo "bad  copy VERSION: 0.1.0 -> $BAD_POST   (expect 0.1.0, rejected)"
if [ "$GOOD_POST" = "0.1.1" ] && [ -x "$GOOD/podium" ] && [ "$BAD_POST" = "0.1.0" ]; then
  echo "HEADLESS UPDATE VERIFIED ✓ — source-seam signed tarball SWAPPED, compiled podium tamper REJECTED"
  exit 0
fi
echo "HEADLESS UPDATE NOT verified — good='$GOOD_POST' (want 0.1.1), bad='$BAD_POST' (want 0.1.0)"
exit 2
