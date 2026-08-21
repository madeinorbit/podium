#!/usr/bin/env bash
# Linux-side assertions for the Darwin cross-compile spike (POD-2501).
# Exits non-zero on any failure. Does NOT claim macOS execution.
#
# Usage:
#   scripts/spike/linux-assert-darwin-spike.sh [spike-dir]
# Default spike-dir: dist-bun-spike/darwin-arm64
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SPIKE="${1:-$ROOT/dist-bun-spike/darwin-arm64}"
export PATH="${HOME}/.local/bin:${HOME}/.cargo/bin:${PATH}"

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }
need() { command -v "$1" >/dev/null || fail "need $1 on PATH"; }

need file
need tar
need rcodesign

[[ -d "$SPIKE" ]] || fail "spike dir missing: $SPIKE"

PODIUM="$SPIKE/podium"
ABDUCO="$SPIKE/abduco"
HEADLESS="$SPIKE/headless"
# Updater-layout tarball (archive root = headless/) — preferred name, fall back to spike name.
TARBALL=""
for c in \
  "$SPIKE/podium-headless-darwin-arm64.tar.gz" \
  "$SPIKE/podium-headless-spike-darwin-arm64.tar.gz"
do
  [[ -f "$c" ]] && TARBALL="$c" && break
done
[[ -n "$TARBALL" ]] || fail "no headless tarball under $SPIKE"

echo "=== linux-assert-darwin-spike ==="
echo "spike=$SPIKE"
echo "tarball=$TARBALL"

# --- Mach-O arch ---
file_podium="$(file -b "$PODIUM" 2>/dev/null || true)"
file_abduco="$(file -b "$ABDUCO" 2>/dev/null || true)"
echo "file podium: $file_podium"
echo "file abduco: $file_abduco"
[[ "$file_podium" == *"Mach-O"* && "$file_podium" == *"arm64"* ]] \
  || fail "podium is not Mach-O arm64 (got: $file_podium)"
pass "podium is Mach-O arm64"
[[ "$file_abduco" == *"Mach-O"* && "$file_abduco" == *"arm64"* ]] \
  || fail "abduco is not Mach-O arm64 (got: $file_abduco)"
pass "abduco is Mach-O arm64"

# Must not be a Linux ELF accidentally embedded/shipped as the "darwin" helper.
if [[ "$file_abduco" == *"ELF"* ]]; then
  fail "abduco looks like ELF (linux) — darwin cross-build was not used"
fi
# Contrast with host linux abduco if present.
if command -v abduco >/dev/null 2>&1; then
  host_ab="$(file -b "$(command -v abduco)" 2>/dev/null || true)"
  if [[ "$host_ab" == *"ELF"* && "$file_abduco" == *"Mach-O"* ]]; then
    pass "spike abduco is Mach-O while host abduco is ELF (not the linux binary)"
  fi
fi

# Embed path used at compile time: must be darwin Mach-O arm64 when present.
# (A later darwin-x64 spike build can overwrite this file — treat mismatch as FAIL
# so we never ship an arm64 podium that was accidentally re-linked against x64 abduco.)
EMBED="$ROOT/dist-bun/abduco.bin"
PREBUILT="$ROOT/scripts/prebuilt/abduco/darwin-arm64/abduco"
if [[ -f "$EMBED" ]]; then
  file_embed="$(file -b "$EMBED" 2>/dev/null || true)"
  echo "file embed dist-bun/abduco.bin: $file_embed"
  [[ "$file_embed" == *"Mach-O"* && "$file_embed" == *"arm64"* ]] \
    || fail "dist-bun/abduco.bin is not Mach-O arm64 (got: $file_embed). Restore from $PREBUILT before asserting/rebuilding."
  pass "compile-time embed dist-bun/abduco.bin is Mach-O arm64"
  if [[ -f "$PREBUILT" ]]; then
    # Byte identity: spike companion should match the prebuilt darwin-arm64 abduco.
    if cmp -s "$ABDUCO" "$PREBUILT"; then
      pass "spike abduco bytes match scripts/prebuilt/abduco/darwin-arm64/abduco"
    else
      fail "spike abduco differs from scripts/prebuilt/abduco/darwin-arm64/abduco"
    fi
  fi
else
  echo "NOTE: dist-bun/abduco.bin absent (ok if cleaned); relying on spike abduco + signature checks"
fi

# --- Ad-hoc signature present and parseable ---
sig_info="$(rcodesign print-signature-info "$PODIUM" 2>&1)" || fail "rcodesign print-signature-info failed on podium"
echo "$sig_info" | grep -q 'CodeSignatureFlags(ADHOC)' \
  || fail "podium signature missing ADHOC flag"
echo "$sig_info" | grep -q 'identifier: podium' \
  || fail "podium signature identifier is not 'podium'"
pass "podium has ad-hoc code signature (ADHOC, identifier=podium)"

ab_sig="$(rcodesign print-signature-info "$ABDUCO" 2>&1)" || fail "rcodesign print-signature-info failed on abduco"
echo "$ab_sig" | grep -q 'CodeSignatureFlags(ADHOC)' \
  || fail "abduco signature missing ADHOC flag"
pass "abduco has ad-hoc code signature (ADHOC)"

# Entitlements slot expected on the Bun binary (JIT).
echo "$sig_info" | grep -q 'Entitlements' \
  || fail "podium signature missing Entitlements slot (Bun JIT entitlements required)"
pass "podium signature includes Entitlements slot"

# --- headless/ dir layout (what the updater swaps in) ---
[[ -x "$HEADLESS/podium-cli" ]] || fail "missing executable headless/podium-cli"
[[ -x "$HEADLESS/podium" ]] || fail "missing executable headless/podium launcher"
[[ -f "$HEADLESS/VERSION" ]] || fail "missing headless/VERSION"
pass "headless/ has podium-cli, podium launcher, VERSION"

hf="$(file -b "$HEADLESS/podium-cli" 2>/dev/null || true)"
[[ "$hf" == *"Mach-O"* && "$hf" == *"arm64"* ]] \
  || fail "headless/podium-cli is not Mach-O arm64: $hf"
pass "headless/podium-cli is Mach-O arm64"

# --- Tarball layout the updater expects (archive root = headless/) ---
# packages/runtime/src/update-install.ts: replacement = join(staged, 'headless')
listing="$(tar -tzf "$TARBALL")"
echo "$listing" | grep -q '^headless/$' \
  || echo "$listing" | grep -q '^headless$' \
  || fail "tarball has no headless/ root entry"
echo "$listing" | grep -q '^headless/podium-cli$' \
  || fail "tarball missing headless/podium-cli"
echo "$listing" | grep -q '^headless/podium$' \
  || fail "tarball missing headless/podium"
echo "$listing" | grep -q '^headless/VERSION$' \
  || fail "tarball missing headless/VERSION"
# Refuse a tarball whose top-level is only loose binaries (old spike layout).
top="$(echo "$listing" | awk -F/ 'NF==1 || ($2=="" && NF==2){print $1}' | sort -u | head -20)"
echo "tarball top-level names: $top"
echo "$listing" | head -1 | grep -q '^headless/' \
  || fail "tarball first entry is not under headless/ (updater extract expects headless/)"
pass "tarball archive root is headless/ with podium-cli, podium, VERSION"

echo "=== ALL LINUX ASSERTIONS PASSED (no macOS execution claimed) ==="
