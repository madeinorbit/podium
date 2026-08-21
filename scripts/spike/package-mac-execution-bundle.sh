#!/usr/bin/env bash
# Build the Mac execution-proof bundle from an existing darwin-arm64 spike dir.
# Output (gitignored under dist-bun-spike/): a directory a human can scp to a Mac.
#
#   dist-bun-spike/mac-execution-bundle/
#     verify-on-mac.sh
#     podium-headless-darwin-arm64.tar.gz   # updater layout: archive root = headless/
#     README.md
#   dist-bun-spike/mac-execution-bundle.tar.gz
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SPIKE="${1:-$ROOT/dist-bun-spike/darwin-arm64}"
OUT="$ROOT/dist-bun-spike/mac-execution-bundle"

[[ -x "$SPIKE/headless/podium-cli" ]] || {
  echo "missing $SPIKE/headless/podium-cli — build the spike first" >&2
  exit 1
}

rm -rf "$OUT"
mkdir -p "$OUT"

# Updater-shaped tarball ONLY (update-install.ts requires staged/headless).
tar -czf "$OUT/podium-headless-darwin-arm64.tar.gz" -C "$SPIKE" headless

# Also refresh the spike-dir copy used by linux-assert.
cp -f "$OUT/podium-headless-darwin-arm64.tar.gz" "$SPIKE/podium-headless-darwin-arm64.tar.gz"

cp "$ROOT/scripts/spike/mac-execution-verify.sh" "$OUT/verify-on-mac.sh"
chmod +x "$OUT/verify-on-mac.sh"

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

- `podium-headless-darwin-arm64.tar.gz` — updater layout (`headless/` root)
- `verify-on-mac.sh` — version, Gatekeeper±quarantine, all-in-one boot, abduco spawn/survive
EOF

tar -czf "$ROOT/dist-bun-spike/mac-execution-bundle.tar.gz" -C "$ROOT/dist-bun-spike" mac-execution-bundle
ls -lah "$OUT" "$ROOT/dist-bun-spike/mac-execution-bundle.tar.gz"
echo "packaged -> $ROOT/dist-bun-spike/mac-execution-bundle.tar.gz"
