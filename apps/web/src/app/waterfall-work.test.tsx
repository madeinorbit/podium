// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { useRef, useSyncExternalStore } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MobxPool } from '@podium/client-graph/pool'
import { insideReader, measureWork } from '../../../../tests/worklist/harness/src/work-meter'
import { FlightDeckWaterfall } from './FlightDeckWaterfall'
import { NOW, waterfallFixture } from './waterfall-view.test.fixture'

const state = vi.hoisted(() => ({
  pool: null as MobxPool | null,
  now: 0,
  history: null as ((input: { sessionIds: string[] }) => Promise<unknown>) | null,
  listeners: new Set<() => void>(),
}))
const query = (input: { sessionIds: string[] }) => state.history?.(input) ?? Promise.resolve({ sessions: {} })
const owner = { access: {
  get coarseNow() { return state.now },
  renameSession: async () => {},
  uiState: { get: () => null, set: () => {} },
  trpc: { sessions: { activityHistory: { query } } },
} }
vi.mock('@podium/client-core/react', async original => ({
  ...await original<typeof import('@podium/client-core/react')>(),
  useStoreHandle: () => owner,
}))
vi.mock('./store', () => ({
  useRuntimeSelector: (read: (access: typeof owner.access) => unknown) => {
    const selector = useRef(read)
    selector.current = read
    return useSyncExternalStore(callback => {
      state.listeners.add(callback)
      return () => state.listeners.delete(callback)
    }, () => selector.current(owner.access), () => selector.current(owner.access))
  },
}))
vi.mock('./store-worklist-pool', () => ({
  useWorklistPoolProjection: (read: (pool: MobxPool) => unknown, empty: unknown) => state.pool ? read(state.pool) : empty,
  useWorklistPool: () => state.pool,
}))
afterEach(() => { cleanup(); state.listeners.clear(); state.pool = null; vi.restoreAllMocks() })

const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)) }) }

async function mount(count: number) {
  const f = await waterfallFixture(count)
  state.pool = f.pool
  state.now = NOW
  const history = vi.fn(async ({ sessionIds }: { sessionIds: string[] }) => ({ sessions: Object.fromEntries(sessionIds.map(id =>
    [id, [{ at: new Date(NOW - 3600000).toISOString(), phase: 'working' }]])) }))
  state.history = history
  const scrollRef = { current: null as HTMLElement | null }
  const props = { screen: f.screen, scrollRef, display: 'compact' as const,
    focusedIssueId: null, activeSessionId: null, renameTarget: null, isFolded: () => false,
    onToggle: vi.fn(), onSelectIssue: vi.fn(), onSelectSession: vi.fn(), onIssueMenu: vi.fn(),
    onStatusPick: vi.fn(), onRenameIssue: vi.fn(), onRenameDone: vi.fn() }
  let ui!: ReturnType<typeof render>
  await act(async () => {
    ui = render(<div ref={node => {
      scrollRef.current = node
      if (node) Object.defineProperty(node, 'clientHeight', { value: 192, configurable: true })
    }} data-testid="flight-deck-scroller"><FlightDeckWaterfall {...props} /></div>)
  })
  await settle()
  await waitFor(() => expect(ui.container.querySelectorAll('.waterfall-issue-row').length).toBeGreaterThan(0))
  return { f, ui, history, scrollRef, close: () => { ui.unmount(); f.close() } }
}

describe('elements waterfall viewport', () => {
  it('keeps actual keyboard, zoom, pointer-pan and activity work flat at 1x and 4x crew', async () => {
    const scales = []
    for (const count of [24, 96]) {
      const mounted = await mount(count)
      const { f, ui, history } = mounted
      try {
        const root = ui.getByTestId('flight-deck-waterfall')
        const drawn = [...ui.container.querySelectorAll<HTMLElement>('.waterfall-issue-row')].map(row => row.dataset.flightIssue!)
        expect(drawn.length).toBeLessThan(count)
        const requested = history.mock.calls.flatMap(([input]) => input.sessionIds)
        const allowed = new Set(drawn.flatMap(id => f.view.row(f.view.rows.find(row => row.id === id)!).drawnSessionIds))
        expect(requested.every(id => allowed.has(id))).toBe(true)
        const cells = []
        for (const [name, action] of [
          ['keyboard-pan', () => fireEvent.keyDown(root, { key: 'ArrowLeft', altKey: true })],
          ['zoom', () => fireEvent.click(ui.getByRole('button', { name: 'Zoom in' }))],
          ['pointer-pan', () => {
            const track = ui.container.querySelector<HTMLElement>('.waterfall-track-cell')!
            root.setPointerCapture = vi.fn()
            fireEvent.pointerDown(track, { button: 0, clientX: 100, pointerId: 1 })
            fireEvent.pointerMove(root, { clientX: 120, pointerId: 1 })
            fireEvent.pointerUp(root, { pointerId: 1 })
          }],
        ] as const) {
          const measured = await measureWork(async () => insideReader(`waterfall.${name}`, async () => {
            await act(async () => action())
            await settle()
          }), { pool: f.pool })
          cells.push({ name, ...measured.work })
        }
        history.mockClear()
        const updated = f.pool.row('session', 's-1-0') as Record<string, unknown>
        const activity = await measureWork(async () => insideReader('waterfall.activity', async () => {
          await act(async () => f.pool.apply({ type: 'update', rows: [{ kind: 'session', id: 's-1-0',
            value: { ...updated, agentState: { ...(updated.agentState as object), phase: 'needs_user' } } }] }))
          await settle()
        }), { pool: f.pool })
        expect(history.mock.calls.flatMap(([input]) => input.sessionIds)).toEqual(['s-1-0'])
        cells.push({ name: 'activity', ...activity.work })
        history.mockClear()
        const tick = await measureWork(async () => insideReader('waterfall.minute', async () => {
          await act(async () => { state.now += 60000; for (const listener of state.listeners) listener() })
        }), { pool: f.pool })
        expect(history).not.toHaveBeenCalled()
        expect(Object.keys(tick.work.derivationsBy).filter(name => /(?:^|\/)observer/.test(name))).toEqual(['consumer:waterfall.minute/observerWaterfallLiveEdge'])
        expect(Object.keys(tick.work.derivationsBy).some(name => /WaterfallRow|WaterfallSession|observerFlightDeckWaterfall|observerWaterfallIssue|observerWaterfallSessionBar/.test(name))).toBe(false)
        cells.push({ name: 'minute', ...tick.work })
        scales.push(cells)
      } finally { mounted.close() }
    }
    for (let i = 0; i < scales[0]!.length; i++) {
      const one = scales[0]![i]!, four = scales[1]![i]!
      console.info(`[waterfall work] ${one.name}: rows ${one.rows} → ${four.rows}; derivations ${one.derivations} → ${four.derivations}; elements ${one.elements} → ${four.elements}`)
      expect(four.rows).toBe(one.rows)
      expect(four.derivations).toBe(one.derivations)
      expect(four.elements).toBe(one.elements)
    }
  })
})
