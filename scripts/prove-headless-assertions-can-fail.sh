#!/usr/bin/env bash
# PROVE THE RELEASE GATE CAN SAY NO.
#
# `assert-headless-bundle.sh` is the only thing standing between a broken Darwin
# payload and a release page. A green from a check that cannot go red is worse than no
# check: it is a claim nobody made. So this harness breaks a real bundle ten ways and
# requires the gate to reject each one FOR THE RIGHT REASON — not merely to exit
# non-zero, which a typo in the script would also do.
#
# Grown out of POD-2501's prove-assert-can-fail.sh, which is where the ten cases come
# from, and wired into the release job so the proof is re-run rather than remembered.
#
# Usage:
#   scripts/prove-headless-assertions-can-fail.sh <darwin-arm64-tarball> [<linux-x64-tarball>]
#
# Needs the abduco cache (scripts/abduco-cross.ts) for the reference helpers.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export PATH="${HOME}/.local/bin:${HOME}/.cargo/bin:${PATH}"

DARWIN_TARBALL="${1:-}"
LINUX_TARBALL="${2:-}"
[ -f "$DARWIN_TARBALL" ] || { echo "ABORT: pass a real darwin-aarch64 tarball to mutate (got '$DARWIN_TARBALL')" >&2; exit 1; }

for tool in rcodesign python3 tar file bun; do
  command -v "$tool" >/dev/null || { echo "ABORT: need $tool on PATH" >&2; exit 1; }
done

bun scripts/abduco-cross.ts >/dev/null || { echo "ABORT: could not build the reference abduco helpers" >&2; exit 1; }
HASH="$(bun -e 'import{abducoSourceHash}from"./scripts/abduco-cross.ts";console.log(abducoSourceHash().slice(0,16))')"
DARWIN_REF="$ROOT/dist-bun/abduco-cache/darwin-aarch64-$HASH"
LINUX_REF="$ROOT/dist-bun/abduco-cache/linux-x86_64-$HASH"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/podium-negctl-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

PASSED=0
FAILED=0

# Unpack once; every case re-packs a mutated copy of this tree.
tar -xzf "$DARWIN_TARBALL" -C "$WORK" || { echo "ABORT: cannot extract $DARWIN_TARBALL" >&2; exit 1; }
[ -f "$WORK/headless/podium-cli" ] || { echo "ABORT: $DARWIN_TARBALL has no headless/podium-cli" >&2; exit 1; }

# Re-pack $WORK/case (a mutated headless/ tree) and run the gate over it.
#
# `expect` is the RIGHT-REASON check: the gate must not only refuse, it must refuse
# with a sentence that names what is actually wrong. A case that goes red for a
# different reason than the one it was built to trigger is reported as a FAILURE of
# this harness, because it means the check under test was never exercised.
check() {
  local label="$1" expect="$2" platform="$3" abduco="$4" tarball="$5"
  local out status
  out="$(bash scripts/assert-headless-bundle.sh "$tarball" "$platform" ${abduco:+--abduco "$abduco"} ${abduco:+} 2>&1)"
  status=$?
  if [ -z "$abduco" ]; then
    out="$(bash scripts/assert-headless-bundle.sh "$tarball" "$platform" 2>&1)"; status=$?
  fi
  if [ "$status" -eq 0 ]; then
    echo "HARNESS FAILURE [$label]: the gate ACCEPTED a bundle it must reject"
    FAILED=$((FAILED + 1))
    return
  fi
  if ! printf '%s' "$out" | grep -qi -- "$expect"; then
    echo "HARNESS FAILURE [$label]: rejected, but for the wrong reason"
    echo "  wanted a message matching: $expect"
    echo "  got: $(printf '%s' "$out" | grep -iE '^(FAIL|ABORT)' | head -1)"
    FAILED=$((FAILED + 1))
    return
  fi
  echo "REJECTED (right reason) [$label]: $(printf '%s' "$out" | grep -iE '^(FAIL|ABORT)' | head -1)"
  PASSED=$((PASSED + 1))
}

