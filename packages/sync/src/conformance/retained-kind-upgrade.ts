import { expect } from 'vitest'
import { instanceKey } from '../replica/cache-state'
import type { ReplicaCacheStore } from '../replica/ports'
import { Replica } from '../replica/replica'
import { CollectionServer, RECENTLY, WORLD_NOW } from './collection-server'

interface DeviceStore {
  viewFor(principal: string): { readonly cache: ReplicaCacheStore }
  settled(): Promise<void>
  close(): void
}

/** Reopen the same physical device store with the new app's retention policy. */
export async function expectNewlySupportedKindAfterUpgrade(
  open: (retainEntity?: (entity: string) => boolean) => Promise<DeviceStore>,
): Promise<void> {
  const principal = 'alice'
  const entity = 'inboxNotice'
  const id = `${principal}\nN1`
  const spec = { collection: 'inboxNotice.all', part: 'main' } as const
  const notice = {
    noticeId: 'N1',
    recipientUserId: principal,
    kind: 'mention',
    subjectKind: 'issue',
    subjectId: 'A1',
    title: 'Mentioned on an issue',
    createdAt: RECENTLY,
  }
  const server = new CollectionServer()
  server.policy = { ...server.policy, steps: [{ step: 'always', collections: [spec.collection] }] }
  server.kindTokens = { [entity]: 'v1' }
  server.put(entity, id, notice)

  const oldApp = await open((kind) => kind !== entity)
  try {
    const cache = oldApp.viewFor(principal).cache
    const replica = new Replica({ store: cache, authority: server, now: () => WORLD_NOW })
    replica.connect()
    await replica.settled()
    await oldApp.settled()
    expect(cache.readCursor()).toEqual(server.cursorAt())
    expect(cache.readKindTokens()).toEqual(server.kindTokens)
    expect(cache.readInstances().has(instanceKey(spec))).toBe(true)
    expect(cache.read(entity, id)).toBeUndefined()
    replica.disconnect()
  } finally {
    oldApp.close()
  }

  const newApp = await open()
  try {
    const cache = newApp.viewFor(principal).cache
    const replica = new Replica({ store: cache, authority: server, now: () => WORLD_NOW })
    replica.connect()
    replica.observeKindTokens(server.kindTokens)
    await replica.settled()
    expect(cache.read(entity, id)?.value).toEqual(notice)
  } finally {
    newApp.close()
  }
}
