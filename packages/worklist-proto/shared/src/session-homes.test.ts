// @vitest-environment happy-dom
import { createKernelReplica, createSideCache, memoryStorage } from '@podium/client-core/replica'
import { type OverlayTarget, type PendingOverlay, withKeyedInputs } from '@podium/client-core/engine'
import { type RowSourceRuntime } from '@podium/client-graph/shared/row-source'
import { createRowSource } from './row-source'
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

function boot(mode: 'truth' | 'pooled' = 'pooled') {
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
  const pending = new Map<string, PendingOverlay[]>()
  const pendingUsers = new Map<string, PendingOverlay[]>()
  const none = new Map<string, PendingOverlay[]>()
  const listeners = new Set<() => void>()
  // A ledger paint moves a painted list (POD-5433): `notify` stands for one.
  const snapshot: { repos: never[]; sessions: unknown[] } = { repos: [], sessions: [] }
  const runtime: RowSourceRuntime = withKeyedInputs({
    principal: { userId: 'b' },
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    pendingOverlaysByRow: (kind: OverlayTarget) =>
      kind === 'sessions' ? pending : kind === 'sessionUserStates' ? pendingUsers : none,
  })
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
  const notify = () => {
    snapshot.sessions = []
    for (const listener of listeners) listener()
  }
  return { cache, replica, handle, push, pending, pendingUsers, notify }
}

