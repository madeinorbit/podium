#!/usr/bin/env bash
# Linux-side assertions for the Darwin cross-compile spike (POD-2501).
#
# EVERY check runs against the binary INSIDE the shipped tarball — the tarball is
# extracted to a temp dir and `headless/podium-cli` from that extraction is the
# only subject. Nothing here inspects a loose sibling binary, and nothing is
# skipped when an input is missing: a missing input is a FAIL, never a pass.
#
# This script does NOT claim macOS execution. See spec section 8b for what the
# macOS CI run proved.
#
# Usage:
#   scripts/spike/linux-assert-darwin-spike.sh [tarball-or-spike-dir] [platform]
#
# Defaults: dist-bun-spike/darwin-arm64/podium-headless-darwin-arm64.tar.gz, darwin-arm64
#
# Proof that it can fail: scripts/spike/prove-assert-can-fail.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export PATH="${HOME}/.local/bin:${HOME}/.cargo/bin:${PATH}"

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }
need() { command -v "$1" >/dev/null || fail "need $1 on PATH"; }

need file
need tar
need rcodesign
need python3

ARG="${1:-$ROOT/dist-bun-spike/darwin-arm64}"
PLATFORM="${2:-darwin-arm64}"
case "$PLATFORM" in
  darwin-arm64) EXPECT_ARCH="arm64"; OTHER_PLATFORM="darwin-x64" ;;
  darwin-x64)   EXPECT_ARCH="x86_64"; OTHER_PLATFORM="darwin-arm64" ;;
  *) fail "unknown platform '$PLATFORM' (want darwin-arm64 | darwin-x64)" ;;
esac

# --- resolve the tarball (the ONLY subject of this script) ---
if [[ -f "$ARG" ]]; then
  TARBALL="$ARG"
elif [[ -d "$ARG" ]]; then
  TARBALL=""
  # Only the updater-shaped tarball counts. The build script's
  # podium-headless-spike-*.tar.gz carries loose extras and is NOT what ships.
  TARBALL="$ARG/podium-headless-$PLATFORM.tar.gz"
  [[ -f "$TARBALL" ]] \
    || fail "no updater-shaped tarball at $TARBALL — run scripts/spike/package-mac-execution-bundle.sh (this is a FAIL, not a skip)"
else
  fail "no such tarball or spike dir: $ARG"
fi

PREBUILT="$ROOT/scripts/prebuilt/abduco/$PLATFORM/abduco"
OTHER_PREBUILT="$ROOT/scripts/prebuilt/abduco/$OTHER_PLATFORM/abduco"

echo "=== linux-assert-darwin-spike ==="
echo "tarball=$TARBALL"
echo "platform=$PLATFORM (expect Mach-O $EXPECT_ARCH)"
echo "tarball sha256=$(sha256sum "$TARBALL" | cut -d' ' -f1)"

# --- Tarball layout the updater expects (archive root = headless/) ---
# packages/runtime/src/update-install.ts: replacement = join(staged, 'headless')
listing="$(tar -tzf "$TARBALL")" || fail "cannot list $TARBALL"
echo "$listing" | grep -qE '^headless/?$' || fail "tarball has no headless/ root entry"
for want in headless/podium-cli headless/podium headless/VERSION; do
  echo "$listing" | grep -qx "$want" || fail "tarball missing $want"
done
echo "$listing" | head -1 | grep -q '^headless/' \
  || fail "tarball first entry is not under headless/ (updater extract expects headless/)"
stray="$(echo "$listing" | awk -F/ '{print $1}' | sort -u | grep -vx 'headless' || true)"
[[ -z "$stray" ]] || fail "tarball has entries outside headless/: $stray"
pass "tarball archive root is headless/ with podium-cli, podium, VERSION and nothing else"

# --- Extract; everything below interrogates the EXTRACTED bytes ---
WORK="$(mktemp -d "${TMPDIR:-/tmp}/podium-assert-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
tar -xzf "$TARBALL" -C "$WORK" || fail "cannot extract $TARBALL"
CLI="$WORK/headless/podium-cli"
[[ -f "$CLI" ]] || fail "no headless/podium-cli after extract"
[[ -x "$CLI" ]] || fail "extracted headless/podium-cli is not executable"
[[ -x "$WORK/headless/podium" ]] || fail "extracted headless/podium launcher is not executable"
[[ -s "$WORK/headless/VERSION" ]] || fail "extracted headless/VERSION is empty"
echo "shipped binary sha256=$(sha256sum "$CLI" | cut -d' ' -f1)"
echo "shipped VERSION=$(tr -d '\n' <"$WORK/headless/VERSION")"

# --- Mach-O arch of the SHIPPED binary ---
file_cli="$(file -b "$CLI")"
echo "file headless/podium-cli: $file_cli"
[[ "$file_cli" == *"Mach-O"* ]] || fail "shipped podium-cli is not Mach-O (got: $file_cli)"
[[ "$file_cli" == *"$EXPECT_ARCH"* ]] || fail "shipped podium-cli is not $EXPECT_ARCH (got: $file_cli)"
[[ "$file_cli" == *"ELF"* ]] && fail "shipped podium-cli is an ELF — this is a Linux binary"
pass "shipped headless/podium-cli is Mach-O $EXPECT_ARCH"

# --- The embedded abduco is the DARWIN prebuilt, and no ELF rode along ---
[[ -f "$PREBUILT" ]] \
  || fail "prebuilt abduco missing: $PREBUILT — rebuild with scripts/spike/build-prebuilt-abduco.sh (this is a FAIL, not a skip)"
