import { createAccountEraser, eraseAccountData } from '@podium/client-core/accounts'
import { createAsyncStorageReplicaStorage, REPLICA_KEY_PREFIX } from '@podium/client-core/replica'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { openMobileEntityStore } from './mobile-entity-store'
import { MOBILE_REPLICA_DB } from './replica-storage-constants'

export const mobileAccountEraser = createAccountEraser(async (principal) => {
  const bridge = await createAsyncStorageReplicaStorage(AsyncStorage, [REPLICA_KEY_PREFIX])
  const store = await openMobileEntityStore(MOBILE_REPLICA_DB, () => {})
  try {
    if (store.durability() !== 'durable') throw new Error('private replica storage is unavailable')
    await eraseAccountData({
      principal,
      storage: bridge.storage,
      basePrefix: REPLICA_KEY_PREFIX,
      enumerateKeys: bridge.keys,
      eraseEntities: (key) => store.erasePrincipal(key),
      flush: bridge.flushDurable,
    })
  } finally {
    store.close()
  }
})
