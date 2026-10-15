// @vitest-environment happy-dom

import type { RoutedUiState } from '@podium/client-core/ui-state'
import { MissionScreen } from '@podium/client-graph/mission-screen'
import { settled } from '@podium/client-graph/mission-view'
import { MobxPool } from '@podium/client-graph/pool'
import { attachPreferenceSource } from '@podium/client-graph/preference-source'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { autorun } from 'mobx'
import { createRef } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { FlightDeckFullGroups } from './FlightDeckFullGroups'

vi.mock('./store', () => ({
  useRuntimeSelector: (read: (store: unknown) => unknown) => read({ renameSession: vi.fn() }),
}))
vi.mock('@/lib/use-harness-descriptors', () => ({
  useHarnessDescriptors: () => ({ served: undefined }),
}))

const stamp = '2026-10-15T12:00:00Z'
type Row = Record<string, unknown>
const issue = (id: string, parentId: string | null, sortKey: string, patch: Row = {}): Row => ({
  id,
  parentId,
  sortKey,
  seq: id.length,
  title: id,
  type: 'task',
  stage: 'backlog',
  audience: 'human',
  repoId: 'repo',
  repoPath: '/synthetic',
  deps: [],
  createdAt: stamp,
  updatedAt: stamp,
  readAt: stamp,
  ...patch,
})
const waits = (id: string) => ({ id, type: 'blocked-by' })
const fixture = () => [
  issue('root', null, 'a'),
  issue('loose', 'root', 'a'),
  issue('build', 'root', 'b', { type: 'phase' }),
  issue('source', 'build', 'a'),
  issue('unrelated', 'build', 'b'),
  issue('parent', 'build', 'c'),
  issue('dependent', 'parent', 'a', { deps: [waits('source'), waits('external')] }),
  issue('semantic', 'build', 'd', {
    deps: ['related', 'discovered-from', 'supersedes', 'duplicates'].map((type) => ({
      id: 'source',
      type,
    })),
  }),
  issue('quality', 'root', 'c', { type: 'phase' }),
  issue('cross', 'quality', 'a', { deps: [waits('source')] }),
  issue('other phase work', 'quality', 'b'),
  issue('external', null, 'a', { seq: 777 }),
  issue('proposal', 'root', 'z', { stage: 'proposed' }),
]
let width = 900
let zoom = 1
const positions = new Map<string, number>()
const observers: ResizeObserverFixture[] = []
class ResizeObserverFixture {
  readonly observed = new Set<Element>()
  disconnected = false
  constructor(readonly callback: ResizeObserverCallback) {
    observers.push(this)
  }
  observe(node: Element) {
    this.observed.add(node)
  }
  unobserve(node: Element) {
    this.observed.delete(node)
  }
  disconnect() {
    this.disconnected = true
    this.observed.clear()
  }
}
const rect = (x: number, y: number, w: number, h: number) =>
  ({
    x,
    y,
    left: x,
    top: y,
    right: x + w,
    bottom: y + h,
    width: w,
    height: h,
    toJSON() {},
  }) as DOMRect
