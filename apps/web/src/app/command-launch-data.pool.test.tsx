// @vitest-environment happy-dom
import { storeStats } from '@podium/client-core/perf'
import { asClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider, useClientRuntime } from '@podium/client-core/react'
import { LOADING } from '@podium/client-graph'
import { commandLaunchViews } from '@podium/client-graph/command-launch-views'
import { asIssueId, asUserId } from '@podium/model/browser'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { ConfirmProvider } from '@/lib/hooks/use-confirm'
import { createHeaderFixture } from '../../test/header-fixture'
import { CommandPalette } from './CommandPalette'
import {
  useCommandLaunchActions,
  useCommandLaunchCatalog,
  useCommandPaletteData,
  useCommandPaletteOpen,
  useCommandRecentFiles,
} from './command-launch-data'
import { attachWorklistPool, useWorklistPool } from './store-worklist-pool'
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
          fixture.bindHub(runtime.services.connection.hub, undefined, runtime.live)
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
      owner: useClientRuntime<Trpc>(),
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
  })
  await waitFor(() => {
    expect(result.current.launch).not.toBe(LOADING)
    expect(result.current.palette).not.toBe(LOADING)
  })
  const { launch, palette, actions, owner } = result.current
  if (typeof launch === 'symbol' || !palette || typeof palette === 'symbol')
    throw new Error('Launch readers did not settle')
  expect(launch.initialRepoPath).toBe('/synthetic/project')
  expect(launch.repoPaths).toEqual(['/synthetic/project'])
  const expectedMachines = [...fixture.records.values()]
    .filter((record) => record.entity === 'machine')
    .map((record) => record.entityId)
  expect(expectedMachines).toHaveLength(3)
  expect(launch.machines.map((machine) => machine.id)).toEqual(expectedMachines)
  expect(palette.paletteOpen).toBe(false)
  expect(palette.selectedIssueId).toBeNull()
  expect(actions.setPaletteOpen).toBe(owner.palette.setOpen)
  expect(actions.updateIssue).toBe(owner.commands.issues.update)

  storeStats.enable()
  storeStats.reset()
  await act(async () => {
    actions.setPaletteOpen(true)
    actions.setSelectedIssueId(asIssueId('synthetic-1'))
    for (let step = 1; step <= 20; step++) fixture.activity(step)
  })
  expect(result.current.open).toBe(true)
  const updated = result.current.palette
  if (!updated || typeof updated === 'symbol') throw new Error('Palette became unavailable')
  expect(updated.paletteOpen).toBe(true)
  expect(updated.selectedIssueId).toBe('synthetic-1')
  expect(storeStats.snapshot().runtimes).toEqual([])
  expect(fatal).not.toHaveBeenCalled()
})

it('mounts the actual closed palette without issue/session demand at 1x/4x, then licenses visible choices', async () => {
  for (const scale of [1, 4]) {
    const fixture = createHeaderFixture(12 * scale, 8 * scale),
      fatal = vi.fn()
    function Wrapper({ children }: { children: ReactNode }) {
      return (
        <StoreProvider
          principal={asClientPrincipal(asUserId(`closed-palette-${scale}`))}
          config={{ httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }}
          api={fixture.api}
          createReplicaFn={() => fixture.newReplica()}
          networkEnabled={false}
          onFatalError={fatal}
          attachRuntime={(runtime) => {
            fixture.bindHub(runtime.services.connection.hub, undefined, runtime.live)
            return attachWorklistPool(runtime, fatal)
          }}
        >
          <ConfirmProvider>
            <CommandPalette />
            {children}
          </ConfirmProvider>
        </StoreProvider>
      )
    }
    const hook = renderHook(
      () => ({ pool: useWorklistPool(), actions: useCommandLaunchActions() }),
      { wrapper: Wrapper },
    )
    await waitFor(() => expect(hook.result.current.pool).toBeTruthy())
    await act(async () => {})
    const pool = hook.result.current.pool!
    const counts = commandLaunchViews(pool).counts
    expect(counts.catalogBuilds).toBe(0)
    expect(counts.issueBuilds).toBe(0)
    expect(counts.coldSessionVisits).toBe(0)
    expect(counts.addressedSessionReads).toBe(0)
    await act(async () => hook.result.current.actions.setPaletteOpen(true))
    await waitFor(() => expect(counts.catalogBuilds).toBeGreaterThan(0))
    await act(async () => hook.result.current.actions.setPaletteOpen(false))
    const afterClose = { ...counts }
    await act(async () => {
      for (let i = 0; i < 5; i++) fixture.activity(i + 1)
    })
    expect(counts).toEqual(afterClose)
    expect(fatal).not.toHaveBeenCalled()
    hook.unmount()
    cleanup()
  }
})
