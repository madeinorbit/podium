import {
  type AppStateStatus,
  createNativeConnectivity,
  type NetInfoStateLike,
} from '@podium/client-core/live-connection'
import { memoryStorage } from '@podium/client-core/replica'
import { openReplicaAssembly, watchSyncResume } from '@podium/client-core/replica-assembly'
import { SocketHub, type WebSocketLike } from '@podium/client-core/socket-transport'
import { CLIENT_WIRE_VERSION, SYNC_CONTENT_TYPE } from '@podium/protocol'
import { IndexedDbSyncStore } from '@podium/sync/adapters/indexeddb'
import { IDBFactory } from 'fake-indexeddb'
import { expect, it, vi } from 'vitest'

class Socket implements WebSocketLike {
  onopen: WebSocketLike['onopen'] = null
  onmessage: WebSocketLike['onmessage'] = null
  onclose: WebSocketLike['onclose'] = null
  send(): void {}
  close(): void {
    this.onclose?.({ code: 1006 })
  }
  open(): void {
    this.onopen?.({})
  }
}

it.each([
  'server unavailable',
  'reachability lost after resume',
  'constructor refused',
] as const)('settles a real resume dial that fails before onopen: %s', async (failure) => {
  const cursor = { feedId: 'resume-feed', epoch: 'resume-epoch', seq: 10 }
  const principal = JSON.stringify(['resume-installation', 'alice'])
  const store = await IndexedDbSyncStore.open({
    factory: new IDBFactory() as never,
    onDegraded: () => {},
  })
  store.viewFor(principal).cache.installSnapshot([], cursor, [])
  await store.settled()
  const storage = memoryStorage()
  const assembly = await openReplicaAssembly({
    api: {} as never,
    principal,
    openStore: async () => store,
    settings: { storage, enumerateKeys: storage.keys, basePrefix: 'resume-test' },
    httpSync: {
      origin: 'https://resume.test',
      streamingFetch: {
        fetch: async () =>
          new Response(
            [
              {
                type: 'syncMeta',
                mode: 'delta',
                formatVersion: 1,
                wireVersion: CLIENT_WIRE_VERSION,
                wireSchemaDigest: '0123456789abcdef',
                transferId: 'resume',
                minAvailableSeq: 0,
                ...cursor,
                fromSeq: 10,
              },
              { type: 'syncComplete', transferId: 'resume', seq: 10, records: 0, rows: 0 },
            ]
              .map((record) => `${JSON.stringify(record)}\n`)
              .join(''),
            {
              headers: { 'content-type': SYNC_CONTENT_TYPE },
            },
          ),
      },
    },
  })
  let currentState: AppStateStatus = 'active'
  let appChanged = (_state: AppStateStatus) => {}
  let networkChanged = (_state: NetInfoStateLike) => {}
  const connectivity = createNativeConnectivity({
    appState: {
      get currentState() {
        return currentState
      },
      addEventListener: (_type, handler) => {
        appChanged = handler
        return { remove() {} }
      },
    },
    netInfo: {
      addEventListener: (handler) => {
        networkChanged = handler
        handler({ isConnected: true, isInternetReachable: true })
        return () => {}
      },
    },
  })
  const go = (state: AppStateStatus) => {
    currentState = state
    appChanged(state)
  }
  const sockets: Socket[] = []
  let refuseDial = false
  const hub = new SocketHub({
    url: 'wss://resume.test',
    feed: assembly.feed,
    makeSocket: () => {
      if (refuseDial) throw new Error('dial refused')
      const socket = new Socket()
      sockets.push(socket)
      return socket
    },
  })
  const stopResume = watchSyncResume(assembly.progress, connectivity)
  const detach = connectivity.attachHub(hub)
  try {
    hub.connect()
    sockets[0]?.open()
    await vi.waitFor(() => expect(assembly.progress.getSnapshot().phase).toBe('ready'))
    go('background')
    expect(assembly.progress.getSnapshot().phase).toBe('offline')
    if (failure === 'constructor refused') refuseDial = true
    go('active')
    if (failure !== 'constructor refused') {
      expect(assembly.progress.getSnapshot().phase).toBe('reconnecting')
      if (failure === 'reachability lost after resume') {
        networkChanged({ isConnected: false, isInternetReachable: false })
      }
      // The replacement socket never opened, so the replica is still stale.
      sockets[1]?.close()
    }
    expect(assembly.progress.getSnapshot().phase).toBe('offline')
  } finally {
    detach()
    stopResume()
    connectivity.dispose()
    hub.dispose()
    await assembly.dispose()
  }
})
