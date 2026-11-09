/** Historical test reference. Product layout reads the pool userLayout model. */
/**
 * Replicated layout command port owned by Actions.
 *
 * POD-403 owns key routing and legacy migration. This port owns the write half:
 * synchronous paint over the durable Outbox.
 *
 * A key's value is the replica's base, then every layout entry still in the
 * outbox (pending and applied, in `queuedAt` order), then temporary paint for an
 * enqueue that has not reached the outbox yet. A layout entry is a generic
 * record write of one key (`records.userLayout.edit` / `.remove`, ADR 12 D3,
 * POD-6404): the edit's value is the paint. Nothing here holds, ignores or
 * refetches. An applied entry stays in the outbox until the replica commits the
 * truth that covers it, and leaves in that same commit (ADR 12, POD-6277), so
 * its paint ends exactly when that truth is installed. A refused entry leaves
 * the outbox, and its paint goes with it.
 */

import {
  isLayoutKey,
  type LayoutSnapshot,
  layoutKeyFromLegacy,
  layoutRowId,
  parseLayoutRowId,
  type UserId,
} from '@podium/model'
import type { StoreNotices } from '../src/engine/types'
import type { EngineOutbox } from '../src/engine/wiring'
import type { OutboxEntry } from '../src/outbox'
import type { RecordEditEntry, RecordRemoveEntry } from '../src/records'

type LayoutOperation =
  | { readonly kind: 'set'; readonly values: Readonly<Record<string, unknown>> }
  | { readonly kind: 'clear'; readonly keys: readonly string[] }

interface TemporaryOperation {
  readonly token: number
  readonly operation: LayoutOperation
}

function onlyLayoutKeys(snapshot: LayoutSnapshot): LayoutSnapshot {
  return Object.fromEntries(Object.entries(snapshot).filter(([key]) => isLayoutKey(key)))
}

function canonicalLayoutKey(key: string): string {
  if (isLayoutKey(key)) return key
  const mapped = layoutKeyFromLegacy(key)
  if (mapped !== null) return mapped
  throw new Error(`'${key}' is not a replicated layout key`)
}

function layoutKeyOf(id: string): string | null {
  try {
    return parseLayoutRowId(id).key
  } catch {
    return null
  }
}

