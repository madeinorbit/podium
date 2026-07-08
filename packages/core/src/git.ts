/**
 * Canonical home is @podium/domain (#194 — git remote identity is pure,
 * platform-neutral entity logic, not runtime plumbing). Re-exported here so
 * apps/server and apps/web's existing `@podium/core` imports keep working.
 */
export { normalizeOriginUrl } from '@podium/domain'
