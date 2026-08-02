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
  'issues',
  'issueProjections',
  'issueDeps',
  'repos',
  'conversations',
  'automations',
  'automationRuns',
] as const satisfies readonly ReplicaKind[]

export type ReplicaBindingSnapshot = {
  readonly [K in ReplicaKind]: ReplicaRows[K][]
}

export interface ReplicaPublication {
  readonly snapshot: ReplicaBindingSnapshot
  readonly changed: ReadonlySet<ReplicaKind>
  readonly reason: 'rows' | 'hydrated'
}

export interface ReplicaBindingSubscriber {
  publish(publication: ReplicaPublication): void
  /** Legacy wire-v1 compatibility only. The kernel feed never seeds the hub. */
  hydrated?(result: ReplicaHydrateResult): void
}

export interface ReplicaBinding {
  /** Synchronous durable read used to build the Store's very first snapshot. */
  snapshot(): ReplicaBindingSnapshot
  /** Arm row subscriptions and hydration. The returned teardown is idempotent. */
  start(subscriber: ReplicaBindingSubscriber): () => void
}

export interface ReplicaBindingInit {
  readonly replica: Replica
}

export function createReplicaBinding(init: ReplicaBindingInit): ReplicaBinding {
  const { replica } = init
  let current = readSnapshot(replica)
  let generation = 0

  return {
    snapshot: () => current,

    start(subscriber): () => void {
      const mine = ++generation
      let stopped = false
      const pending = new Set<ReplicaKind>()
      const offs: Array<() => void> = []

      const flush = (reason: ReplicaPublication['reason']): void => {
        if (stopped || generation !== mine || pending.size === 0) return
        const changed = new Set(pending)
        pending.clear()
        current = readChanged(replica, current, changed)
        subscriber.publish({ snapshot: current, changed, reason })
      }

      const publishRows = (kinds: ReadonlySet<ReplicaKind>): void => {
        for (const kind of kinds) pending.add(kind)
        flush('rows')
      }

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
        if (generation === mine) generation += 1
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

function readSnapshot(replica: Replica): ReplicaBindingSnapshot {
  return {
    sessions: replica.rows('sessions'),
    issues: replica.rows('issues'),
    issueProjections: replica.rows('issueProjections'),
    issueDeps: replica.rows('issueDeps'),
    repos: replica.rows('repos'),
    conversations: replica.rows('conversations'),
    automations: replica.rows('automations'),
    automationRuns: replica.rows('automationRuns'),
  }
}

function readChanged(
  replica: Replica,
  previous: ReplicaBindingSnapshot,
  changed: ReadonlySet<ReplicaKind>,
): ReplicaBindingSnapshot {
  const next = { ...previous } as { [K in ReplicaKind]: ReplicaRows[K][] }
  for (const kind of changed) {
    // The indexed access is the same K on both sides; the mapped object retains
    // the correlation that TypeScript loses while iterating a union of keys.
    ;(next as Record<ReplicaKind, unknown>)[kind] = replica.rows(kind)
  }
  return next
}
