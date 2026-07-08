import type { MetadataChange, MetadataEntityKind } from '@podium/protocol'
import type { SyncRepository } from './sync-repository'

/**
 * Metadata oplog feed (docs/spec/oplog-read-path.md).
 *
 * Sits at the BROADCAST seam, not the store seam: every reactive entity list
 * (`SessionMeta[]`, `IssueWire[]`, `ConversationSummaryWire[]`) is a composite
 * assembled at broadcast time (sessions from live registry objects, issues from
 * allWire() with derived member data), so the only place the wire truth exists is
 * the moment we're about to fan it out. `record()` diffs that truth against the
 * last recorded state and appends only real changes to the durable `changes` table,
 * returning them as wire `MetadataChange` rows for delta fan-out.
 *
 * The diff baseline survives restarts: the constructor folds the retained log to
 * its latest state per (entity, id), so the first record() after a reboot emits
 * deltas for anything that changed while the server was down.
 */
export class MetadataOplog {
  /** entity -> id -> serialized wire JSON of the last recorded state. */
  private readonly last = new Map<MetadataEntityKind, Map<string, string>>()
  /** Conversation id -> stable-field projection JSON of the last recorded state
   *  (see conversationProjection) — the change-detection key for that entity. */
  private readonly lastConvProjection = new Map<string, string>()
  private appendsSincePrune = 0

  /** Retention: keep the newest 20k rows, and nothing older than 3 days —
   *  whichever budget deletes more (store.pruneChanges, head-only). */
  static readonly KEEP_ROWS = 20_000
  static readonly MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000
  private static readonly PRUNE_EVERY = 64

  /** Conversation fields that churn on every discovery scan (activity bumps) —
   *  EXCLUDED from change detection so a scan storm doesn't re-record the full
   *  payload per conversation per scan. Staleness tradeoff: delta clients see
   *  these refresh only when a stable field also changes, or on their next
   *  reconnect snapshot — acceptable for advisory recency/count hints. */
  private static conversationProjection(value: unknown): string {
    const {
      updatedAt: _updatedAt,
      messageCount: _messageCount,
      statusHint: _statusHint,
      ...stable
    } = value as Record<string, unknown>
    return JSON.stringify(stable)
  }

  constructor(
    private readonly store: SyncRepository,
    private readonly now: () => number = Date.now,
  ) {
    // Boot prune BEFORE folding the log: a table bloated by an old retention
    // policy (or a long outage) self-heals on deploy instead of waiting for the
    // PRUNE_EVERY appends, and the baseline fold below reads fewer rows.
    store.pruneChanges({
      keepRows: MetadataOplog.KEEP_ROWS,
      maxAgeMs: MetadataOplog.MAX_AGE_MS,
      now: this.now(),
    })
    for (const row of store.latestChangeStates()) {
      if (row.op !== 'upsert' || row.payload == null) continue
      this.byEntity(row.entity as MetadataEntityKind).set(row.entityId, row.payload)
      if (row.entity === 'conversation') {
        try {
          this.lastConvProjection.set(
            row.entityId,
            MetadataOplog.conversationProjection(JSON.parse(row.payload)),
          )
        } catch {} // corrupt payload -> no baseline; first record() re-upserts it
      }
    }
  }

  private byEntity(entity: MetadataEntityKind): Map<string, string> {
    let m = this.last.get(entity)
    if (!m) {
      m = new Map()
      this.last.set(entity, m)
    }
    return m
  }

  /** Current cursor — the highest seq ever assigned (0 before any change). */
  cursor(): number {
    return this.store.maxChangeSeq()
  }

