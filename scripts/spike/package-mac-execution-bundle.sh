#!/usr/bin/env bash
# Build the Mac execution-proof bundle from an existing darwin-arm64 spike dir.
# Output (gitignored under dist-bun-spike/): a directory a human can scp to a Mac.
#
#   dist-bun-spike/mac-execution-bundle-<platform>/
#     verify-on-mac.sh
#     podium-headless-<platform>.tar.gz   # updater layout: archive root = headless/
#     podium-cli.nosig                     # signature removed, for the unsigned probe
#     README.md
#   dist-bun-spike/mac-execution-bundle-<platform>.tar.gz
#
# Platform via $PLATFORM (darwin-arm64 | darwin-x64), default darwin-arm64.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PLATFORM="${PLATFORM:-darwin-arm64}"
SPIKE="${1:-$ROOT/dist-bun-spike/$PLATFORM}"
OUT="$ROOT/dist-bun-spike/mac-execution-bundle-$PLATFORM"

[[ -x "$SPIKE/headless/podium-cli" ]] || {
  echo "missing $SPIKE/headless/podium-cli — build the spike first" >&2
  exit 1
}

rm -rf "$OUT"
mkdir -p "$OUT"

# Updater-shaped tarball ONLY (update-install.ts requires staged/headless).
tar -czf "$OUT/podium-headless-$PLATFORM.tar.gz" -C "$SPIKE" headless

# Also refresh the spike-dir copy — this IS the tarball linux-assert interrogates.
cp -f "$OUT/podium-headless-$PLATFORM.tar.gz" "$SPIKE/podium-headless-$PLATFORM.tar.gz"

cp "$ROOT/scripts/spike/mac-execution-verify.sh" "$OUT/verify-on-mac.sh"
chmod +x "$OUT/verify-on-mac.sh"

# A GENUINELY unsigned copy for the "unsigned must be refused on arm64" probe.
# `bun build --compile --target=bun-darwin-*` already emits an ad-hoc,
# LINKER_SIGNED Mach-O, so the build's `podium.unsigned` is not unsigned at all —
# the signature has to be removed on purpose.
python3 "$ROOT/scripts/spike/macho-strip-signature.py" \
  "$SPIKE/headless/podium-cli" "$OUT/podium-cli.nosig"
chmod +x "$OUT/podium-cli.nosig"

cat >"$OUT/README.md" <<'EOF'
# Mac execution proof bundle (POD-2501 / follow-up)

Built on Linux. **This archive does not prove macOS execution by itself** — a
human (or online fleet Mac) must run the verifier below.

## On a Mac

```sh
tar -xzf mac-execution-bundle.tar.gz
cd mac-execution-bundle
bash verify-on-mac.sh
```

Paste the MATRIX section onto the follow-up issue. Exit code 0 = PASS.

## Contents

- `podium-headless-<platform>.tar.gz` — updater layout (`headless/` root)
- `podium-cli.nosig` — the same binary with its code signature removed, for the
  "unsigned is refused on arm64" probe. Bun's own `--compile` output is already
  ad-hoc signed, so this had to be stripped deliberately; the spike's old
  `podium.unsigned` was never unsigned and its "AMFI is lenient" reading was wrong.
- `verify-on-mac.sh` — version, `codesign --verify --strict`, unsigned refusal,
  Gatekeeper±quarantine, all-in-one boot, abduco spawn/survive
EOF

tar -czf "$ROOT/dist-bun-spike/mac-execution-bundle-$PLATFORM.tar.gz" \
  -C "$ROOT/dist-bun-spike" "mac-execution-bundle-$PLATFORM"
ls -lah "$OUT" "$ROOT/dist-bun-spike/mac-execution-bundle-$PLATFORM.tar.gz"
echo "packaged -> $ROOT/dist-bun-spike/mac-execution-bundle-$PLATFORM.tar.gz"
