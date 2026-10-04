/**
 * Replica hydration and Store snapshot publication.
 *
 * The sync kernel owns cursor arithmetic, healing, watermarks, evictions and
 * rescopes. This adapter deliberately knows none of those concepts: it reads the
 * principal-bound slice exposed through the client Replica contract and publishes
 * row snapshots. That boundary keeps the Store from becoming a second sync state
 * machine while still giving it hydrate-first, offline paint.
 *
 * A kernel bootstrap installation reports one changed-kind batch, so consumers
 * observe one fully rebuilt slice, never a mixture of the pre- and post-rescope
 * worlds. Ordinary collection writes remain synchronous, matching Store action
 * semantics. Cursor-only events (including watermarks) report no row batch and
 * therefore produce no Store publication.
 */

import type { Replica, ReplicaHydrateResult, ReplicaKind, ReplicaRows } from '../replica/contract'

export const REPLICA_BINDING_KINDS = [
  'sessions',
  'sessionUserStates',
  'machines',
  'issueProjections',
  'issueUserStates',
  'issueGitStates',
  'issueDeps',
  'repos',
  'issueEvents',
  'pendingInteractions',
  'messageRecords',
  'shipOrders',
  'shipLanes',
  'conversations',
  'automations',
  'automationRuns',
  'userLayouts',
] as const satisfies readonly ReplicaKind[]

export type ReplicaBindingSnapshot = {
  readonly [K in ReplicaKind]: ReplicaRows[K][]
}

export interface ReplicaPublication {
  readonly snapshot: ReplicaBindingSnapshot
  readonly changed: ReadonlySet<ReplicaKind>
  readonly reason: 'rows' | 'hydrated'
  /** On-demand mode only (POD-5434): the row ids this batch touched per kind,
   *  or `'replace'` when it replaced the slice or the ids are unknown. */
  readonly addressed?: ReadonlyMap<ReplicaKind, ReadonlySet<string>> | 'replace'
}

export interface ReplicaBindingSubscriber {
  publish(publication: ReplicaPublication): void
  /** Legacy wire-v1 compatibility only. The kernel feed never seeds the hub. */
  hydrated?(result: ReplicaHydrateResult): void
}

/** Whole-kind reads, for the legacy fold meter (POD-5434). */
export interface ReplicaBindingStats {
  /** `replica.rows(kind)` calls: each materialises one kind's whole array. */
  rowReads: number
}

export interface ReplicaBinding {
  readonly stats: ReplicaBindingStats
  /** Synchronous durable read used to build the Store's very first snapshot. */
  snapshot(): ReplicaBindingSnapshot
  /** Arm row subscriptions and hydration. The returned teardown is idempotent. */
  start(subscriber: ReplicaBindingSubscriber): () => void
  /**
   * POD-5434: stop materialising changed kinds per batch. Each publication's
   * `snapshot` then reads the replica when a kind is read (`replica.rows` keeps
   * its own per-kind projection), and carries the batch's `addressed` ids.
   * Needs the replica's addressed batches; false (and no change) without them.
   * One way: the binding never goes back.
   */
  readOnDemand(): boolean
}

export interface ReplicaBindingInit {
  readonly replica: Replica
}

