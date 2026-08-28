#!/usr/bin/env bash
# PROVE THE RELEASE GATE CAN SAY NO.
#
# The release gate combines process-local client continuity with
# `assert-headless-bundle.sh`'s shipped-byte checks. A green from a check that cannot go
# red is worse than no
# check: it is a claim nobody made. So this harness breaks a real bundle and
# requires the gate to reject each mutation FOR THE RIGHT REASON — not merely to exit
# non-zero, which a typo in the script would also do.
#
# Grown out of POD-2501's prove-assert-can-fail.sh, and wired into the release job so
# the proof is re-run rather than remembered. Cases 12–14 are the production-layout
# checks the spike never had.
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
SOURCE_COMMIT="$(git rev-parse HEAD)"
[ -f "$DARWIN_TARBALL" ] || { echo "ABORT: pass a real darwin-aarch64 tarball to mutate (got '$DARWIN_TARBALL')" >&2; exit 1; }

for tool in rcodesign python3 tar file bun; do
  command -v "$tool" >/dev/null || { echo "ABORT: need $tool on PATH" >&2; exit 1; }
done

bun scripts/abduco-cross.ts >/dev/null || { echo "ABORT: could not build the reference abduco helpers" >&2; exit 1; }
HASH="$(bun -e 'import{abducoSourceHash}from"./scripts/abduco-cross.ts";console.log(abducoSourceHash().slice(0,16))')"
DARWIN_REF="$ROOT/dist-bun/abduco-cache/darwin-aarch64-$HASH"
LINUX_REF="$ROOT/dist-bun/abduco-cache/linux-x86_64-$HASH"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/podium-negctl-XXXXXX")"
# When a case fails, the first question is always "what was actually in that tarball?".
# Set PODIUM_KEEP_NEGCTL_WORK=1 to keep the mutated bundles for inspection.
if [ -n "${PODIUM_KEEP_NEGCTL_WORK:-}" ]; then
  echo "keeping mutated bundles in $WORK"
else
  trap 'rm -rf "$WORK"' EXIT
fi

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
#
# THE PATTERN IS MATCHED AGAINST THE FAILURE LINE ALONE, never the whole transcript.
# Matching the transcript is how a right-reason check quietly degrades into "exited
# non-zero": the gate prints the platform it expects, and what a signature failure would
# MEAN on this platform, on every run whether it passes or not — so patterns like
# `signature` or `digest` were being satisfied by output that is always there. Two cases
# were in exactly that state.
check() {
  local label="$1" expect="$2" platform="$3" abduco="$4" tarball="$5"
  local out status line
  if [ -n "$abduco" ]; then
    out="$(bash scripts/assert-headless-bundle.sh "$tarball" "$platform" --source-commit "$SOURCE_COMMIT" --abduco "$abduco" 2>&1)"
  else
    out="$(bash scripts/assert-headless-bundle.sh "$tarball" "$platform" --source-commit "$SOURCE_COMMIT" 2>&1)"
  fi
  status=$?
  if [ "$status" -eq 0 ]; then
    echo "HARNESS FAILURE [$label]: the gate ACCEPTED a bundle it must reject"
    FAILED=$((FAILED + 1))
    return
  fi
  line="$(printf '%s\n' "$out" | grep -iE '^(FAIL|ABORT)' | head -1)"
  if [ -z "$line" ]; then
    echo "HARNESS FAILURE [$label]: the gate exited $status but printed no FAIL/ABORT line"
    FAILED=$((FAILED + 1))
    return
  fi
  if ! printf '%s' "$line" | grep -qi -- "$expect"; then
    echo "HARNESS FAILURE [$label]: rejected, but for the wrong reason"
    echo "  wanted the FAILURE LINE to match: $expect"
    echo "  got: $line"
    FAILED=$((FAILED + 1))
    return
  fi
  echo "REJECTED (right reason) [$label]: $line"
  PASSED=$((PASSED + 1))
}

