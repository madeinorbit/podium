import { headerEntities } from '@podium/client-graph/header-entities'
import { readStoreStats, storeStats } from '@podium/client-core/perf'
import { asClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider, StoreStatsProfiler } from '@podium/client-core/react'
import type { SessionView } from '@podium/client-core/session-values'
import { withKeyedInputs } from '@podium/client-core/test-support/keyed-inputs'
import { createSubscriptionStore } from '@podium/client-core/test-support/local-store'
import type { ReferenceState as Store } from '@podium/client-graph/diagnostics/reference-state'
import { MobxPool } from '@podium/client-graph/pool'
import { createPoolProjection } from '@podium/client-graph/runtime-pool'
import { asUserId, type GitRepositoryWire, type MachineWire } from '@podium/model'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { useMemo, useSyncExternalStore } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { startCensus } from '../../../../tests/worklist/harness/src/mobx-census'
import type { MobileTrpc } from '../client/trpc'
import { NewIssueScreen } from './NewIssueScreen'

const fixture = vi.hoisted(() => ({
  handle: null as unknown,
  pool: null as MobxPool | null,
  sessions: [] as SessionView[],
}))
vi.mock('../../../../packages/client-core/src/engine/runtime', () => ({
  createClientRuntime: () => fixture.handle,
}))
vi.mock('expo-router', () => ({ useRouter: () => ({ back() {}, replace() {} }) }))
vi.mock('../hooks/useContentBottomInset', () => ({ useContentBottomInset: () => 0 }))
vi.mock('../components/Screen', () => ({
  Screen: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
vi.mock('../components/LaunchConfigurationFields', () => ({
  LaunchConfigurationFields: () => null,
}))
vi.mock('../client/hooks', async (original) => {
  const real = await original<typeof import('../client/hooks')>()
  return { ...real, useSessions: () => fixture.sessions }
})
vi.mock('../client/mobile-pool', () => ({
  useMobilePoolProjection: <T,>(read: (pool: MobxPool) => T) => {
    const view = useMemo(() => createPoolProjection(fixture.pool!, read), [read])
    return useSyncExternalStore(view.subscribe, view.getSnapshot)
  },
}))
afterEach(() => {
  cleanup()
  storeStats.enable(false)
  storeStats.reset()
  fixture.sessions = []
})

it('keeps new-task repository order and open, keystroke and machine-update work flat at 1x and 4x', async () => {
  const cells: {
    scale: number
    action: string
    rowReads: number
    derivations: number
    neighbours: number
  }[] = []
  const now = Date.parse('2026-10-03T08:00:00Z')
  for (const scale of [1, 4]) {
    let rowReads = 0,
      machineReads = 0,
      measuring = false
    const repositories = ['z', 'a', 'm'].map((name) => ({
      path: `/repo/${name}`,
      kind: 'repository',
      worktrees: [{ path: `/work/${name}`, branch: 'main' }],
    })) as unknown as GitRepositoryWire[]
    const sessions = Array.from({ length: 1_200 * scale }, (_, index) => ({
      sessionId: `repository-history-${index}`,
      agentKind: 'claude-code',
      status: 'exited',
      archived: true,
      cwd: `/work/${['z', 'a', 'm'][index % 3]}/nested`,
      lastActiveAt: new Date(now - (index % 3) * 60_000 - 86_400_000).toISOString(),
      stoppedAt: new Date(now - 86_400_000).toISOString(),
    })) as unknown as SessionView[]
    fixture.pool = new MobxPool({ selectedIssueId: null, coarseNow: now }, undefined, {
      load: (_kind, id) => sessions.find((session) => session.sessionId === id),
      summaries: { session: ['sessionId', 'cwd', 'lastActiveAt', 'archived', 'status'] },
    })
    fixture.pool.apply({
      type: 'replace',
      rows: sessions.map((session) => ({ kind: 'session', id: session.sessionId, value: session })),
    })
    expect(fixture.pool.tables.session.size, 'historical sessions stay cold').toBe(0)
    headerEntities(fixture.pool).apply(
      repositories.map((value) => ({ kind: 'repository', id: value.path, value })),
    )
    headerEntities(fixture.pool).order(
      'repository',
      repositories.map((value) => value.path),
    )
    const machines = Array.from(
      { length: 128 * scale },
      (_, index) =>
        ({
          id: `unrelated-machine-${index}`,
          name: `Unrelated ${index}`,
        }) as MachineWire,
    )
    headerEntities(fixture.pool).apply(machines.map((value) => ({ kind: 'machine', id: value.id, value })))
    fixture.sessions = sessions.map(
      (session) =>
        new Proxy(session, {
          get(target, key, receiver) {
            if (measuring && key === 'cwd') rowReads++
            return Reflect.get(target, key, receiver)
          },
        }),
    )
    const row = fixture.pool.row.bind(fixture.pool)
    const spy = vi.spyOn(fixture.pool, 'row').mockImplementation(((
      ...args: Parameters<MobxPool['row']>
    ) => {
      if (measuring) {
        rowReads++
        if (String(args[0]) === 'machine') machineReads++
      }
      return row(...args)
    }) as MobxPool['row'])
    const owner = { start() {}, dispose() {}, destroy() {} }
    const trpc = { settings: { get: { query: async () => ({}) } } } as unknown as MobileTrpc
    fixture.handle = Object.assign(
      owner,
      createSubscriptionStore(
        {
          repos: repositories,
          sessions: fixture.sessions,
          trpc,
          coarseNow: now,
        } as unknown as Store<MobileTrpc>,
        undefined,
        owner,
      ),
      { access: { trpc } },
    )
    const census = startCensus({ sample: () => ({ rowReads }) })
    census.enter('open new task')
    measuring = true
    const view = render(
      <StoreProvider
        principal={asClientPrincipal(asUserId('test'))}
        config={{ httpOrigin: 'http://test', wsClientUrl: 'ws://test' }}
        api={trpc}
        onFatalError={() => {}}
        createReplicaFn={() => {
          throw new Error('mock runtime')
        }}
      >
        <NewIssueScreen />
      </StoreProvider>,
    )
    try {
      await act(async () => {})
      const choices = view.getAllByRole('radio', { name: /^Repository / })
      expect(choices.map((choice) => choice.getAttribute('aria-label'))).toEqual([
        'Repository z',
        'Repository a',
        'Repository m',
      ])
      expect(choices[0]?.getAttribute('aria-checked')).toBe('true')
      census.exit()
      const phase = census.snapshot().phases['open new task']!
      cells.push({
        scale,
        action: 'open',
        rowReads,
        derivations: phase.computedRuns + phase.reactionRuns,
        neighbours: choices.length,
      })
      expect(machineReads, 'repository paths and count never demand machine rows').toBe(0)
      for (const action of ['keystroke', 'machine update'] as const) {
        rowReads = 0
        census.enter(action)
        act(() => {
          if (action === 'keystroke') {
            fireEvent.change(view.getByPlaceholderText('What needs doing?'), {
              target: { value: 'A task' },
            })
          } else {
            headerEntities(fixture.pool!).apply([
              {
                kind: 'machine',
                id: machines[0]!.id,
                value: { ...machines[0]!, name: 'Renamed while creating' },
              },
            ])
          }
        })
        await act(async () => {})
        census.exit()
        const work = census.snapshot().phases[action]!
        expect(machineReads).toBe(0)
        expect(rowReads).toBe(0)
        cells.push({
          scale,
          action,
          rowReads,
          derivations: work.computedRuns + work.reactionRuns,
          neighbours: choices.length,
        })
      }
    } finally {
      measuring = false
      census.stop()
      spy.mockRestore()
      view.unmount()
      fixture.pool.dispose()
    }
  }
  console.info('[new task open work]', JSON.stringify(cells))
  for (const action of ['open', 'keystroke', 'machine update']) {
    const base = cells.find((cell) => cell.scale === 1 && cell.action === action)!
    const larger = cells.find((cell) => cell.scale === 4 && cell.action === action)!
    for (const metric of ['rowReads', 'derivations'] as const)
      expect(larger[metric], `new task ${action}: 4x/1x ${metric}`).toBe(base[metric])
  }
})

const repo = (path: string) =>
  ({ path, kind: 'repository', worktrees: [] }) as unknown as GitRepositoryWire

it('isolates NewIssueScreen from unrelated publishes while still painting repository updates', async () => {
  const results = []
  {
    fixture.pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
    headerEntities(fixture.pool).apply([{ kind: 'repository', id: '/before', value: repo('/before') }])
    headerEntities(fixture.pool).order('repository', ['/before'])
    const owner = { start() {}, dispose() {}, destroy() {} }
    const trpc = { settings: { get: { query: async () => ({}) } } } as unknown as MobileTrpc
    const store = createSubscriptionStore(
      {
        repos: [repo('/before')],
        sessions: [],
        trpc,
        coarseNow: 0,
      } as unknown as Store<MobileTrpc>,
      undefined,
      owner,
    )
    fixture.handle = Object.assign(owner, store, { access: { trpc } })
    const view = render(
      <StoreProvider
        principal={asClientPrincipal(asUserId('test'))}
        config={{ httpOrigin: 'http://test', wsClientUrl: 'ws://test' }}
        api={trpc}
        onFatalError={() => {}}
        createReplicaFn={() => {
          throw new Error('mock runtime')
        }}
      >
        <StoreStatsProfiler>
          <NewIssueScreen />
        </StoreStatsProfiler>
      </StoreProvider>,
    )
    await act(async () => {})
    expect(view.getByRole('radio', { name: 'Repository before' })).toBeTruthy()
    storeStats.enable()
    storeStats.reset()
    const window = storeStats.begin('feed')
    for (const coarseNow of [1, 2, 3]) {
      act(() => store.publish({ ...store.getSnapshot(), coarseNow }, new Set(['coarseNow'])))
    }
    storeStats.end(window)
    const unrelated = readStoreStats().runtimes[0]!
    storeStats.reset()
    // Same selected path avoids a separate local selection effect; the added
    // option must appear in both arms and requires a real selected-field update.
    act(() => {
      store.publish(
        { ...store.getSnapshot(), repos: [repo('/before'), repo('/after')] },
        new Set(['repos']),
      )
      headerEntities(fixture.pool!).apply([{ kind: 'repository', id: '/after', value: repo('/after') }])
      headerEntities(fixture.pool!).order('repository', ['/before', '/after'])
    })
    const relevant = readStoreStats().runtimes[0]!
    expect(view.getByRole('radio', { name: 'Repository after' })).toBeTruthy()
    results.push({
      publishes: unrelated.publishes,
      unrelatedCommits: unrelated.reactCommits,
      relevantPublishes: relevant.publishes,
      relevantCommits: relevant.reactCommits,
    })
    view.unmount()
    fixture.pool.dispose()
    storeStats.enable(false)
  }
  expect(results).toEqual([
    { publishes: 3, unrelatedCommits: 0, relevantPublishes: 1, relevantCommits: 1 },
  ])
})
