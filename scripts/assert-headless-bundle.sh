#!/usr/bin/env bash
# Interrogate a SHIPPED headless tarball: is it really a PRODUCTION bundle for the
# platform it claims, built the way a release is supposed to build it?
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

# WHAT THE DARWIN CHECKS ARE FOR — TWO DIFFERENT DEFECTS, NOT ONE.
#
# bun build --compile already emits an ad-hoc signed Mach-O (ADHOC | LINKER_SIGNED,
# identifier a.out, NO entitlements). rcodesign does not "add a signature". It
# REPLACES that linker signature with ADHOC, identifier podium, plus the five Bun
# JIT entitlement keys JavaScriptCore needs. If the release job ever drops
# rcodesign, the binary still carries a signature and the build still goes green;
# what breaks is JIT, at runtime, when JSC cannot map W^X pages. The entitlement
# check below is the build-time stand-in for that.
#
# A genuinely unsigned Mach-O is a different defect (signature stripped, not
# rcodesign skipped). Apple Silicon refuses to execute one; Intel macOS does not
# — an unsigned x86_64 binary runs, just without the entitlements. Both stop a
# release; they send you to different places.
if [ "$PLATFORM" = darwin-x86_64 ]; then
  SIG_MEANING="the binary is unsigned (Intel macOS would still EXECUTE it — it does not require a signature — but without rcodesign it would also lack the JIT entitlements and fail at runtime)"
else
  SIG_MEANING="this binary will not execute at all (Apple Silicon refuses an unsigned Mach-O). Dropping rcodesign is a different defect: Bun already signed it, and what would break is JIT at runtime"
fi

echo "=== assert-headless-bundle ==="
echo "tarball=$TARBALL"
echo "platform=$PLATFORM (expect $EXPECT_FORMAT $EXPECT_ARCH)"
echo "tarball sha256=$(sha256sum "$TARBALL" | cut -d' ' -f1)"

# --- The layout a PRODUCTION bundle has, not the spike ---
#
# packages/runtime/src/update-install.ts joins the staged dir with 'headless', so
# any other archive root silently installs nothing. The file set itself is what
# scripts/build-bun.ts writes: podium-cli, the launcher shim, both client sites,
# the packaged systemd units, VERSION, LICENSE, NOTICE, THIRD-PARTY-NOTICES.md.
# POD-2501's spike packed none of systemd/LICENSE/NOTICE and wrote stub
# index.html files; a gate that only checks that subset accepts a malformed
# production bundle.
listing="$(tar -tzf "$TARBALL")" || fail "cannot list $TARBALL"
for want in \
  headless/podium-cli \
  headless/podium \
  headless/VERSION \
  headless/LICENSE \
  headless/NOTICE \
  headless/THIRD-PARTY-NOTICES.md \
  headless/web/index.html \
  headless/mobile/index.html \
  headless/systemd/podium-parent.service \
  headless/systemd/podium-server.service \
  headless/systemd/podium-janitor.service \
  headless/systemd/podium-daemon.service
do
  grep -qx "$want" <<<"$listing" || fail "tarball missing $want"
done
stray="$(echo "$listing" | awk -F/ '{print $1}' | sort -u | grep -vx 'headless' || true)"
[ -z "$stray" ] || fail "tarball has entries outside headless/: $stray"
pass "archive root is headless/ and carries the production file set"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/podium-assert-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
tar -xzf "$TARBALL" -C "$WORK" || fail "cannot extract $TARBALL"
CLI="$WORK/headless/podium-cli"
[ -x "$CLI" ] || fail "extracted headless/podium-cli is missing or not executable"
[ -x "$WORK/headless/podium" ] || fail "extracted headless/podium launcher is not executable"
grep -q 'PODIUM_HOME' "$WORK/headless/podium" \
  || fail "extracted headless/podium is not the launcher shim (no PODIUM_HOME)"
[ -s "$WORK/headless/VERSION" ] || fail "extracted headless/VERSION is empty"
grep -q Apache "$WORK/headless/LICENSE" \
  || fail "extracted headless/LICENSE is empty or is not the Apache license"
grep -q Podium "$WORK/headless/NOTICE" \
  || fail "extracted headless/NOTICE is empty or does not name Podium"
[ -s "$WORK/headless/THIRD-PARTY-NOTICES.md" ] \
  || fail "extracted headless/THIRD-PARTY-NOTICES.md is empty"
for unit in podium-parent.service podium-server.service podium-janitor.service podium-daemon.service; do
  grep -q '\[Unit\]' "$WORK/headless/systemd/$unit" \
    || fail "extracted headless/systemd/$unit is not a systemd unit"
done

