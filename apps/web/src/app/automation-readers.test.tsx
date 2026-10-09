import { referenceState } from '../../../../tests/worklist/diagnostics/reference-state'
// @vitest-environment happy-dom
import { storeStats } from '@podium/client-core/perf'
import { asClientPrincipal } from '@podium/client-core/principal'
import { automationViews } from '@podium/client-graph/automation-views'
import { StoreProvider, useStoreHandle } from '@podium/client-core/react'
import { machineViewsFromWire } from '@podium/client-core/values'
import { AUTOMATION_ENTITIES } from '@podium/client-graph/automation-schema'
import { AutomationSource } from '@podium/client-graph/automation-source'
import { checkAutomations } from '../../../../tests/worklist/diagnostics/automation-check'
import { attachPoolScreens, type PoolScreen, screenOptions } from '@podium/client-graph/host'
import { MobxPool } from '@podium/client-graph/pool'
import { PoolSources } from '@podium/client-graph/source-registry'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { asMachineId, asUserId } from '@podium/model/browser'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { automationTargetChoices } from '@/features/automations/automation-form'
import { AUTOMATION_HISTORY_LIMIT, AutomationHistory } from '@/features/automations/automation-history'
import type { AutomationRun } from '@/features/automations/AutomationsView'
import { createAutomationsFixture } from '../../test/automations-fixture'
import {
  useAutomationList,
  useAutomationRunSession,
  useAutomationTargets,
  useSpecsRepositories,
} from './automation-readers'
import { attachWorklistPool, useWorklistPool } from './store-worklist-pool'
import type { Trpc } from './trpc'

afterEach(() => {
  cleanup()
  storeStats.enable(false)
})

it('registry routes declared kinds, rejects overlap atomically and disposes once', async () => {
  const replica = createAutomationsFixture().newReplica(),
    registry = new PoolSources()
  const source = new AutomationSource(replica),
    dispose = vi.spyOn(source, 'dispose')
  registry.register(AUTOMATION_ENTITIES, source)
  expect(registry.read('automationCatalog', 'catalog')).toBe(LOADING)
  expect(registry.read('automation', 'synthetic-auto-0')).toBe(LOADING)
  await Promise.resolve()
  expect(source.counts.batches).toBe(1)
  expect(registry.read('automation', 'synthetic-auto-0')).toMatchObject({
    name: 'Synthetic automation 0',
  })
  const duplicate = new AutomationSource(replica),
    duplicateDispose = vi.spyOn(duplicate, 'dispose')
  expect(() => registry.register(AUTOMATION_ENTITIES, duplicate)).toThrow('conflicts')
  expect(duplicateDispose).toHaveBeenCalledTimes(1)
  registry.dispose()
  registry.dispose()
  expect(dispose).toHaveBeenCalledTimes(1)
  expect(registry.read('automationCatalog', 'catalog')).toBe(LOADING)
})

it('screen registry releases late attachments after principal teardown', async () => {
  let finish!: (stop: () => void) => void
  const stop = vi.fn(),
    error = vi.fn()
  const screen: PoolScreen = {
    attach: () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  }
  const detach = attachPoolScreens([screen], {} as never, {} as never, error)
  detach()
  finish(stop)
  await Promise.resolve()
  expect(stop).toHaveBeenCalledTimes(1)
  expect(error).not.toHaveBeenCalled()
  expect(
    screenOptions(
      [
        {
          options: () => ({ summaries: { session: ['title'] } }),
        },
        {
          options: () => ({ summaries: { session: ['title', 'name'] } }),
        },
      ],
      {} as never,
    ),
  ).toMatchObject({ summaries: { session: ['title', 'name'] } })
})

