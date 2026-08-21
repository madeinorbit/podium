#!/usr/bin/env bash
# Interrogate a SHIPPED headless tarball: is it really a bundle for the platform it
# claims, built the way a release is supposed to build it?
#
# EVERY check runs against bytes extracted FROM THE TARBALL. Nothing here inspects a
# loose sibling binary in a build directory — the thing that ships is the only subject,
# because a build tree can be right while the archive is wrong. (Grown out of the
# POD-2501 spike, whose first version checked a sibling and would have passed a 50 KB
# hello-world.)
#
# A MISSING INPUT IS A FAILURE, NEVER A SKIP. The embedded-helper identity check needs
# the reference abduco; running without it requires saying so explicitly with
# --no-abduco-identity, so an omitted path can never read as a green.
#
# Usage:
#   scripts/assert-headless-bundle.sh <tarball> <platform> --abduco <reference-binary>
#   scripts/assert-headless-bundle.sh <tarball> <platform> --no-abduco-identity
#
# platform: linux-x86_64 | linux-aarch64 | darwin-aarch64 | darwin-x86_64
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="${HOME}/.local/bin:${HOME}/.cargo/bin:${PATH}"

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }
need() { command -v "$1" >/dev/null || fail "need $1 on PATH"; }

TARBALL=""
PLATFORM=""
ABDUCO_REF=""
ABDUCO_IDENTITY=unset
while [ $# -gt 0 ]; do
  case "$1" in
    --abduco) ABDUCO_REF="${2:-}"; ABDUCO_IDENTITY=required; shift 2 ;;
    --no-abduco-identity) ABDUCO_IDENTITY=waived; shift ;;
    -*) fail "unknown flag $1" ;;
    *)
      if [ -z "$TARBALL" ]; then TARBALL="$1"
      elif [ -z "$PLATFORM" ]; then PLATFORM="$1"
      else fail "unexpected argument $1"; fi
      shift ;;
  esac
done

[ -n "$TARBALL" ] || fail "pass the tarball to interrogate"
[ -n "$PLATFORM" ] || fail "pass the platform the tarball claims to be for"
[ -f "$TARBALL" ] || fail "no such tarball: $TARBALL"
[ "$ABDUCO_IDENTITY" != unset ] \
  || fail "pass --abduco <reference-binary> to check the embedded helper, or --no-abduco-identity to state deliberately that you are not checking it"

need file
need tar
need python3

# EXPECT_FORMAT/EXPECT_ARCH are what `file -b` prints for a correct binary; OTHER_* name
# the platform whose helper must NOT be inside, which is the check that catches a build
# that embedded the host's abduco instead of the target's.
case "$PLATFORM" in
  linux-x86_64)   EXPECT_FORMAT="ELF";     EXPECT_ARCH="x86-64";  OTHER_PLATFORM="linux-aarch64" ;;
  linux-aarch64)  EXPECT_FORMAT="ELF";     EXPECT_ARCH="aarch64"; OTHER_PLATFORM="linux-x86_64" ;;
  darwin-aarch64) EXPECT_FORMAT="Mach-O";  EXPECT_ARCH="arm64";   OTHER_PLATFORM="darwin-x86_64" ;;
  darwin-x86_64)  EXPECT_FORMAT="Mach-O";  EXPECT_ARCH="x86_64";  OTHER_PLATFORM="darwin-aarch64" ;;
  *) fail "unknown platform '$PLATFORM'" ;;
esac
case "$PLATFORM" in darwin-*) IS_DARWIN=1 ;; *) IS_DARWIN=0 ;; esac
[ "$IS_DARWIN" = 1 ] && need rcodesign

echo "=== assert-headless-bundle ==="
echo "tarball=$TARBALL"
echo "platform=$PLATFORM (expect $EXPECT_FORMAT $EXPECT_ARCH)"
echo "tarball sha256=$(sha256sum "$TARBALL" | cut -d' ' -f1)"

# --- The layout the updater extracts into (packages/runtime/src/update-install.ts
# --- joins the staged dir with 'headless', so anything else silently installs nothing).
listing="$(tar -tzf "$TARBALL")" || fail "cannot list $TARBALL"
for want in headless/podium-cli headless/podium headless/VERSION; do
  echo "$listing" | grep -qx "$want" || fail "tarball missing $want"
done
stray="$(echo "$listing" | awk -F/ '{print $1}' | sort -u | grep -vx 'headless' || true)"
[ -z "$stray" ] || fail "tarball has entries outside headless/: $stray"
pass "archive root is headless/ and carries podium-cli, podium and VERSION"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/podium-assert-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
tar -xzf "$TARBALL" -C "$WORK" || fail "cannot extract $TARBALL"
CLI="$WORK/headless/podium-cli"
[ -x "$CLI" ] || fail "extracted headless/podium-cli is missing or not executable"
[ -x "$WORK/headless/podium" ] || fail "extracted headless/podium launcher is not executable"
[ -s "$WORK/headless/VERSION" ] || fail "extracted headless/VERSION is empty"
for site in web mobile; do
  [ -f "$WORK/headless/$site/index.html" ] || fail "extracted bundle has no $site/index.html"
done
pass "bundle carries both client sites and a non-empty VERSION ($(tr -d '\n' <"$WORK/headless/VERSION"))"
echo "shipped podium-cli sha256=$(sha256sum "$CLI" | cut -d' ' -f1)"

