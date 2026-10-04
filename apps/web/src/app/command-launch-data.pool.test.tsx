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
  useCommandGuardSessions,
  useCommandLaunchActions,
  useCommandLaunchData,
  useCommandPaletteData,
  useCommandPaletteOpen,
  useCommandRecentFiles,
} from './command-launch-data'
import { attachWorklistPool } from './store-worklist-pool'
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
      launch: useCommandLaunchData(),
      palette: useCommandPaletteData(),
      open: useCommandPaletteOpen(),
      sessions: useCommandGuardSessions(),
      files: useCommandRecentFiles(),
      actions: useCommandLaunchActions(),
    }),
    { wrapper: Wrapper },
  )
  expect(result.current.launch).toBe(LOADING)
  expect(result.current.palette).toBe(LOADING)
  expect(result.current.open).toBe(false)
  expect(result.current.sessions).toEqual([])
  expect(result.current.files).toEqual([])

  await act(async () => {
    attach()
    fixture.publishMachines()
    await result.current.owner.access.refreshRepos()
  })
  await waitFor(() => {
    expect(result.current.launch).not.toBe(LOADING)
    expect(result.current.palette).not.toBe(LOADING)
    expect(result.current.sessions).toHaveLength(10)
  })
  const { launch, palette, actions, owner } = result.current
  expect(launch).toMatchObject({
    initialRepoPath: '/synthetic/project',
    repoChoices: [{ path: '/synthetic/project' }],
    machines: [{ id: 'host-one' }, { id: 'host-two' }, { id: 'host-three' }],
  })
  expect(palette).toMatchObject({ paletteOpen: false, selectedIssueId: null })
  expect(result.current.sessions.map((row) => row.sessionId).sort()).toEqual(
    [
      ...Array.from({ length: 8 }, (_, index) => `synthetic-session-${index}`),
      'synthetic-guest-0',
      'synthetic-guest-1',
    ].sort(),
  )
  expect(actions.setPaletteOpen).toBe(owner.access.setPaletteOpen)
  expect(actions.updateIssue).toBe(owner.access.updateIssue)

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
  expect(storeStats.snapshot().runtimes[0]).toMatchObject({ selectorRuns: 0, slices: {} })
  expect(fatal).not.toHaveBeenCalled()
})
