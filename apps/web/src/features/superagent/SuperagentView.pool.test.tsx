// @vitest-environment happy-dom

import type { ClientRuntime } from '@podium/client-core/engine'
import { readRuntimeStoreStats, storeStats } from '@podium/client-core/perf'
import { asClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider, useStoreHandle } from '@podium/client-core/react'
import { createMemoryRouterWindow } from '@podium/client-core/router'
import { checkSuperagent } from '@podium/client-graph/diagnostics/superagent-check'
import { asUserId } from '@podium/model/browser'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { DockHeaderSlotProvider } from '@/app/DockHeaderSlot'
import { attachWorklistPool, useWorklistPool } from '@/app/store-worklist-pool'
import { ConciergeButton } from './ConciergeButton'
import { createSuperagentFixture } from './fixture'
import { SuperagentView } from './SuperagentView'

// The conversation is POD-5173's separately allocated surface. This proof
// exercises the real parent, its props, actions and actual provider attachment.
vi.mock('@/features/chat/ChatView', () => ({
  ChatView: (props: { sessionId: string; initialTurnRunning: boolean }) => (
    <div
      data-testid="embedded-chat"
      data-session={props.sessionId}
      data-running={String(props.initialTurnRunning)}
    >
      Existing session conversation
    </div>
  ),
}))
afterEach(() => {
  cleanup()
  storeStats.enable(false)
})

async function mount() {
  const data = createSuperagentFixture(),
    errors: string[] = [],
    before: (unknown | null)[] = []
  let runtime!: ClientRuntime,
    pool: ReturnType<typeof useWorklistPool> = null
  const header = document.createElement('div')
  function Surface() {
    runtime = useStoreHandle() as ClientRuntime
    pool = useWorklistPool()
    before.push(pool)
    return (
      <>
        <ConciergeButton />
        <SuperagentView />
      </>
    )
  }
  storeStats.enable()
  storeStats.reset()
  const view = render(
    <StoreProvider
      principal={asClientPrincipal(asUserId('operator'))}
      config={{ httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }}
      api={data.api}
      createReplicaFn={() => data.newReplica()}
      networkEnabled={false}
      routerWindow={createMemoryRouterWindow()}
      onFatalError={(error) => errors.push(error)}
      attachRuntime={(owner) => {
        runtime = owner
        data.bindHub(owner.hub)
        owner.readPosition.replace({
          issueEvents: { lastEventId: 9, seenAt: '2026-10-02T00:00:00Z' },
        })
        const stop = attachWorklistPool(owner, (error) => errors.push(error.message))
        void owner.access.refreshSuperThreads()
        void owner.access.refreshRepos()
        return stop
      }}
    >
      <DockHeaderSlotProvider value={header}>
        <Surface />
      </DockHeaderSlotProvider>
    </StoreProvider>,
  )
  await waitFor(() =>
    expect(view.container.querySelector('[data-testid="embedded-chat"]')).toBeTruthy(),
  )
  await waitFor(() =>
    expect(
      view.container.querySelector<HTMLButtonElement>('button[aria-label="Concierge"]')?.disabled,
    ).toBe(false),
  )
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
  return {
    view,
    header,
    data,
    runtime,
    errors,
    before,
    get pool() {
      return pool
    },
  }
}
const snapshot = (f: Awaited<ReturnType<typeof mount>>) => ({
  html: f.view.container.innerHTML,
  controls: f.header.innerHTML,
})
it('preserves saved thread, return marker, concierge and dock controls', async () => {
  const enabled = await mount()
  expect(snapshot(enabled)).toMatchSnapshot('last green superagent controls')
  expect(enabled.errors).toEqual([])
  expect(enabled.before[0]).toBeNull()
  expect(enabled.pool).toBeTruthy()
  await waitFor(() =>
    expect(checkSuperagent(enabled.pool!, enabled.runtime.access)).toMatchObject({
      differences: 0,
      pending: 0,
    }),
  )
})
it('executes zero legacy Superagent derivations through attach, feed, local and thread updates', async () => {
  const enabled = await mount()
  const own = () =>
    Object.entries(readRuntimeStoreStats(enabled.runtime)?.slices ?? {}).filter(
      ([name]) => name === 'superagent' || name.startsWith('superagent.'),
    )
  expect(own()).toEqual([])
  expect(readRuntimeStoreStats(enabled.runtime)?.selectorRuns ?? 0).toBe(0)
  await act(async () => {
    enabled.data.activity(1)
    enabled.runtime.access.setSuperThreadId('btw-private' as never)
    await enabled.data.updateThread(enabled.runtime, true)
  })
  expect(
    enabled.view.container
      .querySelector('[data-testid="embedded-chat"]')
      ?.getAttribute('data-session'),
  ).toBe('synthetic-session-0')
  expect(
    enabled.view.container
      .querySelector('[data-testid="embedded-chat"]')
      ?.getAttribute('data-running'),
  ).toBe('true')
  expect(own()).toEqual([])
  expect(readRuntimeStoreStats(enabled.runtime)?.selectorRuns ?? 0).toBe(0)
  enabled.view.unmount()
})
it('keeps the existing mutation and navigation owner for clear, terminal and concierge actions', async () => {
  const enabled = await mount()
  await act(async () =>
    fireEvent.click(enabled.header.querySelector('button[title^="Clear context"]')!),
  )
  await act(async () =>
    fireEvent.click(enabled.header.querySelector('button[title^="Open this conversation"]')!),
  )
  await waitFor(() => expect(enabled.runtime.access.paneA).toBe('synthetic-session-3'))
  fireEvent.click(enabled.view.container.querySelector('button[aria-label="Concierge"]')!)
  expect(enabled.data.actions).toMatchObject({ cleared: 1, opened: 1 })
  expect(enabled.runtime.access.superThreadId).toMatch(/^concierge_/)
  expect(enabled.errors).toEqual([])
})
