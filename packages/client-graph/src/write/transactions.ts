import { randomUUID } from '@podium/client-core/id'
import { type PoolSpawnPorts, PoolSpawns } from './spawns'
/** PoolTransactions owns client optimism and spawn placeholders over one outbox.
 * A press reduces and paints inside one MobX action before the durable enqueue.
 * Refusal rebases from truth and the remaining commands; no previous visible
 * row is saved. The log adopts other tabs' queue edits and restores queued and
 * awaiting writes on boot, including offline hydration.
 *
 * An applied write paints exactly as long as its outbox entry is awaiting
 * confirmation: the overlays derive from `outbox.awaiting()` and drop when the
 * replica's confirmation retires the entry (ADR 12). No row check, value
 * comparison or timer retires one. Eviction and rescope preserve pending work
 * for readmission. Each log belongs to one principal and releases its spawn
 * waiters and row indexes on disposal.
 */

import type { OverlayTarget, PendingOverlay } from '@podium/client-core/command-reducers'
import { overlaysForOutboxEntry } from '@podium/client-core/command-reducers'
import type {
  EngineOutbox,
  OutboxKinds,
  OutboxOutcome,
  SpawnPlaceholderEvent,
} from '@podium/client-core/engine'
import type { OutboxDeadLetterEntry, OutboxEntry } from '@podium/client-core/outbox'
import type { ReplicaAddressedBatch } from '@podium/client-core/replica'
import { asMutationId, type MutationId } from '@podium/model'
import { type ObservableMap, observable, runInAction } from 'mobx'
import { debugName } from '../debug-name'
import type { PendingRows, PooledPending, RowSourceRepaint } from '../shared/row-source'

type InsertOverlay = Extract<PendingOverlay, { op: 'insert' }>
type AnyKind = keyof OutboxKinds & string
type PoolRow = { readonly kind: 'session' | 'issue'; readonly id: string }

/** An applied change whose outbox entry still awaits confirmation. */
interface Awaiting {
  readonly mutationId: MutationId
  /** The entry's input the overlays were reduced from. */
  readonly input: unknown
  /** Patches, and a generic record write's insert or removal (POD-6392). */
  readonly overlays: readonly PendingOverlay[]
}

const TARGETS: readonly OverlayTarget[] = [
  'sessions',
  'sessionUserStates',
  'issueProjections',
  'issueUserStates',
]

/** One transaction: an outbox record, or a change painted ahead of it. */
interface Transaction {
  readonly mutationId: MutationId
  readonly kind: string
  /** The input the overlays were reduced from; a recovery-surface edit
   *  replaces the record's input object, and the overlays follow it. */
  input: unknown
  overlays: readonly PendingOverlay[]
  /** Its index in the outbox's pending list; undefined until the queue holds it. */
  position: number | undefined
  /** Painted before the durable commit, which has not settled yet. */
  unqueued: boolean
  /** Press order, for changes the queue does not hold yet. */
  readonly seq: number
}

/** A refused or failed change, after its models rebased. */
export interface PoolRejection {
  readonly mutationId: MutationId
  readonly kind: string
  readonly input: unknown
  /** Parked for recovery (authored text) rather than discarded. */
  readonly parked: boolean
  readonly reason?: unknown
  /** The enqueue itself failed; the queue never held it. */
  readonly error?: unknown
}

export interface PoolTransactionsPorts {
  readonly spawn?: Omit<PoolSpawnPorts, 'truth' | 'pending' | 'paint'>
  /** The principal whose per-user rows the log paints. */
  readonly userId: string
  readonly outbox: Pick<EngineOutbox, 'pending' | 'awaiting' | 'subscribe' | 'deadLetters'>
  /** Applied, refused and superseded answers by mutation id. */
  readonly outcomes: (listener: (outcome: OutboxOutcome) => void) => () => void
  /** The outbox's single enqueue path, under the log's id and press clock. */
  readonly enqueue: <K extends AnyKind>(
    kind: K,
    input: OutboxKinds[K],
    opts: { mutationId: MutationId; queuedAt: number },
  ) => Promise<void>
  /** Kernel batches by row: when truth lands, settlement runs. */
  readonly addressed: (listener: (batch: ReplicaAddressedBatch) => void) => () => void
  readonly now?: () => number
  readonly mintId?: () => MutationId
  /** The shared command reducer. Only a test replaces it, to plant a wrong
   *  one and prove the differential check against an independent log fails. */
  readonly reduce?: typeof overlaysForOutboxEntry
}

