import { changedKeyDraftTests } from '../changed-key-draft.test-support'
import { SqliteSyncStore } from './store'
import { FaultySqlDatabase, freshDatabaseFile, sqliteEngine } from './test-support'

changedKeyDraftTests('mobile SQLite', async () => {
  const fresh = freshDatabaseFile()
  let db!: FaultySqlDatabase
  const open = () =>
    SqliteSyncStore.open({
      openDatabase: () => {
        db = new FaultySqlDatabase(sqliteEngine.open(fresh.file))
        return db
      },
      deleteDatabase: () => {
        throw new Error('unexpected file recovery')
      },
      onDegraded: () => {
        throw new Error('unexpected degradation')
      },
    })
  const store = await open()
  return {
    store,
    failCommit: () => db.denyWriteAt({ at: 1, error: new Error('draft failure') }),
    reopen: open,
    settled: async () => undefined,
    cleanup: () => {
      store.close()
      fresh.cleanup()
    },
  }
})
