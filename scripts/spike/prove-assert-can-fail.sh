#!/usr/bin/env bash
# Prove that scripts/spike/linux-assert-darwin-spike.sh CAN fail (POD-2501).
#
# The previous version of the assertion script printed "ALL PASSED" when the
# reviewer swapped the shipped binary for a 50 KB hello-world, and printed
# "ALL PASSED" again when its embedded-abduco input was deleted. An assertion
# script that cannot go red launders a guess into a GO, so every claim it makes
# needs a negative control here.
#
# Each case below tampers with exactly one thing and requires the asserter to
# exit non-zero with the expected FAIL line. A case that PASSES is a failure of
# this harness.
#
# Usage: scripts/spike/prove-assert-can-fail.sh [spike-dir]
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SPIKE="${1:-$ROOT/dist-bun-spike/darwin-arm64}"
ASSERT="$ROOT/scripts/spike/linux-assert-darwin-spike.sh"
GOOD="$SPIKE/podium-headless-darwin-arm64.tar.gz"
PREBUILT="$ROOT/scripts/prebuilt/abduco/darwin-arm64/abduco"
export PATH="${HOME}/.local/bin:${HOME}/.cargo/bin:${PATH}"

[[ -f "$GOOD" ]] || { echo "missing $GOOD — run package-mac-execution-bundle.sh first" >&2; exit 2; }
for t in zig rcodesign python3 file tar; do
  command -v "$t" >/dev/null || { echo "need $t on PATH" >&2; exit 2; }
done

WORK="$(mktemp -d "${TMPDIR:-/tmp}/podium-prove-XXXXXX")"
cleanup() {
  [[ -f "$WORK/prebuilt.bak" ]] && cp -f "$WORK/prebuilt.bak" "$PREBUILT"
  rm -rf "$WORK"
}
trap cleanup EXIT
cp -f "$PREBUILT" "$WORK/prebuilt.bak"

CASES=0
BAD=0

# Repack $WORK/headless (however it has been tampered) into a tarball.
repack() { rm -f "$WORK/t.tar.gz"; tar -czf "$WORK/t.tar.gz" -C "$WORK" headless; }
fresh() { rm -rf "$WORK/headless"; tar -xzf "$GOOD" -C "$WORK"; }

# expect_fail <name> <substring the FAIL line must contain> <tarball>
expect_fail() {
  local name="$1" want="$2" tb="$3"
  CASES=$((CASES + 1))
  echo
  echo "──────────────────────────────────────────────────────────────────────"
  echo "CASE $CASES: $name"
  echo "  expected FAIL to mention: $want"
  local out rc
  out="$("$ASSERT" "$tb" darwin-arm64 2>&1)"
  rc=$?
  echo "  exit=$rc"
  echo "$out" | sed 's/^/  | /'
  if [[ $rc -eq 0 ]]; then
    echo "  >>> HARNESS FAILURE: asserter exited 0 on a tampered input"
    BAD=$((BAD + 1))
  elif ! echo "$out" | grep -q "$want"; then
    echo "  >>> HARNESS FAILURE: went red, but not for the expected reason"
    BAD=$((BAD + 1))
  else
    echo "  >>> OK: went red for the right reason"
  fi
}

echo "=== prove-assert-can-fail (POD-2501) ==="
echo "date:      $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "asserter:  $ASSERT"
echo "good tarball: $GOOD"
echo "good sha256:  $(sha256sum "$GOOD" | cut -d' ' -f1)"
echo
echo "--- baseline: the untampered shipped tarball must PASS ---"
if "$ASSERT" "$GOOD" darwin-arm64 >"$WORK/baseline.log" 2>&1; then
  echo "OK: baseline exit=0"
  grep -c '^PASS:' "$WORK/baseline.log" | sed 's/^/  PASS lines: /'
else
  echo ">>> HARNESS FAILURE: baseline does not pass; nothing below is meaningful"
  cat "$WORK/baseline.log"
  exit 1
fi

# (a) 50 KB hello-world darwin Mach-O in place of the shipped binary — the exact
#     substitution the old script waved through.
fresh
cat >"$WORK/hello.c" <<'EOC'
#include <stdio.h>
int main(void) { printf("hello\n"); return 0; }
EOC
zig cc -target aarch64-macos-none -o "$WORK/hello" "$WORK/hello.c" -Wl,-headerpad,0x8000 2>/dev/null
rcodesign sign --binary-identifier podium \
  --entitlements-xml-file "$ROOT/scripts/spike/bun-jit.entitlements.plist" "$WORK/hello" >/dev/null 2>&1
ls -l "$WORK/hello" | awk '{print "  hello-world size: " $5 " bytes (signed, identifier=podium, JIT entitlements)"}'
cp -f "$WORK/hello" "$WORK/headless/podium-cli"; chmod +x "$WORK/headless/podium-cli"; repack
expect_fail "hello-world Mach-O swapped in as headless/podium-cli" \
  "does NOT appear inside the shipped binary" "$WORK/t.tar.gz"