export interface PoolTransactions {
  spawnDraftAgent: PoolSpawns['spawnDraftAgent']
  spawnIssueAgent: PoolSpawns['spawnIssueAgent']
  waitForSpawnConfirmed: PoolSpawns['waitForSpawnConfirmed']
  /** What the row source reads in `pooled` mode. */
  readonly pending: PooledPending
  /** Attach the row source the log repaints through; settles the boot state. */
  bind(source: RowSourceRepaint): void
  /** One change: reduce, record, repaint, enqueue. Returns its mutation id. */
  mutate<K extends AnyKind>(kind: K, input: OutboxKinds[K]): MutationId
  /** The same change for the runtime's actions (`PoolWriter`, POD-5432):
   *  settles with the durable enqueue and rejects when it fails. */
  write<K extends AnyKind>(kind: K, input: OutboxKinds[K]): Promise<void>
  /** Fires after a refused or failed change's models rebased. */
  onRejected(listener: (rejection: PoolRejection) => void): () => void
  /** TRACKED, keyed by row: a refused or expired record is parked for recovery.
   * Reads only the outbox index, never the target or the legacy snapshot. */
  notSaved(kind: PoolRow['kind'], id: string): boolean
  /** TRACKED: sessions painted as spawn placeholders, and their first turns. */
  readonly spawnPrompts: ReadonlyMap<string, string | null>
  /** Transactions in the log, painted or queued (tests and meters). */
  size(): number
  dispose(): void
}

function poolRowOf(o: PendingOverlay): PoolRow {
  return {
    kind: o.entity === 'sessions' || o.entity === 'sessionUserStates' ? 'session' : 'issue',
    id: o.id,
  }
}

function rowsOf(overlays: Iterable<PendingOverlay>, into: Map<string, PoolRow> = new Map()) {
  for (const o of overlays) {
    const row = poolRowOf(o)
    into.set(`${row.kind}:${row.id}`, row)
  }
  return into
}

/** The pool row a kernel address names, for the target kinds only. */
function poolRowOfAddress(kind: string, id: string): string | undefined {
  switch (kind) {
    case 'sessions':
      return `session:${id}`
    case 'issueProjections':
      return `issue:${id}`
    case 'sessionUserStates':
      return `session:${id.slice(id.lastIndexOf(':') + 1)}`
    case 'issueUserStates':
      return `issue:${id.slice(id.lastIndexOf(':') + 1)}`
    default:
      return undefined
  }
}

