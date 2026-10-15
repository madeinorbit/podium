/**
 * The repository loaders [POD-6149] against a real store, counted at the driver:
 * several loads in one tick are one query, a loaded row is reused for the rest
 * of the operation, nothing is reused by the next operation, and a write is
 * seen by the reads after it.
 */
import { asMachineId, asSessionId, asUserId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import type { SessionStore } from '../store'
import { withReadScope } from './executor/read-scope'
import { openTestStore } from '../test-support/open-test-store'
import { countStatements } from '../test-support/statement-count'
import type { GrantRow } from './grants'
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
})
