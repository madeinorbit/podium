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
  darwin-arm64) EXPECT_ARCH="arm64" ;;
  darwin-x64)   EXPECT_ARCH="x86_64" ;;
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

echo "=== linux-assert-darwin-spike ==="
echo "tarball=$TARBALL"
echo "platform=$PLATFORM (expect Mach-O $EXPECT_ARCH)"
echo "tarball sha256=$(sha256sum "$TARBALL" | cut -d' ' -f1)"

# --- Tarball layout the updater expects (archive root = headless/) ---
# packages/runtime/src/update-install.ts: replacement = join(staged, 'headless')
listing="$(tar -tzf "$TARBALL")" || fail "cannot list $TARBALL"
echo "$listing" | grep -qE '^headless/?$' || fail "tarball has no headless/ root entry"
for want in headless/podium-cli headless/podium headless/podium-host headless/VERSION; do
  echo "$listing" | grep -qx "$want" || fail "tarball missing $want"
done
echo "$listing" | head -1 | grep -q '^headless/' \
  || fail "tarball first entry is not under headless/ (updater extract expects headless/)"
stray="$(echo "$listing" | awk -F/ '{print $1}' | sort -u | grep -vx 'headless' || true)"
[[ -z "$stray" ]] || fail "tarball has entries outside headless/: $stray"
pass "tarball archive root is headless/ with podium-cli, podium, podium-host, VERSION and nothing else"

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

# Size floor: a bundled Bun runtime is tens of megabytes. A signed hello-world with the
# right identifier and entitlements satisfies every other check here; not this one.
size="$(stat -c%s "$CLI")"
[[ "$size" -ge 20000000 ]] \
  || fail "shipped podium-cli is only $size bytes — far too small to embed the Bun runtime"
pass "shipped podium-cli is $size bytes"

# --- Nothing native rode along inside the CLI; the Rust host ships beside it ---
# The CLI embeds no helper any more (the spike once embedded abduco; it and the C
# podium-host are retired), so a Linux ELF header or a retired helper's identifying
# string inside the Mach-O is a build that pulled the wrong bytes in.
embed_report="$(python3 - "$CLI" <<'PY'
import sys
data = open(sys.argv[1], 'rb').read()
# A whole 64-bit little-endian SysV ELF header, not just the 4-byte magic:
# chance of a false positive in a ~70 MB binary is negligible.
print(f"elf_headers={data.count(b'\x7fELF\x02\x01\x01')}")
print(f"abduco_banner={data.count(b'abduco-0.6-podium')}")
print(f"c_host={data.count(b'podium-host %s features=%d')}")
PY
)" || fail "shipped-binary byte scan failed"
echo "$embed_report"
eval "$(echo "$embed_report" | sed 's/^/EMB_/')"
[[ "${EMB_elf_headers}" == "0" ]] \
  || fail "shipped binary contains ${EMB_elf_headers} Linux ELF header(s) — a linux binary was embedded"
pass "shipped binary contains no Linux ELF header"
[[ "${EMB_abduco_banner}" == "0" && "${EMB_c_host}" == "0" ]] \
  || fail "shipped binary carries a retired abduco or C podium-host"
pass "shipped binary carries no retired abduco or C podium-host"

HOST="$WORK/headless/podium-host"
[[ -x "$HOST" ]] || fail "extracted headless/podium-host is missing or not executable"
file_host="$(file -b "$HOST")"
echo "file headless/podium-host: $file_host"
[[ "$file_host" == *"Mach-O"* && "$file_host" == *"$EXPECT_ARCH"* ]] \
  || fail "shipped podium-host is not Mach-O $EXPECT_ARCH (got: $file_host)"
host_sig="$(rcodesign print-signature-info "$HOST" 2>&1)" \
  || fail "cannot read shipped podium-host signature"
echo "$host_sig" | grep -q 'CodeSignatureFlags(ADHOC' \
  || fail "shipped podium-host has no ad-hoc signature"
pass "shipped headless/podium-host is an ad-hoc signed Mach-O $EXPECT_ARCH"

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
