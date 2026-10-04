/** Cookie, metadata, and IndexedDB adapters for the shared accounts layer. */
import {
  browserProfileMetadataStorage,
  cookieCredentials,
  createAccountEraser,
  createAuthClient,
  createSingleServerAccounts,
  eraseAccountData,
} from '@podium/client-core/accounts'
import { retainReplicaEntity } from '@podium/client-core/replica'
import { IndexedDbSyncStore, type IdbFactoryLike } from '@podium/sync/adapters/indexeddb'
import { KERNEL_REPLICA_DB, KERNEL_SIDE_CACHE_PREFIX } from './kernelReplica'
import { currentWorkspaceSlug, workspaceFetch } from './workspace-request'

export const webAuth = createAuthClient({
  credentials: cookieCredentials,
  fetch: workspaceFetch,
  validateProbeEnvelope: false,
  timeoutMs: null,
  loginRefusalMessage: (status) =>
    status === 429
      ? 'too many attempts — wait a moment, then try again'
      : 'incorrect email or password — try again',
})

export const webAccountEraser = createAccountEraser(async (principal) => {
  const store = await IndexedDbSyncStore.open({
    factory: globalThis.indexedDB as unknown as IdbFactoryLike,
    databaseName: KERNEL_REPLICA_DB,
    retainEntity: retainReplicaEntity,
    onDegraded: () => {},
  })
  try {
    if (store.durability() !== 'durable') throw new Error('private replica storage is unavailable')
    await eraseAccountData({
      principal,
      storage: globalThis.localStorage,
      basePrefix: KERNEL_SIDE_CACHE_PREFIX,
      enumerateKeys: () => Object.keys(globalThis.localStorage),
      eraseEntities: (key) => store.erasePrincipal(key),
    })
  } finally {
    store.close()
  }
})

const instances = new Map<string, ReturnType<typeof createSingleServerAccounts>>()
export function webAccounts(httpOrigin: string) {
  httpOrigin ||= globalThis.location.origin
  const scope = JSON.stringify([httpOrigin, currentWorkspaceSlug() ?? ''])
  let accounts = instances.get(scope)
  if (!accounts) {
    accounts = createSingleServerAccounts({
      httpOrigin,
      metadataPrefix: `podium.accounts.web.${encodeURIComponent(scope)}`,
      storage: browserProfileMetadataStorage,
      erasePrincipal: webAccountEraser.erase,
    })
    instances.set(scope, accounts)
  }
  return accounts
}
