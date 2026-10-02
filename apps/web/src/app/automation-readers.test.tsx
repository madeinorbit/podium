// @vitest-environment happy-dom
import { storeStats } from '@podium/client-core/perf'
import { asClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider, useStoreHandle } from '@podium/client-core/react'
import { machineViewsFromWire } from '@podium/client-core/viewmodels'
import { checkAutomations } from '@podium/client-graph/diagnostics/automation-check'
import { AutomationSource } from '@podium/client-graph/automation-source'
import { AUTOMATION_ENTITIES } from '@podium/client-graph/automation-schema'
import { PoolSources } from '@podium/client-graph/source-registry'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { asMachineId, asUserId } from '@podium/model/browser'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { createAutomationsFixture } from '../../test/automations-fixture'
import { automationTargetChoices } from '@/features/automations/automation-form'
import { automationReadStats } from '@/lib/automations-data-layer'
import { useAutomationList, useAutomationRunSession, useAutomationTargets, useSpecsRepositories } from './automation-readers'
import { attachPoolScreens, screenOptions, type PoolScreen } from '@podium/client-graph/host'
import { attachWorklistPool, useWorklistPool } from './store-worklist-pool'
import type { Trpc } from './trpc'

vi.mock('@/lib/automations-data-layer', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/automations-data-layer')>(),
  automationsDataLayer: () => 'pool', specsDataLayer: () => 'pool',
}))
afterEach(() => { cleanup(); storeStats.enable(false); automationReadStats.enable(false) })

it('registry routes declared kinds, rejects overlap atomically and disposes once', async () => {
  const replica = createAutomationsFixture().newReplica(), registry = new PoolSources()
  const source = new AutomationSource(replica), dispose = vi.spyOn(source, 'dispose')
  registry.register(AUTOMATION_ENTITIES, source)
  expect(registry.read('automationCatalog', 'catalog')).toBe(LOADING)
  expect(registry.read('automation', 'synthetic-auto-0')).toBe(LOADING)
  await Promise.resolve()
  expect(source.counts.batches).toBe(1)
  expect(registry.read('automation', 'synthetic-auto-0')).toMatchObject({ name: 'Synthetic automation 0' })
  const duplicate = new AutomationSource(replica), duplicateDispose = vi.spyOn(duplicate, 'dispose')
  expect(() => registry.register(AUTOMATION_ENTITIES, duplicate)).toThrow('conflicts')
  expect(duplicateDispose).toHaveBeenCalledTimes(1)
  registry.dispose(); registry.dispose()
  expect(dispose).toHaveBeenCalledTimes(1)
  expect(registry.read('automationCatalog', 'catalog')).toBe(LOADING)
})

it('screen registry releases late attachments after principal teardown', async () => {
  let finish!: (stop: () => void) => void
  const stop = vi.fn(), error = vi.fn()
  const screen: PoolScreen = { initialize() {}, enabled: () => true,
    attach: () => new Promise(resolve => { finish = resolve }) }
  const detach = attachPoolScreens([screen], {} as never, {} as never, error)
  detach(); finish(stop)
  await Promise.resolve()
  expect(stop).toHaveBeenCalledTimes(1)
  expect(error).not.toHaveBeenCalled()
  expect(screenOptions([
    { initialize() {}, enabled: () => true, options: () => ({ summaries: { session: ['title'] } }) },
    { initialize() {}, enabled: () => true, options: () => ({ summaries: { session: ['title', 'name'] } }) },
    { initialize() {}, enabled: () => false, options: () => ({ summaries: { session: ['privateBody'] } }) },
  ], {} as never)).toMatchObject({ summaries: { session: ['title', 'name'] } })
})

