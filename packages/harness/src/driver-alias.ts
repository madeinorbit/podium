/**
 * Driver id aliases accepted during rollout. A leaf module with no imports, so
 * `./browser.ts` can expose the same canonicalization a daemon applies when it
 * keys its inventory, and `./manifest.ts` keeps its typed overloads over this
 * one implementation.
 */

/** Driver ids accepted from older daemons and user preferences during rollout. */
export const RETIRED_DRIVER_IDS = ['claude-pty'] as const

/** The current id for a driver id, which may be a retired alias. */
export function canonicalDriverIdOf(driverId: string): string {
  return driverId === 'claude-pty' ? 'generic-pty' : driverId
}
