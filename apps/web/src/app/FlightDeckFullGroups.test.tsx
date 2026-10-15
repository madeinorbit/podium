// @vitest-environment happy-dom
import { readFileSync, writeFileSync } from 'node:fs'
import type { FullDeckTask } from '@podium/client-graph/mission-full-deck'
import { MissionScreen } from '@podium/client-graph/mission-screen'
import { settled } from '@podium/client-graph/mission-view'
import { MobxPool } from '@podium/client-graph/pool'
import { attachPreferenceSource } from '@podium/client-graph/preference-source'
import type { RoutedUiState } from '@podium/client-core/ui-state'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { autorun } from 'mobx'
import { createRef } from 'react'
import { afterAll, afterEach, expect, it, vi } from 'vitest'
import { FlightDeckFullGroups } from './FlightDeckFullGroups'

vi.mock('./store', () => ({
  useRuntimeSelector: (read: (value: unknown) => unknown) => read({ renameSession: vi.fn() }),
}))
vi.mock('@/lib/use-harness-descriptors', () => ({
  useHarnessDescriptors: () => ({ served: undefined }),
}))

const stamp = '2026-10-15T12:00:00Z'
type Row = Record<string, unknown>
const issue = (id: string, parentId: string | null, sortKey: string, patch: Row = {}): Row => ({
  id, parentId, sortKey, seq: id.length, title: id, type: 'task', stage: 'backlog',
  audience: 'human', repoPath: '/synthetic', repoId: 'repo', deps: [],
  createdAt: stamp, updatedAt: stamp, readAt: stamp, ...patch,
})
const done = { stage: 'done', closedAt: stamp }
const phase = { type: 'phase' }
const mixed = () => [
  issue('root', null, 'a'),
  issue('completed phase', 'root', 'a', phase),
  issue('released', 'completed phase', 'a', done),
  issue('build', 'root', 'b', phase),
  issue('shipped', 'build', 'a', done),
  issue('parent', 'build', 'b'),
  issue('done grandchild', 'parent', 'a', done),
  issue('open grandchild', 'parent', 'b'),
  issue('last done grandchild', 'parent', 'c', done),
  issue('next', 'root', 'c', phase),
  issue('future task', 'next', 'a'),
  issue('loose done', 'root', 'x', done),
  issue('loose work', 'root', 'z'),
  issue('proposal', 'root', '0', { stage: 'proposed' }),
]
const close: (() => void)[] = []
afterEach(() => {
  cleanup()
  for (const release of close.splice(0)) release()
})
async function open(issues = mixed(), sessions: Row[] = []) {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) })
  const values = new Map<string, string>()
  const listeners = new Set<(keys: ReadonlySet<string>) => void>()
  const uiState: RoutedUiState = {
    get: (key) => values.get(key) ?? null,
    set: (key, value) => {
      if (value === null) values.delete(key)
      else values.set(key, value)
      for (const listener of listeners) listener(new Set([key]))
    },
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
  }
  attachPreferenceSource(pool, uiState)
  pool.apply({ type: 'replace', rows: [
    { kind: 'repo', id: 'repo', value: { id: 'repo', repoPath: '/synthetic', prefix: 'POD' } },
    ...issues.map(value => ({ kind: 'issue' as const, id: value['id'] as string, value: value as never })),
    ...sessions.map(value => ({ kind: 'session' as const, id: value['sessionId'] as string, value: value as never })),
  ] })
  const screen = new MissionScreen(pool, 'root', { setPreference: (key, value) => uiState.set(key, value) })
  screen.open()
  const stop = autorun(() => { void settled(() => screen.full.ready) })
  close.push(() => { stop(); screen.close(); pool.dispose() })
  await waitFor(() => expect(settled(() => screen.full.ready)).toBe(true))
  const actions = {
    activeSessionId: null, renameTarget: null, onSelectSession: vi.fn(), onMenu: vi.fn(),
    onStatusPick: vi.fn(), onRename: vi.fn(), onRenameDone: vi.fn(),
  }
  const props = { full: screen.full, scrollRef: createRef<HTMLElement>(), ...actions }
  const ui = render(<FlightDeckFullGroups {...props} />)
  const task = (id: string) => ui.container.querySelector<HTMLElement>(`[data-flight-issue="${id}"]`)
  const group = (id: string) => ui.container.querySelector<HTMLElement>(`[data-flight-phase="${id}"]`)
  const order = () => [...ui.container.querySelectorAll('[data-flight-issue], [data-flight-phase]')]
    .map(node => node.getAttribute('data-flight-issue') ?? node.getAttribute('data-flight-phase'))
  return { pool, screen, full: screen.full, props, actions, ui, task, group, order }
}

