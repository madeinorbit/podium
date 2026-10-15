// @vitest-environment happy-dom
import { readFileSync, writeFileSync } from 'node:fs'
import { MissionScreen } from '@podium/client-graph/mission-screen'
import { attachPreferenceSource } from '@podium/client-graph/preference-source'
import type { RoutedUiState } from '@podium/client-core/ui-state'
import { settled } from '@podium/client-graph/mission-view'
import { MobxPool } from '@podium/client-graph/pool'
import { SESSION_WORD_LABEL, TASK_WORD_LABEL, type TaskWord } from '@podium/model/browser'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { autorun } from 'mobx'
import { createRef } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import {
  FlightDeckV6Rows,
  FlightDeckV6Task,
  FlightDeckV6Session,
  V6_DEPTH_STEP,
} from './FlightDeckV6Rows'

vi.mock('./store', () => ({
  useRuntimeSelector: (read: (value: unknown) => unknown) => read({ renameSession: vi.fn() }),
}))
vi.mock('@/lib/use-harness-descriptors', () => ({
  useHarnessDescriptors: () => ({ served: undefined }),
}))
vi.mock('@/lib/PoolSessionContextMenu', () => ({
  PoolSessionContextMenu: ({ sessionId }: { sessionId: string }) => (
    <div role="menu">Session menu {sessionId}</div>
  ),
}))

const NOW = Date.parse('2026-10-15T12:00:30Z')
const stamp = '2026-10-15T12:00:00Z'
type Row = Record<string, unknown>
const issue = (id: string, parentId: string | null, seq: number, patch: Row = {}): Row => ({
  id,
  parentId,
  seq,
  title: `Task ${id}`,
  stage: 'in_progress',
  audience: 'human',
  repoPath: '/synthetic',
  deps: [],
  createdAt: stamp,
  updatedAt: stamp,
  readAt: stamp,
  ...patch,
})
const session = (id: string, issueId: string, patch: Row = {}): Row => ({
  sessionId: id,
  issueId,
  name: `Agent ${id}`,
  title: `Agent ${id}`,
  agentKind: 'codex',
  status: 'live',
  cwd: '/synthetic',
  archived: false,
  createdAt: stamp,
  lastActiveAt: stamp,
  readAt: stamp,
  agentState: { phase: 'working', since: stamp, workingMsTotal: 600000 },
  ...patch,
})
const releases: (() => void)[] = []
afterEach(() => {
  cleanup()
  for (const close of releases.splice(0)) close()
  vi.useRealTimers()
})

