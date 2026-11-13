import type { SessionView } from '@podium/client-core/session-values'
import { pickPaneSession } from '@podium/client-core/values'
import { MobxPool } from '@podium/client-graph/pool'
import { PhoneWorkFilters } from '@podium/client-graph/worklist/phone'
import { asIssueId, asSessionId } from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import { readWorkNavigation, workFilterParams, workTaskHref } from './work-navigation'
import { restoreWorkFocus } from './work-restoration.web'

describe('task tap targets shared by Work, Tasks and search', () => {
  let pool: MobxPool | undefined
  afterEach(() => pool?.dispose())
  const stamp = '2026-11-13T12:00:00.000Z'
  const session = (id: string, fields: Partial<SessionView> = {}): SessionView =>
    ({
      sessionId: asSessionId(id),
      issueId: 'task',
      agentKind: 'codex',
      status: 'live',
      title: id,
      cwd: '/repo',
      createdAt: stamp,
      lastActiveAt: stamp,
      archived: false,
      headless: false,
      ...fields,
    }) as SessionView
  function fixture(sessions: SessionView[], issues: Record<string, unknown>[] = [{ id: 'task' }]) {
    pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
    pool.apply({
      type: 'replace',
      rows: [
        ...issues.map((issue, index) => ({
          kind: 'issue' as const,
          id: String(issue.id),
          value: {
            seq: index + 1,
            title: String(issue.id),
            repoPath: '/repo',
            description: '',
            labels: [],
            deps: [],
            stage: 'in_progress',
            type: 'task',
            priority: 2,
            createdAt: stamp,
            updatedAt: stamp,
            ...issue,
          },
        })),
        ...sessions.map((seat) => ({ kind: 'session' as const, id: seat.sessionId, value: seat })),
      ],
    })
    return pool
  }

  it('opens the coordinator chat in one route even when another session spoke later', () => {
    const lead = session('lead', { status: 'exited' })
    const recent = session('recent', { lastActiveAt: '2026-11-13T13:00:00.000Z' })
    const source = fixture([recent, lead], [{ id: 'task', coordinatorSessionId: 'lead' }])
    expect(workTaskHref(source, 'task')).toBe('/mission/task?sessionId=lead')
  })

  it('uses the desktop pick when there is no coordinator, rather than the first session', () => {
    const old = session('old')
    const recent = session('recent', { lastActiveAt: '2026-11-13T13:00:00.000Z' })
    const source = fixture([old, recent])
    const desktop = pickPaneSession([old, recent], null)
    expect(desktop).toBe('recent')
    expect(workTaskHref(source, 'task')).toBe(`/mission/task?sessionId=${desktop}`)
  })

  it('falls back to the desktop pick when the coordinator is not a visible member', () => {
    const old = session('old')
    const recent = session('recent', { lastActiveAt: '2026-11-13T13:00:00.000Z' })
    const source = fixture([old, recent], [{ id: 'task', coordinatorSessionId: 'missing' }])
    expect(workTaskHref(source, 'task')).toBe('/mission/task?sessionId=recent')
  })

  it('opens task details when there is no session', () => {
    expect(workTaskHref(fixture([]), 'task')).toBe('/issue/task')
  })

  it('uses the shared roster to exclude archived, headless and shell seats', () => {
    const source = fixture([
      session('archived', { archived: true }),
      session('headless', { headless: true }),
      session('shell', { agentKind: 'shell' }),
    ])
    expect(workTaskHref(source, 'task')).toBe('/issue/task')
  })

  it('prefers the tapped task coordinator before the mission root coordinator', () => {
    const source = fixture(
      [session('root-lead', { issueId: asIssueId('root') }), session('task-lead')],
      [
        { id: 'root', coordinatorSessionId: 'root-lead' },
        { id: 'task', parentId: 'root', coordinatorSessionId: 'task-lead' },
      ],
    )
    expect(workTaskHref(source, 'task')).toBe('/mission/task?sessionId=task-lead')
  })

  it('uses the root coordinator when the tapped task has no coordinator', () => {
    const source = fixture(
      [
        session('root-lead', { issueId: asIssueId('root') }),
        session('recent', { lastActiveAt: '2026-11-13T13:00:00.000Z' }),
      ],
      [
        { id: 'root', coordinatorSessionId: 'root-lead' },
        { id: 'task', parentId: 'root' },
      ],
    )
    expect(workTaskHref(source, 'task')).toBe('/mission/task?sessionId=root-lead')
  })

  it('lets the existing chat boundary resolve membership while the pool is loading', () => {
    expect(workTaskHref(null, 'cold/task')).toBe('/mission/cold%2Ftask')
  })

  it('encodes the clicked task and picked session without adding a deck route', () => {
    const source = fixture(
      [session('lead/one', { issueId: asIssueId('task/one') })],
      [{ id: 'task/one' }],
    )
    expect(workTaskHref(source, 'task/one')).toBe('/mission/task%2Fone?sessionId=lead%2Fone')
  })
})

it('restores filters from the Work route after the entire screen is remounted', () => {
  let params = {}
  const live = new PhoneWorkFilters(readWorkNavigation(params), (snapshot) => {
    params = workFilterParams(snapshot)
  })
  live.setLane('snoozed')
  live.setQuery('header')
  const remounted = new PhoneWorkFilters(readWorkNavigation(params))
  expect(remounted.lane).toBe('snoozed')
  expect(remounted.query).toBe('header')
  expect(workFilterParams(live)).toMatchObject({ workOffset: undefined, workFocus: undefined })
})
it('normalizes incoming route state without accepting invalid offsets or lanes', () => {
  expect(readWorkNavigation({ workLane: 'unknown', workOffset: '-42' })).toMatchObject({
    lane: 'open',
    query: '',
    offset: 0,
  })
  expect(
    readWorkNavigation({ workLane: ['closed'], workQuery: ['label'], workOffset: 'Infinity' }),
  ).toMatchObject({ lane: 'closed', query: 'label', offset: 0 })
})

it('focuses the current screen while the stack retains an older instance of the same task', () => {
  const previous = document.createElement('button')
  previous.id = 'previous-screen--task'
  previous.hidden = true
  const current = document.createElement('button')
  current.id = 'current-screen--task'
  document.body.append(previous, current)
  try {
    expect(restoreWorkFocus('current-screen--task')).toBe(true)
    expect(document.activeElement).toBe(current)
    expect(restoreWorkFocus('not-mounted-yet')).toBe(false)
  } finally {
    previous.remove()
    current.remove()
  }
})