it('pool launch choices preserve scoped rights, duplicate paths, recency and an unavailable saved target', async () => {
  const fixture = createAutomationsFixture(),
    fatal = vi.fn()
  const machines = [
    { id: asMachineId('usable'), online: true, use: 'granted', availability: { daemon: true } },
    { id: asMachineId('denied'), online: true, use: 'denied', availability: { daemon: true } },
    { id: asMachineId('offline'), online: false, use: 'granted', availability: { daemon: true } },
    { id: asMachineId('server'), online: true, use: 'granted', availability: { daemon: false } },
  ].map((machine) => ({
    ...machine,
    hostname: machine.id,
    name: machine.id,
    lastSeenAt: new Date().toISOString(),
    serviceAssignment: { server: machine.id === 'server', agentExecution: machine.id !== 'server' },
  }))
  const repos = machines.map((machine) => ({
    path: `/synthetic/${machine.id}`,
    machineId: machine.id,
    kind: 'repository',
    branch: 'main',
    worktrees: [],
  }))
  repos.push(
    { ...repos[0]!, path: '/synthetic/project' },
    { ...repos[1]!, path: '/synthetic/project' },
  )
  fixture.api.discovery.refreshRepos.mutate = vi.fn(async () => ({
    repositories: repos,
    machines,
    diagnostics: [],
  })) as never
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <StoreProvider
        principal={asClientPrincipal(asUserId('automation-rights'))}
        config={{ httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }}
        api={fixture.api}
        createReplicaFn={() => fixture.newReplica()}
        networkEnabled={false}
        onFatalError={fatal}
        attachRuntime={(runtime) => {
          fixture.bindHub(runtime.hub)
          return attachWorklistPool(runtime, fatal)
        }}
      >
        {children}
      </StoreProvider>
    )
  }
  const { result } = renderHook(
    () => ({ owner: useStoreHandle<Trpc>(), pool: useWorklistPool(), targets: useAutomationTargets('/synthetic/offline') }),
    { wrapper: Wrapper },
  )
  await act(async () => {
    await referenceState(result.current.owner).refreshRepos()
  })
  await waitFor(() => expect(result.current.targets.pending).toBe(0))
  const state = referenceState(result.current.owner)
  const choices = result.current.targets.ids.map(id => automationViews(result.current.pool!).target(id))
  expect(choices).toEqual(
    automationTargetChoices(
      state.repos,
      state.sessions,
      machineViewsFromWire(state.machines),
      '/synthetic/offline',
    ).choices,
  )
  expect(result.current.targets.excluded).toMatchObject({
    unauthorized: 2,
    unreachable: 1,
    incapable: 1,
  })
  expect(choices[0]?.value).toBe('/synthetic/project')
  expect(choices.at(-1)).toMatchObject({
    value: '/synthetic/offline',
    opaque: true,
  })
  expect(fatal).not.toHaveBeenCalled()
})

it('declared run and target relationships follow edits, deletes and replacement', async () => {
  const fixture = createAutomationsFixture(),
    replica = fixture.newReplica(),
    source = new AutomationSource(replica)
  source.read('automationCatalog', 'catalog')
  await Promise.resolve()
  expect(source.related('automation', 'synthetic-auto-0', 'runs')).toHaveLength(4)
  expect(source.relation('automation', 'synthetic-auto-3', 'target')).toBe('synthetic-session-0')
  fixture.patch('automationRun', 'synthetic-run-0-0', {
    automationId: 'synthetic-auto-1',
    sessionId: null,
  })
  expect(source.related('automation', 'synthetic-auto-0', 'runs')).toHaveLength(3)
  expect(source.related('automation', 'synthetic-auto-1', 'runs')).toHaveLength(5)
  expect(source.relation('automationRun', 'synthetic-run-0-0', 'session')).toBeUndefined()
  fixture.remove('automationRun', 'synthetic-run-0-0')
  expect(source.related('automation', 'synthetic-auto-1', 'runs')).toHaveLength(4)
  fixture.replaceRuns()
  await Promise.resolve()
  expect(source.related('automation', 'synthetic-auto-0', 'runs')).toHaveLength(0)
  expect(source.read('automationRun', 'synthetic-run-0-0')).toBeUndefined()
  source.dispose()
})

