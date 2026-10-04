import type { ClientRuntime } from '@podium/client-core/engine'
import { autorun, observable } from 'mobx'
import { expect, it, vi } from 'vitest'
import { createMobileSessionReader, createMobileSessionSource } from './mobile-session-context'
import { MobxPool } from './pool'
import { LOADING } from './worklist/rollup'

it('demands only the declared borrowed window, coalesces loading, and tears down the existing owner subscriptions', async () => {
  const addressed = new Set<() => void>()
  let cursor: number | null = null
  const readLocal = vi.fn(() => {
    throw new Error('The cursor source must not read runtime locals')
  })
  const getCursor = vi.fn(() => cursor)
  const owner = {
    readLocal,
    onLocals: () => {
      throw new Error('Spawn prompts belong to the pool log')
    },
    replica: {
      getCursor,
      subscribeCursor: (fn: () => void) => {
        addressed.add(fn)
        return () => {
          addressed.delete(fn)
        }
      },
    },
  } as unknown as ClientRuntime
  const pool = new MobxPool({ coarseNow: 0, selectedIssueId: null })
  const source = createMobileSessionSource(owner, pool)
  expect(readLocal).not.toHaveBeenCalled()
  expect(source.read('mobileSessionReader')).toBeTypeOf('object')
  expect(source.read('mobileSessionWindow')).toBe(LOADING)
  expect(source.read('mobileSessionWindow')).toBe(LOADING)
  await Promise.resolve()
  expect(readLocal).not.toHaveBeenCalled()
  expect(getCursor).toHaveBeenCalledTimes(1)
  expect(source.read('mobileSessionWindow')).toEqual({ cursor: null })
  // The cursor alone moves on its own signal (POD-5433). Watched, not read:
  // a read schedules its own refresh.
  let seen: unknown
  const stopWatch = autorun(() => {
    seen = source.read('mobileSessionWindow')
  })
  await Promise.resolve()
  cursor = 27
  for (const fn of addressed) fn()
  await Promise.resolve()
  expect(seen).toEqual({ cursor: 27 })
  stopWatch()
  source.dispose()
  source.dispose()
  expect(addressed.size).toBe(0)
  expect(source.read('mobileSessionWindow')).toBe(LOADING)
  pool.dispose()
})

it('keeps spawn confirmation loading until the shared pane source is attached and answers undefined routes without demand', () => {
  const pool = new MobxPool({ coarseNow: 0, selectedIssueId: null }),
    reader = createMobileSessionReader(pool)
  expect(reader.spawnPending(undefined)).toBe(false)
  expect(reader.spawnPrompt(undefined)).toBeUndefined()
  expect(reader.session(undefined)).toBeUndefined()
  expect(reader.issue(undefined)).toBeUndefined()
  expect(reader.exit(undefined)).toBeUndefined()
  expect(reader.spawnPending('not-attached')).toBe(LOADING)
  expect(reader.booting()).toBe(true)
  pool.attachTransactions({
    mutate: vi.fn(),
    spawnPrompts: observable.map([['provisional', null]]),
  } as never)
  pool.sources.register(['sessionPaneWindow'], {
    read: () => ({
      panelMode: {},
      dockShells: {},
      reposLoaded: false,
    }),
    dispose() {},
  })
  expect(reader.spawnPending('provisional')).toBe(true)
  expect(reader.spawnPending('confirmed')).toBe(false)
  pool.sources.register(['mobileSessionWindow'], {
    read: () => ({ cursor: null }),
    dispose() {},
  })
  pool.sources.register(['chatSessionOrder', 'chatIssueOrder'], {
    read: () => ({ ids: [] }),
    dispose() {},
  })
  expect(reader.booting()).toBe(true)
  // The first provisional row can arrive before the replica cursor or order.
  pool.apply({
    type: 'update',
    rows: [
      {
        kind: 'session',
        id: 'provisional',
        value: {
          sessionId: 'provisional',
          agentKind: 'codex',
          status: 'starting',
          archived: false,
          cwd: '/synthetic/project',
          lastActiveAt: '2026-10-03T00:00:00Z',
        } as never,
      },
    ],
  })
  expect(reader.booting()).toBe(false)
  pool.dispose()
})

it('answers spawn prompts from the pool log while it owns sessions (POD-5432)', () => {
  for (const ownsSessions of [true, false]) {
    const pool = new MobxPool({ coarseNow: 0, selectedIssueId: null }),
      reader = createMobileSessionReader(pool)
    const spawnPrompts = observable.map<string, string | null>([
      ['from-log', 'Log prompt'],
      ['no-prompt', null],
    ])
    pool.attachTransactions({ mutate: vi.fn(), spawnPrompts } as never, ownsSessions)
    pool.sources.register(['mobileSessionWindow'], {
      read: () => ({ cursor: null }),
      dispose: () => {},
    } as never)
    expect(reader.spawnPrompt('from-log')).toBe(ownsSessions ? 'Log prompt' : undefined)
    expect(reader.spawnPrompt('no-prompt')).toBeUndefined()
    expect(reader.spawnPrompt('absent')).toBeUndefined()
    pool.dispose()
  }
})

