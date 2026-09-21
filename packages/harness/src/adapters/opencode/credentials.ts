/**
 * OpenCode credentials — the Inventory credentials section (POD-4414 §4.4,
 * issue 3.3).
 *
 * Declined with the reason: OpenCode authenticates per-provider through its
 * own auth database, and no portable file layout exists to declare yet. The
 * declaration stays so a future layout lands here, not in a new daemon table.
 */
import { unsupported } from '../../manifest.js'

export const opencodeCredentials = unsupported(
  'OpenCode credential portability is not supported yet',
)