const disposals: (() => void)[] = []
beforeEach(() => {
  width = 900
  zoom = 1
  positions.clear()
  observers.length = 0
  vi.stubGlobal('ResizeObserver', ResizeObserverFixture)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    const id = this.dataset.flightTaskRow
    const rows = [
      ...(this.closest('.flight-full-groups')?.querySelectorAll('[data-flight-task-row]') ?? []),
    ]
    const y = id ? (positions.get(id) ?? 40 + rows.indexOf(this) * 40) : 0
    return rect(100, 50 + y * zoom, width * zoom, (id ? 32 : 700) * zoom)
  })
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(() => width)
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width)
})
afterEach(() => {
  cleanup()
  for (const dispose of disposals.splice(0)) dispose()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
async function open(rows = fixture(), sessions: Row[] = []) {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) })
  const values = new Map<string, string>()
  const listeners = new Set<(keys: ReadonlySet<string>) => void>()
  const preferences: RoutedUiState = {
    get: (key) => values.get(key) ?? null,
    set: (key, value) => {
      if (value === null) values.delete(key)
      else values.set(key, value)
      for (const listener of listeners) listener(new Set([key]))
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  attachPreferenceSource(pool, preferences)
  pool.apply({
    type: 'replace',
    rows: [
      { kind: 'repo', id: 'repo', value: { id: 'repo', repoPath: '/synthetic', prefix: 'POD' } },
      ...rows.map((value) => ({
        kind: 'issue' as const,
        id: value['id'] as string,
        value: value as never,
      })),
      ...sessions.map((value) => ({
        kind: 'session' as const,
        id: value['sessionId'] as string,
        value: value as never,
      })),
    ],
  })
  const screen = new MissionScreen(pool, 'root', {
    setPreference: (key, value) => preferences.set(key, value),
  })
  screen.open()
  const stop = autorun(() => {
    void settled(() => screen.full.ready)
  })
  disposals.push(() => {
    stop()
    screen.close()
    pool.dispose()
  })
  await waitFor(() => expect(settled(() => screen.full.ready)).toBe(true))
  const scrollRef = createRef<HTMLDivElement>()
  const actions = {
    activeSessionId: 'selected-session',
    renameTarget: null,
    onSelectSession: vi.fn(),
    onMenu: vi.fn(),
    onStatusPick: vi.fn(),
    onRename: vi.fn(),
    onRenameDone: vi.fn(),
  }
  const ui = render(
    <div className="flight-full-panel" ref={scrollRef}>
      <button type="button">Coordinator</button>
      <FlightDeckFullGroups full={screen.full} scrollRef={scrollRef} {...actions} />
      <button type="button">Proposals</button>
    </div>,
  )
  const row = (id: string) =>
    ui.container.querySelector<HTMLElement>(`[data-flight-task-row="${id}"]`)!
  const card = (id: string) => row(id).closest<HTMLElement>('.flight-v6-card')!
  const edges = () => [...ui.container.querySelectorAll<SVGGElement>('[data-dependency-source]')]
  const resize = () =>
    act(() => {
      for (const observer of observers)
        if (!observer.disconnected) observer.callback([], observer as unknown as ResizeObserver)
    })
  return { screen, pool, full: screen.full, ui, row, card, edges, actions, scrollRef, resize }
}

it('continuously draws only scheduling links in expanded Full and limits dimming to the hovered phase', async () => {
  const f = await open()
  await waitFor(() => expect(f.edges()).toHaveLength(2))
  expect(f.edges().map((e) => [e.dataset.dependencySource, e.dataset.dependencyTarget])).toEqual([
    ['source', 'dependent'],
    ['source', 'cross'],
  ])
  fireEvent.pointerOver(f.row('source'))
  expect(f.card('dependent').dataset.dependencyHighlight).toBe('true')
  expect(f.card('cross').dataset.dependencyHighlight).toBe('true')
  expect(f.card('unrelated').dataset.dependencyDim).toBe('true')
  expect(f.card('semantic').dataset.dependencyDim).toBe('true')
  expect(f.card('parent').dataset.dependencyDim).toBeUndefined() // related descendant retains its ancestors
  expect(f.card('other phase work').dataset.dependencyDim).toBeUndefined()
  expect(f.card('loose').dataset.dependencyDim).toBeUndefined()
  expect(
    f.ui.container.querySelector<HTMLElement>('[data-phase-lead-slot="build"]')?.dataset
      .dependencyDim,
  ).toBe('true')
  expect(
    f.ui.container.querySelector<HTMLElement>('[data-phase-lead-slot="quality"]')?.dataset
      .dependencyDim,
  ).toBeUndefined()
  expect(f.edges().every((e) => e.dataset.highlighted === 'true')).toBe(true)
  for (const edge of f.edges())
    expect(edge.querySelector('path')?.getAttribute('stroke-width')).toBe('1.5')
  expect(
    f.ui.getByRole('button', { name: 'Coordinator' }).hasAttribute('data-dependency-dim'),
  ).toBe(false)
  expect(f.ui.getByRole('button', { name: 'Proposals' }).hasAttribute('data-dependency-dim')).toBe(
    false,
  )
  fireEvent.pointerOut(f.ui.getByTestId('flight-deck-full-groups'), {
    relatedTarget: document.body,
  })
  expect(f.ui.container.querySelector('[data-dependency-dim]')).toBeNull()
  expect(f.edges()).toHaveLength(2)
})

it('cross-phase hover dims only its own group, and loose work does not dim phases', async () => {
  const f = await open()
  fireEvent.pointerOver(f.row('cross'))
  expect(f.card('source').dataset.dependencyHighlight).toBe('true')
  expect(f.card('unrelated').dataset.dependencyDim).toBeUndefined()
  expect(f.card('other phase work').dataset.dependencyDim).toBe('true')
  fireEvent.pointerOver(f.row('loose'))
  expect(f.ui.container.querySelector('[data-dependency-dim]')).toBeNull()
})

it('below 860 focus is equivalent to hover, clears across controls and never selects a session', async () => {
  width = 859
  const f = await open()
  await waitFor(() => expect(f.edges()).toHaveLength(0))
  const buttons = within(f.row('source')).getAllByRole('button')
  act(() => buttons[0]!.focus())
  await waitFor(() => expect(f.edges()).toHaveLength(2))
  expect(f.card('dependent').dataset.dependencyHighlight).toBe('true')
  act(() => buttons.at(-1)!.focus())
  expect(f.card('dependent').dataset.dependencyHighlight).toBe('true')
  fireEvent.pointerOver(f.row('cross'))
  expect(f.card('other phase work').dataset.dependencyDim).toBe('true')
  fireEvent.pointerOut(f.ui.getByTestId('flight-deck-full-groups'), {
    relatedTarget: document.body,
  })
  expect(f.card('unrelated').dataset.dependencyDim).toBe('true') // retained keyboard focus
  act(() => f.ui.getByRole('button', { name: 'Proposals' }).focus())
  expect(f.edges()).toHaveLength(0)
  expect(f.ui.container.querySelector('[data-dependency-highlight]')).toBeNull()
  expect(f.actions.onSelectSession).not.toHaveBeenCalled()
})

it('drops folded, filtered and searched endpoints and retains external refs only in pills', async () => {
  const f = await open()
  await waitFor(() => expect(f.edges()).toHaveLength(2))
  const pill = f.row('dependent').querySelector<HTMLElement>('[data-dependency-slot]')!
  expect(pill.dataset.kind).toBe('blocked')
  expect(pill.textContent).toContain('2 tasks')
  expect(pill.title).toContain('POD-777')
  fireEvent.pointerOver(f.row('dependent'))
  act(() => f.full.toggleFold('parent'))
  await waitFor(() => expect(f.edges()).toHaveLength(1))
  expect(f.ui.container.querySelector('[data-dependency-dim]')).toBeNull()
  act(() => f.full.setFilter('active'))
  await waitFor(() => expect(f.edges()).toHaveLength(0))
  act(() => {
    f.full.setFilter('all')
    f.full.toggleFold('parent')
    f.screen.setQuery('dependent')
  })
  await waitFor(() => expect(f.row('dependent')).not.toBeNull())
  expect(f.row('source')).toBeNull()
  await waitFor(() => expect(f.edges()).toHaveLength(0))
})

it('remeasures scroll, resize and zoom and omits offscreen mounted endpoints', async () => {
  zoom = 1.25
  const f = await open()
  await waitFor(() => expect(f.edges()).toHaveLength(2))
  const circle = f.edges()[0]!.querySelector('circle')!
  expect(circle.getAttribute('cx')).toBe('875')
  positions.set('source', 1000)
  fireEvent.scroll(f.scrollRef.current!)
  await waitFor(() => expect(f.edges()).toHaveLength(0))
  positions.set('source', 180)
  f.resize()
  await waitFor(() => expect(f.edges()).toHaveLength(2))
  expect(f.edges()[0]!.querySelector('circle')?.getAttribute('cy')).toBe('196')
  width = 859
  f.resize()
  await waitFor(() => expect(f.edges()).toHaveLength(0))
  fireEvent.pointerOver(f.row('source'))
  expect(f.edges()).toHaveLength(2)
})

it('ignores virtual placeholders and disconnects observers, listeners and queued frames on unmount', async () => {
  const rows = [
    issue('root', null, 'a'),
    ...Array.from({ length: 100 }, (_, i) =>
      issue(
        `task-${i}`,
        'root',
        String(i).padStart(3, '0'),
        i === 0 ? { deps: [waits('task-99')] } : {},
      ),
    ),
  ]
  const f = await open(rows)
  expect(f.row('task-99')).toBeNull()
  expect(f.ui.container.querySelector('[data-deck-placeholder="task:task-99"]')).not.toBeNull()
  expect(f.edges()).toHaveLength(0)
  const scrollRemove = vi.spyOn(f.scrollRef.current!, 'removeEventListener')
  const windowRemove = vi.spyOn(window, 'removeEventListener')
  const cancel = vi.spyOn(window, 'cancelAnimationFrame')
  const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect')
  f.resize()
  f.ui.unmount()
  expect(observers.every((observer) => observer.disconnected)).toBe(true)
  expect(scrollRemove.mock.calls.some(([type]) => type === 'scroll')).toBe(true)
  expect(windowRemove.mock.calls.some(([type]) => type === 'resize')).toBe(true)
  expect(cancel).toHaveBeenCalled()
  expect(disconnect).toHaveBeenCalled()
})

it('uses the shared word for locked versus neutral pills while keeping external references in the tooltip', async () => {
  const f = await open([
    issue('root', null, 'a'),
    issue('external', null, 'a', { seq: 777 }),
    ...['backlog', 'shipping', 'in_progress'].map((stage, i) =>
      issue(stage, 'root', String(i), {
        stage,
        blocked: true,
        deps: [waits('external')],
      }),
    ),
    issue('decision', 'root', 'z', { type: 'decision', blocked: true, deps: [waits('external')] }),
  ])
  expect(f.row('backlog').querySelector('[data-dependency-slot]')?.getAttribute('data-kind')).toBe(
    'blocked',
  )
  for (const id of ['shipping', 'decision']) {
    const pill = f.row(id).querySelector<HTMLElement>('[data-dependency-slot]')!
    expect(pill.dataset.kind).toBe('waiting')
    expect(pill.title).toContain('POD-777')
    expect(pill.textContent).toContain('after')
  }
  // Started without a live idle session stays Blocked under the shared rule.
  expect(
    f.row('in_progress').querySelector('[data-dependency-slot]')?.getAttribute('data-kind'),
  ).toBe('blocked')
  expect(f.edges()).toHaveLength(0)
})