# The former caller-supplied root is now an explicitly refused interface. An attacker
# computing the root of their own bytes must not be able to hand that value to the gate.
check_caller_client_root() {
  local out status line
  out="$(bash scripts/assert-headless-bundle.sh "$DARWIN_TARBALL" darwin-aarch64 \
    --source-commit "$SOURCE_COMMIT" --client-root-digest "$(printf 'a%.0s' {1..64})" \
    --abduco "$DARWIN_REF" 2>&1)"
  status=$?
  line="$(printf '%s\n' "$out" | grep -iE '^(FAIL|ABORT)' | head -1)"
  if [ "$status" -ne 0 ] && printf '%s' "$line" | grep -qi -- 'unknown flag --client-root-digest'; then
    echo "REJECTED (right reason) [caller-supplied client root]: $line"
    PASSED=$((PASSED + 1))
  else
    echo "HARNESS FAILURE [caller-supplied client root]: expected the retired interface refusal"
    echo "  got: ${line:-<no failure line>}"
    FAILED=$((FAILED + 1))
  fi
}

check_caller_client_root

# Try to route fabricated bytes through the retired raw packager. It must refuse before
# looking at either the forged archive or an attacker-computed root: only the wrapper that
# actually runs package:clients can mint the in-process session build-bun requires.
check_release_capture() {
  local label="$1" tarball="$2" out status
  out="$(PODIUM_BUNDLE_ARTIFACT="$tarball" bun scripts/build-bun.ts 2>&1)"
  status=$?
  if [ "$status" -ne 0 ] && printf '%s' "$out" | grep -qi -- 'direct headless packaging is forbidden'; then
    echo "REJECTED (right reason) [$label]: direct headless packaging is forbidden"
    PASSED=$((PASSED + 1))
  else
    echo "HARNESS FAILURE [$label]: expected the process-local captured digest mismatch"
    echo "  got: ${out:-<no output>}"
    FAILED=$((FAILED + 1))
  fi
}

# Build a mutated tarball from the pristine tree; `$1` is a function that edits $CASE.
#
# EVERY STEP IS CHECKED, and the case directory is deleted as soon as it is packed.
# Both of those are scar tissue. A bundle tree is ~250 MB; keeping one per case put
# ~3 GB in TMPDIR, and on a 97%-full disk those copies began to fail. Nothing checked
# them, so the harness packed short trees and reported "rejected, but for the wrong
# reason" — with a DIFFERENT case failing on each run. A near-full disk truncates
# writes rather than erroring, so unchecked file operations do not fail loudly here:
# they manufacture confusing evidence, which is worse than failing.
mutate() {
  local name="$1" edit="$2"
  local case_dir="$WORK/case-$name"
  rm -rf "$case_dir"
  mkdir -p "$case_dir" || { echo "ABORT: cannot create $case_dir (disk full?)" >&2; exit 1; }
  cp -a "$WORK/headless" "$case_dir/headless" \
    || { echo "ABORT: could not copy the bundle tree for '$name' (disk full?)" >&2; exit 1; }
  # STDOUT OF THIS FUNCTION IS THE TARBALL PATH AND NOTHING ELSE. An edit that prints
  # (macho-strip-signature.py reports what it removed) would otherwise be spliced into
  # the path, and the case would "fail" with `no such tarball` — a red for a reason
  # that has nothing to do with what it was built to test.
  CASE="$case_dir" $edit >&2
  ( cd "$case_dir" && tar -czf "$WORK/$name.tar.gz" headless ) >&2 \
    || { echo "ABORT: could not pack the mutated bundle for '$name' (disk full?)" >&2; exit 1; }
  # The gate reads the TARBALL; the tree has done its job. Deleting it here is what
  # holds peak usage at one bundle instead of one per case.
  rm -rf "$case_dir"
  # A short archive means a truncated write, not a mutation. Say so, rather than letting
  # the gate report a missing file as though this case had caused it.
  #
  # The listing is CAPTURED before it is searched, deliberately. `tar | grep -q` looks
  # equivalent and is not: grep exits at the first match and closes the pipe, tar takes
  # SIGPIPE, and under `pipefail` the pipeline reports failure — so this guard fired on
  # every healthy tarball, aborted the subshell, and returned an empty path. Every case
  # then ran with shifted arguments and failed for a reason that had nothing to do with
  # what it was testing.
  local listing
  listing="$(tar -tzf "$WORK/$name.tar.gz" 2>/dev/null)"
  case "$listing" in
    *"headless/podium-cli"*) : ;;
    *) echo "ABORT: the packed bundle for '$name' is incomplete — truncated write (disk full?)" >&2; exit 1 ;;
  esac
  echo "$WORK/$name.tar.gz"
}

