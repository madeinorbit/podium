#!/usr/bin/env bash
# Install `rcodesign` (apple-codesign) on a Linux CI runner.
#
# It is what lets a Linux box sign a Mach-O: the ad-hoc signature plus the Bun JIT
# entitlements that Apple Silicon requires before it will execute the binary at all.
# Two jobs need it — the one that BUILDS the Darwin bundles and the one that reads their
# signatures back off the published release — so the version lives here rather than being
# spelled twice in the workflow and drifting.
#
# Pinned, not "latest": a signing tool that changes under a release job is a change to
# the bytes we ship. Bump deliberately, and re-run the Darwin assertions when you do.
set -euo pipefail

VERSION="${RCODESIGN_VERSION:-0.29.0}"
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64) TRIPLE="x86_64-unknown-linux-musl" ;;
  aarch64|arm64) TRIPLE="aarch64-unknown-linux-musl" ;;
  *) echo "ci-install-rcodesign: unsupported architecture $ARCH" >&2; exit 1 ;;
esac
NAME="apple-codesign-${VERSION}-${TRIPLE}"
DEST="${RCODESIGN_DEST:-/usr/local/bin}"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
curl -fsSL -o "$WORK/rcodesign.tar.gz" \
  "https://github.com/indygreg/apple-platform-rs/releases/download/apple-codesign%2F${VERSION}/${NAME}.tar.gz"
tar -xzf "$WORK/rcodesign.tar.gz" -C "$WORK"
install -m 0755 "$WORK/$NAME/rcodesign" "$DEST/rcodesign"
"$DEST/rcodesign" --version
