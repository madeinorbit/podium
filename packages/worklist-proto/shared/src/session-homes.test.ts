// @vitest-environment happy-dom
import { createKernelReplica, createSideCache, memoryStorage } from '@podium/client-core/replica'
import { createRowSource, type RowSourceRuntime } from '@podium/client-graph/shared/row-source'
import { asUserId, asSessionId, sessionUserStateRowId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { ScenarioCache } from './scenarios'

const key = (user: string, id = 's1') => sessionUserStateRowId(asUserId(user), asSessionId(id))
const at = '2026-10-01T12:00:00.000Z'
const row = {
  sessionId: 's1',
  issueId: 'i1',
  cwd: '/old/path',
  agentKind: 'codex',
  lastActiveAt: at,
  machineId: 'm1',
  refRepoId: 'r1',
  refSeq: 42,
  refLetter: 'A',
  handoffTargetMachineId: 'm2',
  displayRef: 'OLD-42-A',
  unread: true,
  readAt: null,
  snoozedUntil: null,
  machineName: 'Old source',
  condition: 'logged-out',
  handoffTarget: 'Old target',
}

function boot(mode: 'truth' | 'overlaid' = 'overlaid') {
  const cache = new ScenarioCache()
  cache.put('session', 's1', row)
  cache.put('session', 's2', {
    ...row,
    sessionId: 's2',
    refRepoId: 'r2',
    machineId: 'm3',
    handoffTargetMachineId: undefined,
  })
  cache.put('repo', 'r1', { id: 'r1', prefix: 'NEW', repoPath: '/different/path' })
  cache.put('machine', 'm1', { id: 'm1', name: 'Source', loggedOutHarnesses: [] })
  cache.put('machine', 'm2', { id: 'm2', name: 'Target', loggedOutHarnesses: [] })
  cache.put('sessionUserState', key('b'), { userId: 'b', sessionId: 's1', readAt: at })
  cache.put('sessionUserState', key('a'), {
    userId: 'a',
    sessionId: 's1',
    readAt: null,
    snoozedUntil: null,
  })
  const replica = createKernelReplica({
    cache,
    side: createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] }),
  })
  const pending = new Map()
  const snapshot = { repos: [] }
  const runtime: RowSourceRuntime = {
    principal: { userId: 'b' },
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    pendingOverlaysByRow: () => pending,
  }
  const handle = createRowSource(runtime, replica, { mode })
  const push = (entity: string, id: string, payload?: unknown, op = 'upsert') => {
    if (op === 'upsert') {
      cache.put(entity as never, id, payload)
      replica.onKernelEvent({ type: 'upserted', record: cache.read(entity, id)!, readmitted: true })
    } else {
      cache.drop(entity as never, id)
      replica.onKernelEvent({
        type: op === 'evict' ? 'evicted' : 'removed',
        entity,
        entityId: id,
      } as never)
    }
  }
  return { cache, replica, handle, push, pending }
}