  /**
   * Diff `list` (the full current truth for one entity) against the last recorded
   * state, durably append the difference, and return it as wire changes (empty
   * array = nothing actually changed, e.g. an activity bump that altered no bytes).
   * Elements are compared by their serialized JSON — same cheap byte-equality the
   * sessions broadcast dedup already relies on.
   *
   * `opts.partial` (issue #22): `list` is a SUBSET of the entity's truth (e.g. the
   * one issue a persist() touched), so absence means "not included", never
   * "deleted" — the remove-diff pass is skipped. Only full-truth calls may emit
   * removes.
   */
  record(
    entity: MetadataEntityKind,
    list: { id: string; value: unknown }[],
    opts: { partial?: boolean } = {},
  ): MetadataChange[] {
    const prev = this.byEntity(entity)
    const next = new Map<string, string>()
    const rows: {
      entity: string
      entityId: string
      op: 'upsert' | 'remove'
      payload: string | null
    }[] = []
    const values = new Map<string, unknown>()
    // Conversations diff on a projection EXCLUDING volatile fields (updatedAt /
    // messageCount / statusHint): scan-driven activity bumps re-shipped the FULL
    // payload per conversation per scan (81MB/day of oplog churn). The durable
    // payload stays the full wire value — only change DETECTION is projected.
    const nextProjection = entity === 'conversation' ? new Map<string, string>() : null
    for (const { id, value } of list) {
      const json = JSON.stringify(value)
      next.set(id, json)
      values.set(id, value)
      let changed: boolean
      if (nextProjection) {
        const projection = MetadataOplog.conversationProjection(value)
        nextProjection.set(id, projection)
        changed = this.lastConvProjection.get(id) !== projection
      } else {
        changed = prev.get(id) !== json
      }
      if (changed) rows.push({ entity, entityId: id, op: 'upsert', payload: json })
    }
    if (!opts.partial) {
      for (const id of prev.keys()) {
        if (!next.has(id)) rows.push({ entity, entityId: id, op: 'remove', payload: null })
      }
    }
    if (rows.length === 0) return []
    const seqs = this.store.appendChanges(rows, this.now())
    // Update the baseline only after the append committed — a throw above must not
    // desync the in-memory state from the durable log.
    for (const row of rows) {
      if (row.op === 'upsert') {
        prev.set(row.entityId, row.payload as string)
        if (nextProjection) {
          this.lastConvProjection.set(row.entityId, nextProjection.get(row.entityId) as string)
        }
      } else {
        prev.delete(row.entityId)
        if (nextProjection) this.lastConvProjection.delete(row.entityId)
      }
    }
    if (++this.appendsSincePrune >= MetadataOplog.PRUNE_EVERY) {
      this.appendsSincePrune = 0
      this.store.pruneChanges({
        keepRows: MetadataOplog.KEEP_ROWS,
        maxAgeMs: MetadataOplog.MAX_AGE_MS,
        now: this.now(),
      })
    }
    return rows.map((row, i) => {
      const base = { seq: seqs[i] as number, id: row.entityId, op: row.op }
      return (
        row.op === 'upsert'
          ? { ...base, entity, value: values.get(row.entityId) }
          : { ...base, entity }
      ) as MetadataChange
    })
  }

  /**
   * Catch-up read for `sync.changesSince`. Returns null when the caller must fall
   * back to a snapshot: null cursor (bootstrap), a cursor from before the retained
   * range (compaction), or a cursor from the future (server DB was reset).
   */
  changesSince(cursor: number | null): MetadataChange[] | null {
    const max = this.store.maxChangeSeq()
    if (cursor == null || cursor > max) return null
    if (cursor === max) return []
    const min = this.store.minChangeSeq()
    // Continuity: everything in (cursor, max] must still be retained. The oldest
    // retained row must be no newer than cursor + 1, else rows were pruned away.
    if (min == null || min > cursor + 1) return null
    const rows = this.store.changesSince(cursor)
    const changes: MetadataChange[] = []
    for (const r of rows) {
      const base = { seq: r.seq, id: r.entityId, op: r.op as 'upsert' | 'remove' }
      if (r.op === 'upsert') {
        if (r.payload == null) return null // corrupt row — snapshot instead of a hole
        changes.push({
          ...base,
          entity: r.entity as MetadataEntityKind,
          value: JSON.parse(r.payload),
        } as MetadataChange)
      } else {
        changes.push({ ...base, entity: r.entity as MetadataEntityKind } as MetadataChange)
      }
    }
    return changes
  }
}
