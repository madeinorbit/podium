// @vitest-environment happy-dom
import { readFileSync, writeFileSync } from 'node:fs'
import { MissionScreen } from '@podium/client-graph/mission-screen'
import { settled } from '@podium/client-graph/mission-view'
import { MobxPool } from '@podium/client-graph/pool'
import { attachPreferenceSource } from '@podium/client-graph/preference-source'
import { FLIGHT_DECK_FOLDS_KEY, type RoutedUiState } from '@podium/client-core/ui-state'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { autorun } from 'mobx'
import { createRef } from 'react'
import { afterAll, afterEach, expect, it, vi } from 'vitest'
import { FlightDeckFullControls } from './FlightDeckFullControls'
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
const session = (id: string, issueId: string, phase: string, patch: Row = {}): Row => ({
  sessionId: id, issueId, title: `Agent ${id}`, name: `Agent ${id}`, agentKind: 'codex',
  status: 'live', cwd: '/synthetic', archived: false, createdAt: stamp, lastActiveAt: stamp,
  readAt: stamp, agentState: { phase }, ...patch,
})
const done = { stage: 'done', closedAt: stamp }
const issues = () => [
  issue('root', null, 'a', { coordinatorSessionId: 'coord' }),
  issue('loose', 'root', 'a'),
  issue('build', 'root', 'b', { type: 'phase' }),
  issue('parent', 'build', 'a'),
  issue('error', 'parent', 'a'),
  issue('ask', 'parent', 'b', { type: 'decision' }),
  issue('working', 'build', 'b'),
  issue('idle', 'build', 'c'),
  issue('blocked', 'build', 'd', { blocked: true, deps: [{ id: 'loose', type: 'blocked-by' }] }),
  issue('done', 'build', 'e', done),
  issue('complete', 'root', 'c', { type: 'phase' }),
  issue('released', 'complete', 'a', done),
]
const sessions = () => [
  session('coord', 'root', 'idle'),
  session('failed', 'error', 'errored', { agentState: {
    phase: 'errored', nativeSubagents: [{ id: 'native-1', type: 'general-purpose' }],
  } }),
  session('worker', 'working', 'working'),
  session('parked', 'idle', 'idle'),
]
const cleanups: (() => void)[] = []
afterEach(() => {
  cleanup()
  for (const close of cleanups.splice(0)) close()
})

function storage(initial: [string, string][] = []) {
  const values = new Map(initial)
  const listeners = new Set<(keys: ReadonlySet<string>) => void>()
  const ui: RoutedUiState = {
    get: key => values.get(key) ?? null,
    set: (key, value) => {
      if (value === null) values.delete(key)
      else values.set(key, value)
      for (const listener of listeners) listener(new Set([key]))
    },
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
  }
  return { values, ui }
}
async function open(prefs = storage(), ready = true) {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) })
  attachPreferenceSource(pool, prefs.ui)
  pool.apply({ type: 'replace', rows: [
    { kind: 'repo', id: 'repo', value: { id: 'repo', repoPath: '/synthetic', prefix: 'POD' } },
    ...issues().map(value => ({ kind: 'issue' as const, id: value['id'] as string, value: value as never })),
    ...sessions().map(value => ({ kind: 'session' as const, id: value['sessionId'] as string, value: value as never })),
  ] })
  const screen = new MissionScreen(pool, 'root', { setPreference: prefs.ui.set })
  screen.open()
  const stop = autorun(() => { void settled(() => screen.full.ready) })
  cleanups.push(() => { stop(); screen.close(); pool.dispose() })
  if (ready) await waitFor(() => expect(screen.full.ready).toBe(true))
  const actions = {
    activeSessionId: null, renameTarget: null, onSelectSession: vi.fn(), onMenu: vi.fn(),
    onStatusPick: vi.fn(), onRename: vi.fn(), onRenameDone: vi.fn(),
  }
  const ui = render(<>
    <FlightDeckFullControls full={screen.full} />
    <FlightDeckFullGroups full={screen.full} scrollRef={createRef()} {...actions} />
  </>)
  const initial = {
    pending: ui.queryByRole('status', { name: 'Loading tasks' }) !== null,
    disabled: ui.queryByRole('button', { name: 'All …' })?.hasAttribute('disabled'),
    rows: ui.container.querySelectorAll('[data-flight-issue], [data-flight-phase]').length,
  }
  const button = (name: string | RegExp) => ui.getByRole('button', { name })
  const click = async (name: string | RegExp) => act(async () => { fireEvent.click(button(name)) })
  const order = () => [...ui.container.querySelectorAll('[data-flight-issue], [data-flight-phase]')]
    .map(node => node.getAttribute('data-flight-issue') ?? node.getAttribute('data-flight-phase'))
  const row = (id: string) => ui.container.querySelector<HTMLElement>(`[data-flight-issue="${id}"]`)
  const fold = (id: string) => row(id)!.querySelector<HTMLButtonElement>('.flight-v6-task-body')!
  const tally = () => within(ui.getByRole('group', { name: 'Task filters' })).getAllByRole('button')
    .map(node => node.textContent)
  return { pool, screen, full: screen.full, ui, button, click, order, row, fold, tally, actions, prefs, initial }
}
const totals = ['All8', 'Needs you2', 'Active4', 'Up next2']

