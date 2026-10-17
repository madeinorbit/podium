/**
 * The repository loaders [POD-6149] against a real store, counted at the driver:
 * several loads in one tick are one query, a loaded row is reused for the rest
 * of the operation, nothing is reused by the next operation, and a write is
 * seen by the reads after it.
 */
import { asMachineId, asSessionId, asUserId, type UserId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import type { SessionStore } from '../store'
import { withOperation } from './executor/operation-scope'
import { withReadScope } from './executor/read-scope'
import { openTestStore } from '../test-support/open-test-store'
import { countStatements } from '../test-support/statement-count'
import type { StoreQueries } from './executor/sync-drizzle'
import { type GrantRow, GrantsRepository } from './grants'
import type { SessionRow } from './types'

const owner = asUserId('owner')

const grant = (resourceId: string, grantee: string): GrantRow => ({
  resourceKind: 'issue',
  resourceId,
  grantee,
  verb: 'read',
  owner,
  visibility: 'private',
  createdAt: '2026-10-15T00:00:00.000Z',
  actorKind: 'user',
  actorId: owner,
  onBehalfOf: null,
})

const session = (id: string, spawnedBy: string | null = null): SessionRow => ({
  id: asSessionId(id),
  ownerUserId: owner,
  agentKind: 'claude-code',
  cwd: '/repo',
  title: id,
  name: null,
  nameSource: null,
  originKind: 'spawn',
  conversationId: null,
  resumeKind: null,
  resumeValue: null,
  status: 'live',
  exitCode: null,
  spawnFailure: null,
  durableLabel: `label-${id}`,
  createdAt: '2026-10-15T00:00:00.000Z',
  lastActiveAt: '2026-10-15T00:00:00.000Z',
  geometry: { cols: 80, rows: 24 },
  archived: false,
  workState: null,
  machineId: asMachineId('machine-1'),
  lastOutputAt: null,
  lastInputAt: null,
  lastResumedAt: null,
  spawnedBy,
})

async function withStore(fn: (store: SessionStore) => Promise<void>): Promise<void> {
  const store = await openTestStore(':memory:')
  try {
    await fn(store)
  } finally {
    await store.close()
  }
}

describe('GrantsRepository.loadForResource', () => {
  it('one query for a tick of loads, reuse within the operation, none across operations', async () => {
    await withStore(async (store) => {
      await store.grants.upsert(grant('iss_a', 'alice'))
      await store.grants.upsert(grant('iss_b', 'bob'))
      const loads = () =>
        Promise.all(['iss_a', 'iss_b', 'iss_none'].map((id) => store.grants.loadForResource('issue', id)))
      await withReadScope(async () => {
        const first = await countStatements(store, loads)
        expect(first.statements).toBe(1)
        expect(first.result.map((rows) => rows.map((row) => row.grantee))).toEqual([['alice'], ['bob'], []])
        // "No grants" is remembered too.
        expect((await countStatements(store, loads)).statements).toBe(0)
      })
      await withReadScope(async () => expect((await countStatements(store, loads)).statements).toBe(1))
      // Outside an explicit scope every load is its own live read.
      expect((await countStatements(store, loads)).statements).toBe(3)
    })
  })

  it('sees a grant written earlier in the same operation', async () => {
    await withStore(async (store) => {
      await withReadScope(async () => {
        expect(await store.grants.loadForResource('issue', 'iss_a')).toEqual([])
        await store.grants.upsert(grant('iss_a', 'alice'))
        expect((await store.grants.loadForResource('issue', 'iss_a')).map((row) => row.grantee)).toEqual(['alice'])
        await store.grants.remove('issue', 'iss_a', 'alice', 'read')
        expect(await store.grants.loadForResource('issue', 'iss_a')).toEqual([])
      })
    })
  })
})

// POD-6189: inside a write span the loader used to read live on every check.
// It now memoises there too; these pin the read-your-writes and lifetime rules.
describe('GrantsRepository.loadForResource inside a write span', () => {
  const grantees = (rows: GrantRow[]) => rows.map((row) => row.grantee)

  it('one read per resource for repeated checks, and sees its own grant and revoke', async () => {
    await withStore(async (store) => {
      await store.grants.upsert(grant('iss_b', 'bob'))
      await store.transact(async () => {
        const check = () =>
          Promise.all(['iss_a', 'iss_b', 'iss_a'].map((id) => store.grants.loadForResource('issue', id)))
        expect((await countStatements(store, check)).statements).toBe(1)
        expect((await countStatements(store, check)).statements).toBe(0)
        // A savepoint of a span that has not written grants shares its memo.
        await store.transact(async () => expect((await countStatements(store, check)).statements).toBe(0))
        await store.grants.upsert(grant('iss_a', 'alice'))
        expect(grantees(await store.grants.loadForResource('issue', 'iss_a'))).toEqual(['alice'])
        await store.grants.remove('issue', 'iss_a', 'alice', 'read')
        expect(await store.grants.loadForResource('issue', 'iss_a')).toEqual([])
        expect(grantees(await store.grants.loadForResource('issue', 'iss_b'))).toEqual(['bob'])
      })
    })
  })

  it('reuses nothing across operations; inside one operation, an answer from before its span', async () => {
    await withStore(async (store) => {
      const once = () => store.grants.loadForResource('issue', 'iss_a')
      await store.transact(async () => expect((await countStatements(store, once)).statements).toBe(1))
      await store.transact(async () => expect((await countStatements(store, once)).statements).toBe(1))
      await withReadScope(async () => {
        expect((await countStatements(store, once)).statements).toBe(1)
        await store.transact(async () => expect((await countStatements(store, once)).statements).toBe(0))
        expect((await countStatements(store, once)).statements).toBe(0)
      })
      await withReadScope(async () => expect((await countStatements(store, once)).statements).toBe(1))
    })
  })

  it('a second operation sees a grant the first one memoised the absence of', async () => {
    await withStore(async (store) => {
      await withReadScope(async () => {
        await store.transact(async () => expect(await store.grants.loadForResource('issue', 'iss_a')).toEqual([]))
      })
      await store.grants.upsert(grant('iss_a', 'alice'))
      await withReadScope(async () => {
        await store.transact(async () =>
          expect(grantees(await store.grants.loadForResource('issue', 'iss_a'))).toEqual(['alice']))
      })
    })
  })

  it('forgets a grant written in a savepoint that rolled back', async () => {
    await withStore(async (store) => {
      await withReadScope(async () => {
        await store.transact(async () => {
          expect(await store.grants.loadForResource('issue', 'iss_a')).toEqual([])
          await expect(store.transact(async () => {
            await store.grants.upsert(grant('iss_a', 'alice'))
            expect(grantees(await store.grants.loadForResource('issue', 'iss_a'))).toEqual(['alice'])
            throw new Error('roll the savepoint back')
          })).rejects.toThrow('roll the savepoint back')
          expect(await store.grants.loadForResource('issue', 'iss_a')).toEqual([])
        })
        // The operation's memo after the span holds nothing the rollback undid.
        expect(await store.grants.loadForResource('issue', 'iss_a')).toEqual([])
      })
      expect(await store.grants.loadForResource('issue', 'iss_a')).toEqual([])
    })
  })

  it('forgets what a span read after its own grant write when the span rolls back', async () => {
    await withStore(async (store) => {
      await withReadScope(async () => {
        await expect(store.transact(async () => {
          await store.grants.upsert(grant('iss_a', 'alice'))
          expect(grantees(await store.grants.loadForResource('issue', 'iss_a'))).toEqual(['alice'])
          throw new Error('roll the span back')
        })).rejects.toThrow('roll the span back')
        expect(await store.grants.loadForResource('issue', 'iss_a')).toEqual([])
      })
    })
  })
})

// POD-6189: one operation (a daemon frame, a tRPC call) reads a resource's
// grants once across all its phases, and no further.
describe('GrantsRepository.loadForResource for a whole operation', () => {
  const grantees = (rows: GrantRow[]) => rows.map((row) => row.grantee)

  it('one read before, inside and after its write span; none shared with the next operation', async () => {
    await withStore(async (store) => {
      const once = () => store.grants.loadForResource('issue', 'iss_a')
      const phases = async () => {
        await once()
        await store.transact(async () => {
          await once()
          await store.transact(async () => await once())
        })
        await once()
        await store.grants.loadForResources('issue', ['iss_a'])
      }
      expect((await countStatements(store, () => withOperation(phases))).statements).toBe(1)
      expect((await countStatements(store, () => withOperation(phases))).statements).toBe(1)
      // With no operation, the spans read once each and the plain reads live.
      expect((await countStatements(store, phases)).statements).toBe(4)
    })
  })

  // POD-6217: the kinds a write's passes ask about are one read, and the later
  // pass of either kind finds its answer in the operation's memo.
  it('reads several kinds in one statement, only the pairs asked, and memoises each', async () => {
    await withStore(async (store) => {
      for (const [kind, id, grantee] of [
        ['issue', 'iss_a', 'alice'],
        ['session', 's1', 'bob'],
        // The read crosses the kinds with the ids: these two must not leak in.
        ['session', 'iss_a', 'carol'],
        ['issue', 's1', 'dave'],
      ] as const) {
        await store.grants.upsert({ ...grant(id, grantee), resourceKind: kind })
      }
      await withOperation(async () => {
        const first = await countStatements(store, () =>
          store.grants.loadForResourcesOfKinds({ issue: ['iss_a', 'iss_none'], session: ['s1'] }))
        expect(first.statements).toBe(1)
        expect([...first.result].map(([kind, rows]) => [kind, [...rows].map(([id, edges]) => [id, grantees(edges)])]))
          .toEqual([
            ['issue', [['iss_a', ['alice']], ['iss_none', []]]],
            ['session', [['s1', ['bob']]]],
          ])
        const later = await countStatements(store, async () => [
          grantees(await store.grants.loadForResource('session', 's1')),
          grantees((await store.grants.loadForResources('issue', ['iss_a'])).get('iss_a') ?? []),
        ])
        expect(later.statements).toBe(0)
        expect(later.result).toEqual([['bob'], ['alice']])
      })
    })
  })

  it('sees its own grant and revoke, across the span boundary too', async () => {
    await withStore(async (store) => {
      await withOperation(async () => {
        expect(await store.grants.loadForResource('issue', 'iss_a')).toEqual([])
        await store.transact(async () => {
          expect(await store.grants.loadForResource('issue', 'iss_a')).toEqual([])
          await store.grants.upsert(grant('iss_a', 'alice'))
          expect(grantees(await store.grants.loadForResource('issue', 'iss_a'))).toEqual(['alice'])
        })
        expect(grantees(await store.grants.loadForResource('issue', 'iss_a'))).toEqual(['alice'])
        await store.grants.remove('issue', 'iss_a', 'alice', 'read')
        expect(await store.grants.loadForResource('issue', 'iss_a')).toEqual([])
      })
    })
  })

  it('forgets an answer a rolled-back savepoint read after its write', async () => {
    await withStore(async (store) => {
      await withOperation(async () => {
        await store.transact(async () => {
          expect(await store.grants.loadForResource('issue', 'iss_a')).toEqual([])
          await expect(store.transact(async () => {
            await store.grants.upsert(grant('iss_a', 'alice'))
            expect(grantees(await store.grants.loadForResource('issue', 'iss_a'))).toEqual(['alice'])
            throw new Error('roll the savepoint back')
          })).rejects.toThrow('roll the savepoint back')
          expect(await store.grants.loadForResource('issue', 'iss_a')).toEqual([])
        })
        expect(await store.grants.loadForResource('issue', 'iss_a')).toEqual([])
      })
    })
  })

  it('a second operation does not see the first one\'s answer', async () => {
    await withStore(async (store) => {
      await withOperation(async () => expect(await store.grants.loadForResource('issue', 'iss_a')).toEqual([]))
      // Written through a SECOND repository over the same database, whose
      // invalidation does not reach the store's loader: a reused answer would
      // still say "no grants".
      const queries = (store as unknown as { queries: StoreQueries }).queries
      await new GrantsRepository(queries).upsert(grant('iss_a', 'mallory'))
      await withOperation(async () =>
        expect(grantees(await store.grants.loadForResource('issue', 'iss_a'))).toEqual(['mallory']))
    })
  })
})

describe('SessionsRepository.loadSession', () => {
  it('one query for a tick of loads, reuse within the operation, none across operations', async () => {
    await withStore(async (store) => {
      await store.sessions.upsertSession(session('s1'))
      await store.sessions.upsertSession(session('s2'))
      const loads = () =>
        Promise.all(['s1', 's2', 'absent'].map((id) => store.sessions.loadSession(asSessionId(id))))
      await withReadScope(async () => {
        const first = await countStatements(store, loads)
        expect(first.statements).toBe(1)
        expect(first.result.map((row) => row?.id)).toEqual(['s1', 's2', undefined])
        expect((await countStatements(store, loads)).statements).toBe(0)
        // Each caller gets its own copy of a shared row.
        first.result[0]!.title = 'changed by one caller'
        expect((await store.sessions.loadSession(asSessionId('s1')))?.title).toBe('s1')
      })
      await withReadScope(async () => expect((await countStatements(store, loads)).statements).toBe(1))
      expect((await countStatements(store, loads)).statements).toBe(3)
    })
  })

  it('sees a session write made earlier in the same operation', async () => {
    await withStore(async (store) => {
      await withReadScope(async () => {
        expect(await store.sessions.loadSession(asSessionId('s1'))).toBeUndefined()
        await store.sessions.upsertSession(session('s1'))
        expect((await store.sessions.loadSession(asSessionId('s1')))?.spawnedBy ?? null).toBeNull()
        await store.sessions.upsertSession(session('s1', 'session:parent'))
        expect((await store.sessions.loadSession(asSessionId('s1')))?.spawnedBy).toBe('session:parent')
        await store.sessions.purgeSession(asSessionId('s1'))
        expect(await store.sessions.loadSession(asSessionId('s1'))).toBeUndefined()
      })
    })
  })

  // POD-6197. The read scope's one DataLoader took a root load and a span's load
  // of the same tick into one batch, dispatched at the root. That statement
  // waits for the lease the span holds, and the span waits for the batch: both
  // hung until the store closed ("scheduler is draining").
  it('a root load and a span load of the same tick neither share a batch nor deadlock', async () => {
    await withStore(async (store) => {
      await store.sessions.upsertSession(session('s1'))
      await store.sessions.upsertSession(session('s2'))
      const loads = withReadScope(async () =>
        await Promise.all([
          store.sessions.loadSession(asSessionId('s1')).then((row) => row?.id),
          store.transact(async () => (await store.sessions.loadSession(asSessionId('s2')))?.id),
          store.transact(async () => (await store.sessions.loadSession(asSessionId('s1')))?.id),
        ]))
      expect(await withinSeconds(loads, 5)).toEqual(['s1', 's2', 's1'])
    })
  })
})

// POD-6218: every session projection without a reader acts as the earliest
// admin, and the runtime-event paths read that member's settings, in several
// phases of one frame.
describe('UsersRepository.earliestAdmin for a whole operation', () => {
  const later = (id: string, createdAt: string, role: 'admin' | 'member' = 'admin') => ({
    id, displayName: id, role, createdAt, disabledAt: null,
  })

  it('one statement before, inside and after its write span; none shared with the next operation', async () => {
    await withStore(async (store) => {
      const phases = async () => {
        const ids = [(await store.users.earliestAdmin())?.id]
        await store.transact(async () => {
          ids.push((await store.users.earliestAdmin())?.id)
        })
        ids.push((await store.users.earliestAdmin())?.id)
        return ids
      }
      const first = await countStatements(store, () => withOperation(phases))
      expect(first.statements).toBe(1)
      expect(new Set(first.result).size).toBe(1)
      expect(first.result[0]).toBeDefined()
      expect((await countStatements(store, () => withOperation(phases))).statements).toBe(1)
      // With no operation each ask is one live read (the row, not the id and the row).
      expect((await countStatements(store, phases)).statements).toBe(3)
    })
  })

  it('sees an earlier admin created and a disable made in the same operation', async () => {
    await withStore(async (store) => {
      const original = (await store.users.earliestAdmin())!.id
      await store.users.create(later('mem_2BBBBBBBBBBBBBBBBBBBBBBBBBB', '2099-01-01T00:00:00.000Z'), 'scrypt:hash')
      await withOperation(async () => {
        expect((await store.users.earliestAdmin())?.id).toBe(original)
        await store.users.create(later('mem_0AAAAAAAAAAAAAAAAAAAAAAAAAA', '2000-01-01T00:00:00.000Z'), 'scrypt:hash')
        expect((await store.users.earliestAdmin())?.id).toBe('mem_0AAAAAAAAAAAAAAAAAAAAAAAAAA')
        await store.users.disable(asUserId('mem_0AAAAAAAAAAAAAAAAAAAAAAAAAA'), '2026-10-17T00:00:00.000Z')
        expect((await store.users.earliestAdmin())?.id).toBe(original)
        await store.transact(async () => {
          await store.users.disable(asUserId(original), '2026-10-17T00:00:01.000Z')
          expect((await store.users.earliestAdmin())?.id).toBe('mem_2BBBBBBBBBBBBBBBBBBBBBBBBBB')
        })
        expect((await store.users.earliestAdmin())?.id).toBe('mem_2BBBBBBBBBBBBBBBBBBBBBBBBBB')
      })
    })
  })

  it('forgets an admin a rolled-back span created', async () => {
    await withStore(async (store) => {
      const original = (await store.users.earliestAdmin())!.id
      await withOperation(async () => {
        expect((await store.users.earliestAdmin())?.id).toBe(original)
        await expect(store.transact(async () => {
          await store.users.create(later('mem_0AAAAAAAAAAAAAAAAAAAAAAAAAA', '2000-01-01T00:00:00.000Z'), 'scrypt:hash')
          expect((await store.users.earliestAdmin())?.id).toBe('mem_0AAAAAAAAAAAAAAAAAAAAAAAAAA')
          throw new Error('roll the span back')
        })).rejects.toThrow('roll the span back')
        expect((await store.users.earliestAdmin())?.id).toBe(original)
      })
    })
  })

  it('hands each caller its own copy', async () => {
    await withStore(async (store) => {
      await withOperation(async () => {
        const first = (await store.users.earliestAdmin())!
        first.displayName = 'changed by one caller'
        expect((await store.users.earliestAdmin())?.displayName).not.toBe('changed by one caller')
      })
    })
  })
})

describe('SettingsRepository.getSettingsFor for a whole operation', () => {
  const at = '2026-10-17T00:00:00.000Z'

  it('one read of each table for repeated asks; none shared with the next operation', async () => {
    await withStore(async (store) => {
      const user = (await store.users.earliestAdmin())!.id as UserId
      const asks = async () => {
        await store.settings.getSettingsFor(user)
        await store.transact(async () => await store.settings.getSettingsFor(user))
        return await store.settings.getSettingsFor(user)
      }
      expect((await countStatements(store, () => withOperation(asks))).statements).toBe(2)
      expect((await countStatements(store, () => withOperation(asks))).statements).toBe(2)
      expect((await countStatements(store, asks)).statements).toBe(6)
    })
  })

  it('sees a personal and an instance write made in the same operation, across its span', async () => {
    await withStore(async (store) => {
      const user = (await store.users.earliestAdmin())!.id as UserId
      await withOperation(async () => {
        expect((await store.settings.getSettingsFor(user)).sidebar.repoSort).not.toBe('custom')
        await store.transact(async () => {
          await store.settings.applyPreferencePatch(user, { 'sidebar.repoSort': 'custom' }, at)
          expect((await store.settings.getSettingsFor(user)).sidebar.repoSort).toBe('custom')
        })
        expect((await store.settings.getSettingsFor(user)).sidebar.repoSort).toBe('custom')
        await store.settings.applyPreferencePatch(user, { 'gitWorkflow.mergeStyle': 'ask' }, at)
        expect((await store.settings.getSettingsFor(user)).gitWorkflow.mergeStyle).toBe('ask')
        await store.settings.userPreferences.clear(user, 'sidebar.repoSort')
        expect((await store.settings.getSettingsFor(user)).sidebar.repoSort).not.toBe('custom')
      })
    })
  })

  it('hands each caller its own copy', async () => {
    await withStore(async (store) => {
      const user = (await store.users.earliestAdmin())!.id as UserId
      await withOperation(async () => {
        const first = await store.settings.getSettingsFor(user)
        const stored = first.gitWorkflow.mergeStyle
        first.gitWorkflow.mergeStyle = stored === 'ask' ? 'pr' : 'ask'
        expect((await store.settings.getSettingsFor(user)).gitWorkflow.mergeStyle).toBe(stored)
      })
    })
  })
})

/** `work`, or a rejection naming the hang once `seconds` have passed. */
async function withinSeconds<T>(work: Promise<T>, seconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const hung = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`still waiting after ${seconds} s: deadlocked`)), seconds * 1000)
  })
  try {
    return await Promise.race([work, hung])
  } finally {
    clearTimeout(timer)
  }
}