echo "=== proving scripts/assert-headless-bundle.sh can say NO ==="
echo "subject: $DARWIN_TARBALL"
echo

# 1. A hello-world stub in place of the real binary. The case POD-2501's first
#    assertion script would have PASSED, because it checked a sibling in the build dir.
edit_stub() { printf '#!/bin/sh\necho hi\n' > "$CASE/headless/podium-cli"; chmod +x "$CASE/headless/podium-cli"; }
check "hello-world stub" "shipped podium-cli is not Mach-O" darwin-aarch64 "$DARWIN_REF" "$(mutate stub edit_stub)"

# 2. A Linux ELF shipped as the Darwin payload.
if [ -n "$LINUX_TARBALL" ] && [ -f "$LINUX_TARBALL" ]; then
  # Only ONE file is wanted out of the Linux bundle; extracting just that keeps this
  # from being another quarter-gigabyte tree on a disk that has already bitten us.
  rm -rf "$WORK/linux"; mkdir -p "$WORK/linux"
  tar -xzf "$LINUX_TARBALL" -C "$WORK/linux" headless/podium-cli \
    || { echo "ABORT: could not extract the linux payload" >&2; exit 1; }
  edit_elf() { cp "$WORK/linux/headless/podium-cli" "$CASE/headless/podium-cli"; }
  check "linux ELF as the darwin payload" "shipped podium-cli is not Mach-O" \
    darwin-aarch64 "$DARWIN_REF" "$(mutate elf edit_elf)"
  rm -rf "$WORK/linux"
else
  echo "SKIPPED [linux ELF as the darwin payload]: no linux tarball passed"
fi

# 3a. THE WRONG PLATFORM'S HELPER ACTUALLY EMBEDDED IN THE BUNDLE.
#
#     The regression the matrix collapse most threatens, and the one no format check can
#     see: a perfectly good Darwin Mach-O carrying the Linux abduco. It is also the case
#     this harness got WRONG at first — it swapped the REFERENCE rather than the bundle,
#     so the gate rejected its own input and the check that actually matters was never
#     exercised per release at all.
#
#     The overwrite also breaks the code signature, but the embedded-helper check runs
#     BEFORE the signature checks, so the failure line is unambiguous — and pinning that
#     ordering is itself worth something.
edit_wrong_helper() {
  python3 scripts/embed-wrong-abduco.py "$CASE/headless/podium-cli" "$DARWIN_REF" "$LINUX_REF"
}
check "wrong-platform helper EMBEDDED in the bundle" "does NOT appear inside the shipped binary" \
  darwin-aarch64 "$DARWIN_REF" "$(mutate wronghelper edit_wrong_helper)"

# 3b. The reference the gate is asked to check AGAINST is the wrong platform's. Weaker
#     than 3a, and a distinct failure: it proves the gate validates its own input rather
#     than trusting whatever path CI hands it.
edit_noop() { :; }
check "wrong-platform abduco reference supplied" "reference abduco is not" \
  darwin-aarch64 "$LINUX_REF" "$(mutate wrongref edit_noop)"

# 4. Signature stripped off the shipped binary.
# `bun build --compile` output is ALREADY ad-hoc signed, so there is no "unsigned"
# copy lying around to test with — the signature has to be removed for real.
edit_strip() {
  python3 scripts/macho-strip-signature.py "$CASE/headless/podium-cli" "$CASE/headless/podium-cli.stripped" \
    && mv "$CASE/headless/podium-cli.stripped" "$CASE/headless/podium-cli" \
    && chmod +x "$CASE/headless/podium-cli"
}
STRIPPED="$(mutate stripped edit_strip)"
check "signature stripped" "has NO code signature" darwin-aarch64 "$DARWIN_REF" "$STRIPPED"

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
check "byte flipped inside the sealed region" "does not seal the shipped bytes" \
  darwin-aarch64 "$DARWIN_REF" "$(mutate flipped edit_flip)"

# 6. Re-signed with EMPTY entitlements: ad-hoc, identifier podium, not LINKER_SIGNED —
#    everything the other signature checks look for — and unable to JIT. This isolates
#    the entitlement check, which nothing else reaches: the raw-Bun case below trips
#    LINKER_SIGNED first and never gets there. THIS is the proof that stripping the
#    five keys rcodesign actually contributes is refused; dropping rcodesign entirely
#    is case 7 (LINKER_SIGNED still present).
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
check "empty entitlements" "entitlements missing com.apple.security.cs.allow-jit" \
  darwin-aarch64 "$DARWIN_REF" "$(mutate noent edit_noent)"