# Build a mutated tarball from the pristine tree; `$1` is a function that edits $CASE.
mutate() {
  local name="$1" edit="$2"
  local case_dir="$WORK/case-$name"
  rm -rf "$case_dir"; mkdir -p "$case_dir"
  cp -a "$WORK/headless" "$case_dir/headless"
  # STDOUT OF THIS FUNCTION IS THE TARBALL PATH AND NOTHING ELSE. An edit that prints
  # (macho-strip-signature.py reports what it removed) would otherwise be spliced into
  # the path, and the case would "fail" with `no such tarball` — a red for a reason
  # that has nothing to do with what it was built to test.
  CASE="$case_dir" $edit >&2
  ( cd "$case_dir" && tar -czf "$WORK/$name.tar.gz" headless ) >&2
  echo "$WORK/$name.tar.gz"
}

echo "=== proving scripts/assert-headless-bundle.sh can say NO ==="
echo "subject: $DARWIN_TARBALL"
echo

# 1. A hello-world stub in place of the real binary. The case POD-2501's first
#    assertion script would have PASSED, because it checked a sibling in the build dir.
edit_stub() { printf '#!/bin/sh\necho hi\n' > "$CASE/headless/podium-cli"; chmod +x "$CASE/headless/podium-cli"; }
check "hello-world stub" "is not Mach-O" darwin-aarch64 "$DARWIN_REF" "$(mutate stub edit_stub)"

# 2. A Linux ELF shipped as the Darwin payload.
if [ -n "$LINUX_TARBALL" ] && [ -f "$LINUX_TARBALL" ]; then
  rm -rf "$WORK/linux"; mkdir -p "$WORK/linux"; tar -xzf "$LINUX_TARBALL" -C "$WORK/linux"
  edit_elf() { cp "$WORK/linux/headless/podium-cli" "$CASE/headless/podium-cli"; }
  check "linux ELF as the darwin payload" "is not Mach-O" darwin-aarch64 "$DARWIN_REF" "$(mutate elf edit_elf)"
else
  echo "SKIPPED [linux ELF as the darwin payload]: no linux tarball passed"
fi

# 3. The WRONG platform's abduco embedded — the exact regression a matrix-to-cross
#    migration introduces, and the one no format check can see.
edit_noop() { :; }
check "wrong-platform abduco reference" "reference abduco is not" darwin-aarch64 "$LINUX_REF" "$(mutate wrongabduco edit_noop)"

# 4. Signature stripped off the shipped binary.
# `bun build --compile` output is ALREADY ad-hoc signed, so there is no "unsigned"
# copy lying around to test with — the signature has to be removed for real.
edit_strip() {
  python3 scripts/macho-strip-signature.py "$CASE/headless/podium-cli" "$CASE/headless/podium-cli.stripped" \
    && mv "$CASE/headless/podium-cli.stripped" "$CASE/headless/podium-cli" \
    && chmod +x "$CASE/headless/podium-cli"
}
STRIPPED="$(mutate stripped edit_strip)"
check "signature stripped" "signature\|ADHOC\|LINKER_SIGNED" darwin-aarch64 "$DARWIN_REF" "$STRIPPED"

# 5. A byte flipped INSIDE the sealed region: the signature is still there and still
#    parses, but it no longer seals these bytes.
edit_flip() {
  python3 - "$CASE/headless/podium-cli" <<'PY'
import sys
p = sys.argv[1]
with open(p, 'r+b') as f:
    f.seek(0x2000)
    b = f.read(1)
    f.seek(0x2000)
    f.write(bytes([b[0] ^ 0xFF]))
PY
}
check "byte flipped inside the sealed region" "digest mismatch\|signature" darwin-aarch64 "$DARWIN_REF" "$(mutate flipped edit_flip)"

# 6. Re-signed with EMPTY entitlements: ad-hoc, identifier podium, not LINKER_SIGNED —
#    everything the other signature checks look for — and unable to JIT. This isolates
#    the entitlement check, which nothing else reaches: the raw-Bun case above trips
#    LINKER_SIGNED first and never gets there.
#
#    The signature must be STRIPPED before re-signing. `rcodesign sign` on an already
#    signed binary PRESERVES the existing entitlements, so signing without
#    --entitlements-xml-file changes nothing — the first version of this case mutated
#    the binary not at all and scored a false green.
edit_noent() {
  python3 scripts/macho-strip-signature.py "$CASE/headless/podium-cli" "$CASE/headless/podium-cli.bare" \
    && mv "$CASE/headless/podium-cli.bare" "$CASE/headless/podium-cli" \
    && chmod +x "$CASE/headless/podium-cli" \
    && rcodesign sign --binary-identifier podium "$CASE/headless/podium-cli"
}
check "empty entitlements" "entitlements missing" darwin-aarch64 "$DARWIN_REF" "$(mutate noent edit_noent)"

