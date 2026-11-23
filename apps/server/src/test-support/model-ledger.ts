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

const PREFIX = 'sidebar.section.test-model:'

export class StoreModelLedger extends Ledger {
  private readonly modelStore: SessionStore

  constructor(store: SessionStore, deps: Omit<LedgerDeps, 'records'>) {
    const records = new ModelRecords()
    const user = firstAdminMemberId()
    const key = (entity: string, id: string) => `${PREFIX}${JSON.stringify([entity, id])}`
    records.build = async (entity, ids) => {
      const snapshot = await store.layout.getSnapshot(user)
      return ids.flatMap((id) => {
        const value = snapshot[key(entity, id)]
        return value === undefined ? [] : [{ id, value }]
      })
    }
    // The fixture rows are layout rows, so the store's change capture sees
    // them: a drain maps each captured fixture key back to its record, and
    // takes (and drops) whatever else the transaction captured.
    records.drainCapture = async () => {
      const out = new Map<MetadataEntityKind, string[]>()
      for (const row of await store.sync.drainCapture()) {
        if (row.kind !== 'userLayout') continue
        for (const captured of [row.oldKey, row.newKey]) {
          // A userLayout key is [workspace_id, user_id, key]: the workspace leads every
          // key on a workspace table (POD-7021).
          const name = captured?.[2]
          if (typeof name !== 'string' || !name.startsWith(PREFIX)) continue
          const [kind, id] = JSON.parse(name.slice(PREFIX.length)) as [MetadataEntityKind, string]
          const ids = out.get(kind) ?? []
          if (!ids.includes(id)) ids.push(id)
          out.set(kind, ids)
        }
      }
      return out
    }
    records.streamAll = async function* (entity: MetadataEntityKind) {
      const snapshot = await store.layout.getSnapshot(user)
      yield Object.entries(snapshot).flatMap(([name, value]) => {
        if (!name.startsWith(PREFIX)) return []
        const [kind, id] = JSON.parse(name.slice(PREFIX.length)) as [string, string]
        return kind === entity ? [{ id, value }] : []
      })
    }
    // The fixture rows' writes are captured, so the change log attaches to
    // the store now (POD-6920); the first commit waits for it.
    const attached = store.attachChangeLog()
    super({
      ...deps,
      records,
      transact: async (fn) => {
        await attached
        return await deps.transact(fn)
      },
    })
    this.modelStore = store
  }

  private async put(scope: WriteScope, rows: readonly EntityChangeSpec[]): Promise<void> {
    const user = firstAdminMemberId()
    for (const row of rows) {
      const key = `${PREFIX}${JSON.stringify([row.entity, row.id])}`
      if (row.op === 'remove') await this.modelStore.layout.clear(scope, user, key)
      else await this.modelStore.layout.set(scope, user, key, row.value, '2026-11-11T00:00:00.000Z')
    }
  }

  rowWrite(rows: readonly EntityChangeSpec[]): LedgerCommitOp<void> {
    return { write: async (scope) => await this.put(scope, rows) }
  }

  /** Persist fixture rows in the same commit as the source write. */
  modelOperation<T>(
    op: LedgerCommitOp<T> & {
      rows: () => readonly EntityChangeSpec[] | Promise<readonly EntityChangeSpec[]>
    },
  ): LedgerCommitOp<T> {
    const { rows, ...rest } = op
    return {
      ...rest,
      // The rows are read before the source write, as the fixture always did.
      write: async (scope) => {
        const specs = await rows()
        const result = await op.write(scope)
        await this.put(scope, specs)
        return result
      },
    }
  }
}
