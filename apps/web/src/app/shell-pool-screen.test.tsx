import { asClientPrincipal } from '@podium/client-core/principal'
import { asUserId } from '@podium/model/browser'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { observer } from '@podium/client-graph/react'
import { afterEach, expect, it, vi } from 'vitest'
import { createHeaderFixture } from '../../test/header-fixture'
import type { Trpc } from './trpc'

afterEach(() => { cleanup(); history.replaceState(null, '', '/'); vi.resetModules() })
it('defaults off, latches the URL override once, and gates the diagnostic on the enabled screen', async () => {
  let module = await import('./shell-pool-screen')
  const ui = { get: () => null }
  expect(module.shellDataLayer()).toBe('legacy')
  module.initializeShellDataLayer(ui)
  history.replaceState(null, '', '/?mobxShell=1&mobxShellCheck=1')
  module.initializeShellDataLayer(ui)
  expect(module.shellDataLayer()).toBe('legacy'); expect(module.shellCheckRequested()).toBe(false)
  vi.resetModules(); module = await import('./shell-pool-screen'); module.initializeShellDataLayer(ui)
  expect(module.shellDataLayer()).toBe('pool'); expect(module.shellCheckRequested()).toBe(true)
  history.replaceState(null, '', '/?mobxShell=0'); module.initializeShellDataLayer(ui)
  expect(module.shellDataLayer()).toBe('pool')
  vi.resetModules(); module = await import('./shell-pool-screen'); module.initializeShellDataLayer(ui)
  expect(module.shellDataLayer()).toBe('legacy'); expect(module.shellCheckRequested()).toBe(false)
})

it('attaches the existing pool after mounting every reader without a legacy fallback or React hook error', async () => {
  history.replaceState(null, '', '/?mobxSidebar=0&mobxShell=1')
  const [{ initializePoolScreens }, { attachWorklistPool, useWorklistPool }, reads, { StoreProvider, useStoreHandle }, { storeStats }] = await Promise.all([
    import('./pool-screens'), import('./store-worklist-pool'), import('./shell-data'), import('@podium/client-core/react'), import('@podium/client-core/perf'),
  ])
  initializePoolScreens({ get: () => null } as never)
  const fixture = createHeaderFixture(40, 40), failures: string[] = [], states: boolean[] = []
  let owner: ReturnType<typeof useStoreHandle<Trpc>> | undefined
  const Surface = observer(function Surface() {
    owner = useStoreHandle<Trpc>()
    const pool = useWorklistPool(); states.push(Boolean(pool))
    const chrome = reads.useShellChrome(), dock = reads.useShellDock(), window = reads.useShellWindow()
    const approvals = reads.useShellApprovals(), sessions = reads.useShellSessions(), links = reads.useShellLinks()
    const close = reads.useShellClose(), machines = reads.useShellMachines(), actions = reads.useShellActions()
    expect(actions.trpc).toBe(fixture.api)
    return <div data-testid="loaded" data-loaded={String(Boolean(pool && window && close))}>{[chrome.repoCount, dock.issues.length, approvals.length, sessions.length, links.issues.length, machines.length].join(':')}</div>
  })
  storeStats.enable(); storeStats.reset()
  render(<StoreProvider principal={asClientPrincipal(asUserId('shell-test'))}
    config={{ httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }} api={fixture.api as unknown as Trpc}
    createReplicaFn={() => fixture.newReplica()} networkEnabled={false}
    onFatalError={message => failures.push(message)} attachRuntime={runtime => {
      fixture.bindHub(runtime.hub)
      void runtime.getSnapshot().refreshRepos()
      return attachWorklistPool(runtime, error => failures.push(error.message))
    }}><Surface /></StoreProvider>)
  await waitFor(() => expect(document.querySelector('[data-loaded="true"]')).not.toBeNull())
  expect(states).toContain(false); expect(states).toContain(true); expect(failures).toEqual([])
  expect(document.querySelector('[data-testid="loaded"]')?.textContent).toContain('40')
  storeStats.reset(); const capture = storeStats.begin('feed')
  await act(async () => { for (let step = 0; step < 8; step++) fixture.patch('session', `synthetic-session-${step}`, { lastActiveAt: new Date(Date.now() + step).toISOString() }); await Promise.resolve() })
  storeStats.end(capture)
  const stats = storeStats.snapshot().windows.at(-1)!.runtimes
  expect(stats.reduce((sum, runtime) => sum + runtime.selectorRuns, 0)).toBe(0)
  expect(stats.flatMap(runtime => Object.entries(runtime.slices)).filter(([key]) => key.startsWith('shell.'))).toEqual([])
  expect(owner?.getSnapshot().sessions.length).toBe(42)
})
