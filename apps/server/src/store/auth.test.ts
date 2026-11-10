import { asUserId, firstAdminMemberId } from '@podium/model'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { SessionStore } from '../store'
import { seedLegacyClientSession } from '../test-support/legacy-client-session'
import { openTestStore } from '../test-support/open-test-store'

let store: SessionStore
beforeEach(async () => {
  store = await openTestStore(':memory:')
})
afterEach(async () => {
  await store.close()
})

const FUTURE = '2999-01-01T00:00:00.000Z'

it('keeps the original rows and their expiries readable for the upgrade', async () => {
  const member = firstAdminMemberId()
  const labels = ['login', 'mobile', 'break-glass', 'upstream'] as const
  for (const label of labels) {
    await seedLegacyClientSession(store, label, member, FUTURE, label)
  }
  const byHash = new Map(
    (await store.auth.listClientSessionsOfUser(member)).map((row) => [row.tokenHash, row]),
  )
  for (const label of labels) {
    expect(byHash.get(label)).toMatchObject({ userId: member, label, expiresAt: FUTURE })
  }
})

it('reads a phone’s original metadata by hash without admitting the credential', async () => {
  const member = firstAdminMemberId()
  const device = {
    sessionId: 'old-public-id',
    deviceId: 'old-device',
    deviceName: 'iPhone',
    platform: 'ios',
  }
  await seedLegacyClientSession(store, 'phone-hash', member, FUTURE, 'mobile', device)
  expect(await store.auth.getClientSession('phone-hash')).toMatchObject({
    ...device,
    userId: member,
    expiresAt: FUTURE,
  })
  expect(await store.auth.listClientSessionsOfUser(asUserId('mem_other'))).toEqual([])
})