it.each([
  1, 4,
])('counts only the declared issue roster, maintaining one changed key at %sx history', (scale) => {
  const pool = new MobxPool({ coarseNow: 0, selectedIssueId: null })
  const seat = (id: string, issueId = 'draft', archived = false) => ({
    kind: 'session' as const,
    id,
    value: {
      sessionId: id,
      issueId,
      refIssueId: issueId,
      agentKind: 'codex',
      cwd: '/repo',
      status: 'live',
      archived,
      lastActiveAt: '2026-10-01T00:00:00Z',
    } as never,
  })
  pool.apply({
    type: 'replace',
    rows: [
      seat('a'),
      seat('b'),
      seat('old', 'draft', true),
      ...Array.from({ length: scale * 32 }, (_, n) => seat(`unrelated-${n}`, 'outside')),
    ],
  })
  const reader = createMobileSessionReader(pool)
  const rows = vi.spyOn(pool, 'row'),
    members = vi.spyOn(pool.graph, 'many')
  let count: unknown
  const stop = autorun(() => {
    count = reader.issueAgentCount('draft')
  })
  try {
    expect(count).toBe(2)
    expect(
      new Set(rows.mock.calls.filter(([kind]) => kind === 'session').map(([, id]) => id)),
    ).toEqual(new Set(['a', 'b', 'old']))
    expect(members).toHaveBeenCalledExactlyOnceWith('issue', 'draft', 'missionSessions')
    rows.mockClear()
    members.mockClear()
    pool.apply({ type: 'update', rows: [seat('b', 'draft', true)] })
    expect(count).toBe(1)
    expect(
      new Set(rows.mock.calls.filter(([kind]) => kind === 'session').map(([, id]) => id)),
    ).toEqual(new Set(['b']))
    expect(members).not.toHaveBeenCalled()
    rows.mockClear()
    pool.apply({ type: 'update', rows: [seat('unrelated-0', 'outside', true)] })
    expect(count).toBe(1)
    expect(
      rows.mock.calls.filter(([kind, id]) => kind === 'session' && id !== 'unrelated-0'),
    ).toHaveLength(0)
  } finally {
    stop()
    rows.mockRestore()
    members.mockRestore()
    pool.dispose()
  }
})

it.each([
  1, 4,
])('reads phone issue chrome without seat or dependency demand at %sx history', (scale) => {
  const pool = new MobxPool({ coarseNow: 0, selectedIssueId: null })
  const seat = (id: string, archived = false) => ({
    kind: 'session' as const,
    id,
    value: {
      sessionId: id,
      issueId: 'draft',
      agentKind: 'codex',
      cwd: '/repo',
      status: 'live',
      archived,
      lastActiveAt: '2026-10-01T00:00:00Z',
    } as never,
  })
  pool.apply({
    type: 'replace',
    rows: [
      {
        kind: 'issue',
        id: 'draft',
        value: {
          id: 'draft',
          repoId: 'repo',
          repoPath: '/repo',
          seq: 7,
          title: 'New work',
          stage: 'planning',
          description: '',
          deps: [],
          labels: [],
          archived: false,
          createdAt: '2026-10-01T00:00:00Z',
          updatedAt: '2026-10-01T00:00:00Z',
          isDraftVessel: true,
          pinned: true,
        } as never,
      },
      {
        kind: 'worktree',
        id: '/repo',
        value: {
          path: '/repo',
          repoId: 'repo',
          repoPath: '/repo',
          repoName: 'Repo',
          prefix: 'POD',
        } as never,
      },
      ...Array.from({ length: scale * 32 }, (_, n) => seat(`seat-${n}`)),
    ],
  })
  const rows = vi.spyOn(pool, 'row'),
    members = vi.spyOn(pool.graph, 'many')
  const reader = createMobileSessionReader(pool)
  const chromeReads = vi.spyOn(reader, 'chromeIssue')
  let chrome: unknown
  const stop = autorun(() => {
    chrome = reader.chromeIssue('draft')
  })
  try {
    expect(chrome).toMatchObject({
      id: 'draft',
      title: 'New work',
      displayRef: 'POD-7',
      isDraftVessel: true,
      pinned: true,
    })
    expect(rows.mock.calls.filter(([kind]) => kind === 'session')).toHaveLength(0)
    expect(members).not.toHaveBeenCalled()
    rows.mockClear()
    chromeReads.mockClear()
    pool.apply({ type: 'update', rows: [seat('seat-0', true)] })
    expect(chromeReads).not.toHaveBeenCalled()
    // The pool maintains the changed contribution; the closed chrome stays asleep.
    expect(
      rows.mock.calls.filter(([kind, id]) => kind === 'session' && id !== 'seat-0'),
    ).toHaveLength(0)
  } finally {
    stop()
    rows.mockRestore()
    members.mockRestore()
    chromeReads.mockRestore()
    pool.dispose()
  }
})

it('checks booting without demanding chat catalog orders', () => {
  const pool = new MobxPool({ coarseNow: 0, selectedIssueId: null })
  pool.sources.register(['mobileSessionWindow'], {
    read: () => ({ cursor: null }),
    dispose() {},
  })
  const rows = vi.spyOn(pool, 'row')
  expect(createMobileSessionReader(pool).booting()).toBe(true)
  expect(
    rows.mock.calls.some(
      ([kind]) => String(kind) === 'chatSessionOrder' || String(kind) === 'chatIssueOrder',
    ),
  ).toBe(false)
  rows.mockRestore()
  pool.dispose()
})