# --- Object format and architecture of the SHIPPED binary ---
file_cli="$(file -b "$CLI")"
echo "file headless/podium-cli: $file_cli"
case "$file_cli" in
  *"$EXPECT_FORMAT"*) : ;;
  *) fail "shipped podium-cli is not $EXPECT_FORMAT (got: $file_cli)" ;;
esac
case "$file_cli" in
  *"$EXPECT_ARCH"*) : ;;
  *) fail "shipped podium-cli is not $EXPECT_ARCH (got: $file_cli)" ;;
esac
# Size floor: a bundled Bun runtime is tens of megabytes. A stub that satisfies every
# string check above cannot satisfy this one.
size="$(stat -c%s "$CLI")"
[ "$size" -ge 20000000 ] \
  || fail "shipped podium-cli is only $size bytes — far too small to embed the Bun runtime"
pass "shipped podium-cli is $EXPECT_FORMAT $EXPECT_ARCH, $size bytes"

# --- The embedded abduco helper is the one built FOR THIS PLATFORM ---
if [ "$ABDUCO_IDENTITY" = required ]; then
  [ -f "$ABDUCO_REF" ] || fail "reference abduco missing: $ABDUCO_REF (regenerate with scripts/abduco-cross.ts)"
  ref_file="$(file -b "$ABDUCO_REF")"
  case "$ref_file" in
    *"$EXPECT_FORMAT"*"$EXPECT_ARCH"*|*"$EXPECT_ARCH"*) : ;;
    *) fail "reference abduco is not $EXPECT_FORMAT $EXPECT_ARCH (got: $ref_file)" ;;
  esac
  OTHER_REF="$ROOT/dist-bun/abduco-cache/$OTHER_PLATFORM-$(basename "$ABDUCO_REF" | sed "s/^$PLATFORM-//")"
  report="$(python3 - "$CLI" "$ABDUCO_REF" "$OTHER_REF" <<'PY'
import sys
cli, ref, other = sys.argv[1:4]
data = open(cli, 'rb').read()
want = open(ref, 'rb').read()
print(f"ref_len={len(want)}")
print(f"ref_at={data.find(want)}")
print(f"banner={data.count(b'abduco-0.6-podium')}")
try:
    print(f"other_at={data.find(open(other, 'rb').read())}")
except OSError:
    print("other_at=absent-input")
PY
)" || fail "embedded-helper byte scan failed"
  echo "$report"
  eval "$(echo "$report" | sed 's/^/EMB_/')"
  [ "${EMB_ref_at}" != "-1" ] \
    || fail "the $PLATFORM abduco (${EMB_ref_len} bytes) does NOT appear inside the shipped binary — the wrong helper was embedded"
  pass "shipped binary embeds the $PLATFORM abduco verbatim at offset ${EMB_ref_at}"
  [ "${EMB_banner}" = "1" ] \
    || fail "expected exactly one abduco copy in the shipped binary, found ${EMB_banner} banner strings"
  pass "shipped binary carries exactly one abduco"
  case "${EMB_other_at}" in
    -1) pass "the $OTHER_PLATFORM abduco is absent from the shipped binary" ;;
    absent-input) echo "NOTE: no $OTHER_PLATFORM reference built; cross-arch absence not checked" ;;
    *) fail "the $OTHER_PLATFORM abduco is embedded at offset ${EMB_other_at} — wrong architecture helper" ;;
  esac
else
  echo "NOTE: embedded-helper identity NOT checked (--no-abduco-identity was passed)"
fi

# --- Darwin code signature: the thing that makes the binary runnable at all ---
if [ "$IS_DARWIN" = 1 ]; then
  sig="$(rcodesign print-signature-info "$CLI" 2>&1)" \
    || fail "rcodesign could not parse a signature out of the shipped binary"
  echo "$sig" | grep -q 'signature: null' && fail "shipped binary has NO code signature — Apple Silicon will refuse to execute it"
  echo "$sig" | grep -q 'CodeSignatureFlags(ADHOC' || fail "shipped binary signature is missing the ADHOC flag"
  # Bun's --compile output is ALREADY ad-hoc signed, as LINKER_SIGNED with identifier
  # a.out and no entitlements. Both discriminators below prove the build re-signed it
  # with rcodesign, which is what attaches the JIT entitlements JavaScriptCore needs.
  echo "$sig" | grep -q 'LINKER_SIGNED' \
    && fail "shipped binary still carries Bun's LINKER_SIGNED signature — the JIT entitlements were never attached"
  echo "$sig" | grep -q 'identifier: podium' \
    || fail "shipped binary signature identifier is not 'podium' (Bun's linker signature uses a.out)"
  pass "shipped binary was re-signed ad-hoc by rcodesign (identifier=podium)"
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

  # Does the signature still seal these bytes? An ad-hoc signature has no CMS blob, so
  # `rcodesign verify` ALWAYS reports a CMS error — that line is the proof the verifier
  # ran at all. What must not appear is a code digest mismatch.
  verify_out="$(rcodesign verify "$CLI" 2>&1 || true)"
  echo "$verify_out" | grep -q 'CMS error' \
    || fail "rcodesign verify did not produce the expected ad-hoc CMS marker — the verifier did not run as expected:
$verify_out"
  echo "$verify_out" | grep -qi 'digest mismatch' \
    && fail "code digest mismatch — the signature does not seal the shipped bytes"
  pass "signature seals the shipped bytes (no code digest mismatch)"
fi

echo "=== ALL ASSERTIONS PASSED for $(basename "$TARBALL") ($PLATFORM) ==="
