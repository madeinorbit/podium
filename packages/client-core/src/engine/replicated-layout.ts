/**
 * Replicated layout command port owned by Actions.
 *
 * POD-403 owns key routing, bootstrap hydration, and legacy migration. This port
 * owns the write half: synchronous reducer optimism over the durable Outbox,
 * terminal rollback when queue membership disappears, and an explicit
 * reconciliation seam for authoritative snapshots.
 */

import {
  isLayoutKey,
  layoutKeyFromLegacy,
  type LayoutSnapshot,
} from '@podium/model'
import type { OutboxEntry } from '../outbox'
import type { StoreNotices } from './types'
import type { EngineOutbox, OutboxKinds } from './wiring'

type LayoutOperation =
  | { readonly kind: 'set'; readonly values: Readonly<Record<string, unknown>> }
  | { readonly kind: 'clear'; readonly keys: readonly string[] }

interface TemporaryOperation {
  readonly token: number
  readonly operation: LayoutOperation
}

function canonicalLayoutKey(key: string): string {
  if (isLayoutKey(key)) return key
  const mapped = layoutKeyFromLegacy(key)
  if (mapped !== null) return mapped
  throw new Error(`'${key}' is not a replicated layout key`)
}

function operationForEntry(
  entry: Pick<OutboxEntry, 'kind' | 'input'>,
): LayoutOperation | null {
  if (entry.kind === 'layoutSet') {
    const input = entry.input as OutboxKinds['layoutSet']
    return { kind: 'set', values: input.values }
  }
  if (entry.kind === 'layoutClear') {
    const input = entry.input as OutboxKinds['layoutClear']
    return { kind: 'clear', keys: input.keys }
  }
  return null
}

export function reduceLayoutSnapshot(
  base: LayoutSnapshot,
  operations: readonly LayoutOperation[],
): LayoutSnapshot {
  const next: LayoutSnapshot = { ...base }
  for (const operation of operations) {
    if (operation.kind === 'set') {
      for (const [key, value] of Object.entries(operation.values)) {
        if (isLayoutKey(key)) next[key] = value
      }
    } else {
      for (const key of operation.keys) delete next[key]
    }
  }
  return next
}

function storedValue(value: unknown): string | null {
  if (value === undefined) return null
  if (typeof value === 'string') return value
  const encoded = JSON.stringify(value)
  return typeof encoded === 'string' ? encoded : null
}

/**
 * Structurally compatible with POD-403's ReplicatedUiStatePort. Keys may be the
 * legacy ui-state spelling or the canonical layout spelling; device-local keys
 * fail closed instead of silently acquiring a server row.
 */
export interface ReplicatedLayoutPort {
  get(key: string): string | null
  set(key: string, value: string | null): void
  subscribe(listener: () => void): () => void
  /** Install a full authoritative snapshot. POD-403 owns when bootstrap,
   * rebind, and rescope call this seam. */
  hydrate(snapshot: LayoutSnapshot): void
}

/** Engine-only lifecycle hooks kept off POD-403's routing surface. */
export interface ReplicatedLayoutController extends ReplicatedLayoutPort {
  outboxChanged(): void
  commandApplied(entry: OutboxEntry): boolean
  commandDropped(entry: OutboxEntry): void
  reconcile(snapshot: LayoutSnapshot, mutationIds: readonly string[]): void
}

export function createReplicatedLayoutController(init: {
  outbox: EngineOutbox
  notices: StoreNotices
}): ReplicatedLayoutController {
  const { outbox, notices } = init
  let base: LayoutSnapshot = {}
  let nextToken = 1
  let temporary: TemporaryOperation[] = []
  const ignoredAwaiting = new Set<string>()
  const listeners = new Set<() => void>()

  const emit = (): void => {
    for (const listener of listeners) listener()
  }

  const durableOperations = (): LayoutOperation[] =>
    [...outbox.awaiting(), ...outbox.pending()]
      .filter((entry) => !ignoredAwaiting.has(entry.mutationId))
      .sort((a, b) => a.queuedAt - b.queuedAt)
      .flatMap((entry) => {
        const operation = operationForEntry(entry)
        return operation === null ? [] : [operation]
      })

  const projection = (): LayoutSnapshot =>
    reduceLayoutSnapshot(base, [
      ...durableOperations(),
      ...temporary.map((entry) => entry.operation),
    ])

  const removeTemporary = (token: number): void => {
    const next = temporary.filter((entry) => entry.token !== token)
    if (next.length === temporary.length) return
    temporary = next
    emit()
  }

  const enqueue = (operation: LayoutOperation): void => {
    const token = nextToken++
    temporary = [...temporary, { token, operation }]
    emit()

    let queued: OutboxEntry | Promise<OutboxEntry>
    try {
      queued =
        operation.kind === 'set'
          ? outbox.enqueue('layoutSet', { values: operation.values })
          : outbox.enqueue('layoutClear', { keys: [...operation.keys] })
    } catch (error) {
      removeTemporary(token)
      throw error
    }

    void Promise.resolve(queued).then(
      () => removeTemporary(token),
      (error) => {
        removeTemporary(token)
        notices.error(
          `Couldn't save replicated layout — ${
            error instanceof Error ? error.message : 'durable queue unavailable'
          }`,
        )
      },
    )
  }

  return {
    get: (key) => storedValue(projection()[canonicalLayoutKey(key)]),
    set: (key, value) => {
      const canonical = canonicalLayoutKey(key)
      if (storedValue(projection()[canonical]) === value) return
      enqueue(
        value === null
          ? { kind: 'clear', keys: [canonical] }
          : { kind: 'set', values: { [canonical]: value } },
      )
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    hydrate: (snapshot) => {
      base = Object.fromEntries(
        Object.entries(snapshot).filter(([key]) => isLayoutKey(key)),
      )
      emit()
    },
    outboxChanged: () => {
      const awaiting = new Set(outbox.awaiting().map((entry) => entry.mutationId))
      for (const mutationId of ignoredAwaiting) {
        if (!awaiting.has(mutationId)) ignoredAwaiting.delete(mutationId)
      }
      emit()
    },
    commandApplied: (entry) => operationForEntry(entry) !== null,
    commandDropped: (entry) => {
      if (operationForEntry(entry) !== null) emit()
    },
    reconcile: (snapshot, mutationIds) => {
      base = Object.fromEntries(
        Object.entries(snapshot).filter(([key]) => isLayoutKey(key)),
      )
      for (const mutationId of mutationIds) {
        ignoredAwaiting.add(mutationId)
        outbox.retireAwaiting(mutationId)
      }
      emit()
    },
  }
}

