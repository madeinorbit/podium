import { changedKeyDraftTests } from '../changed-key-draft.test-support'
import { IndexedDbSyncStore } from './store'
import { FaultyIdbFactory, freshFactory } from './test-support'

changedKeyDraftTests('IndexedDB', async () => {
  const factory = new FaultyIdbFactory(freshFactory())
  const open = () => IndexedDbSyncStore.open({
    factory,
    onDegraded: () => { throw new Error('unexpected degradation') },
  })
  const store = await open()
  return {
    store,
    failCommit: () => factory.denyWriteAt({ at: 1, error: new Error('draft failure') }),
    reopen: open,
    settled: () => store.settled(),
    cleanup: () => store.close(),
  }
})