it('enabled list, launch, run and specs readers execute zero legacy derivations and match the old policy', async () => {
  const fixture = createAutomationsFixture()
  const fatal = vi.fn()
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <StoreProvider
        principal={asClientPrincipal(asUserId('automation-test'))}
        config={{ httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }}
        api={fixture.api}
        createReplicaFn={() => fixture.newReplica()}
        networkEnabled={false}
        onFatalError={fatal}
        attachRuntime={(runtime) => {
          fixture.bindHub(runtime.hub)
          return attachWorklistPool(runtime, fatal)
        }}
      >
        {children}
      </StoreProvider>
    )
  }
  const result = renderHook(
    () => ({
      owner: useStoreHandle<Trpc>(),
      pool: useWorklistPool(),
      list: useAutomationList(),
      targets: useAutomationTargets('/synthetic/missing'),
      session: useAutomationRunSession('synthetic-session-0'),
      repos: useSpecsRepositories(),
    }),
    { wrapper: Wrapper },
  ).result
  await act(async () => {
    fixture.publishMachines()
    await referenceState(result.current.owner).refreshRepos()
  })
  await waitFor(() =>
    expect(
      result.current.list.pending + result.current.targets.pending + result.current.repos.pending,
    ).toBe(0),
  )
  const { owner, pool } = result.current
  expect(pool).toBeTruthy()
  expect(result.current.repos.repos.map((repo) => repo.path)).toEqual(['/synthetic/project'])
  expect(result.current.list.automations).toHaveLength(6)
  expect(result.current.session?.sessionId).toBe('synthetic-session-0')
  storeStats.enable()
  storeStats.reset()
  await act(async () => {
    for (let step = 1; step <= 20; step++)
      fixture.patch('session', 'synthetic-session-0', {
        lastActiveAt: new Date(Date.now() + step).toISOString(),
      })
    await Promise.resolve()
  })
  expect(storeStats.snapshot().runtimes[0]?.selectorRuns ?? 0).toBe(0)
  expect(fatal).not.toHaveBeenCalled()
  const state = referenceState(owner)
  expect(result.current.repos.repos).toEqual(state.repos)
  expect(result.current.targets.ids.map(id => automationViews(pool!).target(id))).toEqual(
    automationTargetChoices(
      state.repos,
      state.sessions,
      machineViewsFromWire(state.machines),
      '/synthetic/missing',
    ).choices,
  )
  const check = checkAutomations(
    pool!,
    state,
    (path) =>
      automationTargetChoices(
        state.repos,
        state.sessions,
        machineViewsFromWire(state.machines),
        path,
      ),
    [null, '/synthetic/missing'],
  )
  expect(check).toMatchObject({ differences: 0, pending: 0, first: null })
  await act(async () => {
    fixture.patch('automation', 'synthetic-auto-0', { enabled: false, system: true })
    await Promise.resolve()
  })
  expect(result.current.list.automations).toHaveLength(5)
  const updated = referenceState(owner)
  expect(
    checkAutomations(pool!, updated, (path) =>
      automationTargetChoices(
        updated.repos,
        updated.sessions,
        machineViewsFromWire(updated.machines),
        path,
      ),
    ),
  ).toMatchObject({ differences: 0, pending: 0 })
})

/** The removed list's run groups, verbatim: every related run, resolved and sorted. */
function legacyRunGroups(pool: MobxPool) {
  const catalog = pool.row('automationCatalog', 'catalog')
  const runGroups: Record<string, AutomationRun[]> = {}
  if (catalog && catalog !== LOADING) for (const id of catalog.automations) {
    const row = pool.row('automation', id)
    if (!row || row === LOADING || Reflect.get(row, 'system') === true) continue
    runGroups[id] = pool.sources.related('automation', id, 'runs').flatMap(runId => {
      const run = pool.row('automationRun', runId)
      return run && run !== LOADING ? [run] : []
    }).sort((a, b) => b.firedAt.localeCompare(a.firedAt))
  }
  return runGroups
}