validate_client() {
  python3 - "$1" "$2" <<'PY'
import gzip
import json
import re
import sys
from datetime import datetime
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit

site = Path(sys.argv[1])
version = Path(sys.argv[2]).read_text(encoding='utf-8').strip()

class Document(HTMLParser):
    def __init__(self):
        super().__init__()
        self.has_root = False
        self.version = None
        self.scripts = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if attrs.get('id') == 'root':
            self.has_root = True
        if tag == 'meta' and attrs.get('name', '').lower() == 'podium-version':
            self.version = attrs.get('content')
        if tag == 'script' and attrs.get('src'):
            self.scripts.append((attrs.get('type', '').lower(), attrs['src']))

def reject(message):
    print(message, file=sys.stderr)
    sys.exit(1)

html_path = site / 'index.html'
stamp_path = site / 'podium-build.json'
if not html_path.is_file():
    reject(f'has no {site.name}/index.html')
if not stamp_path.is_file():
    reject(f'has no {site.name}/podium-build.json')

html = html_path.read_text(encoding='utf-8')
doc = Document()
doc.feed(html)
if not doc.has_root:
    reject('is a static stub (no React mount id="root")')
if doc.version != version:
    reject(f'podium-version meta {doc.version!r} does not match VERSION {version!r}')

try:
    stamp = json.loads(stamp_path.read_text(encoding='utf-8'))
except (OSError, json.JSONDecodeError) as error:
    reject(f'has an invalid podium-build.json: {error}')
if not isinstance(stamp, dict):
    reject('podium-build.json is not an object')
if stamp.get('appVersion') != version:
    reject(f'build stamp appVersion {stamp.get("appVersion")!r} does not match VERSION {version!r}')
if not isinstance(stamp.get('wireVersion'), int) or isinstance(stamp.get('wireVersion'), bool) or stamp['wireVersion'] < 1:
    reject('build stamp has no positive integer wireVersion')
if not re.fullmatch(r'[0-9a-f]{16}', stamp.get('wireSchemaDigest', '')):
    reject('build stamp has no 16-hex wireSchemaDigest')
source_sha = stamp.get('sourceSha', '')
if not re.fullmatch(r'[0-9a-f]{7,40}', source_sha):
    reject('build stamp has no hexadecimal sourceSha')
if version.startswith('dev+') and version[4:] != source_sha:
    reject(f'build stamp sourceSha {source_sha!r} does not match development version {version!r}')
try:
    built_at = datetime.fromisoformat(stamp.get('builtAt', '').replace('Z', '+00:00'))
    if built_at.tzinfo is None:
        reject('build stamp builtAt has no timezone')
except (TypeError, ValueError):
    reject('build stamp builtAt is not an ISO-8601 timestamp')

hashed = re.compile(r'(?:^|/)[^/?#]+-([A-Za-z0-9_-]{8}|[0-9a-f]{32})\.js(?:[?#]|$)')
module = [(src, hashed.search(src)) for typ, src in doc.scripts if typ == 'module']
classic = [(src, hashed.search(src)) for typ, src in doc.scripts if typ != 'module']
candidates = [pair for pair in (module or classic) if pair[1]]
if not candidates:
    reject('index.html references no content-hashed JavaScript entry')
src, match = candidates[0]
expected_bundle = f'bundle+{match.group(1)}'
if stamp.get('bundleVersion') != expected_bundle:
    reject(f'build stamp bundleVersion {stamp.get("bundleVersion")!r} does not match entry {expected_bundle!r}')

url = urlsplit(src)
if url.scheme or url.netloc:
    reject(f'entry script is not a local client asset: {src}')
relative = unquote(url.path).lstrip('/')
if relative.startswith(f'{site.name}/'):
    relative = relative[len(site.name) + 1:]
asset = (site / relative).resolve()
try:
    asset.relative_to(site.resolve())
except ValueError:
    reject(f'entry script escapes the client root: {src}')
if not asset.is_file():
    reject(f'index.html references missing client asset {src}')
raw = asset.read_bytes()
if len(raw) < 100_000:
    reject(f'hashed entry asset {src} is only {len(raw)} bytes')
compressed = len(gzip.compress(raw, compresslevel=9))
if compressed < 20_000:
    reject(f'hashed entry asset {src} compresses to only {compressed} bytes — padded static content is not a client build')
try:
    javascript = raw.decode('utf-8')
except UnicodeDecodeError:
    reject(f'hashed entry asset {src} is not UTF-8 JavaScript')
if not ('{' in javascript and '(' in javascript and any(token in javascript for token in ('function', '=>', 'const ', 'var ', 'class '))):
    reject(f'hashed entry asset {src} does not contain executable JavaScript structure')

print(f'{site.name}: validated {src} ({len(raw)} raw bytes, {compressed} gzip bytes), stamp {expected_bundle}')
PY
}

