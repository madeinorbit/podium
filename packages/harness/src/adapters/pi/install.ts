/**
 * Pi install declaration — the Inventory install section (POD-4414 §4.4).
 *
 * Declined with the reason: Pi is distributed through npm, its standalone
 * installer, and GitHub releases (docs/agent-harness-reference/pi.md) — no
 * single vendor install script for the mechanism to run unattended.
 */
import { unsupported } from '../../manifest.js'

export const piInstall = unsupported(
  'Pi is distributed through npm, its standalone installer, and GitHub releases — no single vendor install script to run',
)
