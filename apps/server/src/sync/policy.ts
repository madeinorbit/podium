/**
 * THE SERVER'S POLICY PER CLIENT TYPE (POD-7085, design POD-7059 "Policy").
 *
 * Which collections each kind of app holds at all times, in which order its
 * first download loads them, how many days "recent" reaches back, and the
 * device's budgets in memory and on disk. The client says only what it is; the policy
 * comes back in the load header (`syncMeta.policy`). The numbers live here, on
 * the server, so they change without a client release.
 *
 * The order is the design's: always and live (with the sessions that ask, and
 * the server's own windows), so the first screen can paint; what the visible
 * view asks for; recent; the sidebar with what it comes with, and the
 * sidebar's lanes; the issue stubs last.
 *
 * The budgets (design POD-7157, "Decisions"): the warm set in memory (what no
 * view reads but the device keeps for going back, POD-7161), and local
 * storage's size and unread age (POD-7162). Held views and the policy's own
 * collections are outside every budget. The server publishes these numbers.
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
  // The sessions with no issue are not a step of their own: their rule is a
  // subset of live, asking and recent, which the steps above already hold.
  { step: 'sidebar', collections: [...DESIGN_COLLECTIONS.sidebar] },
  { step: 'stubs', collections: [...DESIGN_COLLECTIONS.issueStubs] },
]

const policy = (
  clientType: ClientType,
  recentDays: number,
  budgets: Pick<SyncPolicy, 'memoryBudgetMb' | 'diskBudgetMb' | 'diskMaxIdleDays'>,
): SyncPolicy => ({ clientType, steps: STEPS as SyncPolicy['steps'], recentDays, ...budgets })

/**
 * One policy per client type. The budgets are design POD-7157's ("Decisions"
 * 1): the warm set in memory, local storage, and the unread age. POD-7164 may
 * move each by up to a factor of two from measurement.
 */
export const SYNC_POLICIES: Readonly<Record<ClientType, SyncPolicy>> = {
  phone: policy('phone', 7, { memoryBudgetMb: 20, diskBudgetMb: 150, diskMaxIdleDays: 14 }),
  browser: policy('browser', 30, { memoryBudgetMb: 80, diskBudgetMb: 500, diskMaxIdleDays: 30 }),
  desktop: policy('desktop', 30, { memoryBudgetMb: 160, diskBudgetMb: 1024, diskMaxIdleDays: 60 }),
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
