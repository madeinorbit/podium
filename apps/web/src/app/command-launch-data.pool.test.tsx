import { referenceState } from '../../../../tests/worklist/diagnostics/reference-state'
// @vitest-environment happy-dom
import { storeStats } from '@podium/client-core/perf'
import { asClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider, useStoreHandle } from '@podium/client-core/react'
import { LOADING } from '@podium/client-graph'
import { asIssueId, asUserId } from '@podium/model/browser'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { createHeaderFixture } from '../../test/header-fixture'
import {
  useCommandLaunchActions,
  useCommandLaunchCatalog,
  useCommandPaletteData,
  useCommandPaletteOpen,
  useCommandRecentFiles,
} from './command-launch-data'
import { attachWorklistPool, useWorklistPool } from './store-worklist-pool'
import { commandLaunchViews } from '@podium/client-graph/command-launch-views'
import { ConfirmProvider } from '@/lib/hooks/use-confirm'
import { CommandPalette } from './CommandPalette'
import type { Trpc } from './trpc'

afterEach(() => {
  cleanup()
  storeStats.enable(false)
  storeStats.reset()
})

it('declares launch and palette demand after attachment, follows window updates and preserves action ownership', async () => {
  const fixture = createHeaderFixture(12, 8),
    fatal = vi.fn()
  let attach!: () => void
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <StoreProvider
        principal={asClientPrincipal(asUserId('command-reader-regression'))}
        config={{ httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }}
        api={fixture.api}
        createReplicaFn={() => fixture.newReplica()}
        networkEnabled={false}
        onFatalError={fatal}
        attachRuntime={(runtime) => {
          fixture.bindHub(runtime.hub)
          let detach: (() => void) | undefined
          attach = () => {
            detach = attachWorklistPool(runtime, fatal)
          }
          return () => detach?.()
        }}
      >
        {children}
      </StoreProvider>
    )
  }
  const { result } = renderHook(
    () => ({
      owner: useStoreHandle<Trpc>(),
      launch: useCommandLaunchCatalog(),
      palette: useCommandPaletteData(),
      open: useCommandPaletteOpen(),
      files: useCommandRecentFiles(),
      actions: useCommandLaunchActions(),
    }),
    { wrapper: Wrapper },
  )
  expect(result.current.launch).toBe(LOADING)
  expect(result.current.palette).toBe(LOADING)
  expect(result.current.open).toBe(false)
  expect(result.current.files).toEqual([])

  await act(async () => {
    attach()
    fixture.publishMachines()
    await referenceState(result.current.owner).refreshRepos()
  })
  await waitFor(() => {
    expect(result.current.launch).not.toBe(LOADING)
    expect(result.current.palette).not.toBe(LOADING)
  })
  const { launch, palette, actions, owner } = result.current
  expect(launch).toMatchObject({
    initialRepoPath: '/synthetic/project',
    repoPaths: ['/synthetic/project'],
    machines: [{ id: 'host-one' }, { id: 'host-two' }, { id: 'host-three' }],
  })
  expect(palette).toMatchObject({ paletteOpen: false, selectedIssueId: null })
  expect(actions.setPaletteOpen).toBe(referenceState(owner).setPaletteOpen)
  expect(actions.updateIssue).toBe(referenceState(owner).updateIssue)

  storeStats.enable()
  storeStats.reset()
  await act(async () => {
    actions.setPaletteOpen(true)
    actions.setSelectedIssueId(asIssueId('synthetic-1'))
    for (let step = 1; step <= 20; step++) fixture.activity(step)
  })
  expect(result.current.open).toBe(true)
  expect(result.current.palette).toMatchObject({
    paletteOpen: true,
    selectedIssueId: 'synthetic-1',
  })
  expect(storeStats.snapshot().runtimes).toEqual([])
  expect(fatal).not.toHaveBeenCalled()
})


it('mounts the actual closed palette without issue/session demand at 1x/4x, then licenses visible choices', async () => {
  for (const scale of [1, 4]) {
    const fixture = createHeaderFixture(12 * scale, 8 * scale), fatal = vi.fn()
    function Wrapper({ children }: { children: ReactNode }) {
      return <StoreProvider principal={asClientPrincipal(asUserId(`closed-palette-${scale}`))}
        config={{ httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }} api={fixture.api}
        createReplicaFn={() => fixture.newReplica()} networkEnabled={false} onFatalError={fatal}
        attachRuntime={runtime => { fixture.bindHub(runtime.hub); return attachWorklistPool(runtime, fatal) }}>
        <ConfirmProvider><CommandPalette />{children}</ConfirmProvider>
      </StoreProvider>
    }
    const hook = renderHook(() => ({ pool: useWorklistPool(), actions: useCommandLaunchActions() }), { wrapper: Wrapper })
    await waitFor(() => expect(hook.result.current.pool).toBeTruthy())
    await act(async () => {})
    const pool = hook.result.current.pool!
    const counts = commandLaunchViews(pool).counts
    expect(counts.catalogBuilds).toBe(0); expect(counts.issueBuilds).toBe(0)
    expect(counts.coldSessionVisits).toBe(0); expect(counts.addressedSessionReads).toBe(0)
    await act(async () => hook.result.current.actions.setPaletteOpen(true))
    await waitFor(() => expect(counts.catalogBuilds).toBeGreaterThan(0))
    await act(async () => hook.result.current.actions.setPaletteOpen(false))
    const afterClose = { ...counts }
    await act(async () => { for (let i = 0; i < 5; i++) fixture.activity(i + 1) })
    expect(counts).toEqual(afterClose)
    expect(fatal).not.toHaveBeenCalled()
    hook.unmount(); cleanup()
  }
})
