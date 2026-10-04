import { referenceState } from '@podium/client-graph/diagnostics/reference-state'
// @vitest-environment happy-dom
import { storeStats } from '@podium/client-core/perf'
import { asClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider, useStoreHandle } from '@podium/client-core/react'
import { placementOptions } from '@podium/client-core/values'
import {
  checkWorkflows,
  probeWorkflowCheckScope,
} from '@podium/client-graph/diagnostics/workflow-check'
import { workflowMachines, workflowSubject } from '@podium/client-graph/workflow-views'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { asUserId } from '@podium/model/browser'
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { attachWorklistPool, useWorklistPool } from '@/app/store-worklist-pool'
import type { Trpc } from '@/app/trpc'
import { MergeQueuePanel } from '@/features/merge-queue/MergeQueuePanel'
import { createWorkflowsFixture } from '../../../test/workflows-fixture'
import { ExecutionProfiles } from './ExecutionProfiles'
import { RunProgress } from './RunProgress'
import { useWorkflowMachines, useWorkflowSubject } from './readers'
import { useWorkflows } from './use-workflows'
import { OPERATOR_WORKFLOW_RIGHTS } from './workflow-commands'

beforeAll(() => {
  history.replaceState(null, '', '/?mobxWorkflows=1')
})
afterEach(() => {
  cleanup()
  storeStats.enable(false)
  storeStats.reset()
})

function setup(delayed = false) {
  const fixture = createWorkflowsFixture(),
    fatal = vi.fn()
  let start: (() => void) | undefined
  const config = { httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }
  const principal = asClientPrincipal(asUserId('workflow-test'))
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <StoreProvider
        principal={principal}
        config={config}
        api={fixture.api}
        createReplicaFn={() => fixture.newReplica()}
        networkEnabled={false}
        onFatalError={fatal}
        attachRuntime={(runtime) => {
          fixture.bindHub(runtime.hub)
          let detach: (() => void) | undefined
          start = () => {
            detach = attachWorklistPool(runtime, fatal)
          }
          if (!delayed) start()
          void referenceState(runtime).refreshRepos()
          return () => detach?.()
        }}
      >
        {children}
      </StoreProvider>
    )
  }
  return { fixture, fatal, Wrapper, attach: () => start!() }
}

it('renders the actual screens through no-pool then real attachment without changing hook order', async () => {
  const { fixture, fatal, Wrapper, attach } = setup(true)
  function Surface() {
    const source = useWorkflows()
    return (
      <>
        <ExecutionProfiles source={source} rights={OPERATOR_WORKFLOW_RIGHTS} />
        <RunProgress source={source} rights={OPERATOR_WORKFLOW_RIGHTS} />
        <MergeQueuePanel
          issues={[]}
          scope={{ repoPath: '/synthetic/project' }}
          onSelectIssue={() => {}}
        />
      </>
    )
  }
  storeStats.enable()
  render(
    <Wrapper>
      <Surface />
    </Wrapper>,
  )
  expect(screen.getByText('Loading execution profiles…')).toBeTruthy()
  expect(await screen.findByText('Loading issue · synthetic-0…')).toBeTruthy()
  await act(async () => {
    attach()
  })
  await screen.findByText('Synthetic profile 0')
  await screen.findByText('session · synthetic-session-0')
  expect(screen.queryByText('Loading execution profiles…')).toBeNull()
  expect(screen.getAllByText(/synthetic-missing · no access/)).toHaveLength(2)
  expect(screen.getByLabelText('Machine').querySelectorAll('option')).toHaveLength(2)
  expect(fixture.calls).toMatchObject({
    list: 1,
    bindings: 1,
    profiles: 1,
    runs: 1,
    get: 1,
    locks: 1,
  })
  expect(fixture.lockInputs).toEqual([{ repoPath: '/synthetic/project' }])
  expect(storeStats.snapshot().runtimes).toHaveLength(1)
  expect(storeStats.snapshot().runtimes[0]?.selectorRuns).toBe(0)
  expect(fatal).not.toHaveBeenCalled()
})