describe('session homes in the graph row source', () => {
  it('joins all values from their rows by id in both source modes', () => {
    for (const mode of ['truth', 'overlaid'] as const) {
      const { handle } = boot(mode)
      try {
        expect(handle.source.row!('session', 's1')).toMatchObject({
          displayRef: 'NEW-42-A',
          readAt: at,
          unread: false,
          snoozedUntil: undefined,
          machineName: 'Source',
          condition: undefined,
          handoffTarget: 'Target',
        })
      } finally {
        handle.dispose()
      }
    }
  })
  it('a prefix rename updates every dependent ref with no session resent or kind enumeration', () => {
    const { replica, handle, push } = boot()
    try {
      const another = { ...row, sessionId: 's3', refSeq: 43, refLetter: 'C' }
      push('session', 's3', another)
      handle.flush()
      handle.source.snapshot('worktree')
      const untouched = handle.source.row!('session', 's2')
      handle.stats.reset()
      push('repo', 'r1', { id: 'r1', prefix: 'RENAMED', repoPath: '/different/path' })
      const event = handle.flush()!
      expect(event.rows.filter((row) => row.kind === 'session').map((row) => row.id)).toEqual([
        's1', 's3',
      ])
      expect(handle.source.row!('session', 's1')).toHaveProperty('displayRef', 'RENAMED-42-A')
      expect(handle.source.row!('session', 's3')).toHaveProperty('displayRef', 'RENAMED-43-C')
      expect(replica.row!('sessions', 's3')).toBe(another)
      expect(handle.source.row!('session', 's2')).toBe(untouched)
      expect(replica.row!('sessions', 's1')).toBe(row)
      expect(handle.stats.enumerations).toBe(0)
    } finally {
      handle.dispose()
    }
  })
  it('machine and personal state changes emit only the joined sessions', () => {
    const { handle, push } = boot()
    try {
      push('machine', 'm2', { id: 'm2', name: 'Renamed target', loggedOutHarnesses: [] })
      expect(
        handle
          .flush()
          ?.rows.filter((row) => row.kind === 'session')
          .map((row) => row.id),
      ).toEqual(['s1'])
      expect(handle.source.row!('session', 's1')).toHaveProperty('handoffTarget', 'Renamed target')
      push('machine', 'm1', { id: 'm1', name: 'Source', loggedOutHarnesses: ['codex'] })
      handle.flush()
      expect(handle.source.row!('session', 's1')).toHaveProperty('condition', 'logged-out')
      push('sessionUserState', key('b'), {
        userId: 'b',
        sessionId: 's1',
        readAt: null,
        snoozedUntil: null,
      })
      expect(handle.flush()?.rows.map((row) => row.id)).toEqual(['s1'])
      expect(handle.source.row!('session', 's1')).toMatchObject({
        readAt: null,
        unread: true,
        snoozedUntil: null,
      })
      push('sessionUserState', key('a'), { userId: 'a', sessionId: 's1', readAt: at })
      expect(handle.flush()).toBeNull()
      expect(handle.source.row!('session', 's1')).toHaveProperty('readAt', null)
    } finally {
      handle.dispose()
    }
  })
  it('missing companions fall back on eviction and readmission restores the new truth', () => {
    const { handle, push } = boot()
    try {
      for (const [kind, id] of [
        ['sessionUserState', key('b')],
        ['repo', 'r1'],
        ['machine', 'm1'],
        ['machine', 'm2'],
      ]) {
        push(kind!, id!, undefined, 'evict')
        expect(handle.flush()?.rows.filter(row => row.kind === 'session').map(row => row.id)).toEqual(['s1'])
      }
      expect(handle.source.row!('session', 's1')).toMatchObject({
        displayRef: 'OLD-42-A',
        unread: true,
        snoozedUntil: null,
        machineName: 'Old source',
        condition: 'logged-out',
        handoffTarget: 'Old target',
      })
      push('sessionUserState', key('b'), { userId: 'b', sessionId: 's1', readAt: at })
      handle.flush()
      expect(handle.source.row!('session', 's1')).toMatchObject({
        readAt: at,
        unread: false,
        snoozedUntil: undefined,
      })
      push('session', 's1', undefined, 'remove')
      handle.flush()
      expect(handle.source.row!('session', 's1')).toBeUndefined()
      push('machine', 'm1', { id: 'm1', name: 'Again', loggedOutHarnesses: [] })
      expect(handle.flush()).toBeNull()
    } finally {
      handle.dispose()
    }
  })
  it('legacy read and snooze overlays still paint and rollback above new truth', () => {
    const { handle, pending, push } = boot()
    try {
      const truth = handle.source.row!('session', 's1')
      pending.set('s1', [
        {
          key: 'pending',
          entity: 'sessions',
          id: 's1',
          op: 'patch',
          patch: { unread: true, readAt: null, snoozedUntil: null },
          coveredBy: () => false,
        },
      ])
      expect(handle.source.row!('session', 's1')).toMatchObject({
        unread: true,
        readAt: null,
        snoozedUntil: null,
      })
      pending.clear()
      expect(handle.source.row!('session', 's1')).toBe(truth)
      push('session', 's1', {
        ...row,
        refRepoId: 'r2',
        machineId: 'm3',
        handoffTargetMachineId: undefined,
      })
      handle.flush()
      push('repo', 'r1', { id: 'r1', prefix: 'NO_LONGER_USED' })
      expect(handle.flush()?.rows.filter((row) => row.kind === 'session')).toEqual([])
    } finally {
      handle.dispose()
    }
  })
  it('rescope replaces personal join keys and removes old companion fan-out', () => {
    const { handle, cache, replica, push } = boot()
    try {
      cache.install([])
      cache.put('session', 's1', { ...row, refRepoId: 'r2', machineId: 'm3', handoffTargetMachineId: undefined })
      cache.put('sessionUserState', key('b'), { userId: 'b', sessionId: 's1', readAt: null })
      replica.onKernelEvent({ type: 'bootstrap-installed', cause: 'rescope', snapshotSeq: 4, entityCount: 2, bufferedFramesApplied: 0 })
      expect(handle.flush()?.type).toBe('replace')
      expect(handle.source.row!('session', 's1')).toHaveProperty('unread', true)
      push('machine', 'm1', { id: 'm1', name: 'Old scope', loggedOutHarnesses: [] })
      expect(handle.flush()).toBeNull()
      push('sessionUserState', key('b'), { userId: 'b', sessionId: 's1', readAt: at })
      expect(handle.flush()?.rows.map(row => row.id)).toEqual(['s1'])
      expect(handle.source.row!('session', 's1')).toHaveProperty('unread', false)
    } finally { handle.dispose() }
  })

})