it('orders the done line, unheaded loose tasks, sorted phase sections, leaving proposals for the tail', async () => {
  const f = await open()
  expect(f.order()).toEqual(['loose work', 'build', 'parent', 'open grandchild', 'next', 'future task'])
  expect(f.ui.container.querySelector('.flight-full-groups')?.firstElementChild?.className).toBe('flight-full-done-line')
  expect(f.task('loose work')?.closest('[data-flight-phase]')).toBeNull()
  expect(f.task('loose work')?.querySelector<HTMLElement>('.flight-v6-card')?.style.marginLeft).toBe('0px')
  expect(f.task('proposal')).toBeNull()
  expect(f.full.proposalIds).toEqual(['proposal'])
  expect(f.group('build')?.querySelector('.flight-full-phase-index')?.textContent).toBe('02')
  expect(f.group('next')?.querySelector('.flight-full-phase-index')?.textContent).toBe('03')
  capture('Mixed work · done hidden', f.ui.container)
})

it('keeps a plain task list with no headers or rails when no phases exist', async () => {
  const f = await open([
    issue('root', null, 'a'), issue('one', 'root', 'a'), issue('two', 'root', 'b'),
  ])
  expect(f.order()).toEqual(['one', 'two'])
  expect(f.ui.container.querySelector('.flight-full-phase-header')).toBeNull()
  expect(f.ui.container.querySelector('.flight-full-phase-content')).toBeNull()
  expect(f.ui.container.querySelector('.flight-full-done-line')).toBeNull()
  capture('No phases · plain list', f.ui.container)
})

it('counts phase direct children separately from done leaf tasks and hides done grandchildren', async () => {
  const f = await open()
  expect(f.group('build')?.querySelector('.flight-full-phase-counter')?.textContent).toBe('1/2')
  expect(f.task('parent')?.querySelector('.flight-v6-counter')?.textContent).toBe('2/3')
  expect(f.full.counts.done).toBe(5)
  expect(f.ui.getByRole('button', { name: '1 phase complete · 5 tasks done Show' })).toBeDefined()
  for (const id of ['loose done', 'shipped', 'done grandchild', 'last done grandchild']) expect(f.task(id)).toBeNull()
  const meter = within(f.group('build')!).getByRole('meter')
  expect(meter.getAttribute('aria-valuenow')).toBe('1')
  expect(meter.getAttribute('aria-valuemax')).toBe('2')
  expect(meter.querySelector<HTMLElement>('span')?.style.width).toBe('50%')
})

it('restores completed phases and every done row at their original positions through the shared Done action', async () => {
  const f = await open()
  const counts = f.full.counts
  fireEvent.click(f.ui.getByRole('button', { name: /5 tasks done Show/ }))
  expect(f.full.showDone).toBe(true)
  expect(f.full.filter).toBe('all')
  expect(f.order()).toEqual([
    'loose done', 'loose work', 'completed phase', 'released', 'build', 'shipped',
    'parent', 'done grandchild', 'open grandchild', 'last done grandchild', 'next', 'future task',
  ])
  expect(f.ui.container.querySelector('.flight-full-done-line')).toBeNull()
  expect(f.full.counts).toEqual(counts)
  // Completion follows contained work; displaying it never closes the phase.
  expect(f.full.task('completed phase').entity.stage).toBe('backlog')
  capture('Show done · original positions', f.ui.container)
  act(() => f.full.toggleShowDone())
  expect(f.group('completed phase')).toBeNull()
  expect(f.task('done grandchild')).toBeNull()
  expect(f.ui.getByRole('button', { name: /5 tasks done Show/ })).toBeDefined()
})