it('a collapsed list reads no runs; an opened history shows the legacy newest window from a bounded request', async () => {
  const fixture = createAutomationsFixture(),
    fatal = vi.fn()
  const first = fixture.runs[0]!
  // 30 runs on one automation, fired out of ID order, so the window cuts.
  for (let index = 0; index < 26; index++) {
    const value = { ...first, id: `synthetic-run-extra-${index}`, sessionId: null, outcome: 'missed', detail: `extra ${index}`,
      firedAt: new Date(Date.parse(first.firedAt) + (((index * 7) % 26) + 10) * 1000).toISOString() }
    fixture.records.set(`automationRun:${value.id}`, { entity: 'automationRun', entityId: value.id, value, provenance: { seq: 1 } })
  }
  const reads = vi.spyOn(MobxPool.prototype, 'row')
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <StoreProvider
        principal={asClientPrincipal(asUserId('automation-history'))}
        config={{ httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }}
        api={fixture.api}
        createReplicaFn={() => fixture.newReplica()}
        networkEnabled={false}
        onFatalError={fatal}
        attachRuntime={(runtime) => {
          fixture.bindHub(runtime.hub)
          return attachWorklistPool(runtime, fatal)
        }}
      >
        {children}
      </StoreProvider>
    )
  }
  const { result } = renderHook(
    () => ({ owner: useStoreHandle<Trpc>(), pool: useWorklistPool(), list: useAutomationList() }),
    { wrapper: Wrapper },
  )
  await waitFor(() => expect(result.current.list.pending).toBe(0))
  expect(result.current.list.automations).toHaveLength(6)
  const runReads = () => reads.mock.calls.filter(([entity]) => String(entity) === 'automationRun').map(([, id]) => id)
  expect(runReads()).toEqual([])
  const pool = result.current.pool!
  const state = referenceState(result.current.owner)
  // The server's order: firedAt descending, newest window only.
  const query = vi.fn(async ({ automationId, limit }: { automationId: string; limit: number }) =>
    state.automationRuns.filter(run => run.automationId === automationId)
      .sort((a, b) => Date.parse(b.firedAt) - Date.parse(a.firedAt)).slice(0, limit))
  const legacy = legacyRunGroups(pool)
  reads.mockClear()
  for (const automation of result.current.list.automations) {
    const history = new AutomationHistory(automation.id, query, pool)
    expect(history.pending).toBe(true)
    await history.refresh()
    expect(history.runs).toEqual(legacy[automation.id]!.slice(0, AUTOMATION_HISTORY_LIMIT))
    expect(history.runs.at(0)).toEqual(legacy[automation.id]![0])
    expect(history.pending).toBe(false)
    history.close()
  }
  expect(legacy['synthetic-auto-0']).toHaveLength(30)
  expect(query).toHaveBeenCalledWith({ automationId: 'synthetic-auto-0', limit: AUTOMATION_HISTORY_LIMIT })
  // Six windows: 20 + 5 × 4 distinct runs read, never the 30th-newest history.
  expect(new Set(runReads()).size).toBe(AUTOMATION_HISTORY_LIMIT + 5 * 4)
  // Shown runs stay live in today's run source; a failed request is the view's error.
  const live = new AutomationHistory('synthetic-auto-1' as never, query, pool)
  await live.refresh()
  await act(async () => {
    fixture.patch('automationRun', 'synthetic-run-1-3', { outcome: 'error', detail: 'Synthetic failure' })
    await Promise.resolve()
  })
  expect(live.runs[0]).toMatchObject({ id: 'synthetic-run-1-3', outcome: 'error' })
  const failing = new AutomationHistory('synthetic-auto-1' as never, async () => { throw new Error('offline') }, pool)
  await failing.refresh()
  expect(failing).toMatchObject({ error: 'offline', pending: false })
  expect(failing.runs).toEqual([])
  expect(fatal).not.toHaveBeenCalled()
})
