/**
 * Cursor credentials — the Inventory credentials section (POD-4414 §4.4,
 * issue 3.3).
 *
 * Declined with the reason: no portable Cursor credential layout has been
 * verified. The declaration stays so one lands here, not in a new daemon
 * table.
 */
import { unsupported } from '../../manifest.js'

export const cursorCredentials = unsupported(
  'Cursor credential portability is not supported yet',
)