it('collapses a phase by pointer, Enter and Space without selecting a session or changing a stage', async () => {
  const f = await open()
  const keyboard = userEvent.setup()
  fireEvent.click(f.ui.getByRole('button', { name: 'Collapse phase build' }))
  expect(f.task('parent')).toBeNull()
  expect(f.task('future task')).not.toBeNull()
  expect(f.screen.folds.get('build')).toBe('closed')
  const toggle = f.ui.getByRole('button', { name: 'Expand phase build' })
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  toggle.focus()
  await keyboard.keyboard('{Enter}')
  expect(f.task('parent')).not.toBeNull()
  await keyboard.keyboard(' ')
  expect(f.task('parent')).toBeNull()
  expect(f.actions.onSelectSession).not.toHaveBeenCalled()
  expect(f.actions.onStatusPick).not.toHaveBeenCalled()
  capture('Build collapsed · counts retained', f.ui.container)
})

it('preserves nested phases under both tasks and phases, with phase-local elbows and no lost work', async () => {
  const f = await open([
    issue('root', null, 'a'),
    issue('unphased parent', 'root', 'a'),
    issue('phase under task', 'unphased parent', 'a', phase),
    issue('task in nested phase', 'phase under task', 'a'),
    issue('outer phase', 'root', 'b', phase),
    issue('outer task', 'outer phase', 'a'),
    issue('deep phase', 'outer task', 'a', phase),
    issue('deep work', 'deep phase', 'a'),
    issue('phase under phase', 'outer phase', 'b', phase),
    issue('innermost task', 'phase under phase', 'a'),
    issue('done deep leaf', 'phase under phase', 'b', done),
  ])
  expect(f.order()).toEqual([
    'unphased parent', 'phase under task', 'task in nested phase', 'outer phase',
    'outer task', 'deep phase', 'deep work', 'phase under phase', 'innermost task',
  ])
  expect(f.group('deep phase')?.closest('[data-flight-phase="outer phase"]')).toBe(f.group('outer phase'))
  expect(f.group('phase under phase')?.parentElement?.closest('[data-flight-phase]')).toBe(f.group('outer phase'))
  expect(f.task('deep work')?.getAttribute('data-depth')).toBe('3')
  expect(f.task('deep work')?.querySelector<HTMLElement>('.flight-v6-card')?.style.marginLeft).toBe('0px')
  expect(f.group('deep phase')?.querySelector<HTMLElement>('.flight-full-phase-section')?.style.marginLeft).toBe('22px')
  expect(f.full.counts.all).toBe(4)
  expect(f.group('outer phase')?.querySelector('.flight-full-phase-counter')?.textContent).toBe('1/3')
  capture('Nested phases · structural location preserved', f.ui.container)
  fireEvent.click(f.ui.getByRole('button', { name: 'Collapse phase outer phase' }))
  expect(f.group('deep phase')).toBeNull()
  expect(f.task('task in nested phase')).not.toBeNull()
  fireEvent.click(f.ui.getByRole('button', { name: 'Expand phase outer phase' }))
  fireEvent.click(f.ui.getByRole('button', { name: /1 task done Show/ }))
  expect(f.task('done deep leaf')?.closest('[data-flight-phase]')).toBe(f.group('phase under phase'))
})

it('keeps empty phases and a closed phase with unfinished contained work visible', async () => {
  const f = await open([
    issue('root', null, 'a'), issue('empty', 'root', 'a', phase),
    issue('closed container', 'root', 'b', { ...phase, ...done }),
    issue('unfinished', 'closed container', 'a'),
  ])
  expect(f.group('empty')?.querySelector('.flight-full-phase-counter')?.textContent).toBe('0/0')
  expect(f.group('closed container')?.getAttribute('data-complete')).toBe('false')
  expect(f.task('unfinished')).not.toBeNull()
  expect(f.full.counts.all).toBe(1)
  expect(f.ui.container.querySelector('.flight-full-done-line')).toBeNull()
})