function operationForEntry(entry: Pick<OutboxEntry, 'kind' | 'input'>): LayoutOperation | null {
  const record = entry.input as Partial<RecordEditEntry & RecordRemoveEntry> | undefined
  if (
    (entry.kind === 'recordEdit' || entry.kind === 'recordRemove') &&
    record?.kind === 'userLayout' &&
    typeof record.id === 'string'
  ) {
    const key = layoutKeyOf(record.id)
    if (key === null) return null
    if (entry.kind === 'recordRemove' || (record.unset ?? []).includes('value')) {
      return { kind: 'clear', keys: [key] }
    }
    return { kind: 'set', values: { [key]: record.patch?.value } }
  }
  // LEGACY(remove-after: 2027-03): `layoutSet` / `layoutClear` entries an older
  // build queued still paint until they retire (POD-6404).
  if (entry.kind === 'layoutSet') {
    return { kind: 'set', values: (entry.input as { values: Record<string, unknown> }).values }
  }
  if (entry.kind === 'layoutClear') {
    return { kind: 'clear', keys: (entry.input as { keys: string[] }).keys }
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

/**
 * Structurally compatible with POD-403's ReplicatedUiStatePort. Keys may be the
 * legacy ui-state spelling or the canonical layout spelling; device-local keys
 * fail closed instead of silently acquiring a server row.
 */
export interface ReplicatedLayoutPort {
  get(key: string): unknown
  set(key: string, value: unknown): void
  clear(key: string): void
  subscribe(listener: (keys: ReadonlySet<string>) => void): () => void
  /** Resolves at once. The base is the replica's rows, seeded at construction
   * and replaced as the replica commits, so there is nothing to fetch. On a
   * cold device the shell does not mount until the first bootstrap installs. */
  hydrate(): Promise<void>
  /** Install the replica's committed rows as the base. */
  replace(snapshot: LayoutSnapshot): void
}

/** Engine-only lifecycle hooks kept off POD-403's routing surface. */
export interface ReplicatedLayoutController extends ReplicatedLayoutPort {
  /** The outbox changed: an entry was queued, applied, retired or refused. */
  outboxChanged(): void
}

export function createReplicatedLayoutController(init: {
  outbox: EngineOutbox
  notices: StoreNotices
  /** Whose layout rows these are: a key's record id names its user. */
  userId: UserId
  /**
   * The persisted base this client last installed, read from the replica at
   * construction (POD-571).
   *
   * Without it `base` starts empty and stays empty until the replica commits, so
   * the shell mounts its DEFAULT branch first — an expanded sidebar, an open
   * Flight Deck — and swaps once the rows land. This is the same
   * hydrate-first rule the runtime already applies to the entity slices; layout
   * is the one slice that never got it, and it is the slice that decides what
   * mounts.
   */
  seed?: LayoutSnapshot
}): ReplicatedLayoutController {
  const { outbox, notices } = init
  let base: LayoutSnapshot = onlyLayoutKeys(init.seed ?? {})
  let nextToken = 1
  let temporary: TemporaryOperation[] = []
  const listeners = new Set<(keys: ReadonlySet<string>) => void>()
  let notified: LayoutSnapshot = { ...base }

  const emit = (candidates?: Iterable<string>): void => {
    const changed = new Set<string>()
    if (candidates !== undefined) {
      // A local operation/queue change identifies its keys. Neither reading
      // nor signalling one key copies the full persisted layout namespace.
      const operations = currentOperations()
      for (const key of candidates) {
        const next = valueAt(key, operations)
        if (!Object.is(notified[key], next)) changed.add(key)
        if (next === undefined) delete notified[key]
        else notified[key] = next
      }
    } else {
      // An authoritative replacement delivers the full namespace.
      const next = projection()
      for (const key of new Set([...Object.keys(notified), ...Object.keys(next)])) {
        if (!Object.is(notified[key], next[key])) changed.add(key)
      }
      notified = next
    }
    for (const listener of listeners) listener(changed)
  }

  const layoutEntries = (): OutboxEntry[] =>
    [...outbox.awaiting(), ...outbox.pending()].filter((entry) => operationForEntry(entry) !== null)

  const keysOf = (operation: LayoutOperation): readonly string[] =>
    operation.kind === 'set' ? Object.keys(operation.values) : operation.keys
  const outboxKeys = (): Set<string> =>
    new Set(layoutEntries().flatMap((entry) => keysOf(operationForEntry(entry)!)))
  let previousOutboxKeys = outboxKeys()

  const durableOperations = (): LayoutOperation[] =>
    layoutEntries()
      .sort((a, b) => a.queuedAt - b.queuedAt)
      .flatMap((entry) => {
        const operation = operationForEntry(entry)
        return operation === null ? [] : [operation]
      })

  const currentOperations = (): readonly LayoutOperation[] => [
    ...durableOperations(),
    ...temporary.map((entry) => entry.operation),
  ]
  const projection = (): LayoutSnapshot => reduceLayoutSnapshot(base, currentOperations())
  const valueAt = (key: string, operations = currentOperations()): unknown => {
    let value = base[key]
    for (const operation of operations) {
      if (operation.kind === 'set') {
        if (Object.hasOwn(operation.values, key)) value = operation.values[key]
      } else if (operation.keys.includes(key)) value = undefined
    }
    return value
  }

  const removeTemporary = (token: number): void => {
    const removed = temporary.find((entry) => entry.token === token)
    const next = temporary.filter((entry) => entry.token !== token)
    if (next.length === temporary.length) return
    temporary = next
    emit(removed ? keysOf(removed.operation) : [])
  }

  const enqueue = (operation: LayoutOperation): void => {
    // Layout is non-optimistic for pool rows. This controller owns only the
    // temporary paint until the entry is durable; from then on the entry itself
    // paints, and the ordinary durable outbox is the only queue (POD-5426 §5).
    const token = nextToken++
    temporary = [...temporary, { token, operation }]
    emit(keysOf(operation))

    // One key per operation (`set` and `clear` below), one record write each.
    let queued: OutboxEntry | Promise<OutboxEntry>
    try {
      const [key] = keysOf(operation)
      if (key === undefined) {
        removeTemporary(token)
        return
      }
      const id = layoutRowId(init.userId, key)
      queued =
        operation.kind === 'set'
          ? outbox.enqueue('recordEdit', {
              kind: 'userLayout',
              id,
              patch: { value: operation.values[key] },
            })
          : outbox.enqueue('recordRemove', { kind: 'userLayout', id })
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
    get: (key) => valueAt(canonicalLayoutKey(key)),
    set: (key, value) => {
      const canonical = canonicalLayoutKey(key)
      if (Object.is(valueAt(canonical), value)) return
      enqueue({ kind: 'set', values: { [canonical]: value } })
    },
    clear: (key) => {
      const canonical = canonicalLayoutKey(key)
      if (valueAt(canonical) === undefined) return
      enqueue({ kind: 'clear', keys: [canonical] })
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    hydrate: async () => {},
    replace: (snapshot) => {
      base = onlyLayoutKeys(snapshot)
      emit()
    },
    outboxChanged: () => {
      const nextKeys = outboxKeys()
      emit(new Set([...previousOutboxKeys, ...nextKeys]))
      previousOutboxKeys = nextKeys
    },
  }
}