# 6b. All five keys still PRESENT, but explicitly false. Presence alone is not the
#     policy: Bun's JIT needs each entitlement enabled. This is the closest false
#     positive to the real regression because a key-only grep accepts it.
edit_false_entitlements() {
  cat > "$CASE/false-entitlements.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key><false/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><false/>
  <key>com.apple.security.cs.disable-executable-page-protection</key><false/>
  <key>com.apple.security.cs.allow-dyld-environment-variables</key><false/>
  <key>com.apple.security.cs.disable-library-validation</key><false/>
</dict>
</plist>
PLIST
  python3 scripts/macho-strip-signature.py "$CASE/headless/podium-cli" "$CASE/headless/podium-cli.bare" \
    && mv "$CASE/headless/podium-cli.bare" "$CASE/headless/podium-cli" \
    && chmod +x "$CASE/headless/podium-cli" \
    && rcodesign sign --binary-identifier podium \
      --entitlements-xml-file "$CASE/false-entitlements.plist" "$CASE/headless/podium-cli"
}
check "all JIT entitlements false" "entitlement com.apple.security.cs.allow-jit is not enabled" \
  darwin-aarch64 "$DARWIN_REF" "$(mutate falseentitlements edit_false_entitlements)"

# 7. Raw `bun build --compile` output: already ad-hoc signed, but LINKER_SIGNED with
#    identifier a.out and NO entitlements. The regression that looks most like success.
RAW="$WORK/raw-podium"
# The compiled binary embeds dist-bun/abduco.bin, which holds whatever the LAST build
# left there — often another platform's helper. Put the darwin one back first, so the
# only thing wrong with this binary is its signature. Otherwise the embedded-helper
# check fires first and this case silently stops testing LINKER_SIGNED at all.
cp "$DARWIN_REF" dist-bun/abduco.bin 2>/dev/null
if bun build --compile --target=bun-darwin-arm64 --conditions=@podium/source \
     scripts/cli-compiled.ts --outfile "$RAW" >/dev/null 2>&1; then
  edit_raw() { cp "$RAW" "$CASE/headless/podium-cli"; chmod +x "$CASE/headless/podium-cli"; }
  check "raw Bun output, never re-signed" "still carries Bun's LINKER_SIGNED" \
    darwin-aarch64 "$DARWIN_REF" "$(mutate raw edit_raw)"
  rm -f "$RAW"
else
  echo "HARNESS FAILURE [raw Bun output]: could not produce the raw compile to test against"
  FAILED=$((FAILED + 1))
fi

# 8. The reference helper is missing, against an otherwise PERFECT bundle. A gate that
#    skips here reads as a pass. It must be given a good tarball, or it dies on the
#    tarball's own defects and this check is never reached — which is what the first
#    version of this case did.
check "reference abduco deleted" "reference abduco missing" \
  darwin-aarch64 "$WORK/does-not-exist" "$DARWIN_TARBALL"

# 9. Wrong archive layout: the updater joins the staged dir with `headless`, so any
#    other root silently installs nothing.
rm -rf "$WORK/case-layout"; mkdir -p "$WORK/case-layout/podium"
cp -a "$WORK/headless/." "$WORK/case-layout/podium/" \
  || { echo "ABORT: could not build the wrong-layout case (disk full?)" >&2; exit 1; }
( cd "$WORK/case-layout" && tar -czf "$WORK/layout.tar.gz" podium ) \
  || { echo "ABORT: could not pack the wrong-layout case (disk full?)" >&2; exit 1; }
rm -rf "$WORK/case-layout"
check "archive root is not headless/" "tarball missing headless/podium-cli" \
  darwin-aarch64 "$DARWIN_REF" "$WORK/layout.tar.gz"

# 10. A file the bundle cannot work without is absent.
edit_noversion() { rm -f "$CASE/headless/VERSION"; }
check "VERSION removed" "tarball missing headless/VERSION" \
  darwin-aarch64 "$DARWIN_REF" "$(mutate noversion edit_noversion)"

