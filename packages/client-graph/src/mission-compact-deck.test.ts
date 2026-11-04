import type { RoutedUiState } from '@podium/client-core/ui-state'
import { FLIGHT_DECK_FULL_ISSUES_KEY } from '@podium/client-core/ui-state'
import { autorun } from 'mobx'
import { afterEach, expect, it } from 'vitest'
import { MissionScreen } from './mission-screen'
import { settled } from './mission-view'
import { MobxPool } from './pool'
import { attachPreferenceSource } from './preference-source'

const stamp = '2026-11-04T12:00:00Z'
const later = '2026-11-04T12:10:00Z'
const cleanups: (() => void)[] = []
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close()
})
const issue = (id = 'root', patch: Record<string, unknown> = {}) => ({
  id,
  seq: id === 'root' ? 1 : 2,
  title: id,
  stage: 'in_progress',
  audience: 'human',
  parentId: id === 'root' ? null : 'root',
  deps: [],
  repoPath: '/synthetic',
  createdAt: stamp,
  updatedAt: stamp,
  ...patch,
})
const session = (id: string, patch: Record<string, unknown> = {}) => ({
  sessionId: id,
  issueId: 'root',
  cwd: '/synthetic',
  title: id,
  name: id,
  nameSource: 'agent',
  agentKind: 'codex',
  status: 'live',
  archived: false,
  createdAt: stamp,
  lastActiveAt: stamp,
  agentState: { phase: 'working', since: stamp },
  ...patch,
})
const flush = async () => {
  for (let turn = 0; turn < 4; turn++) await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

async function open(sessions = [session('worker')], issues = [issue()]) {
  const values = new Map<string, string>()
  const listeners = new Set<(keys: ReadonlySet<string>) => void>()
  const ui: RoutedUiState = {
    get: (key) => values.get(key) ?? null,
    set: (key, value) => {
      if (value === null) values.delete(key)
      else values.set(key, value)
      for (const listener of listeners) listener(new Set([key]))
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
  const pool = new MobxPool({ selectedIssueId: 'root', coarseNow: Date.parse(later) })
  cleanups.push(() => pool.dispose())
  attachPreferenceSource(pool, ui)
  const update = (nextSessions = sessions, nextIssues = issues) =>
    pool.apply({
      type: 'replace',
      rows: [
        ...nextIssues.map((value) => ({
          kind: 'issue' as const,
          id: value.id,
          value: value as never,
        })),
        ...nextSessions.map((value) => ({
          kind: 'session' as const,
          id: value.sessionId,
          value: value as never,
        })),
      ],
    })
  update()
  const mount = () => {
    const screen = new MissionScreen(pool, 'root', {
      fullOnly: true,
      setPreference: (key, raw) => ui.set(key, raw),
    })
    const stop = autorun(() => {
      void settled(() => [screen.ready, screen.full.ready, screen.compact.shown])
    })
    const stopMode = screen.compact.observe()
    cleanups.push(() => {
      stopMode()
      stop()
      screen.close()
    })
    return screen
  }
  const screen = mount()
  await flush()
  return { screen, compact: screen.compact, pool, ui, update, mount }
}

it('keeps zero-session issues in Full, then shows a compact card for one through three sessions', async () => {
  const f = await open([])
  expect(f.compact.shown).toBe(false)
  expect(f.compact.expanded).toBe(false)
  for (const count of [1, 2, 3]) {
    f.update(Array.from({ length: count }, (_, i) => session(`s${i}`)))
    await flush()
    expect(f.compact.shown).toBe(true)
    expect(f.compact.totalCount).toBe(count)
  }
})

it('outgrows compact at four sessions and remembers Full after removal and reopening', async () => {
  const f = await open()
  expect(f.compact.shown).toBe(true)
  f.update(['a', 'b', 'c', 'd'].map((id) => session(id)))
  await flush()
  expect(f.compact.shown).toBe(false)
  expect(JSON.parse(f.ui.get(FLIGHT_DECK_FULL_ISSUES_KEY) ?? '[]')).toEqual(['root'])
  f.update([session('a')])
  await flush()
  expect(f.compact.shown).toBe(false)
  const reopened = f.mount()
  await flush()
  expect(reopened.compact.shown).toBe(false)
})

it.each([
  'task',
  'phase',
  'proposal',
  'archive',
  'native',
] as const)('retains Full for %s details', async (kind) => {
  const f = await open()
  f.update(
    [
      session(
        'worker',
        kind === 'archive'
          ? { archived: true, status: 'exited' }
          : kind === 'native'
            ? {
                agentState: { phase: 'working', nativeSubagentCount: 1 },
              }
            : {},
      ),
    ],
    kind === 'task' || kind === 'phase' || kind === 'proposal'
      ? [
          issue(),
          issue('child', {
            type: kind === 'phase' ? 'phase' : 'task',
            stage: kind === 'proposal' ? 'proposed' : 'backlog',
          }),
        ]
      : [issue()],
  )
  await flush()
  expect(f.compact.shown).toBe(false)
})

it('orders attention before the coordinator, then coordinator and recent activity within a state', async () => {
  const f = await open(
    [
      session('coord'),
      session('error', { agentState: { phase: 'errored' }, exitCode: 1, status: 'exited' }),
      session('ask', { agentState: { phase: 'needs_user' } }),
    ],
    [issue('root', { coordinatorSessionId: 'coord' })],
  )
  expect(f.compact.sessionIds).toEqual(['ask', 'error', 'coord'])
  f.update(
    [session('coord'), session('older'), session('newer', { lastActiveAt: later })],
    [issue('root', { coordinatorSessionId: 'coord' })],
  )
  await flush()
  expect(f.compact.sessionIds).toEqual(['coord', 'newer', 'older'])
})

it('counts completed sessions independently of issue stage and preserves Idle for a living finished turn', async () => {
  const f = await open([
    session('one', { status: 'exited', stoppedAt: later }),
    session('two', { status: 'exited', stoppedAt: later }),
    session('idle', { agentState: { phase: 'idle', idle: { kind: 'done' } } }),
  ])
  expect(f.compact.doneCount).toBe(2)
  expect(f.compact.totalCount).toBe(3)
  expect(f.compact.row('idle').session.word).toBe('idle')
  expect(f.screen.rootStage).toBe('in_progress')
  expect(f.compact.row('one').completedAt).toBe(Date.parse(later))
  f.update(['one', 'two', 'idle'].map((id) => session(id, { status: 'exited', stoppedAt: later })))
  await flush()
  expect(f.compact.doneCount).toBe(3)
  expect(f.screen.rootStage).toBe('in_progress')
  expect(f.compact.shown).toBe(true)
})

it('keeps external blocker details available in Full', async () => {
  const f = await open(
    [session('worker')],
    [
      issue('root', { blocked: true, deps: [{ id: 'outside', type: 'blocked-by' }] }),
      issue('outside', { parentId: null }),
    ],
  )
  expect(f.compact.shown).toBe(false)
  expect(f.compact.requiresFull).toBe(true)
})

it('keeps a phase selected as its own mission in Full', async () => {
  const f = await open([session('worker')], [issue('root', { type: 'phase' })])
  expect(f.compact.shown).toBe(false)
})

it('retains the ending presentation for a cancelled issue with stopped sessions', async () => {
  const f = await open(
    [session('worker', { status: 'exited' })],
    [issue('root', { stage: 'done', closedReason: 'cancelled', closedAt: later })],
  )
  expect(f.compact.shown).toBe(false)
  expect(f.screen.rootAbandoned).toBe(true)
})

it('uses the first prompt-title line while pending, never a product boot name, and respects curated names', async () => {
  const f = await open([
    session('prompt', {
      name: undefined,
      nameSource: undefined,
      title: 'Fix refresh after sleep\nDetails below',
    }),
    session('boot', { name: 'Codex', nameSource: undefined, title: 'Codex' }),
    session('named', { name: 'Chosen by the user', nameSource: 'user' }),
  ])
  expect(f.compact.row('prompt').title).toBe('Fix refresh after sleep')
  expect(f.compact.row('prompt').pendingTitle).toBe(true)
  expect(f.compact.row('boot').title).toBe('New session')
  expect(f.compact.row('named').title).toBe('Chosen by the user')
  expect(f.compact.row('named').pendingTitle).toBe(false)
})
