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
    if (pool) expect(pool.sources.peekView('sessionPanes')).toBeDefined()
    const chrome = reads.useShellChrome(),
      shipping = reads.useShellShipping(),
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
          shipping.unfinishedCount,
          approvals.length,
          sessions.length,
          links.readIssue('synthetic-0')?.seq ?? 0,
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
        fixture.bindHub(runtime.hub, undefined, runtime.live)
        return attachWorklistPool(runtime, (error) => failures.push(error.message))
      }}
    >
      <Surface />
    </StoreProvider>,
  )
  // Lazy screen imports are transformed after render in this source-based fixture.
  await waitFor(
    () => {
      expect(failures).toEqual([])
      expect(document.querySelector('[data-loaded="true"]')).not.toBeNull()
    },
    { timeout: 10_000 },
  )
  expect(states).toContain(false)
  expect(states).toContain(true)
  expect(failures).toEqual([])
  expect(document.querySelector('[data-testid="loaded"]')?.textContent?.split(':')[3]).toBe('42')
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
  expect(owner?.replica.rowCount?.('sessions')).toBe(42)
})