it('matches scoped placement and cold issue/session targets through the one reader, with no peeks', async () => {
  const { fixture, Wrapper, fatal } = setup()
  const old = new Date(Date.now() - 14 * 86400000).toISOString()
  fixture.patch('issueProjection', 'synthetic-5', { archived: true, closedAt: old, updatedAt: old })
  fixture.patch('session', 'synthetic-session-5', {
    status: 'hibernated',
    archived: true,
    lastActiveAt: old,
  })
  const { result } = renderHook(
    () => ({
      owner: useStoreHandle<Trpc>(),
      pool: useWorklistPool(),
      machines: useWorkflowMachines(),
      issue: useWorkflowSubject(fixture.runs[1]!),
      session: useWorkflowSubject(fixture.runs[4]!),
    }),
    { wrapper: Wrapper },
  )
  await waitFor(() => expect(result.current.machines.pending).toBe(0))
  const pool = result.current.pool!,
    row = vi.spyOn(pool, 'row')
  expect(pool.tables.issue.has('synthetic-5')).toBe(false)
  const check = checkWorkflows(pool, referenceState(result.current.owner), fixture)
  expect(check).toMatchObject({ differences: 0, pending: 0, positions: 14, first: null })
  expect(result.current.issue).toMatchObject({ state: 'present' })
  expect(result.current.session).toMatchObject({ state: 'present' })
  expect(pool.tables.issue.has('synthetic-5')).toBe(false)
  expect(placementOptions(result.current.machines.views)).toMatchObject({
    offerable: [{ id: 'synthetic-available' }],
  })
  expect(
    fixture.profiles.map((profile) => pool.row('settingsMachine', profile.machineId ?? '')),
  ).toHaveLength(8)
  expect(result.current.machines.views.map((view) => view.availability)).toEqual([
    'available',
    'unauthorized',
    'unreachable',
    'incapable',
    'disabled',
    'degraded',
  ])
  expect(row.mock.calls.some((call) => String(call[2]) === 'peek')).toBe(false)
  expect(fatal).not.toHaveBeenCalled()
})

it('preserves resume twins and reacts to addressed removals and replacement', async () => {
  const { fixture, Wrapper } = setup()
  for (const [index, time] of [
    [6, 10],
    [7, 20],
  ] as const)
    fixture.patch('session', `synthetic-session-${index}`, {
      status: 'hibernated',
      archived: true,
      lastActiveAt: new Date(Date.now() + time).toISOString(),
      resume: { kind: 'codex', value: 'synthetic-twin' },
    })
  const twins = [6, 7].map((index) => ({
    ...fixture.runs[3]!,
    id: `twin-${index}`,
    subjectId: `synthetic-session-${index}`,
  }))
  const inputs = { profiles: fixture.profiles, runs: [...fixture.runs, ...twins] }
  const { result } = renderHook(
    () => ({
      owner: useStoreHandle<Trpc>(),
      pool: useWorklistPool(),
      machines: useWorkflowMachines(),
      suppressed: useWorkflowSubject(twins[0]!),
      kept: useWorkflowSubject(twins[1]!),
      issue: useWorkflowSubject(fixture.runs[0]!),
    }),
    { wrapper: Wrapper },
  )
  await waitFor(() => expect(result.current.machines.pending).toBe(0))
  expect(result.current.suppressed).toMatchObject({ state: 'pending' })
  expect(result.current.kept).toMatchObject({ state: 'present' })
  expect(
    checkWorkflows(result.current.pool!, referenceState(result.current.owner), inputs),
  ).toMatchObject({ differences: 0, pending: 0 })
  await act(async () => {
    fixture.remove('session', 'synthetic-session-7')
    fixture.remove('issueProjection', 'synthetic-0')
  })
  await waitFor(() => expect(result.current.suppressed).toMatchObject({ state: 'present' }))
  expect(result.current.kept).toMatchObject({ state: 'pending' })
  expect(result.current.issue).toMatchObject({ state: 'pending' })
  await act(async () => {
    fixture.replace()
  })
  expect(
    checkWorkflows(result.current.pool!, referenceState(result.current.owner), inputs),
  ).toMatchObject({ differences: 0, pending: 0 })
})

