/** Model tables for kernel tests. These rows are independent of the catch-up log. */
import { MetadataEntityKind } from '@podium/protocol'
import { Authority, type AuthorityDeps, entityOverlayKey } from '../authority/authority'
import type { SequencedChange, StagedChangeSpec } from '../authority/change-lifecycle'
import type { RecordSourcePort } from '../authority/ports'
import type { BuiltRecord, RecordIdsByKind } from '../record-builders'

/**
 * Model rows in memory, with the change capture a database keeps (POD-6920):
 * every {@link set} of a row whose value changes is captured, and
 * {@link drainCapture} hands the captured records to the Authority. A set
 * that leaves a row as it was captures nothing, like a trigger whose columns
 * did not change.
 */
export class ModelRecords implements RecordSourcePort {
  private rows = new Map<string, BuiltRecord & { entity: MetadataEntityKind }>()
  private captured = new Map<MetadataEntityKind, string[]>()
  kinds = () => MetadataEntityKind.options

  set(specs: readonly StagedChangeSpec[]): void {
    for (const spec of specs) {
      const key = entityOverlayKey(spec.entity, spec.entityId)
      const was = this.rows.get(key)
      if (spec.op === 'remove') {
        if (was === undefined) continue
        this.rows.delete(key)
      } else {
        if (was !== undefined && JSON.stringify(was.value) === JSON.stringify(spec.value)) continue
        this.rows.set(key, { entity: spec.entity, id: spec.entityId, value: spec.value })
      }
      this.capture(spec.entity, spec.entityId)
    }
  }

  /** Capture a record as changed without changing its row (a fixture's
   *  stand-in for a row a kind reads that is not the record's own). */
  capture(entity: MetadataEntityKind, id: string): void {
    const ids = this.captured.get(entity)
    if (ids === undefined) this.captured.set(entity, [id])
    else if (!ids.includes(id)) ids.push(id)
  }

  async drainCapture(): Promise<RecordIdsByKind> {
    const drained = this.captured
    this.captured = new Map()
    return drained
  }

  checkpoint(): () => void {
    const rows = new Map(this.rows)
    const captured = new Map<MetadataEntityKind, string[]>(
      [...this.captured].map(([kind, ids]) => [kind, [...ids]]),
    )
    return () => {
      this.rows = rows
      this.captured = captured
    }
  }

  async build(entity: MetadataEntityKind, ids: readonly string[]): Promise<readonly BuiltRecord[]> {
    return ids.flatMap((id) => {
      const row = this.rows.get(entityOverlayKey(entity, id))
      return row === undefined ? [] : [{ id, value: row.value }]
    })
  }

  async *buildMany(idsByKind: Parameters<RecordSourcePort['buildMany']>[0]) {
    for (const [entity, ids] of idsByKind) yield { entity, records: await this.build(entity, ids) }
  }

  async *streamAll(entity: MetadataEntityKind): AsyncIterable<readonly BuiltRecord[]> {
    yield [...this.rows.values()].filter((row) => row.entity === entity)
  }

  async *streamAllKinds() {
    for (const entity of this.kinds()) {
      for await (const records of this.streamAll(entity)) yield { entity, records }
    }
  }
}

/** Kernel tests save model rows through the real commit funnel. */
export class ModelAuthority extends Authority {
  readonly models: ModelRecords

  constructor(deps: Omit<AuthorityDeps, 'records'> & { records?: RecordSourcePort }) {
    const models = deps.records instanceof ModelRecords ? deps.records : new ModelRecords()
    super({
      ...deps,
      records: deps.records ?? models,
      transact: async (fn) => {
        const rollback = models.checkpoint()
        try {
          return await deps.transact(fn)
        } catch (error) {
          rollback()
          throw error
        }
      },
    })
    this.models = models
  }

  async save(specs: readonly StagedChangeSpec[]): Promise<readonly SequencedChange[]> {
    const outcome = await this.commit({ write: async () => this.models.set(specs) })
    if (outcome.outcome !== 'committed') throw new Error('fixture save rejected')
    return outcome.changes
  }
}

import { type EntityChangeSpec, Ledger, type LedgerCommitOp, type LedgerDeps } from '../ledger'

/** A Ledger with explicit model rows for command/scope tests without feature repositories. */
export class ModelLedger extends Ledger {
  readonly models: ModelRecords

  constructor(deps: Omit<LedgerDeps, 'records'> & { records?: RecordSourcePort }) {
    const models = new ModelRecords()
    super({ ...deps, records: deps.records ?? models })
    this.models = models
  }

  rowWrite(specs: readonly EntityChangeSpec[]): LedgerCommitOp<void> {
    return {
      write: async () => this.models.set(specs.map(({ id, ...row }) => ({ ...row, entityId: id }))),
    }
  }
}