it('offers exact model leaf totals and matching descendant paths for each Full filter', async () => {
  const f = await open()
  expect(f.tally()).toEqual(totals)
  expect(f.order()).toEqual(['loose', 'build', 'parent', 'error', 'ask', 'working', 'idle', 'blocked'])
  capture('All · eight leaves, done hidden', f.ui.container)
  await f.click('Needs you 2')
  expect(f.order()).toEqual(['build', 'parent', 'error', 'ask'])
  expect(f.button('Needs you 2').getAttribute('aria-pressed')).toBe('true')
  expect(f.ui.container.querySelector('[data-flight-phase="build"]')?.getAttribute('data-context')).toBe('true')
  capture('Needs you · ancestor path', f.ui.container)
  await f.click('Active 4')
  expect(f.order()).toEqual(['build', 'parent', 'error', 'ask', 'working', 'idle'])
  await f.click('Up next 2')
  expect(f.order()).toEqual(['loose', 'build', 'blocked'])
  capture('Up next · two leaves', f.ui.container)
  await f.click('All 8')
  expect(f.order()).toEqual(['loose', 'build', 'parent', 'error', 'ask', 'working', 'idle', 'blocked'])
  expect(f.tally()).toEqual(totals)
  expect(f.prefs.values.has('podium.flightDeck.mode')).toBe(false)
})

it('colors Needs you red for Error, amber for attention alone, and neutral for zero', async () => {
  const f = await open()
  const tone = () => f.button(/^Needs you \d/).querySelector('[data-tone]')?.getAttribute('data-tone')
  expect(tone()).toBe('error')
  const css = readFileSync('src/styles.css', 'utf8')
  expect(css).toContain(".flight-full-filter-count[data-tone='error'] { color: var(--destructive); }")
  expect(css).toContain(".flight-full-filter-count[data-tone='needs-you'] { color: var(--attention); }")
  act(() => f.pool.apply({ type: 'update', rows: [{ kind: 'session', id: 'failed',
    value: session('failed', 'error', 'idle') as never }] }))
  expect(f.button('Needs you 1')).toBeDefined()
  expect(tone()).toBe('needs-you')
  act(() => f.pool.apply({ type: 'update', rows: [{ kind: 'issue', id: 'ask',
    value: issue('ask', 'parent', 'b', { type: 'decision', ...done }) as never }] }))
  expect(f.button('Needs you 0')).toBeDefined()
  expect(tone()).toBeUndefined()
})

it("colors Needs you red for a parent's own Error over Idle leaves, leaf totals unchanged", async () => {
  const f = await open()
  const tone = () => f.button(/^Needs you \d/).querySelector('[data-tone]')?.getAttribute('data-tone')
  act(() => f.pool.apply({ type: 'update', rows: [
    { kind: 'session', id: 'failed', value: session('failed', 'error', 'idle') as never },
    { kind: 'issue', id: 'ask', value: issue('ask', 'parent', 'b', { type: 'decision', ...done }) as never },
    { kind: 'session', id: 'own', value: session('own', 'parent', 'errored') as never },
  ] }))
  expect(f.button('Needs you 0')).toBeDefined()
  expect(tone()).toBe('error')
  await f.click('Needs you 0')
  expect(f.order()).toEqual(['build', 'parent'])
})

