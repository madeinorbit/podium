import type { MetadataChange, MetadataEntityKind } from '@podium/protocol'
import {
  CHANGE_KEEP_ROWS,
  CHANGE_MAX_AGE_MS,
  CHANGE_PRUNE_EVERY,
  ChangeBaseline,
  readChangesSince,
} from './change-log'
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
 *
 * LEGACY seam [spec:SP-3fe2] (#253): the write-seam {@link Ledger} shares this
 * class's baseline/projection/retention machinery (./change-log.ts) and will
 * replace it under the funnel in a later sub-phase.
 */
export class MetadataOplog {
  /** Per-(entity, id) dedup baseline — byte JSON plus the conversation projection. */
  private readonly baseline = new ChangeBaseline()
  private appendsSincePrune = 0

  /** Retention: keep the newest 20k rows, and nothing older than 3 days —
   *  whichever budget deletes more (store.pruneChanges, head-only). */
  static readonly KEEP_ROWS = CHANGE_KEEP_ROWS
  static readonly MAX_AGE_MS = CHANGE_MAX_AGE_MS

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
    this.baseline.seed(store)
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
   * sessions broadcast dedup already relies on. Conversations compare on a
   * stable-field projection instead (see change-log.ts conversationProjection).
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
    const next = new Set<string>()
    const rows: {
      entity: string
      entityId: string
      op: 'upsert' | 'remove'
      payload: string | null
    }[] = []
    const values = new Map<string, unknown>()
    for (const { id, value } of list) {
      const json = JSON.stringify(value)
      next.add(id)
      values.set(id, value)
      if (this.baseline.upsertChanged(entity, id, value, json)) {
        rows.push({ entity, entityId: id, op: 'upsert', payload: json })
      }
    }
    if (!opts.partial) {
      for (const id of this.baseline.ids(entity)) {
        if (!next.has(id)) rows.push({ entity, entityId: id, op: 'remove', payload: null })
      }
    }
    if (rows.length === 0) return []
    const seqs = this.store.appendChanges(rows, this.now())
    // Update the baseline only after the append committed — a throw above must not
    // desync the in-memory state from the durable log.
    for (const row of rows) {
      if (row.op === 'upsert') {
        this.baseline.applyUpsert(
          entity,
          row.entityId,
          values.get(row.entityId),
          row.payload as string,
        )
      } else {
        this.baseline.applyRemove(entity, row.entityId)
      }
    }
    if (++this.appendsSincePrune >= CHANGE_PRUNE_EVERY) {
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
    return readChangesSince(this.store, cursor)
  }
}
