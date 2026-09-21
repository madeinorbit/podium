/**
 * OpenCode install declaration — the Inventory install section (POD-4414 §4.4).
 *
 * Declined with the reason: OpenCode is distributed through npm, brew, and
 * its own standalone installer into ~/.opencode/bin
 * (docs/agent-harness-reference/opencode.md) — no single vendor install
 * script for the mechanism to run unattended.
 */
import { unsupported } from '../../manifest.js'

export const opencodeInstall = unsupported(
  'OpenCode is distributed through npm, brew, and its own standalone installer — no single vendor install script to run',
)