async function open(
  issues = [issue('root', null, 1), issue('task', 'root', 2, { coordinatorSessionId: 'worker' })],
  sessions = [session('worker', 'task'), session('helper', 'task')],
) {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: NOW })
  const values = new Map<string, string>()
  const listeners = new Set<(keys: ReadonlySet<string>) => void>()
  const uiState: RoutedUiState = {
    get: (key) => values.get(key) ?? null,
    set: (key, raw) => {
      if (raw === null) values.delete(key)
      else values.set(key, raw)
      for (const listener of listeners) listener(new Set([key]))
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  attachPreferenceSource(pool, uiState)
  pool.apply({
    type: 'replace',
    rows: [
      ...issues.map((value) => ({
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
    setPreference: (key, raw) => uiState.set(key, raw),
  })
  screen.open()
  const stop = autorun(() => {
    void settled(() => [screen.ready, screen.full.ready])
  })
  releases.push(() => {
    stop()
    screen.close()
    pool.dispose()
  })
  await waitFor(() => expect(settled(() => screen.full.ready)).toBe(true))
  const actions = {
    activeSessionId: null as string | null,
    renameTarget: null,
    onSelectSession: vi.fn(),
    onMenu: vi.fn(),
    onStatusPick: vi.fn(),
    onRename: vi.fn(),
    onRenameDone: vi.fn(),
  }
  const ui = render(<FlightDeckV6Rows full={screen.full} scrollRef={createRef()} {...actions} />)
  const task = (id = 'task') =>
    ui.container.querySelector(`[data-flight-issue="${id}"]`) as HTMLElement
  const fold = (id = 'task') =>
    task(id).querySelector('button.flight-v6-task-body') as HTMLButtonElement
  const agent = (id = 'worker') =>
    ui.container.querySelector(`[data-flight-session="${id}"]`) as HTMLElement
  return { pool, screen, full: screen.full, actions, ui, task, fold, agent }
}

it('strip pointer and keyboard fold only; session pointer and keyboard open the existing pane', async () => {
  const f = await open()
  expect(f.agent()).toBeNull()
  const keyboard = userEvent.setup()
  f.fold().focus()
  await keyboard.keyboard('{Enter}')
  expect(f.fold().getAttribute('aria-expanded')).toBe('true')
  expect(f.actions.onSelectSession).not.toHaveBeenCalled()
  fireEvent.click(f.agent().querySelector('button.deck-agent')!)
  expect(f.actions.onSelectSession).toHaveBeenLastCalledWith(
    f.full.task('task'),
    f.pool.sessionObject('worker'),
    false,
  )
  fireEvent.keyDown(f.agent().querySelector('button.deck-agent')!, { key: 'Enter' })
  expect(f.actions.onSelectSession).toHaveBeenLastCalledWith(
    f.full.task('task'),
    f.pool.sessionObject('worker'),
    true,
  )
  fireEvent.keyDown(f.agent().querySelector('button.deck-agent')!, { key: ' ' })
  expect(f.actions.onSelectSession).toHaveBeenCalledTimes(3)
  expect(f.fold().getAttribute('aria-expanded')).toBe('true')
  // The native strip button handles both keyboard activation keys.
  f.fold().focus()
  await keyboard.keyboard(' ')
  expect(f.agent()).toBeNull()
  expect(f.actions.onSelectSession).toHaveBeenCalledTimes(3)
})

it('session selection tints only its own row and leaves the task surface unchanged', async () => {
  const f = await open()
  fireEvent.click(f.fold())
  f.ui.rerender(
    <FlightDeckV6Rows
      full={f.full}
      scrollRef={createRef()}
      {...f.actions}
      activeSessionId="worker"
    />,
  )
  expect(f.agent().getAttribute('data-selected')).toBe('true')
  expect(f.agent('helper').getAttribute('data-selected')).toBe('false')
  expect(f.task().querySelector('.flight-v6-card')?.hasAttribute('data-selected')).toBe(false)
  expect(f.task().querySelector('.flight-v6-strip')?.hasAttribute('aria-pressed')).toBe(false)
})

it('native chip starts collapsed; pointer, Enter and Space toggle a read-only running list without selecting or folding', async () => {
  const f = await open(undefined, [
    session('worker', 'task', {
      agentState: {
        phase: 'idle',
        nativeSubagents: [{ id: 'n-1', type: 'general-purpose' }],
        nativeSubagentCount: 2,
      },
    }),
  ])
  fireEvent.click(f.fold())
  const native = within(f.agent()).getByRole('button', { name: /2 native/ })
  expect(native.getAttribute('aria-expanded')).toBe('false')
  expect(f.ui.queryByRole('list')).toBeNull()
  fireEvent.click(native)
  const list = f.ui.getByRole('list', { name: 'Native subagents of Agent worker' })
  expect(within(list).getAllByRole('listitem')).toHaveLength(2)
  expect(list.textContent).toContain('n-1')
  expect(list.textContent?.match(/running/g)).toHaveLength(2)
  expect(within(list).queryByRole('button')).toBeNull()
  fireEvent.click(list)
  fireEvent.keyDown(native, { key: 'Enter' })
  expect(f.ui.queryByRole('list')).toBeNull()
  fireEvent.keyDown(native, { key: ' ' })
  expect(f.ui.getByRole('list')).toBeDefined()
  expect(f.actions.onSelectSession).not.toHaveBeenCalled()
  expect(f.fold().getAttribute('aria-expanded')).toBe('true')
})

it('draws 22px guide steps with middle, last and continuing ancestor elbows beyond three levels', async () => {
  const f = await open(
    [
      issue('root', null, 1),
      issue('a', 'root', 2),
      issue('b', 'a', 3),
      issue('c', 'b', 4),
      issue('d', 'c', 5),
      issue('e', 'c', 6),
      issue('tail', 'a', 7),
    ],
    [],
  )
  expect(V6_DEPTH_STEP).toBe(22)
  expect(f.task('d').getAttribute('data-depth')).toBe('3')
  expect((f.task('d').querySelector('.flight-v6-card') as HTMLElement).style.marginLeft).toBe(
    '66px',
  )
  expect(
    [...f.task('d').querySelectorAll('[data-guide]')].map((node) =>
      node.getAttribute('data-guide'),
    ),
  ).toEqual(['carry', 'empty', 'middle'])
  expect(
    [...f.task('e').querySelectorAll('[data-guide]')].map((node) =>
      node.getAttribute('data-guide'),
    ),
  ).toEqual(['carry', 'empty', 'last'])
  expect(
    [...f.task('e').querySelectorAll<HTMLElement>('[data-guide]')].map((node) => node.style.left),
  ).toEqual(['0px', '22px', '44px'])
})

it('uses direct-child counters rather than leaf totals and retains a full title tooltip and ref', async () => {
  const f = await open(
    [
      issue('root', null, 1),
      issue('task', 'root', 123456789),
      issue('child', 'task', 3),
      issue('grandchild', 'child', 4),
      issue('done', 'task', 5, { stage: 'done', closedAt: stamp }),
    ],
    [],
  )
  expect(f.task().querySelector('.flight-v6-counter')?.textContent).toBe('1/2')
  expect(f.task().querySelector('.flight-v6-title')?.getAttribute('title')).toBe('Task task')
  expect(f.task().querySelector('.flight-v6-ref')?.textContent).toBe('POD-123456789')
})

it('hides strip chips while open and caps the closed strip at two established engine icons', async () => {
  const f = await open(undefined, [
    session('worker', 'task'),
    session('a', 'task', { agentKind: 'claude-code' }),
    session('b', 'task', { agentKind: 'grok' }),
  ])
  expect(f.ui.getByTestId('v6-engines').children).toHaveLength(2)
  fireEvent.click(f.fold())
  expect(f.ui.queryByTestId('v6-engines')).toBeNull()
  expect(f.ui.container.querySelectorAll('[data-flight-session]')).toHaveLength(3)
  expect(f.agent('a').textContent).toContain('helper')
  expect(f.agent().textContent).not.toContain('helper')
})

it.each([
  'claude-code',
  'codex',
  'grok',
  'opencode',
  'cursor',
  'pi',
])('uses the established engine support for %s', async (agentKind) => {
  const f = await open(undefined, [session('worker', 'task', { agentKind })])
  const foldedIcon = f.ui.getByTestId('v6-engines').querySelector('svg')
  expect(foldedIcon?.getAttribute('aria-label')).toBeTruthy()
  fireEvent.click(f.fold())
  expect(f.agent().querySelector('svg')?.getAttribute('aria-label')).toBe(
    foldedIcon?.getAttribute('aria-label'),
  )
})

it('keeps task menu, status picker and rename access independent of fold and session selection', async () => {
  const f = await open()
  fireEvent.click(f.ui.getByRole('button', { name: 'Task actions for Task task' }))
  fireEvent.contextMenu(f.task().querySelector('.flight-v6-strip')!)
  expect(f.actions.onMenu).toHaveBeenCalledTimes(2)
  expect(f.actions.onMenu.mock.calls[0]?.[0]).toBe(f.full.task('task'))
  expect(f.fold().getAttribute('aria-expanded')).toBe('false')
  fireEvent.click(f.ui.getByTestId('issue-status-picker'))
  expect(f.fold().getAttribute('aria-expanded')).toBe('false')
  expect(f.actions.onSelectSession).not.toHaveBeenCalled()
  cleanup()
  const renamed = render(
    <FlightDeckV6Task
      task={f.full.task('task')}
      carries={[]}
      {...f.actions}
      renameTarget={{ id: 'task', seed: 'Task task' }}
    />,
  )
  const editor = renamed.getByRole('textbox')
  fireEvent.change(editor, { target: { value: 'Renamed task' } })
  fireEvent.keyDown(editor, { key: 'Enter' })
  expect(f.actions.onRename).toHaveBeenCalledWith(f.full.task('task'), 'Renamed task')
  expect(f.actions.onRenameDone).toHaveBeenCalled()
})

it('session actions retain the shared lifecycle menu without opening the session', async () => {
  const f = await open()
  fireEvent.click(f.fold())
  fireEvent.click(
    within(f.agent()).getByRole('button', { name: 'Session actions for Agent worker' }),
  )
  expect(f.ui.getByRole('menu').textContent).toContain('Session menu worker')
  expect(f.actions.onSelectSession).not.toHaveBeenCalled()
})

it('uses the shared Working current-turn clock and Done cumulative working duration', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(NOW)
  const f = await open(undefined, [
    session('worker', 'task'),
    session('stopped', 'task', {
      status: 'exited',
      stopReason: 'self',
      agentState: { phase: 'ended', since: stamp, workingMsTotal: 65000 },
    }),
  ])
  fireEvent.click(f.fold())
  expect(f.agent().textContent).toContain('Working0:30')
  expect(f.agent().textContent).not.toContain('10:30')
  expect(f.agent('stopped').textContent).toContain('Done∑ 1:05')
  await act(async () => {
    vi.advanceTimersByTime(2000)
  })
  expect(f.agent().textContent).toContain('Working0:32')
  expect(f.agent('stopped').textContent).toContain('Done∑ 1:05')
})

it.each([
  ['error', { agentState: { phase: 'errored' } }],
  ['needs-you', { offer: { message: 'Review ready', createdAt: stamp } }],
  ['idle', { agentState: { phase: 'idle' } }],
  ['working', { status: 'starting', agentState: undefined }],
  ['done', { status: 'exited', stopReason: 'self' }],
] as const)('uses the shared session word %s without inline error or offer UI', async (word, patch) => {
  const f = await open(undefined, [session('worker', 'task', patch)])
  if (f.fold().getAttribute('aria-expanded') !== 'true') fireEvent.click(f.fold())
  expect(f.agent().querySelector('.flight-v6-state')?.textContent).toContain(
    SESSION_WORD_LABEL[word],
  )
  expect(f.ui.queryByRole('button', { name: /retry|resume|answer/i })).toBeNull()
  expect(f.ui.queryByText('Review ready')).toBeNull()
})

it.each([
  'blocked',
  'not-started',
  'done',
] as TaskWord[])('shows the shared task word and ring for %s', async (word) => {
  const patch =
    word === 'done'
      ? { stage: 'done', closedAt: stamp }
      : { stage: 'backlog', blocked: word === 'blocked' }
  const f = await open([issue('root', null, 1), issue('task', 'root', 2, patch)], [])
  if (word === 'done') act(() => f.full.setShowDone(true))
  expect(f.task().querySelector('.flight-v6-state')?.textContent).toBe(TASK_WORD_LABEL[word])
  expect(f.task().querySelector('.flight-v6-ring')?.getAttribute('data-word')).toBe(word)
})

// Optional review capture uses this test's real rendered markup and the scoped
// source CSS. It is static evidence, not a second implementation of the UI.
it('opens Error and Needs you by default and leaves working and blocked leaves folded', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(NOW)
  const f = await open(
    [
      issue('root', null, 1),
      issue('task', 'root', 2, { title: 'Build query planner', coordinatorSessionId: 'worker' }),
      issue('error', 'task', 3, { title: 'Check adapter errors' }),
      issue('ask', 'task', 4, { title: 'Review index strategy' }),
      issue('blocked', 'root', 5, {
        title: 'Run acceptance checks',
        stage: 'backlog',
        blocked: true,
        deps: [{ id: 'task', type: 'blocked-by' }],
      }),
      issue('later', 'root', 6, { title: 'Publish readme', stage: 'backlog' }),
    ],
    [
      session('worker', 'task', {
        agentState: {
          phase: 'working',
          since: stamp,
          nativeSubagents: [{ id: 'n-query', type: 'general-purpose' }],
        },
      }),
      session('helper', 'task', { agentKind: 'claude-code', agentState: { phase: 'idle' } }),
      session('failed', 'error', { agentKind: 'grok', agentState: { phase: 'errored' } }),
      session('question', 'ask', { agentState: { phase: 'needs_user' } }),
    ],
  )
  expect(f.fold('error').getAttribute('aria-expanded')).toBe('true')
  expect(f.fold('ask').getAttribute('aria-expanded')).toBe('true')
  expect(f.fold('blocked').getAttribute('aria-expanded')).toBe('false')
  expect(f.task('blocked').querySelector('.flight-v6-dependency')?.textContent).toContain('POD-2')
  const capture = process.env['PODIUM_V6_REVIEW_HTML']
  if (capture) {
    fireEvent.click(within(f.agent()).getByRole('button', { name: /1 native/ }))
    const css = readFileSync('apps/web/src/styles.css', 'utf8').split('/* Full flight deck v6.')[1]
    const tokens = readFileSync('apps/web/src/index.css', 'utf8')
      .split('[data-theme="podium"].dark {')[1]
      ?.split('}')[0]
    writeFileSync(
      capture,
      `<!doctype html><html lang="en"><meta charset="utf-8"><title>Full task strips and sessions</title><style>
      :root { ${tokens} --v6-state-width:118px; --font-mono:ui-monospace,monospace; --motion-total:#848a94; --motion-working:#6f9dff; }
      *{box-sizing:border-box} body{margin:0;padding:24px;background:#16171a;color:#d7dae0;font:13px system-ui} main{max-width:960px;margin:auto} h1{font-size:18px} p{color:#949aa4;line-height:1.5} button{font:inherit;color:inherit;border:0;padding:0;background:none} svg{flex:none} .size-4{width:16px;height:16px}.size-5{width:20px;height:20px}.flex{display:flex}.flex-none{flex:none}.items-center{align-items:center}.justify-center{justify-content:center}.border{border:1px solid #3a3f48}.rounded{border-radius:4px}.rounded-\\[6px\\]{border-radius:6px}
      /* Full flight deck v6.${css}
    </style><main><h1>Full task strips and inset sessions</h1><p>Rendered acceptance fixture. Error and Needs you open automatically; the task surface stays neutral. Session buttons open conversations; the native chip discloses a read-only running list. This capture is static.</p>${f.ui.container.innerHTML}</main></html>`,
    )
  }
})

it('retains the shared shell icon without changing mission roster membership', async () => {
  const f = await open(undefined, [session('worker', 'task', { agentKind: 'shell' })])
  expect(f.full.task('task').sessionIds).toHaveLength(0)
  const shell = f.screen.reader.rawSession('worker')
  if (!shell || typeof shell === 'symbol') throw new Error('Missing shell fixture')
  const row = render(
    <FlightDeckV6Session
      task={f.full.task('task')}
      session={shell}
      active={false}
      onOpen={vi.fn()}
    />,
  )
  expect(row.getByLabelText('Shell')).toBeDefined()
})
