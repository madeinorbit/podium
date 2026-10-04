import { referenceState } from '@podium/client-graph/diagnostics/reference-state'
import { asClientPrincipal } from '@podium/client-core/principal'
import { observer } from '@podium/client-graph/react'
import { asUserId } from '@podium/model/browser'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { createHeaderFixture } from '../../test/header-fixture'
import type { Trpc } from './trpc'

afterEach(() => {
  cleanup()
  history.replaceState(null, '', '/')
  vi.resetModules()
})
it('registers shell inputs without a startup switch', async () => {
  const { shellPoolScreen } = await import('./shell-pool-screen')
  expect(shellPoolScreen).not.toHaveProperty('initialize')
  expect(shellPoolScreen).not.toHaveProperty('enabled')
})

it('attaches the existing pool after mounting every reader without a legacy fallback or React hook error', async () => {
  history.replaceState(null, '', '/')
  const [
    { attachWorklistPool, useWorklistPool },
    reads,
    { StoreProvider, useStoreHandle },
    { storeStats },
  ] = await Promise.all([
    import('./store-worklist-pool'),
    import('./shell-data'),
    import('@podium/client-core/react'),
    import('@podium/client-core/perf'),
  ])
  const fixture = createHeaderFixture(40, 40),
    failures: string[] = [],
    states: boolean[] = []
  let owner: ReturnType<typeof useStoreHandle<Trpc>> | undefined
  const Surface = observer(function Surface() {
    owner = useStoreHandle<Trpc>()
    const pool = useWorklistPool()
    states.push(Boolean(pool))
    const chrome = reads.useShellChrome(),
      dock = reads.useShellDock(),
      window = reads.useShellWindow()
    const approvals = reads.useShellApprovals(),
      sessions = reads.useShellSessions(),
      links = reads.useShellLinks()
    const close = reads.useShellClose(),
      machines = reads.useShellMachines(),
      actions = reads.useShellActions()
    expect(actions.trpc).toBe(fixture.api)
    return (
      <div data-testid="loaded" data-loaded={String(Boolean(pool && window && close))}>
        {[
          chrome.repoCount,
          dock.issues.length,
          approvals.length,
          sessions.length,
          links.issues.length,
          machines.length,
        ].join(':')}
      </div>
    )
  })
  storeStats.enable()
  storeStats.reset()
  render(
    <StoreProvider
      principal={asClientPrincipal(asUserId('shell-test'))}
      config={{ httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }}
      api={fixture.api as unknown as Trpc}
      createReplicaFn={() => fixture.newReplica()}
      networkEnabled={false}
      onFatalError={(message) => failures.push(message)}
      attachRuntime={(runtime) => {
        fixture.bindHub(runtime.hub)
        void referenceState(runtime).refreshRepos()
        return attachWorklistPool(runtime, (error) => failures.push(error.message))
      }}
    >
      <Surface />
    </StoreProvider>,
  )
  await waitFor(() => expect(document.querySelector('[data-loaded="true"]')).not.toBeNull())
  expect(states).toContain(false)
  expect(states).toContain(true)
  expect(failures).toEqual([])
  expect(document.querySelector('[data-testid="loaded"]')?.textContent).toContain('40')
  await waitFor(() =>
    expect(document.querySelector('[data-testid="loaded"]')?.textContent?.split(':')[0]).toBe('1'),
  )
  storeStats.reset()
  const capture = storeStats.begin('feed')
  await act(async () => {
    for (let step = 0; step < 8; step++)
      fixture.patch('session', `synthetic-session-${step}`, {
        lastActiveAt: new Date(Date.now() + step).toISOString(),
      })
    await Promise.resolve()
  })
  storeStats.end(capture)
  const stats = storeStats.snapshot().windows.at(-1)!.runtimes
  expect(stats.reduce((sum, runtime) => sum + runtime.selectorRuns, 0)).toBe(0)
  expect(
    stats
      .flatMap((runtime) => Object.entries(runtime.slices))
      .filter(([key]) => key.startsWith('shell.')),
  ).toEqual([])
  expect(owner?.getSnapshot().sessions.length).toBe(42)
})
