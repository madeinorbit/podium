import type { MetadataChange, MetadataEntityKind, ServerMessage } from '@podium/protocol'
import { type Ledger, MetadataOplog } from '@podium/sync'
import type { SessionStore } from '../store'
import type { EventBus } from './bus'

export interface WriteFunnelDeps {
  store: SessionStore
  now(): number
  bus: EventBus
  /** WS fan-out (modules/sessions owns the client set): full-list snapshot to
   *  legacy clients, `metadataDelta` to delta-cap clients. */
  fanOut(
    snapshot: ServerMessage,
    changes: MetadataChange[],
    opts?: { snapshotToCapClients?: boolean },
  ): void
  /** The write-seam change log ([spec:SP-3fe2] #255). When present, the funnel
   *  bridges its appends onto the bus so 'oplog.appended' keeps firing for
   *  EVERY durable change regardless of which seam captured it (the ledger
   *  owns issues; the legacy oplog still owns sessions/conversations). */
  ledger?: Pick<Ledger, 'onAppended'>
}

/** One publishable state change: the oplog rows for an entity kind plus the
 *  legacy snapshot message that carries the same truth. */
export interface PublishSpec {
  entity: MetadataEntityKind
  rows: { id: string; value: unknown }[]
  snapshot: ServerMessage
  /** Partial upsert (e.g. single-issue update, #22): absence of the other rows
   *  must not read as deletion. */
  partial?: boolean
  /** Rare: force the snapshot to delta-cap clients too (diagnostics changes). */
  snapshotToCapClients?: boolean
}

/**
 * THE single write funnel (issue #13 Phase 2 step 3): every mutation flows
 * authorize → repository write → oplog append → broadcast (bus + WS), in that
 * order and nowhere else. The funnel owns the durable metadata oplog; the
 * broadcast pipelines of every entity kind (sessions, issues, conversations)
 * end in {@link publish}, so "durable before fan-out" (oplog-read-path §2.5)
 * holds by construction rather than by convention at each call site.
 *
 * Callers with all four stages in hand use {@link run}; pipelines whose repo
 * write happened upstream (the coalesced session broadcast) enter at the
 * {@link publish} tail.
 *
 * ISSUES are the exception ([spec:SP-3fe2] #255): their changes are captured
 * at the WRITE seam by the injected {@link Ledger} (atomic with the entity
 * write), so their fan-outs enter at {@link publishComputed} — the oplog half
 * of {@link publish}/{@link record} REJECTS issue specs (see the guard in
 * record) to keep the change log single-writer per entity kind.
 */
export class WriteFunnel {
  private readonly oplog: MetadataOplog

  constructor(private readonly deps: WriteFunnelDeps) {
    this.oplog = new MetadataOplog(deps.store.sync, deps.now)
    // Ledger-appended changes (issue commits/reconciles, #255) fire the same
    // bus event the legacy record() path does, so bus consumers see one
    // unified 'oplog.appended' stream across both seams.
    deps.ledger?.onAppended((changes) => deps.bus.emit('oplog.appended', { changes }))
  }

  /**
   * The full four-stage path. `authorize` throwing stops everything (no write,
   * no oplog, no broadcast); `write` throwing stops the oplog append and the
   * broadcast — a failed repository write must never publish.
   */
  run<T>(op: {
    authorize?: () => void
    write: () => T
    publish?: (result: T) => PublishSpec | null
  }): T {
    op.authorize?.()
    const result = op.write()
    const spec = op.publish?.(result)
    if (spec) this.publishSpec(spec)
    return result
  }

  /** {@link publish} taking a prebuilt {@link PublishSpec} — the shape
   *  {@link run}'s publish stage returns, for callers that build specs via a
   *  spec factory (modules/issues/publish) rather than inline. */
  publishSpec(spec: PublishSpec): void {
    this.publish(spec.entity, spec.rows, spec.snapshot, {
      ...(spec.partial !== undefined ? { partial: spec.partial } : {}),
      ...(spec.snapshotToCapClients !== undefined
        ? { snapshotToCapClients: spec.snapshotToCapClients }
        : {}),
    })
  }

  /** Oplog append + broadcast — the shared tail of every publish pipeline. */
  publish(
    entity: MetadataEntityKind,
    rows: { id: string; value: unknown }[],
    snapshot: ServerMessage,
    opts: { partial?: boolean; snapshotToCapClients?: boolean } = {},
  ): void {
    const changes = this.record(entity, rows, opts.partial ? { partial: true } : {})
    this.deps.fanOut(
      snapshot,
      changes,
      opts.snapshotToCapClients ? { snapshotToCapClients: true } : {},
    )
  }

  /**
   * Fan out a snapshot whose changes were ALREADY durably appended at the
   * write seam by the Ledger ([spec:SP-3fe2] #255) — commit/reconcile ran
   * before this call, so recording here again would double-append. Emission
   * shape is identical to {@link publish}'s tail: delta-cap clients get the
   * `metadataDelta` batch (when non-empty), legacy clients get the snapshot
   * exactly as before.
   */
  publishComputed(snapshot: ServerMessage, changes: MetadataChange[]): void {
    this.deps.fanOut(snapshot, changes)
  }

  /** Durable oplog append (no fan-out) — boot reconciliation and the publish
   *  tail both land here, so 'oplog.appended' fires for every recorded change. */
  record(
    entity: MetadataEntityKind,
    rows: { id: string; value: unknown }[],
    opts: { partial?: boolean } = {},
  ): MetadataChange[] {
    // SEVERED ([spec:SP-3fe2] #255): 'issue' changes are captured at the WRITE
    // seam by the Ledger (IssueService persist/broadcastList/delete/boot). The
    // legacy broadcast-seam oplog keeps its own baseline, so appending an issue
    // spec here would DOUBLE-APPEND everything the ledger already wrote — every
    // issue publish path must route through Ledger.commit/reconcile +
    // publishComputed. Loud so a regressed call site can't silently fork the
    // change log: throw under tests, degrade to fan-out-only in production.
    if (entity === 'issue') {
      const msg =
        '[funnel] issue spec reached the legacy oplog path — issue changes are ' +
        'ledger-owned (#255); route through Ledger.commit/reconcile + publishComputed'
      if (process.env.VITEST || process.env.NODE_ENV === 'test') throw new Error(msg)
      console.error(msg)
      return []
    }
    const changes = this.oplog.record(entity, rows, opts)
    if (changes.length > 0) this.deps.bus.emit('oplog.appended', { changes })
    return changes
  }

  /** Cursor catch-up read (sync.changesSince) — null when compacted/future. */
  changesSince(cursor: number | null): MetadataChange[] | null {
    return this.oplog.changesSince(cursor)
  }

  cursor(): number {
    return this.oplog.cursor()
  }
}