# 11. (ours) No --abduco and no explicit waiver: an omitted input must be an ERROR,
#     never a silent skip that reads as a green.
check "no abduco flag" "pass --abduco" darwin-aarch64 "" "$DARWIN_TARBALL"

# 12–14. THE PRODUCTION LAYOUT, not the spike layout. The spike packed no systemd/,
#     no NOTICE, and stub web/mobile index.html files. A gate that only checked what
#     the spike happened to emit would accept each of these as a green.

# 12. Packaged systemd units gone — a headless VPS cannot enable the parent unit.
edit_nosystemd() { rm -rf "$CASE/headless/systemd"; }
check "systemd/ removed" "tarball missing headless/systemd" \
  darwin-aarch64 "$DARWIN_REF" "$(mutate nosystemd edit_nosystemd)"

# 13. The spike's stub web/index.html in place of the stamped production client.
#     Existence of a file named index.html is the check that would have passed this.
edit_stub_web() {
  printf '<!doctype html><title>spike</title><p>POD-2501 spike — no web dist</p>\n' \
    > "$CASE/headless/web/index.html"
}
check "stub web/index.html" "build provenance hash mismatch for index.html" \
  darwin-aarch64 "$DARWIN_REF" "$(mutate stubweb edit_stub_web)"

# 13b. Forge plausible bytes, a public release stamp and an exact internal manifest.
#      The archive is internally self-consistent; the raw packager must still refuse because
#      it has no module-branded evidence that this invocation ran a fresh client build.
edit_forged_web() {
  rm -rf "$CASE/headless/web/assets"
  python3 - "$CASE/headless/web" "$CASE/headless/VERSION" "$SOURCE_COMMIT" <<'PY'
import hashlib
import json
import sys
from pathlib import Path

site = Path(sys.argv[1])
version = Path(sys.argv[2]).read_text().strip()
source_commit = sys.argv[3][:7]
bundle_hash = 'AbCdEf12'
(site / 'index.html').write_text(
    '<!doctype html><html><head>'
    f'<meta name="podium-version" content="{version}">'
    '</head><body><div id="root"></div>'
    f'<script type="module" src="/assets/index-{bundle_hash}.js"></script>'
    f'<!-- forged padding {"x" * 200_000} --></body></html>\n'
)
stamp = {
    'wireSchemaDigest': '0123456789abcdef',
    'wireVersion': 1,
    'builtAt': '2026-08-21T00:00:00.000Z',
    'appVersion': version,
    'sourceSha': source_commit,
    'bundleVersion': f'bundle+{bundle_hash}',
}
(site / 'podium-build.json').write_text(json.dumps(stamp) + '\n')
files = {}
for path in sorted(site.rglob('*')):
    if path.is_file() and path.name != 'podium-build-manifest.json':
        files[path.relative_to(site).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
(site / 'podium-build-manifest.json').write_text(json.dumps({
    'manifestVersion': 1,
    'sourceCommit': source_commit,
    'buildStamp': stamp,
    'files': files,
}) + '\n')
PY
}
check_release_capture "padded forged web stub with matching forged manifest" \
  "$(mutate forgedweb edit_forged_web)"

# 13c. Removing the manifest itself must trip the provenance guard. This is the
#      armedness proof: delete that check and this case reaches the binary unchanged.
edit_nomanifest() { rm -f "$CASE/headless/web/podium-build-manifest.json"; }
check "web build provenance manifest removed" "has no build provenance manifest" \
  darwin-aarch64 "$DARWIN_REF" "$(mutate nomanifest edit_nomanifest)"

# 14. NOTICE absent — Apache-2.0 convention, packed by build-bun.ts with LICENSE.
edit_nonotice() { rm -f "$CASE/headless/NOTICE"; }
check "NOTICE missing" "tarball missing headless/NOTICE" \
  darwin-aarch64 "$DARWIN_REF" "$(mutate nonotice edit_nonotice)"

# THE CONTROL FOR THE CONTROLS: the pristine bundle must still PASS. Without this a
# gate that rejected everything would score a perfect set above.
echo
if bash scripts/assert-headless-bundle.sh "$DARWIN_TARBALL" darwin-aarch64 \
    --source-commit "$SOURCE_COMMIT" --abduco "$DARWIN_REF" >/dev/null 2>&1; then
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