# (b) Linux ELF in place of the shipped binary.
fresh
cp -f "$(command -v abduco)" "$WORK/headless/podium-cli"; chmod +x "$WORK/headless/podium-cli"; repack
expect_fail "Linux ELF swapped in as headless/podium-cli" \
  "is not Mach-O" "$WORK/t.tar.gz"

# (c) A REAL build whose embedded abduco is the Linux ELF one (the subtle failure
#     mode the whole spike exists to exclude). Fixture built by pointing the
#     prebuilt path at the host linux abduco and re-running the spike build.
if [[ -f "$ROOT/dist-bun-spike/fixtures/linux-abduco-embedded.tar.gz" ]]; then
  expect_fail "build with the LINUX abduco embedded" \
    "Linux ELF header" "$ROOT/dist-bun-spike/fixtures/linux-abduco-embedded.tar.gz"
else
  echo
  echo "SKIP case: no dist-bun-spike/fixtures/linux-abduco-embedded.tar.gz"
  echo "  rebuild it with:"
  echo "    cp \$(command -v abduco) $PREBUILT"
  echo "    bun --conditions=@podium/source scripts/spike/build-bun-darwin.ts --target=bun-darwin-arm64"
  echo "    tar -czf dist-bun-spike/fixtures/linux-abduco-embedded.tar.gz -C dist-bun-spike/darwin-arm64 headless"
  echo "  then restore the darwin prebuilt and rebuild."
fi

# (d) Signature removed for real. Note Bun already ad-hoc signs its darwin output,
#     so this needs macho-strip-signature.py — the old "podium.unsigned" was signed.
fresh
python3 "$ROOT/scripts/spike/macho-strip-signature.py" \
  "$WORK/headless/podium-cli" "$WORK/nosig" | sed 's/^/  /'
cp -f "$WORK/nosig" "$WORK/headless/podium-cli"; chmod +x "$WORK/headless/podium-cli"; repack
expect_fail "code signature stripped (genuinely unsigned)" \
  "NO code signature" "$WORK/t.tar.gz"

# (e) Signature left in place but a byte of the sealed code flipped.
fresh
python3 - "$WORK/headless/podium-cli" <<'PY'
import sys
p = sys.argv[1]
with open(p, 'r+b') as fh:
    fh.seek(0x10000)
    b = fh.read(1)
    fh.seek(0x10000)
    fh.write(bytes([b[0] ^ 0xFF]))
print(f"  flipped one byte at offset 0x10000 ({b[0]:#04x} -> {b[0]^0xFF:#04x})")
PY
repack
expect_fail "one sealed byte flipped (signature no longer matches the bytes)" \
  "digest mismatch" "$WORK/t.tar.gz"

# (f) Re-signed ad-hoc but with an EMPTY entitlements plist — the exact case the
#     old slot-presence grep waved through.
fresh
cat >"$WORK/empty.plist" <<'EOP'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict/></plist>
EOP
rcodesign sign --binary-identifier podium --entitlements-xml-file "$WORK/empty.plist" \
  "$WORK/headless/podium-cli" >/dev/null 2>&1
repack
expect_fail "re-signed with an EMPTY entitlements plist" \
  "entitlements missing com.apple.security.cs.allow-jit" "$WORK/t.tar.gz"

# (g) Bun's raw --compile output, never passed through rcodesign. It is already
#     ad-hoc signed (ADHOC | LINKER_SIGNED, identifier a.out) but has no entitlements.
if [[ -f "$SPIKE/podium.unsigned" ]]; then
  fresh
  cp -f "$SPIKE/podium.unsigned" "$WORK/headless/podium-cli"; chmod +x "$WORK/headless/podium-cli"; repack
  expect_fail "raw bun --compile output (ADHOC|LINKER_SIGNED, no rcodesign pass)" \
    "LINKER_SIGNED" "$WORK/t.tar.gz"
fi

# (h) The regression that mattered most: an input that vanishes must FAIL, not skip.
fresh; repack
mv -f "$PREBUILT" "$WORK/prebuilt.moved"
expect_fail "prebuilt abduco input deleted (must fail, not silently skip)" \
  "prebuilt abduco missing" "$WORK/t.tar.gz"
cp -f "$WORK/prebuilt.bak" "$PREBUILT"

# (i) Old spike tarball layout (loose binaries at the archive root) — not what the
#     updater extracts.
if [[ -f "$SPIKE/podium-headless-spike-darwin-arm64.tar.gz" ]]; then
  expect_fail "old spike tarball layout (extras outside headless/)" \
    "entries outside headless/" "$SPIKE/podium-headless-spike-darwin-arm64.tar.gz"
fi

# (j) A tarball that does not exist at all.
expect_fail "nonexistent tarball path" \
  "no such tarball" "$WORK/does-not-exist.tar.gz"

echo
echo "──────────────────────────────────────────────────────────────────────"
echo "=== SUMMARY: $CASES negative controls, $BAD harness failures ==="
if [[ $BAD -ne 0 ]]; then
  echo "RESULT: the asserter does NOT reliably go red — do not trust its PASS."
  exit 1
fi
echo "RESULT: every negative control went red for the right reason."
echo "        The asserter's PASS on the shipped tarball is load-bearing."
exit 0
