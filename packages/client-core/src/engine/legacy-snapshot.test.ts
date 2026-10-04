import type { SessionMeta } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { IssueMembershipWatch, LazyLists, SessionTopology } from './legacy-snapshot'
import type { EngineState } from './state'

describe('lazy lists (POD-5434)', () => {
  function lists() {
    const state = { sessions: ['s0'], issueProjections: [] } as unknown as EngineState
    let built = 0
    let truth: unknown = ['s1']
    const lazy = new LazyLists(state, (key) => {
      built++
      lazy.fill(key, truth)
    })
    return { state, lazy, built: () => built, setTruth: (value: unknown) => (truth = value) }
  }

  it('builds a stale list once, on its first read', () => {
    const { state, lazy, built } = lists()
    lazy.markStale('sessions')
    expect(built()).toBe(0)
    expect(state.sessions).toEqual(['s1'])
    expect(state.sessions).toEqual(['s1'])
    expect(built()).toBe(1)
  })

  it('a snapshot reads only the lists it is asked for', () => {
    const { lazy, built } = lists()
    lazy.markStale('sessions')
    lazy.markStale('issueProjections')
    const snapshot = {} as Record<string, unknown>
    lazy.snapshot(snapshot)
    expect(built()).toBe(0)
    expect(snapshot.sessions).toEqual(['s1'])
    expect(built()).toBe(1)
  })

  it('an older snapshot keeps the list it was built at', () => {
    const { lazy, setTruth } = lists()
    const before = {} as Record<string, unknown>
    lazy.snapshot(before)
    // Read at its version, then the list changes.
    expect(before.sessions).toEqual(['s0'])
    lazy.markStale('sessions')
    setTruth(['s2'])
    const after = {} as Record<string, unknown>
    lazy.snapshot(after)
    expect(after.sessions).toEqual(['s2'])
    expect(before.sessions).toEqual(['s0'])
  })

  it('an eager write is a change of its own', () => {
    const { state, lazy } = lists()
    const before = {} as Record<string, unknown>
    lazy.snapshot(before)
    ;(state as unknown as Record<string, unknown>).sessions = ['painted']
    expect(state.sessions).toEqual(['painted'])
    expect(before.sessions).toEqual(['s0'])
  })
})

const row = (id: string, fields: Partial<SessionMeta> = {}): SessionMeta =>
  ({
    sessionId: id,
    cwd: '/w',
    status: 'live',
    lastActiveAt: '2026-07-01T00:00:00.000Z',
    ...fields,
  }) as SessionMeta

describe('session topology by row (POD-5434)', () => {
  function topology(rows: SessionMeta[]) {
    const byId = new Map(rows.map((r) => [r.sessionId as string, r]))
    const tracked = new SessionTopology(() => [...byId.values()])
    return {
      write(next: SessionMeta | string) {
        if (typeof next === 'string') byId.delete(next)
        else byId.set(next.sessionId as string, next)
        const id = typeof next === 'string' ? next : (next.sessionId as string)
        return tracked.update([id], (key) => byId.get(key))
      },
    }
  }

  it('activity alone moves nothing; a rehome, a move, an arrival and a removal do', () => {
    const t = topology([row('a'), row('b')])
    expect(t.write(row('a', { lastActiveAt: '2026-07-02T00:00:00.000Z' }))).toBe(false)
    expect(t.write(row('a', { issueId: 'i2' as never }))).toBe(true)
    expect(t.write(row('a', { issueId: 'i2' as never, cwd: '/x' }))).toBe(true)
    expect(t.write(row('c'))).toBe(true)
    expect(t.write('b')).toBe(true)
  })

  it('a parked twin that takes over its resume group moves the list', () => {
    const resume = { kind: 'claude-code', value: 'r' } as never
    const parked = (id: string, at: string) =>
      row(id, { resume, status: 'hibernated', lastActiveAt: at })
    const t = topology([
      parked('a', '2026-07-01T00:00:02.000Z'),
      parked('b', '2026-07-01T00:00:01.000Z'),
    ])
    // The hidden twin's activity stays behind the shown one: nothing moves.
    expect(t.write(parked('b', '2026-07-01T00:00:01.500Z'))).toBe(false)
    // Now it is the most recent: the group shows the other row.
    expect(t.write(parked('b', '2026-07-01T00:00:03.000Z'))).toBe(true)
    // A live twin keeps the whole group visible; its activity moves nothing.
    expect(t.write(row('a', { resume, status: 'live' }))).toBe(true)
    expect(
      t.write(row('a', { resume, status: 'live', lastActiveAt: '2026-07-09T00:00:00.000Z' })),
    ).toBe(false)
  })
})

describe('issue membership of open workspaces (POD-5434)', () => {
  function watch(workspaces: string[], members: Record<string, string[]>) {
    const issues = new Map<string, Record<string, unknown>>([
      ['root', { id: 'root' }],
      ['m1', { id: 'm1', parentId: 'root', stage: 'started' }],
      ['other', { id: 'other', parentId: 'elsewhere' }],
    ])
    const w = new IssueMembershipWatch({
      workspaceKeys: () => workspaces,
      members: (root) => new Set(members[root] ?? []),
      issue: (id) => issues.get(id),
      sessionIssue: () => undefined,
    })
    return {
      write(id: string, patch: Record<string, unknown>) {
        issues.set(id, { ...issues.get(id), ...patch })
        return w.moved(new Set([id]))
      },
    }
  }

  it('a title on a member moves nothing; a parent, stage or archive does', () => {
    const w = watch(['mission:root'], { root: ['root', 'm1'] })
    // A member first seen in the batch that changes it has no "before": a yes.
    expect(w.write('m1', { title: 'first' })).toBe(true)
    expect(w.write('m1', { title: 'renamed' })).toBe(false)
    expect(w.write('m1', { stage: 'done' })).toBe(true)
    expect(w.write('m1', { archived: true })).toBe(true)
    expect(w.write('m1', { parentId: 'elsewhere' })).toBe(true)
  })

  it('an issue outside every open workspace moves nothing, until it joins one', () => {
    const w = watch(['mission:root'], { root: ['root', 'm1'] })
    expect(w.write('other', { title: 'x', stage: 'done' })).toBe(false)
    expect(w.write('other', { parentId: 'm1' })).toBe(true)
  })

  it('without an open mission or issue workspace nothing is watched', () => {
    const w = watch(['wt:/w'], {})
    expect(w.write('m1', { parentId: 'elsewhere' })).toBe(false)
  })
})
