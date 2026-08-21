#!/usr/bin/env bash
# A/B the CROSS-built headless bundle against the NATIVE one for the same platform,
# ON A MACHINE OF THAT PLATFORM.
#
# This is the check that retires the per-architecture release matrix. Everything the
# Linux-side assertions can prove — object format, embedded helper, signature — they
# prove without running anything. What they cannot prove is that the cross-built binary
# BEHAVES like the native one, and behaviour is the whole question. So this script runs
# both.
#
# ONE DIFFERENCE IS EXPECTED AND INTENDED: the abduco helper. The native leg links the
# runner's glibc, which quietly made that glibc version the floor for every machine
# taking the bundle; the cross leg links musl statically and has no floor at all. The
# bytes therefore differ on purpose. What must NOT differ is what abduco DOES — same
# version banner, same ability to host a detached session that outlives its starter.
#
# Usage: scripts/ab-headless-cross-vs-native.sh <cross.tar.gz> <native.tar.gz>
set -euo pipefail

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }

CROSS="${1:-}"
NATIVE="${2:-}"
[ -f "$CROSS" ] || fail "pass the cross-built tarball (got '$CROSS')"
[ -f "$NATIVE" ] || fail "pass the native tarball (got '$NATIVE')"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/podium-ab-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/cross" "$WORK/native"
tar -xzf "$CROSS" -C "$WORK/cross" || fail "cannot extract $CROSS"
tar -xzf "$NATIVE" -C "$WORK/native" || fail "cannot extract $NATIVE"

echo "=== A/B cross vs native, on $(uname -s)/$(uname -m) ==="

# --- The two bundles must be the same RELEASE ---
cv="$(tr -d '\n' <"$WORK/cross/headless/VERSION")"
nv="$(tr -d '\n' <"$WORK/native/headless/VERSION")"
[ "$cv" = "$nv" ] || fail "VERSION differs: cross=$cv native=$nv — these are not the same release"
pass "both bundles are version $cv"

# --- The packed client sites must be the same build ---
# Everything but podium-build.json must be byte-identical. That stamp carries a wall-clock
# `builtAt` written at pack time, so two jobs packing the SAME commit legitimately differ
# there — the fields that identify the build (sourceSha, appVersion) must not.
for site in web mobile; do
  diff -r -x podium-build.json "$WORK/cross/headless/$site" "$WORK/native/headless/$site" >/dev/null \
    || fail "packed $site/ differs between the cross and native bundles:
$(diff -rq -x podium-build.json "$WORK/cross/headless/$site" "$WORK/native/headless/$site" | head -10)"
  for field in sourceSha appVersion; do
    cf="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$WORK/cross/headless/$site/podium-build.json" "$field")"
    nf="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$WORK/native/headless/$site/podium-build.json" "$field")"
    [ "$cf" = "$nf" ] || fail "packed $site/ $field differs: cross=$cf native=$nf"
  done
done
pass "packed web/ and mobile/ are the same build in both legs (identical bytes; identical sourceSha and appVersion)"

# --- The bundles must contain the same FILES (the binary and helper aside) ---
( cd "$WORK/cross/headless" && find . -type f | sort ) > "$WORK/cross.list"
( cd "$WORK/native/headless" && find . -type f | sort ) > "$WORK/native.list"
diff "$WORK/cross.list" "$WORK/native.list" >/dev/null \
  || fail "the two bundles do not contain the same set of files:
$(diff "$WORK/cross.list" "$WORK/native.list" | head -20)"
pass "both bundles contain the same set of files"

# --- BEHAVIOUR. Both binaries run, here, on this architecture. ---
run_version() {
  local root="$1"
  env -u PODIUM_AGENT_RELAY -u PODIUM_UPDATE_FEED PODIUM_HOME="$root" "$root/podium" --version
}
cver="$(run_version "$WORK/cross/headless")" || fail "the CROSS-built binary failed to run --version on $(uname -m)"
nver="$(run_version "$WORK/native/headless")" || fail "the NATIVE binary failed to run --version on $(uname -m)"
echo "cross --version: $cver"
echo "native --version: $nver"
[ "$cver" = "$nver" ] || fail "--version output differs: cross='$cver' native='$nver'"
pass "the cross-built binary runs on $(uname -m) and reports the same version as the native one"

# --- The embedded abduco: materialized by the real code path, then exercised ---
materialize_abduco() {
  local root="$1" state="$2"
  rm -rf "$state"
  env -u PODIUM_ABDUCO -u PODIUM_AGENT_RELAY PODIUM_STATE_DIR="$state" PODIUM_HOME="$root" \
    "$root/podium" --version >/dev/null 2>&1 || true
  [ -x "$state/bin/abduco" ] || fail "$root did not materialize an executable abduco into $state/bin"
  echo "$state/bin/abduco"
}
cab="$(materialize_abduco "$WORK/cross/headless" "$WORK/cross-state")"
nab="$(materialize_abduco "$WORK/native/headless" "$WORK/native-state")"
echo "cross abduco:  $(file -b "$cab")"
echo "native abduco: $(file -b "$nab")"

cabv="$("$cab" -v 2>&1 | head -1)" || fail "the CROSS-built bundle's abduco does not run on $(uname -m)"
nabv="$("$nab" -v 2>&1 | head -1)" || fail "the NATIVE bundle's abduco does not run on $(uname -m)"
[ "$cabv" = "$nabv" ] || fail "abduco version banner differs: cross='$cabv' native='$nabv'"
pass "both embedded abducos run here and report the same banner: $cabv"

# The one behaviour that matters: a detached session that outlives the process that
# started it. Run it with the CROSS-built helper, since that is the one under suspicion.
SESSION="podium-ab-$$"
export ABDUCO_SOCKET_DIR="$WORK/sockets"
mkdir -p "$ABDUCO_SOCKET_DIR"
"$cab" -n "$SESSION" sh -c 'sleep 60' || fail "the cross-built abduco could not start a detached session"
for _ in 1 2 3 4 5 6 7 8 9 10; do
  "$cab" 2>&1 | grep -q "$SESSION" && break
  sleep 0.5
done
"$cab" 2>&1 | grep -q "$SESSION" \
  || fail "the cross-built abduco started no durable session (it is absent from its own session list)"
pass "the cross-built abduco hosts a detached session that outlived its starter"
"$cab" 2>&1 | grep "$SESSION" || true
pkill -f "abduco.*$SESSION" 2>/dev/null || true

echo "=== A/B PASSED: the cross-built bundle behaves like the native one on $(uname -m) ==="
echo "(Known and intended difference: the abduco helper is static musl in the cross leg"
echo " and dynamically linked glibc in the native one — same banner, same behaviour, no libc floor.)"
