import { asAccountId, asUserId } from '@podium/model'
import { expect, it, vi } from 'vitest'
import { managedKeyFor } from '../modules/sessions/account-env'
import type { SessionStore } from '../store'
import { openTestStore } from '../test-support/open-test-store'
import {
  expectArmed,
  expectConstantStatements,
  type StatementPin,
} from '../test-support/statement-count'
import { SHARED_WITH_EVERYONE } from './accounts'

const viewer = asUserId('mem_viewer')
const provider = asAccountId('managed:anthropic')
const earlier = asAccountId('managed:anthropic:earlier-workspace')

it('resolves shared provider keys and adopted aliases in two statements at any membership size', async () => {
  const pin: StatementPin<SessionStore> = {
    name: 'managed provider resolution with workspace aliases',
    setup: async (size) => {
      const store = await openTestStore(':memory:')
      for (let index = 0; index < size; index++) {
        const ownerUserId = asUserId(`mem_owner_${index}`)
        const accountKey = index === 0 ? earlier : provider
        await store.accounts.connect({
          ownerUserId,
          accountKey,
          provider: 'anthropic',
          kind: 'api-key',
          credential: `credential-${index}`,
          identity: 'masked',
          scope: 'role',
          createdAt: index,
        })
        await store.accounts.share(ownerUserId, accountKey, [SHARED_WITH_EVERYONE])
      }
      return store
    },
    target: (store) => store,
    run: (store) => managedKeyFor(store.accounts, viewer, provider),
    check: (result) =>
      expect(result).toMatchObject({ accountKey: earlier, credential: 'credential-0' }),
    teardown: (store) => store.close(),
  }
  await expectConstantStatements(pin, 2)
  await expectArmed(pin, 2, (store, size) => {
    const original = store.accounts.sharedWith.bind(store.accounts)
    const spy = vi.spyOn(store.accounts, 'sharedWith').mockImplementation(async (...args) => {
      for (let index = 0; index < size; index++)
        await store.accounts.own(asUserId(`mem_owner_${index}`), provider)
      return original(...args)
    })
    return () => spy.mockRestore()
  })
})
