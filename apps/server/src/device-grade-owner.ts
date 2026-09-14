/**
 * Legacy first-admin owner fallback (POD-1079).
 *
 * Per-account credentials landed in POD-1554 and client principals are now
 * user-grade. This helper does NOT resolve the authenticated caller: it selects
 * the first admin. It must not be used to attribute an authenticated action.
 *
 * The old device-grade premise no longer justifies this fallback. The current
 * server has no executable callers; audit:machine-grants retains a call-site
 * census. Removing the helper and its audit entries is a compatibility cleanup,
 * not work waiting for per-user login to exist.
 */

import { firstAdminMemberId, type FirstAdminSource, type UserId } from '@podium/model'

/** Select the first admin explicitly; this is not a principal resolver. */
export function deviceGradeSoleOwner(store: FirstAdminSource): Promise<UserId> {
  return firstAdminMemberId(store)
}