# 7. Raw `bun build --compile` output: already ad-hoc signed, but LINKER_SIGNED with
#    identifier a.out and NO entitlements. The regression that looks most like success.
RAW="$WORK/raw-podium"
if bun build --compile --target=bun-darwin-arm64 --conditions=@podium/source \
     scripts/cli-compiled.ts --outfile "$RAW" >/dev/null 2>&1; then
  edit_raw() { cp "$RAW" "$CASE/headless/podium-cli"; chmod +x "$CASE/headless/podium-cli"; }
  check "raw Bun output, never re-signed" "LINKER_SIGNED\|identifier is not" darwin-aarch64 "$DARWIN_REF" "$(mutate raw edit_raw)"
  rm -f "$RAW"
else
  echo "HARNESS FAILURE [raw Bun output]: could not produce the raw compile to test against"
  FAILED=$((FAILED + 1))
fi

# 8. The reference helper is missing, against an otherwise PERFECT bundle. A gate that
#    skips here reads as a pass. It must be given a good tarball, or it dies on the
#    tarball's own defects and this check is never reached — which is what the first
#    version of this case did.
check "reference abduco deleted" "prebuilt abduco missing\|reference abduco missing\|no such\|missing" \
  darwin-aarch64 "$WORK/does-not-exist" "$DARWIN_TARBALL"

# 9. Wrong archive layout: the updater joins the staged dir with `headless`, so any
#    other root silently installs nothing.
rm -rf "$WORK/case-layout"; mkdir -p "$WORK/case-layout/podium"
cp -a "$WORK/headless/." "$WORK/case-layout/podium/"
( cd "$WORK/case-layout" && tar -czf "$WORK/layout.tar.gz" podium )
check "archive root is not headless/" "missing headless/podium-cli\|entries outside headless" \
  darwin-aarch64 "$DARWIN_REF" "$WORK/layout.tar.gz"

# 10. A file the bundle cannot work without is absent.
edit_noversion() { rm -f "$CASE/headless/VERSION"; }
check "VERSION removed" "missing headless/VERSION" darwin-aarch64 "$DARWIN_REF" "$(mutate noversion edit_noversion)"

# 11. (ours) No --abduco and no explicit waiver: an omitted input must be an error,
#     never a silent skip that reads as a green.
out="$(bash scripts/assert-headless-bundle.sh "$DARWIN_TARBALL" darwin-aarch64 2>&1)"
if [ $? -eq 0 ]; then
  echo "HARNESS FAILURE [no abduco flag]: the gate ran without being told what to check against"
  FAILED=$((FAILED + 1))
else
  echo "REJECTED (right reason) [no abduco flag]: $(printf '%s' "$out" | grep -iE '^(FAIL|ABORT)' | head -1)"
  PASSED=$((PASSED + 1))
fi

# THE CONTROL FOR THE CONTROLS: the pristine bundle must still PASS. Without this a
# gate that rejected everything would score a perfect ten above.
echo
if bash scripts/assert-headless-bundle.sh "$DARWIN_TARBALL" darwin-aarch64 --abduco "$DARWIN_REF" >/dev/null 2>&1; then
  echo "ACCEPTED (control): the unmutated bundle still passes"
  PASSED=$((PASSED + 1))
else
  echo "HARNESS FAILURE [control]: the gate rejects a GOOD bundle — it is not discriminating, just broken"
  FAILED=$((FAILED + 1))
fi

echo
echo "=== $PASSED proven, $FAILED harness failures ==="
[ "$FAILED" -eq 0 ] || exit 1
echo "THE GATE CAN SAY NO, AND SAYS IT FOR THE RIGHT REASON."
