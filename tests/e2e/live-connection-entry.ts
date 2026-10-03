/** Browser boundary fixture over the actual web and mobile replica wrappers. */
import { cookieCredentials } from '@podium/client-core/accounts'
import type { PodiumClientApi } from '@podium/client-core/api'
import {
  browserServerRelocation,
  checkWireVersion,
  createSocketLogin,
  observeLiveConnection,
} from '@podium/client-core/live-connection'
import { asClientPrincipal } from '@podium/client-core/principal'
import { retainReplicaEntity } from '@podium/client-core/replica'
import { SocketHub } from '@podium/client-core/socket-transport'
import { asUserId } from '@podium/model'
import { IndexedDbSyncStore, type IdbFactoryLike } from '@podium/sync/adapters/indexeddb'
import { openKernelAssembly } from '../../apps/web/src/lib/kernelReplica'
import { openMobileReplica } from '../../apps/mobile/src/client/MobileClientProvider'
import { mobileVersionObservers } from '../../apps/mobile/src/client/mobile-live-connection'
import { makePlatformSocketLogin } from '../../apps/mobile/src/client/native-websocket.web'
import { platformFeedChannel } from '../../apps/mobile/src/client/platform-feed-channel.web'

const params = new URLSearchParams(location.search)
const app = params.get('app') === 'mobile' ? 'mobile' : 'web'
const tab = params.get('tab') ?? 'one'
const databaseName = `connection-proof-${app}`
const principal = JSON.stringify(['fixture-installation', 'alice'])
const factory = indexedDB as unknown as IdbFactoryLike
const state = {
  app,
  tab,
  rows: [] as string[],
  connected: false,
  versionReads: 0,
  verdicts: [] as string[],
  notices: [] as string[],
}
const render = () => {
  document.getElementById('state')!.textContent = JSON.stringify(state, null, 2)
}

// Cache seeded exactly as the cross-tab regression: the durable cursor must not
// make a later tab miss the update to its separate in-memory replica.
const seed = await IndexedDbSyncStore.open({
  factory,
  databaseName,
  retainEntity: retainReplicaEntity,
  onDegraded: () => {},
})
seed
  .viewFor(principal)
  .cache.applyAtomic({
    operations: [],
    cursor: { feedId: 'fixture-feed', epoch: 'fixture-epoch', seq: 0 },
  })
await seed.settled()
seed.close()
const api = {} as PodiumClientApi
const assembly =
  app === 'web'
    ? await openKernelAssembly({
        trpc: api as never,
        httpOrigin: location.origin,
        databaseName,
        principal,
        evidence: { kind: 'single-account', principal: 'default' },
        onDegraded: (detail) => console.error('web fixture degradation', detail),
      })
    : await openMobileReplica({
        api,
        principal,
        clientPrincipal: 'alice',
        storage: localStorage,
        enumerateKeys: () => Object.keys(localStorage),
        onDegraded: (detail) => console.error('mobile fixture degradation', detail),
        evidence: { kind: 'single-account', principal: 'default' },
        openStore: () =>
          IndexedDbSyncStore.open({
            factory,
            databaseName,
            retainEntity: retainReplicaEntity,
            onDegraded: () => {},
          }),
        httpSync: { origin: location.origin, streamingFetch: { fetch, credentials: 'include' } },
        broadcastChannelFactory: platformFeedChannel(),
      })
const replica = assembly.createReplicaFn(
  asClientPrincipal(asUserId('alice'), 'fixture-installation'),
)
const stopRows = replica.subscribeRows('issueProjections', () => {
  state.rows = replica.rows('issueProjections').map((row) => row.title)
  render()
})
const login = { credentials: cookieCredentials, httpOrigin: location.origin, bearer: () => null }
const hub = new SocketHub({
  url: `${location.origin.replace('http', 'ws')}/client?tab=${tab}`,
  feed: assembly.feed,
  makeSocket: app === 'web' ? createSocketLogin(login) : makePlatformSocketLogin(login),
  onServerRelocation: browserServerRelocation(location),
})
const fetchVersion = async () => {
  state.versionReads++
  const value = await (await fetch('/version')).json()
  render()
  return value
}
const mobileVersion = mobileVersionObservers({
  credentials: cookieCredentials,
  fetchVersion,
  report: (message) => {
    state.notices.push(message)
    render()
  },
})
const stopConnection = observeLiveConnection(
  hub,
  app === 'web'
    ? {
        onReconnect: () => {
          void checkWireVersion(fetchVersion).then((result) => {
            if (result) state.verdicts.push(result.verdict)
            render()
          })
        },
        onWireSkew: () => {
          state.notices.push('Unreadable wire frame observed')
          render()
        },
      }
    : mobileVersion,
)
const stopHealth = hub.onConnectionHealth(() => {
  state.connected = hub.connected
  render()
})
hub.connect()
render()
Object.assign(window, {
  connectionProof: {
    state: () => ({
      ...state,
      hello: assembly.feed.helloFields(),
      progress:
        'progress' in assembly ? assembly.progress.getSnapshot() : assembly.syncProgress.getSnapshot(),
    }),
    stop: async () => {
      stopRows()
      stopConnection()
      stopHealth()
      mobileVersion.dispose()
      hub.dispose()
      await assembly.dispose()
    },
  },
})