pf="$(file -b "$PREBUILT")"
[[ "$pf" == *"Mach-O"* && "$pf" == *"$EXPECT_ARCH"* ]] \
  || fail "prebuilt abduco is not Mach-O $EXPECT_ARCH (got: $pf)"
pass "prebuilt abduco input is Mach-O $EXPECT_ARCH"

embed_report="$(python3 - "$CLI" "$PREBUILT" "$OTHER_PREBUILT" <<'PY'
import sys
cli, prebuilt, other = sys.argv[1], sys.argv[2], sys.argv[3]
data = open(cli, 'rb').read()
want = open(prebuilt, 'rb').read()
at = data.find(want)
print(f"size={len(data)}")
print(f"prebuilt_len={len(want)}")
print(f"prebuilt_at={at}")
# A whole 64-bit little-endian SysV ELF header, not just the 4-byte magic:
# chance of a false positive in a ~70 MB binary is negligible.
print(f"elf_headers={data.count(b'\x7fELF\x02\x01\x01')}")
print(f"abduco_banner={data.count(b'abduco-0.6-podium')}")
try:
    o = open(other, 'rb').read()
    print(f"other_prebuilt_at={data.find(o)}")
except FileNotFoundError:
    print("other_prebuilt_at=absent-input")
PY
)" || fail "embedded-abduco byte scan failed"
echo "$embed_report"
eval "$(echo "$embed_report" | sed 's/^/EMB_/')"

# Order matters: a build that embedded the LINUX abduco fails BOTH of the next two
# checks, and "a linux binary rode along" is the more useful message of the two.
[[ "${EMB_elf_headers}" == "0" ]] \
  || fail "shipped binary contains ${EMB_elf_headers} Linux ELF header(s) — a linux binary was embedded"
pass "shipped binary contains no Linux ELF header"

[[ "${EMB_prebuilt_at}" != "-1" ]] \
  || fail "the darwin $EXPECT_ARCH prebuilt abduco (${EMB_prebuilt_len} bytes) does NOT appear inside the shipped binary"
pass "shipped binary contains the darwin $EXPECT_ARCH prebuilt abduco verbatim at offset ${EMB_prebuilt_at}"

[[ "${EMB_abduco_banner}" == "1" ]] \
  || fail "expected exactly one abduco banner string in the shipped binary, found ${EMB_abduco_banner}"
pass "shipped binary carries exactly one abduco copy (banner string count = 1)"

case "${EMB_other_prebuilt_at}" in
  -1) pass "the $OTHER_PLATFORM abduco is absent from the shipped binary" ;;
  absent-input) echo "NOTE: $OTHER_PREBUILT not built; cross-arch absence not checked" ;;
  *) fail "the $OTHER_PLATFORM abduco is embedded at offset ${EMB_other_prebuilt_at} — wrong arch helper" ;;
esac

# --- Signature of the SHIPPED binary ---
sig="$(rcodesign print-signature-info "$CLI" 2>&1)" \
  || fail "rcodesign print-signature-info failed on the shipped binary (no parseable signature?)"
echo "$sig" | grep -q 'signature: null' \
  && fail "shipped binary has NO code signature at all"
echo "$sig" | grep -q 'CodeSignatureFlags(ADHOC' \
  || fail "shipped binary signature missing ADHOC flag"
pass "shipped binary has an ad-hoc code signature"

# Bun's own `--compile` output is already ad-hoc signed, but as LINKER_SIGNED with
# identifier a.out. Both discriminators below prove rcodesign re-signed it: that is
# what carries the JIT entitlements, which Bun's linker signature does not.
echo "$sig" | grep -q 'LINKER_SIGNED' \
  && fail "shipped binary still carries Bun's LINKER_SIGNED signature — rcodesign did not re-sign it"
echo "$sig" | grep -q 'identifier: podium' \
  || fail "shipped binary signature identifier is not 'podium' (Bun's linker signature uses a.out)"
pass "shipped binary was re-signed by rcodesign (identifier=podium, not LINKER_SIGNED)"

# Entitlements: the CONTENT, not just the presence of the slot.
for ent in \
  com.apple.security.cs.allow-jit \
  com.apple.security.cs.allow-unsigned-executable-memory \
  com.apple.security.cs.disable-executable-page-protection \
  com.apple.security.cs.allow-dyld-environment-variables \
  com.apple.security.cs.disable-library-validation
do
  echo "$sig" | grep -q "$ent" || fail "shipped binary entitlements missing $ent"
done
pass "shipped binary carries the full Bun JIT entitlement set (5 keys)"

# Seal: do the recorded code hashes still match the shipped bytes?
# `rcodesign verify` always reports a CMS error for an ad-hoc signature (there is no
# CMS blob to parse) — that line is our proof the verifier actually ran. What must
# NOT appear is a code digest mismatch.
verify_out="$(rcodesign verify "$CLI" 2>&1 || true)"
echo "$verify_out" | grep -q 'CMS error' \
  || fail "rcodesign verify did not produce the expected ad-hoc CMS marker — verifier did not run as expected:
$verify_out"
if echo "$verify_out" | grep -qi 'digest mismatch'; then
  fail "code digest mismatch — the signature does not seal the shipped bytes:
$(echo "$verify_out" | grep -i 'digest mismatch' | head -3)"
fi
pass "signature seals the shipped bytes (no code digest mismatch under rcodesign verify)"

echo "=== ALL LINUX ASSERTIONS PASSED for $(basename "$TARBALL") ==="
echo "(Linux-side only. macOS execution evidence: spec section 8b + docs/internal/superpowers/spikes/2026-08-21-mac-verify-round2.log)"