it('pool launch choices preserve scoped rights, duplicate paths, recency and an unavailable saved target', async () => {
  const fixture = createAutomationsFixture(), fatal = vi.fn()
  const machines = [
    { id: asMachineId('usable'), online: true, use: 'granted', availability: { daemon: true } },
    { id: asMachineId('denied'), online: true, use: 'denied', availability: { daemon: true } },
    { id: asMachineId('offline'), online: false, use: 'granted', availability: { daemon: true } },
    { id: asMachineId('server'), online: true, use: 'granted', availability: { daemon: false } },
  ].map(machine => ({ ...machine, hostname: machine.id, name: machine.id, lastSeenAt: new Date().toISOString(),
    serviceAssignment: { server: machine.id === 'server', agentExecution: machine.id !== 'server' },
  }))
  const repos = machines.map(machine => ({ path: `/synthetic/${machine.id}`, machineId: machine.id, kind: 'repository', branch: 'main', worktrees: [] }))
  repos.push({ ...repos[0]!, path: '/synthetic/project' }, { ...repos[1]!, path: '/synthetic/project' })
  fixture.api.discovery.refreshRepos.mutate = vi.fn(async () => ({ repositories: repos, machines, diagnostics: [] })) as never
  function Wrapper({ children }: { children: ReactNode }) {
    return <StoreProvider principal={asClientPrincipal(asUserId('automation-rights'))}
      config={{ httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }} api={fixture.api}
      createReplicaFn={() => fixture.newReplica()} networkEnabled={false} onFatalError={fatal}
      attachRuntime={runtime => { fixture.bindHub(runtime.hub); return attachWorklistPool(runtime, fatal) }}
    >{children}</StoreProvider>
  }
  const { result } = renderHook(() => ({ owner: useStoreHandle<Trpc>(), targets: useAutomationTargets('/synthetic/offline') }), { wrapper: Wrapper })
  await act(async () => { await result.current.owner.getSnapshot().refreshRepos() })
  await waitFor(() => expect(result.current.targets.pending).toBe(0))
  const state = result.current.owner.getSnapshot()
  expect(result.current.targets.choices).toEqual(automationTargetChoices(state.repos, state.sessions, machineViewsFromWire(state.machines), '/synthetic/offline').choices)
  expect(result.current.targets.excluded).toMatchObject({ unauthorized: 2, unreachable: 1, incapable: 1 })
  expect(result.current.targets.choices[0]?.value).toBe('/synthetic/project')
  expect(result.current.targets.choices.at(-1)).toMatchObject({ value: '/synthetic/offline', opaque: true })
  expect(fatal).not.toHaveBeenCalled()
})

it('declared run and target relationships follow edits, deletes and replacement', async () => {
  const fixture = createAutomationsFixture(), replica = fixture.newReplica(), source = new AutomationSource(replica)
  source.read('automationCatalog', 'catalog'); await Promise.resolve()
  expect(source.related('automation', 'synthetic-auto-0', 'runs')).toHaveLength(4)
  expect(source.relation('automation', 'synthetic-auto-3', 'target')).toBe('synthetic-session-0')
  fixture.patch('automationRun', 'synthetic-run-0-0', { automationId: 'synthetic-auto-1', sessionId: null })
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
    return <StoreProvider principal={asClientPrincipal(asUserId('automation-test'))}
      config={{ httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }} api={fixture.api}
      createReplicaFn={() => fixture.newReplica()} networkEnabled={false} onFatalError={fatal}
      attachRuntime={runtime => { fixture.bindHub(runtime.hub); return attachWorklistPool(runtime, fatal) }}
    >{children}</StoreProvider>
  }
  const result = renderHook(() => ({ owner: useStoreHandle<Trpc>(), pool: useWorklistPool(), list: useAutomationList(),
    targets: useAutomationTargets('/synthetic/missing'), session: useAutomationRunSession('synthetic-session-0'), repos: useSpecsRepositories(),
  }), { wrapper: Wrapper }).result
  await waitFor(() => expect(result.current.list.pending + result.current.targets.pending + result.current.repos.pending).toBe(0))
  const { owner, pool } = result.current
  expect(pool).toBeTruthy()
  expect(result.current.list.automations).toHaveLength(6)
  expect(result.current.session?.sessionId).toBe('synthetic-session-0')
  storeStats.enable(); storeStats.reset(); automationReadStats.enable(); automationReadStats.reset()
  await act(async () => {
    for (let step = 1; step <= 20; step++) fixture.patch('session', 'synthetic-session-0', { lastActiveAt: new Date(Date.now() + step).toISOString() })
    await Promise.resolve()
  })
  expect(automationReadStats.read(owner)).toEqual({})
  expect(storeStats.snapshot().runtimes[0]?.selectorRuns ?? 0).toBe(0)
  expect(fatal).not.toHaveBeenCalled()
  const state = owner.getSnapshot()
  const check = checkAutomations(pool!, state, path => automationTargetChoices(state.repos, state.sessions, machineViewsFromWire(state.machines), path), [null, '/synthetic/missing'])
  expect(check).toMatchObject({ differences: 0, pending: 0, first: null })
  await act(async () => { fixture.patch('automation', 'synthetic-auto-0', { enabled: false, system: true }); await Promise.resolve() })
  expect(result.current.list.automations).toHaveLength(5)
  const updated = owner.getSnapshot()
  expect(checkAutomations(pool!, updated, path => automationTargetChoices(updated.repos, updated.sessions, machineViewsFromWire(updated.machines), path))).toMatchObject({ differences: 0, pending: 0 })
})
