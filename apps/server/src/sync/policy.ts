/**
 * THE SERVER'S POLICY PER CLIENT TYPE (POD-7085, design POD-7059 "Policy").
 *
 * Which collections each kind of app holds at all times, in which order its
 * first download loads them, how many days "recent" reaches back, and how many
 * records it may keep as cache. The client says only what it is; the policy
 * comes back in the load header (`syncMeta.policy`). The numbers live here, on
 * the server, so they change without a client release.
 *
 * The order is the design's: always and live (with the sessions that ask, and
 * the server's own windows), so the first screen can paint; what the visible
 * view asks for; recent; the sidebar with what it comes with, and the
 * sidebar's lanes; the issue stubs last.
 *
 * Cache caps are placeholders until POD-7095 measures them; nothing on the
 * server reads them.
 */

import { DESIGN_COLLECTIONS, RECORDS } from '@podium/model'
import type { ClientType, CollectionInstance, PolicyStep, SyncPolicy } from '@podium/protocol'

/** The bounded windows the server publishes (messages, issue events, effects). */
const WINDOWS = RECORDS.filter((record) => record.group === 'windowed').map(
  (record) => `${record.kind}.window`,
)

const STEPS: readonly PolicyStep[] = [
  {
    step: 'always',
    collections: [
      ...DESIGN_COLLECTIONS.always,
      ...WINDOWS,
      ...DESIGN_COLLECTIONS.live,
      ...DESIGN_COLLECTIONS.asking,
    ],
  },
  { step: 'view', collections: [] },
  { step: 'recent', collections: [...DESIGN_COLLECTIONS.recent] },
  {
    step: 'sidebar',
    collections: [...DESIGN_COLLECTIONS.sidebar, ...DESIGN_COLLECTIONS.sessionsWithNoIssue],
  },
  { step: 'stubs', collections: [...DESIGN_COLLECTIONS.issueStubs] },
]

const policy = (clientType: ClientType, recentDays: number, cacheCap: number): SyncPolicy => ({
  clientType,
  steps: STEPS as SyncPolicy['steps'],
  recentDays,
  cacheCap,
})

/** One policy per client type. */
export const SYNC_POLICIES: Readonly<Record<ClientType, SyncPolicy>> = {
  phone: policy('phone', 7, 1_000),
  browser: policy('browser', 30, 5_000),
  desktop: policy('desktop', 30, 10_000),
}

/** A request that names no client type is a browser's (the CLI and tests included). */
export const DEFAULT_CLIENT_TYPE: ClientType = 'browser'

export function policyFor(clientType: ClientType | undefined): SyncPolicy {
  return SYNC_POLICIES[clientType ?? DEFAULT_CLIENT_TYPE]
}

/**
 * The first download's instances, in the policy's order: each step's
 * collections, and at the `view` step what the visible view asked for. A
 * policy collection takes no arguments of its own; the policy fills its
 * numbers.
 */
export function firstDownload(
  policy: SyncPolicy,
  view: readonly CollectionInstance[],
): CollectionInstance[] {
  return policy.steps.flatMap((step) =>
    step.step === 'view' ? [...view] : step.collections.map((collection) => ({ collection })),
  )
}
