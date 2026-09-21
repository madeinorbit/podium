/**
 * Pi install declaration — the Inventory install section (POD-4414 §4.4).
 *
 * Declined with the reason: Podium has no verified unattended installer
 * declared for Pi yet, so the CLI refuses with this rather than
 * guessing a vendor URL.
 */
import { unsupported } from '../../manifest.js'

export const piInstall = unsupported('Pi has no verified unattended installer yet')
