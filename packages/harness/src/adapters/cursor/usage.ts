/**
 * Cursor quota + usage — the Inventory usage section (POD-4414 §4.4,
 * issue 3.3).
 *
 * Declined with the reason: no Cursor quota endpoint or transcript harvest
 * layout is declared yet. The declaration stays so either lands here, not in
 * a new daemon table.
 */
import { unsupported } from '../../manifest.js'

export const cursorUsage = unsupported(
  'Cursor exposes no declared quota endpoint or transcript harvest layout yet',
)
