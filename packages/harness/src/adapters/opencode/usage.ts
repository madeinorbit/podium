/**
 * OpenCode quota + usage — the Inventory usage section (POD-4414 §4.4,
 * issue 3.3).
 *
 * Declined with the reason: OpenCode stores transcripts in SQLite (no JSONL
 * harvest layout) and exposes no vendor quota endpoint Podium reads. The
 * declaration stays so either lands here, not in a new daemon table.
 */
import { unsupported } from '../../manifest.js'

export const opencodeUsage = unsupported(
  'OpenCode exposes no vendor quota endpoint and stores transcripts in SQLite — no harvest layout to declare yet',
)
