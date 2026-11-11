/** Transactional model rows for tests of generic Ledger wiring, independent of its log. */
import { firstAdminMemberId } from '@podium/model'
import type { MetadataEntityKind } from '@podium/protocol'
import {
  type EntityChangeSpec,
  Ledger,
  type LedgerCommitOp,
  type LedgerDeps,
  type WriteScope,
} from '@podium/sync'
import { ModelRecords } from '@podium/sync/testing'
import type { SessionStore } from '../store'

export class StoreModelLedger extends Ledger {
  private readonly modelStore: SessionStore

  constructor(store: SessionStore, deps: Omit<LedgerDeps, 'records'>) {
    const records = new ModelRecords()
    const user = firstAdminMemberId()
    const key = (entity: string, id: string) =>
      `sidebar.section.test-model:${JSON.stringify([entity, id])}`
    records.build = async (entity, ids) => {
      const snapshot = await store.layout.getSnapshot(user)
      return ids.flatMap((id) => {
        const value = snapshot[key(entity, id)]
        return value === undefined ? [] : [{ id, value }]
      })
    }
    records.streamAll = async function* (entity: MetadataEntityKind) {
      const snapshot = await store.layout.getSnapshot(user)
      yield Object.entries(snapshot).flatMap(([name, value]) => {
        if (!name.startsWith('sidebar.section.test-model:')) return []
        const [kind, id] = JSON.parse(name.slice('sidebar.section.test-model:'.length)) as [
          string,
          string,
        ]
        return kind === entity ? [{ id, value }] : []
      })
    }
    super({ ...deps, records })
    this.modelStore = store
  }

  private async put(scope: WriteScope, rows: readonly EntityChangeSpec[]): Promise<void> {
    const user = firstAdminMemberId()
    for (const row of rows) {
      const key = `sidebar.section.test-model:${JSON.stringify([row.entity, row.id])}`
      if (row.op === 'remove') await this.modelStore.layout.clear(scope, user, key)
      else await this.modelStore.layout.set(scope, user, key, row.value, '2026-11-11T00:00:00.000Z')
    }
  }

  rowWrite(rows: readonly EntityChangeSpec[]): LedgerCommitOp<void> {
    return { affects: rows, write: async (scope) => await this.put(scope, rows) }
  }

  /** Name fixture rows before the source write; persist them in that same commit. */
  modelOperation<T>(
    op: Omit<LedgerCommitOp<T>, 'affects'> & {
      rows: () => readonly EntityChangeSpec[] | Promise<readonly EntityChangeSpec[]>
    },
  ): LedgerCommitOp<T> {
    let rows: readonly EntityChangeSpec[] = []
    return {
      ...op,
      affects: async () => {
        rows = await op.rows()
        return rows
      },
      write: async (scope) => {
        const result = await op.write(scope)
        await this.put(scope, rows)
        return result
      },
    }
  }
}