it('shares Done state with the done line and resets filters and Done in both directions', async () => {
  const f = await open()
  await f.click('Active 4')
  await f.click('Done 2')
  expect(f.button('All 8').getAttribute('aria-pressed')).toBe('true')
  expect(f.button('Done 2').getAttribute('aria-pressed')).toBe('true')
  expect(f.order()).toEqual(['loose', 'build', 'parent', 'error', 'ask', 'working', 'idle', 'blocked', 'done', 'complete', 'released'])
  expect(f.ui.container.querySelector('.flight-full-done-line')).toBeNull()
  capture('Done restored · original positions', f.ui.container)
  for (const name of ['All 8', 'Needs you 2', 'Active 4', 'Up next 2']) {
    await f.click(name)
    expect(f.button('Done 2').getAttribute('aria-pressed')).toBe('false')
    expect(f.row('done')).toBeNull()
    await f.click(/1 phase complete · 2 tasks done Show/)
    expect(f.button('All 8').getAttribute('aria-pressed')).toBe('true')
    expect(f.button('Done 2').getAttribute('aria-pressed')).toBe('true')
    expect(f.row('done')).not.toBeNull()
  }
  await f.click('Done 2')
  expect(f.row('released')).toBeNull()
  expect(f.tally()).toEqual(totals)
})

it('searches matching paths while respecting explicit folds, with clear and Escape handling', async () => {
  const f = await open()
  await f.click('Collapse parent')
  await f.click('Search this mission')
  const input = f.ui.getByRole('textbox', { name: 'Search this mission' })
  expect(document.activeElement).toBe(input)
  fireEvent.change(input, { target: { value: 'Agent failed' } })
  expect(f.order()).toEqual(['build', 'parent'])
  expect(f.fold('parent').getAttribute('aria-expanded')).toBe('false')
  await f.click('Expand parent')
  expect(f.order()).toEqual(['build', 'parent', 'error'])
  expect(f.tally()).toEqual(totals)
  await f.click('Clear search')
  expect(f.order()).toContain('idle')
  expect(f.ui.getByRole('textbox').getAttribute('value')).toBe('')
  fireEvent.change(input, { target: { value: 'nothing matches' } })
  expect(f.order()).toEqual([])
  fireEvent.keyDown(input, { key: 'Escape' })
  expect(f.ui.queryByRole('textbox')).toBeNull()
  expect(f.button('Search this mission').getAttribute('aria-expanded')).toBe('false')
  expect(f.screen.query).toBe('')
  expect(f.order()).toContain('error')
  expect(f.screen.folds.get('parent')).toBe('open')
})

it('folds every branch independent of filters and search and restores explicit opens on remount', async () => {
  const f = await open()
  await f.click('Up next 2')
  await f.click('Search this mission')
  fireEvent.change(f.ui.getByRole('textbox'), { target: { value: 'loose' } })
  await f.click('Fold every branch')
  expect(f.full.allFolded).toBe(true)
  for (const id of f.full.foldableIds) expect(f.screen.folds.get(id)).toBe('closed')
  expect(f.tally()).toEqual(totals)
  await f.click('Expand every branch')
  for (const id of f.full.foldableIds) expect(f.screen.folds.get(id)).toBe('open')
  f.ui.unmount()
  const reopened = await open(f.prefs)
  expect(reopened.fold('working').getAttribute('aria-expanded')).toBe('true')
  expect(reopened.fold('idle').getAttribute('aria-expanded')).toBe('true')
  expect(reopened.full.filter).toBe('all')
  expect(reopened.screen.searchOpen).toBe(false)
})