export function createPoolTransactions(ports: PoolTransactionsPorts): PoolTransactions {
  // Stamps a press; no derivation reads it.
  const now = ports.now ?? (() => Date.now())
  // Not `crypto.randomUUID`: a browser on plain-HTTP LAN origins has none, and this
  // default minter ran on every UI write there (POD-5931).
  const mintId = ports.mintId ?? (() => asMutationId(randomUUID()))
  const reduceWith = ports.reduce ?? overlaysForOutboxEntry
  const viewer = { userId: ports.userId }
  const reduce = (entry: Parameters<typeof overlaysForOutboxEntry>[0]) => reduceWith(entry, viewer)

  let source: RowSourceRepaint | null = null
  let disposed = false
  let seq = 0

  const txns = new Map<MutationId, Transaction>()
  /** Transactions by the target row each of their changes lands on. */
  const byRow: Record<OverlayTarget, Map<string, Set<Transaction>>> = {
    sessions: new Map(),
    sessionUserStates: new Map(),
    issueProjections: new Map(),
    issueUserStates: new Map(),
  }
  /** Applied, awaiting confirmation: a mirror of `outbox.awaiting()`, in its order. */
  let awaiting: Awaiting[] = []
  /** Adopted spawn placeholders. */
  let spawns: InsertOverlay[] = []
  /** Ids the outbox answered while the queue may still list them. */
  const settled = new Set<MutationId>()
  const spawnPrompts: ObservableMap<string, string | null> = observable.map(undefined, {
    deep: false,
    name: debugName(() => 'transactions.spawnPrompts'),
  })
  const notSavedRows = observable.map<string, number>(undefined, {
    deep: false,
    name: debugName(() => 'transactions.notSaved'),
  })
  const parked = new Map<
    MutationId,
    {
      entry: OutboxEntry
      rows: ReadonlyMap<string, PoolRow>
    }
  >()

  /** An index of the durable parked records, including boot, expiry and recovery.
   * Keep row slots stable when unrelated queue entries change. Multiple refusals
   * on one row keep its mark until the last one leaves recovery. */
  function reconcileParked(): void {
    const records: readonly OutboxDeadLetterEntry[] = ports.outbox.deadLetters()
    const seen = new Set<MutationId>()
    const removeParked = (id: MutationId): void => {
      const previous = parked.get(id)
      if (!previous) return
      for (const key of previous.rows.keys()) {
        const count = notSavedRows.get(key)! - 1
        if (count) notSavedRows.set(key, count)
        else notSavedRows.delete(key)
      }
      parked.delete(id)
    }
    for (const { entry } of records) {
      seen.add(entry.mutationId)
      const previous = parked.get(entry.mutationId)
      if (previous?.entry.kind === entry.kind && previous.entry.input === entry.input) continue
      removeParked(entry.mutationId)
      const rows = rowsOf(reduce(entry))
      // Sending text paints no model, but a refused send belongs to its session.
      if (entry.kind === 'sendText') {
        const { sessionId } = entry.input as OutboxKinds['sendText']
        rows.set(`session:${sessionId}`, { kind: 'session', id: sessionId })
      }
      parked.set(entry.mutationId, { entry, rows })
      for (const key of rows.keys()) notSavedRows.set(key, (notSavedRows.get(key) ?? 0) + 1)
    }
    for (const id of parked.keys()) if (!seen.has(id)) removeParked(id)
  }
  const rejected = new Set<(rejection: PoolRejection) => void>()
  const offs: (() => void)[] = []

  // ---------------------------------------------------------------- index

  function index(t: Transaction): void {
    for (const o of t.overlays) {
      let set = byRow[o.entity].get(o.id)
      if (set === undefined) {
        set = new Set()
        byRow[o.entity].set(o.id, set)
      }
      set.add(t)
    }
  }

  function unindex(t: Transaction): void {
    for (const o of t.overlays) {
      const set = byRow[o.entity].get(o.id)
      if (set === undefined) continue
      set.delete(t)
      if (set.size === 0) byRow[o.entity].delete(o.id)
    }
  }

  function add(t: Transaction): void {
    txns.set(t.mutationId, t)
    index(t)
  }

  function remove(t: Transaction): void {
    if (txns.get(t.mutationId) !== t) return
    txns.delete(t.mutationId)
    unindex(t)
  }

  function reproject(t: Transaction, entry: OutboxEntry): void {
    unindex(t)
    t.overlays = reduce(entry)
    t.input = entry.input
    index(t)
  }

  // ---------------------------------------------------------------- reads

  function truth(entity: OverlayTarget, id: string): Record<string, unknown> | undefined {
    return source?.truth(entity, id) as Record<string, unknown> | undefined
  }

  /** What an absent per-user row means while its entity is in the slice: the
   *  null markers the server deletes the row for (the log's rule). */
  function absentRow(entity: OverlayTarget, id: string): object | undefined {
    if (entity === 'issueUserStates') {
      const known =
        truth('issueProjections', id) !== undefined ||
        spawns.some((o) => o.entity === 'issueProjections' && o.id === id)
      return known
        ? { userId: ports.userId, entityId: id, readAt: null, tuckedAt: null, pinned: false }
        : undefined
    }
    if (entity === 'sessionUserStates') {
      const known =
        truth('sessions', id) !== undefined ||
        spawns.some((o) => o.entity === 'sessions' && o.id === id)
      return known ? { userId: ports.userId, sessionId: id, readAt: null } : undefined
    }
    return undefined
  }

  function decorate(o: PendingOverlay): PendingOverlay {
    if (o.op !== 'patch') return o
    const absent = absentRow(o.entity, o.id)
    return absent === undefined ? o : { ...o, absent }
  }

  /** One row's changes in the log's fold order: spawn inserts, awaiting
   *  confirmation, queued in queue order, then painted ahead of the queue. */
  function listFor(entity: OverlayTarget, id: string): PendingOverlay[] {
    const out: PendingOverlay[] = []
    for (const o of spawns) if (o.entity === entity && o.id === id) out.push(o)
    for (const a of awaiting) {
      for (const o of a.overlays) if (o.entity === entity && o.id === id) out.push(decorate(o))
    }
    const set = byRow[entity].get(id)
    if (set !== undefined) {
      const live = [...set].filter((t) => t.position !== undefined || t.unqueued)
      live.sort((a, b) =>
        a.position !== undefined && b.position !== undefined
          ? a.position - b.position
          : a.position !== undefined
            ? -1
            : b.position !== undefined
              ? 1
              : a.seq - b.seq,
      )
      for (const t of live) {
        for (const o of t.overlays) if (o.entity === entity && o.id === id) out.push(decorate(o))
      }
    }
    return out
  }

  function rowIds(entity: OverlayTarget): Set<string> {
    const ids = new Set(byRow[entity].keys())
    for (const o of spawns) if (o.entity === entity) ids.add(o.id)
    for (const a of awaiting) for (const o of a.overlays) if (o.entity === entity) ids.add(o.id)
    return ids
  }

  function view(entity: OverlayTarget): PendingRows {
    return {
      get: (id) => {
        const list = listFor(entity, id)
        return list.length === 0 ? undefined : list
      },
      has: (id) =>
        byRow[entity].has(id) ||
        spawns.some((o) => o.entity === entity && o.id === id) ||
        awaiting.some((a) => a.overlays.some((o) => o.entity === entity && o.id === id)),
      keys: () => rowIds(entity),
    }
  }

  const views = Object.fromEntries(TARGETS.map((t) => [t, view(t)])) as Record<
    OverlayTarget,
    PendingRows
  >
  const pending: PooledPending = { byRow: (entity) => views[entity] }

  // ---------------------------------------------------------------- repaint

  function commit(rows: Map<string, PoolRow>): void {
    if (source === null || rows.size === 0) return
    source.repaint(rows.values())
  }

  // ---------------------------------------------------------------- settlement

  /** Retire spawn placeholders whose server row landed. Returns the rows
   *  that moved. A placeholder is not an outbox entry; a row with its
   *  client-minted id is exact evidence. */
  function settle(): Map<string, PoolRow> {
    const touched = new Map<string, PoolRow>()
    if (spawns.length > 0 && source !== null) {
      const kept = spawns.filter((o) => {
        if (o.entity === 'issueUserStates') {
          return spawns.some(
            (p) =>
              p.entity === 'issueProjections' &&
              p.id === o.id &&
              truth('issueProjections', p.id) === undefined,
          )
        }
        if (o.entity === 'sessionUserStates') {
          return spawns.some(
            (p) =>
              p.entity === 'sessions' && p.id === o.id && truth('sessions', p.id) === undefined,
          )
        }
        return truth(o.entity, o.id) === undefined
      })
      if (kept.length !== spawns.length) {
        rowsOf(
          spawns.filter((o) => !kept.includes(o)),
          touched,
        )
        spawns = kept
        for (const id of [...spawnPrompts.keys()]) {
          if (!spawns.some((o) => o.entity === 'sessions' && o.id === id)) spawnPrompts.delete(id)
        }
      }
    }
    spawnOwner?.confirmed()
    return touched
  }

  // ---------------------------------------------------------------- outbox

  /** Mirror `outbox.awaiting()`: adopt applied entries this log has not seen
   *  (boot, another tab), drop those the replica's confirmation retired. */
  function reconcileAwaiting(touched: Map<string, PoolRow>): void {
    const known = new Map(awaiting.map((a) => [a.mutationId, a]))
    const next: Awaiting[] = []
    for (const entry of ports.outbox.awaiting()) {
      const previous = known.get(entry.mutationId)
      known.delete(entry.mutationId)
      if (previous !== undefined && previous.input === entry.input) {
        next.push(previous)
        continue
      }
      if (previous !== undefined) rowsOf(previous.overlays, touched)
      const a = awaitingOf(entry)
      rowsOf(a.overlays, touched)
      next.push(a)
    }
    for (const gone of known.values()) rowsOf(gone.overlays, touched)
    // A re-order changes a composition only where two changes share a row.
    const kept = next.filter((a) => awaiting.includes(a))
    const before = awaiting.filter((a) => kept.includes(a))
    if (kept.some((a, i) => before[i] !== a)) for (const a of kept) rowsOf(a.overlays, touched)
    awaiting = next
  }

  function awaitingOf(entry: OutboxEntry, overlays?: readonly PendingOverlay[]): Awaiting {
    return {
      mutationId: entry.mutationId,
      input: entry.input,
      // Everything the entry paints. A spawn placeholder is never an entry's
      // overlay, so an insert here is a record create's, retired with it.
      overlays: overlays ?? reduce(entry),
    }
  }

  /** Follow the queue: adopt records this log did not author, follow edits
   *  and order, drop records the queue no longer holds. Returns moved rows. */
  function reconcile(): Map<string, PoolRow> {
    const touched = new Map<string, PoolRow>()
    reconcileAwaiting(touched)
    const entries = ports.outbox.pending()
    const seen = new Set<MutationId>()
    const before = [...txns.values()].filter((t) => t.position !== undefined)
    before.sort((a, b) => a.position! - b.position!)
    entries.forEach((entry, i) => {
      seen.add(entry.mutationId)
      const known = txns.get(entry.mutationId)
      if (known === undefined) {
        if (settled.has(entry.mutationId)) return
        const t: Transaction = {
          mutationId: entry.mutationId,
          kind: entry.kind,
          input: entry.input,
          overlays: reduce(entry),
          position: i,
          unqueued: false,
          seq: ++seq,
        }
        add(t)
        rowsOf(t.overlays, touched)
        return
      }
      if (known.input !== entry.input) {
        rowsOf(known.overlays, touched)
        reproject(known, entry)
        rowsOf(known.overlays, touched)
      }
      if (known.position === undefined) rowsOf(known.overlays, touched)
      known.position = i
    })
    for (const t of [...txns.values()]) {
      if (seen.has(t.mutationId)) continue
      if (t.position === undefined && t.unqueued) continue
      remove(t)
      rowsOf(t.overlays, touched)
    }
    for (const id of settled) if (!seen.has(id)) settled.delete(id)
    // A re-order changes a composition only where two changes share a row.
    const survivors = before.filter((t) => txns.get(t.mutationId) === t)
    const reordered = [...survivors].sort((a, b) => a.position! - b.position!)
    if (survivors.some((t, i) => reordered[i] !== t)) {
      for (const entity of TARGETS) {
        for (const [id, set] of byRow[entity]) {
          if (set.size < 2) continue
          const kind = entity === 'sessions' || entity === 'sessionUserStates' ? 'session' : 'issue'
          touched.set(`${kind}:${id}`, { kind, id })
        }
      }
    }
    return touched
  }

  /** The reply came back: the change moves from the queue to awaiting
   *  confirmation, unchanged. Its entry's retirement drops it (`reconcile`). */
  function onApplied(entry: OutboxEntry): void {
    settled.add(entry.mutationId)
    const touched = new Map<string, PoolRow>()
    const t = txns.get(entry.mutationId)
    if (t !== undefined) {
      remove(t)
      rowsOf(t.overlays, touched)
    }
    if (!awaiting.some((a) => a.mutationId === entry.mutationId)) {
      const a = awaitingOf(
        entry,
        t !== undefined && t.input === entry.input ? t.overlays : undefined,
      )
      awaiting = [...awaiting, a]
      rowsOf(a.overlays, touched)
    }
    commit(touched)
  }

  /** A definitive refusal: the change leaves the log and its models rebase
   *  (§4.8). The queue's own change notice may have dropped it already (the
   *  record left the pending list first); the refusal is announced either way.
   *  Returns the rejection to announce once the action closed. */
  function onRefused(entry: OutboxEntry, parked: boolean, reason: unknown): PoolRejection {
    settled.add(entry.mutationId)
    const t = txns.get(entry.mutationId)
    if (t !== undefined) {
      remove(t)
      commit(rowsOf(t.overlays))
    }
    return {
      mutationId: entry.mutationId,
      kind: entry.kind,
      input: entry.input,
      parked,
      ...(reason === undefined ? {} : { reason }),
    }
  }

  function announce(rejection: PoolRejection): void {
    for (const listener of [...rejected]) {
      try {
        listener(rejection)
      } catch {
        // A listener never stops the rest, nor the outbox that called us.
      }
    }
  }

  function onSpawn(event: SpawnPlaceholderEvent): void {
    if (event.type === 'painted') {
      spawns = [...spawns, ...(event.overlays as InsertOverlay[])]
      spawnPrompts.set(event.sessionId, event.prompt ?? null)
      commit(rowsOf(event.overlays))
      return
    }
    const ids = new Set(event.ids)
    const gone = spawns.filter((o) => ids.has(o.id))
    if (gone.length === 0) return
    spawns = spawns.filter((o) => !ids.has(o.id))
    for (const id of ids) spawnPrompts.delete(id)
    commit(rowsOf(gone))
  }

  const spawnOwner = ports.spawn
    ? new PoolSpawns({
        ...ports.spawn,
        truth,
        pending: (id) => spawnPrompts.has(id),
        paint: (event) =>
          runInAction(() => {
            onSpawn(event)
            spawnOwner?.confirmed()
          }),
      })
    : null

  // ---------------------------------------------------------------- boot

  // Awaiting confirmation first, in outbox order; then the queue.
  reconcile()
  runInAction(reconcileParked)
  offs.push(
    ports.outbox.subscribe(() => {
      if (!disposed)
        runInAction(() => {
          reconcileParked()
          commit(new Map([...reconcile(), ...settle()]))
        })
    }),
    ports.outcomes((outcome) => {
      if (disposed) return
      let refusal: PoolRejection | null = null
      runInAction(() => {
        reconcileParked()
        if (outcome.type === 'applied') onApplied(outcome.entry)
        else if (outcome.type === 'rejected') {
          refusal = onRefused(outcome.entry, outcome.parked, outcome.reason)
        }
        // A supersede leaves the queue without an answer: the next reconcile
        // drops it, and its successor carries the value.
      })
      // After the rebase, never inside it (§4.8).
      if (refusal !== null) announce(refusal)
    }),
    ports.addressed((batch) => {
      if (disposed) return
      runInAction(() => {
        const touched = settle()
        // Rows this batch names are re-read by the row source's own flush.
        if (batch.type === 'update') {
          for (const row of batch.rows) {
            const key = poolRowOfAddress(row.kind, row.id)
            if (key !== undefined) touched.delete(key)
          }
          commit(touched)
        }
      })
    }),
  )
  /** One change: reduce, record, repaint, enqueue (§4.2). */
  function begin<K extends AnyKind>(
    kind: K,
    input: OutboxKinds[K],
  ): { mutationId: MutationId; committed: Promise<void> } {
    if (disposed) throw new Error('PoolTransactions: mutate after dispose')
    const mutationId = mintId()
    const queuedAt = now()
    let t!: Transaction
    runInAction(() => {
      const overlays = reduce({ mutationId, kind, input, queuedAt })
      t = { mutationId, kind, input, overlays, position: undefined, unqueued: true, seq: ++seq }
      add(t)
      commit(rowsOf(overlays))
    })
    const committed = ports.enqueue(kind, input, { mutationId, queuedAt })
    committed.then(
      () => {
        if (disposed || txns.get(mutationId) !== t) return
        t.unqueued = false
        // Committed, and the queue already let it go (applied or dropped
        // before this settled): nothing carries the paint any more.
        if (t.position === undefined) {
          runInAction(() => {
            remove(t)
            commit(rowsOf(t.overlays))
          })
        }
      },
      (error: unknown) => {
        if (disposed || txns.get(mutationId) !== t) return
        t.unqueued = false
        runInAction(() => {
          if (t.position !== undefined) {
            // The record reached the queue before the throw: it still owes an
            // answer, and paints as the queue holds it.
            const entry = ports.outbox.pending().find((e) => e.mutationId === mutationId)
            if (entry !== undefined) {
              const rows = rowsOf(t.overlays)
              reproject(t, entry)
              commit(rowsOf(t.overlays, rows))
            }
            return
          }
          remove(t)
          commit(rowsOf(t.overlays))
        })
        if (t.position === undefined) {
          announce({ mutationId, kind, input, parked: false, error })
        }
      },
    )
    return { mutationId, committed }
  }

  return {
    pending,
    spawnDraftAgent: (args) => {
      if (!spawnOwner) throw new Error('Pool spawn transport is not attached')
      return spawnOwner.spawnDraftAgent(args)
    },
    spawnIssueAgent: (args) => {
      if (!spawnOwner) throw new Error('Pool spawn transport is not attached')
      return spawnOwner.spawnIssueAgent(args)
    },
    waitForSpawnConfirmed: (id) => spawnOwner?.waitForSpawnConfirmed(id) ?? Promise.resolve(),
    spawnPrompts,
    notSaved: (kind, id) => notSavedRows.has(`${kind}:${id}`),

    bind(next) {
      source = next
      runInAction(() => commit(settle()))
    },

    mutate(kind, input) {
      return begin(kind, input).mutationId
    },

    write(kind, input) {
      return begin(kind, input).committed
    },

    onRejected(listener) {
      rejected.add(listener)
      return () => {
        rejected.delete(listener)
      }
    },

    size: () => txns.size,

    dispose() {
      if (disposed) return
      disposed = true
      spawnOwner?.dispose()
      for (const off of offs.splice(0)) off()
      txns.clear()
      for (const entity of TARGETS) byRow[entity].clear()
      awaiting = []
      spawns = []
      settled.clear()
      rejected.clear()
      source = null
      parked.clear()
      runInAction(() => {
        spawnPrompts.clear()
        notSavedRows.clear()
      })
    },
  }
}
