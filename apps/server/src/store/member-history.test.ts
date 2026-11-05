import { asUserId } from '@podium/model'
import { expect, it } from 'vitest'
import type { FamilyState } from '../modules/derived-family'
import { USAGE_QUERIES } from '../modules/misc-queries'
import { openTestStore } from '../test-support/open-test-store'
import { expectConstantStatements } from '../test-support/statement-count'

it('preserves a one-member daemon’s complete legacy usage response', async () => {
  const store = await openTestStore(':memory:')
  const usage = {
    hostname: 'sole-host',
    buckets: [
      {
        hour: '2026-11-01T00:00:00Z',
        model: 'native-unattributed',
        inputTokens: 20,
        outputTokens: 2,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        messages: 1,
      },
    ],
  }
  try {
    const owner = await store.users.soleActiveMember()
    if (!owner) throw new Error('missing sole member')
    const state = {
      store,
      caller: { userId: owner.id },
      privateAccess: { mayReadMachineFiles: async () => true },
      modules: {
        rpc: { answeringMachineId: async () => store.hostMachineId, usage: async () => usage },
      },
    } as unknown as FamilyState
    expect(await USAGE_QUERIES.summary.run(state, undefined)).toEqual(usage)
  } finally {
    await store.close()
  }
})

it('keeps a sole member compatible, but retained disabled people keep usage personal', async () => {
  const store = await openTestStore(':memory:')
  try {
    expect(await store.users.hasSeveralMembers()).toBe(false)
    await store.users.create(
      {
        id: asUserId('mem_retained'),
        displayName: 'Retained',
        role: 'member',
        createdAt: '2026-11-01T00:00:00Z',
        disabledAt: null,
      },
      'fixture-hash',
    )
    await store.users.disable(asUserId('mem_retained'), '2026-11-02T00:00:00Z')
    expect(await store.users.hasSeveralActiveMembers()).toBe(false)
    expect(await store.users.hasSeveralMembers()).toBe(true)
  } finally {
    await store.close()
  }
})

it('checks retained membership in one statement at 5 and 200 people', async () => {
  await expectConstantStatements(
    {
      name: 'retained membership bounds the usage compatibility fallback',
      setup: async (size) => {
        const store = await openTestStore(':memory:')
        for (let n = 1; n < size; n += 1) {
          const id = asUserId(`mem_retained_${n}`)
          await store.users.create(
            {
              id,
              displayName: 'Retained',
              role: 'member',
              createdAt: '2026-11-01T00:00:00Z',
              disabledAt: null,
            },
            'fixture-hash',
          )
          await store.users.disable(id, '2026-11-02T00:00:00Z')
        }
        return store
      },
      target: (store) => store,
      run: (store) => store.users.hasSeveralMembers(),
      check: (result) => expect(result).toBe(true),
      teardown: async (store) => await store.close(),
    },
    1,
  )
})
