/**
 * ONE ACCOUNT'S TOKEN USAGE: the hour×model buckets for the last 7 days,
 * harvested from the answering machine's transcripts.
 *
 * Two readers ask the same question, so it is answered here once:
 * - `usage.summary`, a request (the CLI, and any caller without topics);
 * - the `account.quota` topic (ADR 7 Amendment 2 D26, POD-5798), whose live
 *   pass reads it for each account that holds the key.
 *
 * ALSO WRITES (POD-1858), on the same terms as `quota.summary`: the daemon
 * returns the per-FILE half of the walk it just did, and it is folded into the
 * per-task cost rows on the way out. No caller input reaches the fold and no
 * second scan happens. Attributing the walk that already runs is the whole
 * design of the cost read path, because a second walk of the same 4 GB would
 * land on the daemon loop that carries PTY traffic.
 *
 * `sources` is STRIPPED before the answer is returned: it is an order of
 * magnitude larger than the buckets and no client reads it. Best-effort: a
 * failed fold never fails the usage read.
 */

import { createLogger } from '@podium/logger'
import { asUserId, type MachineId, type UsageBucketWire, type UsageSourceWire } from '@podium/model'
import type { PrivateResourceAccess } from '../private-resources'
import type { SessionStore } from '../store'
import { CostService } from './cost/service'

const log = createLogger('cost')

/** The daemon's own default window, restated because the fold records which window it covers. */
export const USAGE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

export interface UsageSummary {
  hostname: string
  sampledAt?: string
  buckets: UsageBucketWire[]
}

export interface UsageSummaryDeps {
  readonly rpc: {
    answeringMachineId(): Promise<MachineId>
    usage(
      sinceMs?: number,
      withSources?: boolean,
      machineId?: MachineId,
    ): Promise<UsageSummary & { sources?: UsageSourceWire[]; sourcesSinceMs?: number }>
  }
  readonly store: SessionStore
  /** The caller's private-class decisions (machine use permits the scan). */
  readonly privateAccess: PrivateResourceAccess
  /** The human whose usage this is. */
  readonly userId: string
  readonly now?: () => number
}

/**
 * Thrown on a multi-member instance when the answering daemon cannot attribute
 * its buckets to their owners: disclosing the aggregate would show one
 * person's usage to another, so the read fails closed.
 */
export class UsageAttributionUnavailable extends Error {
  constructor() {
    super(
      'Upgrade the answering daemon before viewing usage on a multi-member instance: it must report per-transcript usage buckets.',
    )
    this.name = 'UsageAttributionUnavailable'
  }
}

export async function readUsageSummary(deps: UsageSummaryDeps): Promise<UsageSummary> {
  // Fix the answering machine before both authorization and dispatch. Machine
  // use permits the scan; it does not permit another human's usage (MU-30).
  const machineId = await deps.rpc.answeringMachineId()
  if (!(await deps.privateAccess.mayReadMachineFiles(machineId)))
    return { hostname: '', buckets: [] }
  const sinceMs = (deps.now ?? Date.now)() - USAGE_WINDOW_MS
  const { sources, sourcesSinceMs, ...usage } = await deps.rpc.usage(sinceMs, true, machineId)
  const shared = await deps.store.users.hasSeveralMembers()
  if (
    shared &&
    (sources?.some((source) => source.windowBuckets === undefined) ||
      (!sources?.length && usage.buckets.length > 0))
  ) {
    throw new UsageAttributionUnavailable()
  }
  let buckets = shared ? ([] as UsageBucketWire[]) : usage.buckets
  if (sources?.length) {
    let harvest: Awaited<ReturnType<CostService['prepareHarvest']>>
    try {
      harvest = await new CostService(deps.store).prepareHarvest(machineId, sources)
    } catch (err) {
      // Without owner attribution a multi-member response must fail closed.
      if (shared) throw err
      log.warn('cost attribution failed — single-member usage buckets unaffected', { err })
      return usage
    }
    if (shared)
      buckets = harvest
        .bucketsForOwner(asUserId(deps.userId))
        .filter((bucket) => Date.parse(bucket.hour) >= sinceMs - 3_600_000)
    try {
      // The MEMO's window, not ours. The daemon may serve a fold it computed
      // against an older `sinceMs`; stamping it with the newer one re-dates
      // last window's numbers as current and keeps a transcript that has
      // since fallen out of the window contributing to "attributed".
      const foldSinceMs = sourcesSinceMs ?? sinceMs
      await harvest.record(foldSinceMs)
    } catch (err) {
      log.warn('cost fold failed — usage buckets unaffected', { err })
    }
  }
  return { ...usage, buckets }
}