describe('session homes in the graph row source', () => {
  it.each(['truth', 'pooled'] as const)('keeps missing personal homes pending until bootstrap in %s mode', mode => {
    const { handle, replica } = boot(mode)
    try {
      expect(handle.source.row!('session', 's1')).toHaveProperty('unread', false)
      expect(handle.source.row!('session', 's2')).toHaveProperty('unread', false)
      replica.onKernelEvent({ type: 'bootstrap-installed', cause: 'cold-start', snapshotSeq: 1, entityCount: 7, bufferedFramesApplied: 0 })
      handle.flush()
      expect(handle.source.row!('session', 's1')).toHaveProperty('unread', false)
      expect(handle.source.row!('session', 's2')).toHaveProperty('unread', true)
    } finally {
      handle.dispose()
    }
  })
  it('joins all values from their rows by id in both source modes', () => {
    for (const mode of ['truth', 'pooled'] as const) {
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
        's1',
        's3',
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
  it.each(['evict', 'remove'])('ignores stale fields after companion %s and rejoins on readmission', op => {
    const { handle, replica, push } = boot()
    try {
      replica.onKernelEvent({ type: 'bootstrap-installed', cause: 'cold-start', snapshotSeq: 1, entityCount: 7, bufferedFramesApplied: 0 })
      handle.flush()
      for (const [kind, id] of [
        ['sessionUserState', key('b')],
        ['repo', 'r1'],
        ['machine', 'm1'],
        ['machine', 'm2'],
      ]) {
        push(kind!, id!, undefined, op)
        expect(
          handle
            .flush()
            ?.rows.filter((row) => row.kind === 'session')
            .map((row) => row.id),
        ).toEqual(['s1'])
      }
      expect(handle.source.row!('session', 's1')).toMatchObject({
        displayRef: undefined,
        readAt: null,
        unread: true,
        snoozedUntil: undefined,
        machineName: '',
        condition: undefined,
        handoffTarget: undefined,
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
  const personalEdits = [
    { name: 'mark read', before: { readAt: null }, patch: { readAt: at }, shown: { readAt: at, unread: false } },
    { name: 'mark unread', before: { readAt: at }, patch: { readAt: null }, shown: { readAt: null, unread: true } },
    { name: 'snooze', before: { readAt: at }, patch: { snoozedUntil: null }, shown: { readAt: at, unread: false, snoozedUntil: null } },
    { name: 'clear snooze', before: { readAt: at, snoozedUntil: null }, patch: { snoozedUntil: undefined }, shown: { readAt: at, unread: false, snoozedUntil: undefined } },
  ]
  for (const edit of personalEdits) {
    for (const mode of ['truth', 'pooled'] as const) {
      it(`${edit.name}: per-user paint and rollback in ${mode} mode`, () => {
        const { handle, push, pendingUsers, notify } = boot(mode)
        try {
          push('sessionUserState', key('b'), { userId: 'b', sessionId: 's1', ...edit.before })
          handle.flush()
          const truth = handle.source.row!('session', 's1')
          const other = handle.source.row!('session', 's2')
          pendingUsers.set('s1', [{
            key: edit.name,
            entity: 'sessionUserStates',
            id: 's1',
            op: 'patch',
            patch: edit.patch,
            coveredBy: () => false,
          }])
          notify()
          const painted = handle.flush()
          if (mode === 'pooled') {
            expect(painted?.rows.map((row) => row.id)).toEqual(['s1'])
            expect(handle.source.row!('session', 's1')).toMatchObject(edit.shown)
          } else {
            expect(painted).toBeNull()
            expect(handle.source.row!('session', 's1')).toBe(truth)
          }
          expect(handle.source.row!('session', 's2')).toBe(other)
          pendingUsers.clear()
          notify()
          const rollback = handle.flush()
          expect(rollback?.rows.map((row) => row.id) ?? []).toEqual(mode === 'pooled' ? ['s1'] : [])
          expect(handle.source.row!('session', 's1')).toBe(truth)
        } finally {
          handle.dispose()
        }
      })
    }
  }
  it('joins an optimistic spawn with its per-user insert and emits its rollback', () => {
    const { handle, pending, pendingUsers, notify } = boot()
    try {
      const { readAt: _readAt, unread: _unread, snoozedUntil: _snooze, ...own } = row
      pending.set('spawn', [{
        key: 'spawn', entity: 'sessions', id: 'spawn', op: 'insert',
        insert: { ...own, sessionId: 'spawn' } as never,
      }])
      pendingUsers.set('spawn', [{
        key: 'spawn-user', entity: 'sessionUserStates', id: 'spawn', op: 'insert',
        insert: { userId: asUserId('b'), sessionId: asSessionId('spawn'), readAt: at },
      }])
      notify()
      expect(handle.flush()?.rows.map((row) => row.id)).toEqual(['spawn'])
      expect(handle.source.row!('session', 'spawn')).toMatchObject({ readAt: at, unread: false })
      expect(handle.source.snapshot('session').find((row) => row.id === 'spawn')?.value)
        .toMatchObject({ readAt: at, unread: false })
      pending.clear()
      pendingUsers.clear()
      notify()
      expect(handle.flush()?.rows).toEqual([{ kind: 'session', id: 'spawn', value: undefined }])
    } finally {
      handle.dispose()
    }
  })
  it('rescope replaces personal join keys and removes old companion fan-out', () => {
    const { handle, cache, replica, push } = boot()
    try {
      cache.install([])
      cache.put('session', 's1', {
        ...row,
        refRepoId: 'r2',
        machineId: 'm3',
        handoffTargetMachineId: undefined,
      })
      cache.put('sessionUserState', key('b'), { userId: 'b', sessionId: 's1', readAt: null })
      replica.onKernelEvent({
        type: 'bootstrap-installed',
        cause: 'rescope',
        snapshotSeq: 4,
        entityCount: 2,
        bufferedFramesApplied: 0,
      })
      expect(handle.flush()?.type).toBe('replace')
      expect(handle.source.row!('session', 's1')).toHaveProperty('unread', true)
      push('machine', 'm1', { id: 'm1', name: 'Old scope', loggedOutHarnesses: [] })
      expect(handle.flush()).toBeNull()
      push('sessionUserState', key('b'), { userId: 'b', sessionId: 's1', readAt: at })
      expect(handle.flush()?.rows.map((row) => row.id)).toEqual(['s1'])
      expect(handle.source.row!('session', 's1')).toHaveProperty('unread', false)
    } finally {
      handle.dispose()
    }
  })
})
