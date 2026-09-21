/**
 * Cursor install declaration — the Inventory install section (POD-4414 §4.4).
 *
 * Declined with the reason: cursor-agent is distributed through Cursor's own
 * installer (docs/agent-harness-reference/cursor.md), which the mechanism
 * does not run unattended.
 */
import { unsupported } from '../../manifest.js'

export const cursorInstall = unsupported(
  "cursor-agent is distributed through Cursor's own installer (curl https://cursor.com/install | bash)",
)