it('batches initial machine demand and returns LOADING before the shared source settles', async () => {
  const { fixture, Wrapper } = setup()
  const { result } = renderHook(
    () => ({ owner: useStoreHandle<Trpc>(), pool: useWorklistPool() }),
    { wrapper: Wrapper },
  )
  await waitFor(() => expect(result.current.pool).toBeTruthy())
  const pool = result.current.pool!
  // No machine consumer has demanded this source yet.
  expect(workflowMachines(pool).pending).toBe(1)
  expect(pool.row('settingsMachine', fixture.machines[0]!.id)).toBe(LOADING)
  expect(pool.row('settingsCatalog', 'catalog')).toBe(LOADING)
  await act(async () => {
    await Promise.resolve()
  })
  expect(workflowMachines(pool).pending).toBe(0)
  expect(workflowSubject(pool, fixture.runs[2]!)).toMatchObject({ state: 'pending' })
})

it('bounds diagnostic summary reads and releases its tracking scope even inside an action', async () => {
  const { fixture, Wrapper } = setup()
  const { result } = renderHook(
    () => ({ owner: useStoreHandle<Trpc>(), pool: useWorklistPool() }),
    { wrapper: Wrapper },
  )
  await waitFor(() => expect(result.current.pool).toBeTruthy())
  const pool = result.current.pool!
  workflowMachines(pool)
  await act(async () => {
    await Promise.resolve()
  })
  const row = vi.spyOn(pool, 'row')
  const inputs = {
    profiles: fixture.profiles,
    runs: Array.from({ length: 500 }, (_, index) => ({
      ...fixture.runs[3 + (index % 3)]!,
      id: `diagnostic-${index}`,
    })),
  }
  const probe = probeWorkflowCheckScope(
    pool,
    referenceState(result.current.owner),
    inputs,
    'synthetic-session-0',
  )
  expect(probe.result).toMatchObject({ differences: 0, pending: 0, positions: 508 })
  const sessions = [...fixture.records.values()].filter(
    (record) => record.entity === 'session',
  ).length
  expect(row.mock.calls.filter((call) => String(call[0]) === 'setupSession')).toHaveLength(sessions)
  expect(probe.after).toEqual(probe.before)
})

it('executes zero legacy readers after feed activity and preserves one denied-write attempt', async () => {
  const { fixture, Wrapper, fatal } = setup()
  let owner: ReturnType<typeof useStoreHandle<Trpc>> | undefined
  function Surface() {
    owner = useStoreHandle<Trpc>()
    const source = useWorkflows()
    return (
      <>
        <ExecutionProfiles source={source} rights={OPERATOR_WORKFLOW_RIGHTS} />
        <RunProgress source={source} rights={OPERATOR_WORKFLOW_RIGHTS} />
        {source.error && <p role="alert">{source.error}</p>}
        <MergeQueuePanel
          issues={[]}
          scope={{ repoPath: '/synthetic/project' }}
          onSelectIssue={() => {}}
        />
      </>
    )
  }
  render(
    <Wrapper>
      <Surface />
    </Wrapper>,
  )
  await screen.findByText('Synthetic profile 0')
  await screen.findByText('session · synthetic-session-0')
  storeStats.enable()
  storeStats.reset()
  await act(async () => {
    for (let step = 1; step <= 20; step++)
      fixture.patch('session', 'synthetic-session-0', {
        lastActiveAt: new Date(Date.now() + step).toISOString(),
      })
  })
  expect(storeStats.snapshot().runtimes).toHaveLength(1)
  expect(storeStats.snapshot().runtimes[0]).toMatchObject({
    publishes: 20,
    selectorRuns: 0,
    slices: {},
  })
  expect(fixture.calls.list).toBe(1)
  fixture.denyProfileSave('Synthetic denial')
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Synthetic saved profile' } })
  fireEvent.change(screen.getByLabelText('Account ID'), { target: { value: 'synthetic-account' } })
  fireEvent.click(screen.getByRole('button', { name: /Save profile/ }))
  expect((await screen.findByRole('alert')).textContent).toContain('Synthetic denial')
  expect(fixture.calls.profileSave).toBe(1)
  expect(fixture.calls.list).toBe(2)
  expect(fixture.calls.locks).toBe(1)
  expect(owner?.getSnapshot().replica).toBe(fixture.replica)
  expect(fatal).not.toHaveBeenCalled()
})
