import { asAccountId, asUserId } from '@podium/model'
import { expect, it, vi } from 'vitest'
import { managedKeyFor } from '../modules/sessions/account-env'
import { openPeopleStoreSlice, type PeopleStoreSlice } from '../test-support/people-store-slice'
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
  const pin: StatementPin<PeopleStoreSlice> = {
    name: 'managed provider resolution with workspace aliases',
    setup: async (size) => {
      const store = await openPeopleStoreSlice()
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
    target: (store) => store.probeTarget,
    // A read, through the accounts repository NOT drained: on Postgres the drain's own
    // statements would be counted with the reads.
    run: (store) => managedKeyFor(store.undrained.accounts, viewer, provider),
    check: (result) =>
      expect(result).toMatchObject({ accountKey: earlier, credential: 'credential-0' }),
    teardown: (store) => store.close(),
  }
  await expectConstantStatements(pin, 2)
  await expectArmed(pin, 2, (store, size) => {
    const accounts = store.undrained.accounts
    const original = accounts.sharedWith.bind(accounts)
    const spy = vi.spyOn(accounts, 'sharedWith').mockImplementation(async (...args) => {
      for (let index = 0; index < size; index++)
        await accounts.own(asUserId(`mem_owner_${index}`), provider)
      return original(...args)
    })
    return () => spy.mockRestore()
  })
})
