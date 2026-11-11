/** Model tables for kernel tests. These rows are independent of the catch-up log. */
import { MetadataEntityKind } from '@podium/protocol'
import { Authority, type AuthorityDeps, entityOverlayKey } from '../authority/authority'
import type { SequencedChange, StagedChangeSpec } from '../authority/change-lifecycle'
import type { RecordSourcePort } from '../authority/ports'
import type { BuiltRecord } from '../record-builders'

export class ModelRecords implements RecordSourcePort {
  private rows = new Map<string, BuiltRecord & { entity: MetadataEntityKind }>()
  comparesAtSave = () => true
  namedAfterWrite = () => true
  kinds = () => MetadataEntityKind.options

  set(specs: readonly StagedChangeSpec[]): void {
    for (const spec of specs) {
      const key = entityOverlayKey(spec.entity, spec.entityId)
      if (spec.op === 'remove') this.rows.delete(key)
      else this.rows.set(key, { entity: spec.entity, id: spec.entityId, value: spec.value })
    }
  }

  checkpoint(): () => void {
    const rows = new Map(this.rows)
    return () => {
      this.rows = rows
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

  async *streamAll(entity: MetadataEntityKind) {
    yield [...this.rows.values()].filter((row) => row.entity === entity)
  }

  async *streamAllKinds() {
    for (const entity of this.kinds()) {
      for await (const records of this.streamAll(entity)) yield { entity, records }
    }
  }
}

/** Kernel tests save model rows through the real compare-at-save funnel. */
export class ModelAuthority extends Authority {
  readonly models: ModelRecords

  constructor(deps: Omit<AuthorityDeps, 'records'> & { records?: RecordSourcePort }) {
    const models = new ModelRecords()
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
    const outcome = await this.commit({
      affects: specs,
      write: async () => this.models.set(specs),
    })
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
      affects: specs,
      write: async () => this.models.set(specs.map(({ id, ...row }) => ({ ...row, entityId: id }))),
    }
  }
}
