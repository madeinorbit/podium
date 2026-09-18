import type { ClientSwitchTrace } from '@podium/protocol'
import type { ReplicaKind, ReplicaRows } from '../replica/contract'
import type { EngineState } from './state'

/** Internal, opt-in seam. No runtime constructs this publisher yet. */
export type EffectiveLocalState = Omit<EngineState, ReplicaKind>
export type EffectiveLocalKey = keyof EffectiveLocalState
export interface EffectiveAddress {
  readonly kind: ReplicaKind
  readonly id: string
}
export interface EffectiveRowChange extends EffectiveAddress {
  /** Absent means deleted OR no longer visible; never infer server deletion. */
  readonly presence: 'present' | 'absent'
}

/** Reads are pinned to this completed runtime commit, never live mutable state.
 * The producer owns the rows. Consumers must not mutate any returned value. */
export interface EffectiveReadView {
  /** Existing Store snapshot identity, not a new sequence/cursor. */
  readonly commit: object
  readonly trace?: Pick<ClientSwitchTrace, 'switchId'>
  row<K extends ReplicaKind>(kind: K, id: string): Readonly<ReplicaRows[K]> | undefined
  ids(kind: ReplicaKind): readonly string[]
  local<K extends EffectiveLocalKey>(key: K): EffectiveLocalState[K]
}
export type EffectivePublication = {
  readonly view: EffectiveReadView
} & (
  | { readonly type: 'replace'; readonly reason: 'seed' | 'bootstrap' | 'rescope' }
  | {
      readonly type: 'update'
      readonly rows: readonly EffectiveRowChange[]
      readonly local: readonly EffectiveLocalKey[]
    }
)
export type EffectiveCommit =
  | { readonly type: 'replace'; readonly reason: 'bootstrap' | 'rescope'; readonly view: EffectiveReadView }
  | {
      readonly type: 'update'
      readonly view: EffectiveReadView
      /** Candidate addresses, including overlay-only writes. Duplicates allowed. */
      readonly rows: readonly EffectiveAddress[]
      readonly local: readonly EffectiveLocalKey[]
    }

export interface EffectiveChanges {
  /** Registers and synchronously delivers one complete seed, without a read gap. */
  subscribe(listener: (publication: EffectivePublication) => void): () => void
}

/** Reference delivery implementation for D3–D5. Holds borrowed immutable commit
 * views only; it neither mutates entities nor derives raw replica deltas. */
export function createEffectiveChanges(initial: EffectiveReadView) {
  let current = initial
  let destroyed = false
  let draining = false
  const listeners = new Set<{ notify: (publication: EffectivePublication) => void }>()
  const pending: Array<{ publication: EffectivePublication; targets: Array<{ notify: (publication: EffectivePublication) => void }> }> = []

  function drain(): void {
    if (draining) return
    draining = true
    const errors: unknown[] = []
    try {
      while (!destroyed && pending.length > 0) {
        const { publication, targets } = pending.shift()!
        for (const target of targets) {
          if (destroyed) break
          if (!listeners.has(target)) continue
          try { target.notify(publication) } catch (error) { errors.push(error) }
        }
      }
    } finally {
      draining = false
    }
    if (errors.length > 0) throw new AggregateError(errors, 'Effective-change listener failed')
  }

  return {
    subscribe(notify: (publication: EffectivePublication) => void): () => void {
      if (destroyed) return () => {}
      const target = { notify }
      listeners.add(target)
      // Direct seed delivery also works inside a listener: it includes all
      // already accepted commits; that listener is excluded from queued deltas.
      try { notify({ type: 'replace', reason: 'seed', view: current }) }
      catch (error) { listeners.delete(target); throw error }
      return () => { listeners.delete(target) }
    },
    publish(commit: EffectiveCommit): void {
      if (destroyed) return
      let publication: EffectivePublication
      if (commit.type === 'replace') {
        publication = { type: 'replace', reason: commit.reason, view: commit.view }
      } else {
        const addresses = new Map<ReplicaKind, Set<string>>()
        const rows: EffectiveRowChange[] = []
        for (const { kind, id } of commit.rows) {
          let ids = addresses.get(kind)
          if (!ids) addresses.set(kind, ids = new Set())
          if (ids.has(id)) continue
          ids.add(id)
          rows.push({ kind, id, presence: commit.view.row(kind, id) === undefined ? 'absent' : 'present' })
        }
        publication = { type: 'update', view: commit.view, rows, local: [...new Set(commit.local)] }
      }
      current = commit.view
      pending.push({ publication, targets: [...listeners] })
      drain()
    },
    destroy(): void {
      destroyed = true
      listeners.clear()
      pending.length = 0
    },
  }
}
