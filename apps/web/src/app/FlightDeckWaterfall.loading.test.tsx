// @vitest-environment happy-dom
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { LOADING } from '@podium/client-graph'
import { screenOptions } from '@podium/client-graph/host'
import { MissionScreen } from '@podium/client-graph/mission-screen'
import { createRuntimeWorklistPool } from '@podium/client-graph/runtime-pool'
import { autorun } from 'mobx'
import { startScenarioEngine } from '../../../../tests/worklist/shared/src/scenarios'
import { FlightDeckWaterfall } from './FlightDeckWaterfall'
import { poolBackedScreens } from './pool-screens'
import { NOW, waterfallFixture } from './waterfall-view.test.fixture'

const state = vi.hoisted(() => ({ pool: null as unknown, now: 0 }))
const owner = {
  access: {
    get coarseNow() {
      return state.now
    },
    uiState: { get: () => null, set: () => {} },
    trpc: { sessions: { activityHistory: { query: async () => ({ sessions: {} }) } } },
  },
}
vi.mock('@podium/client-core/react', async (original) => ({
  ...(await original<typeof import('@podium/client-core/react')>()),
  useStoreHandle: () => owner,
}))
vi.mock('./store', () => ({
  useRuntimeSelector: (read: (store: typeof owner.access) => unknown) => read(owner.access),
}))
vi.mock('./store-worklist-pool', () => ({
  useWorklistPool: () => state.pool,
  useWorklistPoolProjection: (read: (pool: unknown) => unknown, empty: unknown) =>
    state.pool ? read(state.pool) : empty,
}))
afterEach(() => {
  cleanup()
  state.pool = null
  vi.restoreAllMocks()
})

it('opens a cold production mission in Waterfall without throwing the loading sentinel', async () => {
  const ctx = await startScenarioEngine(1, { seed: 4443 })
  const handle = createRuntimeWorklistPool(ctx.engine, screenOptions(poolBackedScreens, ctx.engine))
  const screen = new MissionScreen(handle.pool, 'i1766', { development: true })
  state.pool = handle.pool
  state.now = ctx.engine.access.coarseNow
  screen.open()
  const stop = autorun(() => void screen.ready)
  try {
    // Match the mission opening seam: header ready, no Waterfall reads warmed.
    for (let turn = 0; turn < 8 && !screen.ready; turn++) {
      await Promise.resolve()
      handle.pool.hydrate()
    }
    expect(screen.ready).toBe(true)
    const ui = render(waterfall(screen))
    await waitFor(() => {
      handle.pool.hydrate()
      expect(ui.container.querySelector('.waterfall-issue-open')).not.toBeNull()
    })
    expect(ui.container.textContent).not.toContain(String(LOADING))
  } finally {
    cleanup()
    stop()
    screen.close()
    handle.dispose()
    ctx.dispose()
  }
}, 60_000)

function waterfall(screen: MissionScreen, isFolded = () => false) {
  const scrollRef = { current: null as HTMLElement | null }
  return (
    <div
      ref={(node) => {
        scrollRef.current = node
        if (node) Object.defineProperty(node, 'clientHeight', { value: 192, configurable: true })
      }}
    >
      <FlightDeckWaterfall
        screen={screen}
        scrollRef={scrollRef}
        display="compact"
        focusedIssueId={null}
        activeSessionId={null}
        renameTarget={null}
        isFolded={isFolded}
        onToggle={() => {}}
        onSelectIssue={() => {}}
        onSelectSession={() => {}}
        onIssueMenu={() => {}}
        onStatusPick={() => {}}
        onRenameIssue={() => {}}
        onRenameDone={() => {}}
      />
    </div>
  )
}

it.each([
  'spine',
  'row',
] as const)('shows loading and recovers when the %s reader settles', async (seam) => {
  const f = await waterfallFixture(3)
  state.pool = f.pool
  state.now = NOW
  const read =
    seam === 'spine'
      ? vi.spyOn(f.screen, 'rootRow', 'get').mockImplementation(() => {
          throw LOADING
        })
      : null
  const pending = () => {
    throw LOADING
  }
  try {
    const ui = render(waterfall(f.screen, seam === 'row' ? pending : undefined))
    await waitFor(() =>
      expect(ui.getAllByRole('status')[0]?.textContent).toContain('Loading timeline'),
    )
    expect(ui.container.querySelector('.waterfall-issue-open')).toBeNull()
    read?.mockRestore()
    ui.rerender(waterfall(f.screen))
    await waitFor(() => expect(ui.container.querySelector('.waterfall-issue-open')).not.toBeNull())
    expect(ui.queryByRole('status')).toBeNull()
  } finally {
    cleanup()
    read?.mockRestore()
    f.close()
  }
})
