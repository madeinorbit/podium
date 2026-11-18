import { here } from '@podium/client-graph/lookup'
import { createMobileInboxViews } from '../../test/legacy-mobile-inbox'
import { ProposalScreening } from '@podium/client-graph/mobile-triage'
import { MobxPool } from '@podium/client-graph/pool'
import { autorun } from 'mobx'
import { expect, it } from 'vitest'
import { resolvePoolWorkMenu } from '../../test/legacy-pool-work-menu'
import { resolvePoolWorkMenu as resolveSharedWorkMenu } from './pool-work-menu'
import { reconcileScreeningIds } from '../../test/legacy-screening-order'
import { workMenuActionIds } from './work-menu'

const stamp = '2026-10-08T12:00:00Z'
const issue = (id: string, patch: object = {}) => ({
  id,
  title: id,
  repoPath: '/synthetic',
  stage: 'proposed',
  seq: 1,
  priority: 2,
  audience: 'human',
  createdAt: stamp,
  updatedAt: stamp,
  blockedByNotes: [],
  ...patch,
})
const session = (id: string, patch: object = {}) => ({
  sessionId: id,
  cwd: '/synthetic',
  issueId: 'a',
  agentKind: 'codex',
  status: 'live',
  createdAt: stamp,
  lastActiveAt: stamp,
  title: id,
  ...patch,
})
function fixture(extra = 0) {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) })
  pool.sources.register(['mobileInboxState'], { read: () => ({ hasCursor: true }), dispose() {} })
  const issues = [issue('a', { seq: 3 }), issue('b', { seq: 2 }), issue('c')]
  const sessions = [
    session('ask', { agentState: { phase: 'needs_user', since: stamp } }),
    session('work', { agentState: { phase: 'working', since: stamp } }),
    session('idle', { status: 'hibernated', agentState: { phase: 'working', since: stamp } }),
    session('offer', { offer: { message: 'Decide', actions: [] } }),
    session('shell', { agentKind: 'shell' }),
    session('headless', { headless: true }),
    session('archived', { archived: true }),
    ...Array.from({ length: extra }, (_, at) => session(`hidden-${at}`, { archived: true })),
  ]
  pool.apply({
    type: 'replace',
    rows: [
      ...issues.map((value) => ({ kind: 'issue' as const, id: value.id, value })),
      ...sessions.map((value) => ({ kind: 'session' as const, id: value.sessionId, value })),
    ],
  })
  return { pool, old: createMobileInboxViews(pool) }
}

it('compares shared menu facts and actions with the old captured menu on the same fixture', () => {
  const f = fixture()
  try {
    for (const lane of ['live', 'closed', 'snoozed'] as const) {
      const old = resolvePoolWorkMenu(f.pool, 'a', lane)!
      const next = resolveSharedWorkMenu(f.pool, 'a', lane)!
      expect(next.target.issue).toBe(here(f.pool.model('issue', 'a')))
      for (const key of [
        'id',
        'title',
        'displayRef',
        'unread',
        'childCount',
        'childDoneCount',
      ] as const)
        expect(next.target.issue[key]).toEqual(old.target.issue[key])
      expect(next.target.sessionCount).toBe(old.target.sessionCount)
      expect(workMenuActionIds(next.target.issue, lane, { placement: false })).toEqual(
        workMenuActionIds(old.target.issue, lane, { placement: false }),
      )
    }
  } finally {
    f.old.dispose()
    f.pool.dispose()
  }
})

it('compares stable deck order with old queue/reconciliation through edits, removals and arrivals', () => {
  const f = fixture(),
    deck = new ProposalScreening(f.pool)
  const close = deck.open()
  let oldOrder = f.old.screening().queue,
    oldIndex = 0
  try {
    expect(deck.order).toEqual(oldOrder)
    deck.advance()
    oldIndex++
    for (const value of [
      issue('b', { stage: 'backlog' }),
      issue('z', { priority: 0, seq: 99 }),
      issue('c', { priority: 0 }),
      issue('a', { stage: 'done' }),
    ]) {
      f.pool.apply({ type: 'update', rows: [{ kind: 'issue', id: value.id, value }] })
      const old = reconcileScreeningIds(oldOrder, oldIndex, f.old.screening().queue)
      oldOrder = old.order
      oldIndex = old.index
      expect(deck.order).toEqual(oldOrder)
      expect(deck.index).toBe(oldIndex)
    }
    expect(deck.order).toEqual(['a', 'c', 'z'])
  } finally {
    close()
    f.old.dispose()
    f.pool.dispose()
  }
})

it('keeps opening choices while shared menu titles, child counts and action targets update', () => {
  const f = fixture(),
    menu = resolveSharedWorkMenu(f.pool, 'a', 'live')!
  const stop = autorun(() => {
    void menu.target.issue.title
    void menu.target.issue.childCount
    void menu.target.sessionCount
  })
  try {
    f.pool.apply({
      type: 'update',
      rows: [
        { kind: 'issue', id: 'a', value: issue('a', { title: 'Changed while open' }) },
        { kind: 'issue', id: 'child', value: issue('child', { parentId: 'a', stage: 'done' }) },
        { kind: 'session', id: 'arrival', value: session('arrival') },
      ],
    })
    expect(menu.target.issue.title).toBe('Changed while open')
    expect(menu.target.issue.childCount).toBe(1)
    expect(menu.target.issue.childDoneCount).toBe(1)
    expect(menu.target.issue.id).toBe('a')
    expect(menu.target.lane).toBe('live')
    expect(menu.target.sessionCount).toBe(resolvePoolWorkMenu(f.pool, 'a')!.target.sessionCount)
  } finally {
    stop()
    f.old.dispose()
    f.pool.dispose()
  }
})