# A file named index.html is not enough. Nor are padding, a stamp-shaped JSON
# file, and a made-up hashed script name: all three are cheap to forge around a
# static stub. Validate the stamp's relationships and require the referenced,
# content-hashed entry chunk to contain substantial compressed JavaScript.
for site in web mobile; do
  site_dir="$WORK/headless/$site"
  if ! client_report="$(validate_client "$site_dir" "$WORK/headless/VERSION" 2>&1)"; then
    fail "extracted $site client is not a validated production build: $client_report"
  fi
  echo "$client_report"
done
pass "bundle carries validated production clients and VERSION ($(tr -d '\n' <"$WORK/headless/VERSION"))"
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
  # BOTH format and architecture, in order, and no looser alternative. This used to
  # accept `*<arch>*` on its own, which made the FORMAT optional — so the check read as
  # "is this an ELF aarch64?" while only asking "does the word aarch64 appear?". Among
  # the four platforms we ship I could not construct a pair that actually exploited it
  # (`file` prints x86-64 for ELF and x86_64 for Mach-O, arm64 for Mach-O and ARM
  # aarch64 for ELF), so this is not a fixed bug — it is a check that now says what it
  # means, and cannot be widened by a fifth platform arriving.
  ref_file="$(file -b "$ABDUCO_REF")"
  case "$ref_file" in
    *"$EXPECT_FORMAT"*"$EXPECT_ARCH"*) : ;;
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

# --- Darwin signature + entitlements ---
#
# rcodesign CONTRIBUTES THE ENTITLEMENTS, NOT THE SIGNATURE. Bun's --compile
# output is already ad-hoc signed (LINKER_SIGNED, identifier a.out, no
# entitlements). The discriminators below prove the build re-signed it; the
# five keys prove the thing that re-sign actually adds. Drop rcodesign and the
# LINKER_SIGNED check fails here; strip the keys off a re-signed binary and
# the entitlement loop fails here. Neither is visible as "unsigned".
if [ "$IS_DARWIN" = 1 ]; then
  echo "signature policy for $PLATFORM: a failure below means — $SIG_MEANING"
  sig="$(rcodesign print-signature-info "$CLI" 2>&1)" \
    || fail "rcodesign could not parse a signature out of the shipped binary: $SIG_MEANING"
  grep -q 'signature: null' <<<"$sig" && fail "shipped binary has NO code signature: $SIG_MEANING"
  grep -q 'CodeSignatureFlags(ADHOC' <<<"$sig" \
    || fail "shipped binary signature is missing the ADHOC flag: $SIG_MEANING"
  grep -q 'LINKER_SIGNED' <<<"$sig" \
    && fail "shipped binary still carries Bun's LINKER_SIGNED signature — rcodesign never re-signed it, so the JIT entitlements were never attached ($SIG_MEANING)"
  grep -q 'identifier: podium' <<<"$sig" \
    || fail "shipped binary signature identifier is not 'podium' (Bun's linker signature uses a.out)"
  pass "shipped binary was re-signed ad-hoc by rcodesign (identifier=podium)"
  for ent in \
    com.apple.security.cs.allow-jit \
    com.apple.security.cs.allow-unsigned-executable-memory \
    com.apple.security.cs.disable-executable-page-protection \
    com.apple.security.cs.allow-dyld-environment-variables \
    com.apple.security.cs.disable-library-validation
  do
    ent_value="$(awk -v ent="$ent" '
      index($0, "<key>" ent "</key>") { getline; print; exit }
    ' <<<"$sig")"
    [ -n "$ent_value" ] || fail "shipped binary entitlements missing $ent"
    case "$ent_value" in
      *'<true/>'*|*'<true />'*) : ;;
      *) fail "shipped binary entitlement $ent is not enabled (expected true, got: $ent_value)" ;;
    esac
  done
  pass "shipped binary carries the full Bun JIT entitlement set (5 keys, all true)"

  # Does the signature still seal these bytes? An ad-hoc signature has no CMS blob, so
  # `rcodesign verify` ALWAYS reports a CMS error — that line is the proof the verifier
  # ran at all. What must not appear is a code digest mismatch.
  verify_out="$(rcodesign verify "$CLI" 2>&1 || true)"
  grep -q 'CMS error' <<<"$verify_out" \
    || fail "rcodesign verify did not produce the expected ad-hoc CMS marker — the verifier did not run as expected:
$verify_out"
  grep -qi 'digest mismatch' <<<"$verify_out" \
    && fail "code digest mismatch — the signature does not seal the shipped bytes"
  pass "signature seals the shipped bytes (no code digest mismatch)"
fi

echo "=== ALL ASSERTIONS PASSED for $(basename "$TARBALL") ($PLATFORM) ==="