it('keeps phase actions and rename accessible without coupling collapse to issue stages', async () => {
  const f = await open()
  fireEvent.click(f.ui.getByRole('button', { name: 'Phase actions for build' }))
  fireEvent.contextMenu(f.group('build')!.querySelector('.flight-full-phase-header')!)
  expect(f.actions.onMenu).toHaveBeenCalledTimes(2)
  expect(f.actions.onMenu.mock.calls[0]?.[0]).toBe(f.full.task('build'))
  expect(f.full.task('build').open).toBe(true)
  f.ui.rerender(<FlightDeckFullGroups {...f.props} renameTarget={{ id: 'build', seed: 'build' }} />)
  fireEvent.change(f.ui.getByRole('textbox'), { target: { value: 'Build and verify' } })
  fireEvent.keyDown(f.ui.getByRole('textbox'), { key: 'Enter' })
  expect(f.actions.onRename).toHaveBeenCalledWith(f.full.task('build'), 'Build and verify')
  expect(f.actions.onRenameDone).toHaveBeenCalled()
})

it('reserves the first phase-content slot for seats, brightens its rail and preserves crew access', async () => {
  const f = await open([
    issue('root', null, 'a'), issue('build', 'root', 'a', { ...phase, coordinatorSessionId: 'lead' }),
    issue('task', 'build', 'a'),
  ], [{
    sessionId: 'lead', issueId: 'build', title: 'Build lead', name: 'Build lead', agentKind: 'codex',
    status: 'live', cwd: '/synthetic', archived: false, createdAt: stamp, lastActiveAt: stamp,
    readAt: stamp, agentState: { phase: 'idle' },
  }])
  expect(f.group('build')?.querySelector('.flight-full-phase-content')?.getAttribute('data-has-lead')).toBe('true')
  fireEvent.click(f.ui.container.querySelector('[data-flight-session="lead"] button.deck-agent')!)
  expect(f.actions.onSelectSession).toHaveBeenCalled()
  f.ui.rerender(<FlightDeckFullGroups {...f.props} renderPhaseLead={(task: FullDeckTask) => <div>Seat for {task.id}</div>} />)
  const content = f.group('build')!.querySelector('.flight-full-phase-content')!
  expect(content.firstElementChild?.getAttribute('data-phase-lead-slot')).toBe('build')
  expect(content.firstElementChild?.textContent).toBe('Seat for build')
})

it('uses task dependency notes without inventing a phase waiting gate', async () => {
  const f = await open([
    issue('root', null, 'a'), issue('first', 'root', 'a', phase), issue('blocker', 'first', 'a'),
    issue('second', 'root', 'b', phase),
    issue('waiting', 'second', 'a', { blocked: true, deps: [{ id: 'blocker', type: 'blocked-by' }] }),
  ])
  expect(f.task('waiting')?.querySelector('.flight-v6-dependency')?.textContent).toContain('POD-7')
  expect(f.group('second')?.querySelector('.flight-full-phase-header')?.textContent).not.toContain('Starts when')
  expect(f.full.task('second').open).toBe(true)
})

// Review evidence is the actual tested DOM with its source CSS, captured only
// when explicitly requested by the validation command. No browser driving.
const captures: { title: string; html: string }[] = []
function capture(title: string, node: HTMLElement) {
  if (process.env['PODIUM_FULL_GROUPS_REVIEW_HTML']) captures.push({ title, html: node.innerHTML })
}
afterAll(() => {
  const path = process.env['PODIUM_FULL_GROUPS_REVIEW_HTML']
  if (!path) return
  const css = readFileSync('src/styles.css', 'utf8').split('/* Full flight deck v6.')[1]
  const tokens = readFileSync('src/index.css', 'utf8').split('[data-theme="podium"].dark {')[1]?.split('}')[0]
  writeFileSync(path, `<!doctype html><html lang="en"><meta charset="utf-8"><title>Full phases and done work</title><style>
  :root {${tokens} --font-mono:ui-monospace,monospace}
  *{box-sizing:border-box}body{margin:0;padding:24px;background:#16171a;color:#d7dae0;font:13px system-ui}main{max-width:960px;margin:auto}h1{font-size:18px}h2{font-size:14px;margin-top:32px}p{color:#949aa4;line-height:1.5}button{font:inherit;color:inherit;background:none;border:0;padding:0}svg{flex:none}
  /* Full flight deck v6.${css}
  </style><main><h1>Full phases and done work</h1><p>Actual rendered acceptance fixtures. The dashed line restores done work at its original position. Phase headers show direct-child counts; the done line counts leaves. Nested phases retain their structural location. These are static captures of tested states.</p>${captures.map(c => `<article><h2>${c.title}</h2>${c.html}</article>`).join('')}</main></html>`)
})