it('keeps explicit task and phase choices across remount, state changes and a second session', async () => {
  const f = await open()
  // Error and Needs you open by default; ordinary tasks with crew start closed.
  for (const id of ['parent', 'error', 'ask']) expect(f.fold(id).getAttribute('aria-expanded')).toBe('true')
  for (const id of ['working', 'idle', 'blocked']) expect(f.fold(id).getAttribute('aria-expanded')).toBe('false')
  await f.click('Collapse error')
  await f.click('Expand working')
  act(() => f.pool.apply({ type: 'update', rows: [
    { kind: 'session', id: 'second', value: session('second', 'error', 'needs_user') as never },
    { kind: 'session', id: 'worker', value: session('worker', 'working', 'errored') as never },
  ] }))
  expect(f.fold('error').getAttribute('aria-expanded')).toBe('false')
  expect(f.fold('working').getAttribute('aria-expanded')).toBe('true')
  await f.click('Collapse phase build')
  expect(f.row('parent')).toBeNull()
  f.ui.unmount()
  const reopened = await open(f.prefs)
  expect(reopened.button('Expand phase build').getAttribute('aria-expanded')).toBe('false')
  await reopened.click('Expand phase build')
  expect(reopened.fold('error').getAttribute('aria-expanded')).toBe('false')
  expect(reopened.fold('working').getAttribute('aria-expanded')).toBe('true')
  expect(reopened.actions.onSelectSession).not.toHaveBeenCalled()
})

it('waits for stored folds before drawing tasks or enabling controls, with no default-open flash', async () => {
  const f = await open(storage([[FLIGHT_DECK_FOLDS_KEY, JSON.stringify({ v: 2, closed: ['build', 'error'], open: [] })]]), false)
  expect(f.initial).toEqual({ pending: true, disabled: true, rows: 0 })
  await waitFor(() => expect(f.button('All 8').hasAttribute('disabled')).toBe(false))
  expect(f.order()).toEqual(['loose', 'build'])
  expect(f.button('Expand phase build').getAttribute('aria-expanded')).toBe('false')
})

it('gives task, phase and native disclosures distinct live targets and keyboard actions', async () => {
  const f = await open()
  const phase = f.button('Collapse phase build')
  const task = f.fold('error')
  const native = f.button('Expand 1 native subagents of Agent failed')
  const targets = [phase, task, native].map(node => node.getAttribute('aria-controls')!.split(' '))
  expect(new Set(targets.flat()).size).toBe(targets.flat().length)
  for (const id of targets.flat()) expect(document.getElementById(id)).not.toBeNull()
  const parentTargets = f.fold('parent').getAttribute('aria-controls')!.split(' ')
  expect(parentTargets.some(id => document.getElementById(id)?.contains(f.row('error')))).toBe(true)
  const keyboard = userEvent.setup()
  native.focus()
  await keyboard.keyboard('{Enter}')
  expect(f.ui.getByRole('list', { name: 'Native subagents of Agent failed' })).toBeDefined()
  await keyboard.keyboard(' ')
  expect(f.ui.queryByRole('list')).toBeNull()
  expect(document.getElementById(targets[2]![0]!)?.hidden).toBe(true)
  phase.focus()
  await keyboard.keyboard(' ')
  expect(f.row('error')).toBeNull()
  await keyboard.keyboard('{Enter}')
  expect(f.row('error')).not.toBeNull()
  expect(f.actions.onSelectSession).not.toHaveBeenCalled()
})

const captures: { title: string; html: string }[] = []
function capture(title: string, node: HTMLElement) {
  if (process.env['PODIUM_FULL_CONTROLS_REVIEW_HTML']) captures.push({ title, html: node.innerHTML })
}
afterAll(() => {
  const path = process.env['PODIUM_FULL_CONTROLS_REVIEW_HTML']
  if (!path) return
  const css = readFileSync('src/styles.css', 'utf8').split('/* Full flight deck v6.')[1]
  const tokens = readFileSync('src/index.css', 'utf8').split('[data-theme="podium"].dark {')[1]?.split('}')[0]
  writeFileSync(path, `<!doctype html><html lang="en"><meta charset="utf-8"><title>Full filters and folds</title><style>
  :root{${tokens} --font-mono:ui-monospace,monospace}*{box-sizing:border-box}body{margin:0;padding:24px;background:#16171a;color:#d7dae0;font:13px system-ui}main{max-width:960px;margin:auto}h1{font-size:18px}h2{font-size:14px;margin-top:32px}p{color:#949aa4;line-height:1.5}button{font:inherit;color:inherit;background:none;border:0;padding:0}svg{flex:none}
  /* Full flight deck v6.${css}
  </style><main><h1>Full filters and folds</h1><p>Actual rendered acceptance fixtures. Counts cover leaves regardless of folds or search. Needs you includes Error, shown red. Done restores finished work in place and returns to All. These captures are static.</p>${captures.map(c => `<article><h2>${c.title}</h2>${c.html}</article>`).join('')}</main></html>`)
})