export function createReplicaBinding(init: ReplicaBindingInit): ReplicaBinding {
  const { replica } = init
  const stats: ReplicaBindingStats = { rowReads: 0 }
  let current = readSnapshot(replica, stats)
  let generation = 0
  let onDemand = false
  /** The started generation's switch to on-demand reads, if one is running. */
  let armOnDemand: (() => void) | null = null

  return {
    stats,
    snapshot: () => current,

    readOnDemand(): boolean {
      if (onDemand) return true
      if (replica.subscribeAddressedBatch === undefined || replica.row === undefined) return false
      onDemand = true
      current = liveSnapshot(replica, stats)
      armOnDemand?.()
      return true
    },

    start(subscriber): () => void {
      const mine = ++generation
      let stopped = false
      const pending = new Set<ReplicaKind>()
      const offs: Array<() => void> = []
      /** On demand: the kernel names a batch's rows right after its kinds, in
       *  the same drain. A batch waits for its names; this is the fallback if
       *  they never come. */
      let awaitingAddresses = false

      const flush = (
        reason: ReplicaPublication['reason'],
        addressed?: ReplicaPublication['addressed'],
      ): void => {
        if (stopped || generation !== mine || pending.size === 0) return
        const changed = new Set(pending)
        pending.clear()
        if (!onDemand) {
          current = readChanged(replica, current, changed, stats)
          subscriber.publish({ snapshot: current, changed, reason })
          return
        }
        subscriber.publish({
          snapshot: current,
          changed,
          reason,
          addressed: addressed ?? 'replace',
        })
      }

      const publishRows = (kinds: ReadonlySet<ReplicaKind>): void => {
        for (const kind of kinds) pending.add(kind)
        if (!onDemand) {
          flush('rows')
          return
        }
        if (awaitingAddresses) return
        awaitingAddresses = true
        queueMicrotask(() => {
          if (!awaitingAddresses) return
          awaitingAddresses = false
          flush('rows')
        })
      }

      armOnDemand = () => {
        if (stopped || generation !== mine || replica.subscribeAddressedBatch === undefined) return
        offs.push(
          replica.subscribeAddressedBatch((batch) => {
            if (!awaitingAddresses) return
            awaitingAddresses = false
            if (batch.type === 'replace') {
              flush('rows', 'replace')
              return
            }
            const ids = new Map<ReplicaKind, Set<string>>()
            for (const { kind, id } of batch.rows) {
              const set = ids.get(kind) ?? new Set<string>()
              ids.set(kind, set)
              set.add(id)
            }
            flush('rows', ids)
          }),
        )
      }
      if (onDemand) armOnDemand()

      // Subscribe first, then re-read every kind. A write in the construction →
      // start gap is either caught by the listener or by this synchronous read.
      if (replica.subscribeRowBatch !== undefined) {
        offs.push(replica.subscribeRowBatch((changed) => publishRows(changed)))
      } else {
        for (const kind of REPLICA_BINDING_KINDS) {
          offs.push(replica.subscribeRows(kind, () => publishRows(new Set([kind]))))
        }
      }
      for (const kind of REPLICA_BINDING_KINDS) pending.add(kind)
      flush('rows')

      // Hydration belongs here, not in engine.ts. Re-read through rows() after it
      // resolves: the returned result is also handed to the v1 hub adapter, but
      // rows() is the one read model both legacy and kernel facades expose.
      void replica.hydrate().then((result) => {
        if (stopped || generation !== mine) return
        subscriber.hydrated?.(result)
        for (const kind of REPLICA_BINDING_KINDS) pending.add(kind)
        flush('hydrated')
      })

      return () => {
        if (stopped) return
        stopped = true
        if (generation === mine) {
          generation += 1
          armOnDemand = null
        }
        pending.clear()
        for (const off of offs.splice(0)) {
          try {
            off()
          } catch {
            // Teardown is best-effort, matching the engine lifecycle contract.
          }
        }
      }
    },
  }
}

function readSnapshot(replica: Replica, stats: ReplicaBindingStats): ReplicaBindingSnapshot {
  stats.rowReads += REPLICA_BINDING_KINDS.length
  return {
    sessions: replica.rows('sessions'),
    sessionUserStates: replica.rows('sessionUserStates'),
    machines: replica.rows('machines'),
    issueProjections: replica.rows('issueProjections'),
    issueUserStates: replica.rows('issueUserStates'),
    issueGitStates: replica.rows('issueGitStates'),
    issueDeps: replica.rows('issueDeps'),
    repos: replica.rows('repos'),
    issueEvents: replica.rows('issueEvents'),
    pendingInteractions: replica.rows('pendingInteractions'),
    messageRecords: replica.rows('messageRecords'),
    shipOrders: replica.rows('shipOrders'),
    shipLanes: replica.rows('shipLanes'),
    conversations: replica.rows('conversations'),
    automations: replica.rows('automations'),
    automationRuns: replica.rows('automationRuns'),
    userLayouts: replica.rows('userLayouts'),
  }
}

/** A snapshot that reads each kind from the replica when the kind is read.
 *  Every read counts: it is a reader asking for a whole kind. */
function liveSnapshot(replica: Replica, stats: ReplicaBindingStats): ReplicaBindingSnapshot {
  const live = {} as Record<ReplicaKind, unknown>
  for (const kind of REPLICA_BINDING_KINDS) {
    Object.defineProperty(live, kind, {
      enumerable: true,
      get: () => {
        stats.rowReads++
        return replica.rows(kind)
      },
    })
  }
  return live as unknown as ReplicaBindingSnapshot
}

function readChanged(
  replica: Replica,
  previous: ReplicaBindingSnapshot,
  changed: ReadonlySet<ReplicaKind>,
  stats: ReplicaBindingStats,
): ReplicaBindingSnapshot {
  const next = { ...previous } as { [K in ReplicaKind]: ReplicaRows[K][] }
  for (const kind of changed) {
    stats.rowReads++
    // The indexed access is the same K on both sides; the mapped object retains
    // the correlation that TypeScript loses while iterating a union of keys.
    ;(next as Record<ReplicaKind, unknown>)[kind] = replica.rows(kind)
  }
  return next
}
