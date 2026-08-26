#!/usr/bin/env bash
# Claim the selected named instance and write the rig's minimal host config.
#
# This uses the same runtime config writer as `podium setup`. `saveConfig()`
# claims the selected state root through `ensureInstanceStateIdentity()` before
# it writes config.json, so rigs never fabricate instance.json themselves.

set -euo pipefail

: "${PODIUM_DRIVE_REPO:?PODIUM_DRIVE_REPO must name the source checkout}"
cd "$PODIUM_DRIVE_REPO"

bun --conditions=@podium/source -e '
  import { loadConfig, saveConfig } from "@podium/runtime/config"
  saveConfig({ ...loadConfig(), mode: "all-in-one" })
'

echo "claimed instance '$PODIUM_INSTANCE' and wrote first-run config through the runtime setup path"
