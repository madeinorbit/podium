import { afterEach, describe, expect, it, vi } from 'vitest'
import { reaction, runInAction } from 'mobx'
import { dedupeSessions } from '@podium/client-core/engine'
import { deriveIssueViews, deriveIssueRollups, sessionRollupPhase, type IssueViewInput, type IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import { deckDestinationFor, issueForPanel, issueDisplayTitle, presenceNote } from '@podium/client-core/viewmodels'
import { asIssueId, asSessionId } from '@podium/model/browser'
import { MobxPool } from '@podium/client-graph/pool'
import { issuePages } from '@podium/client-graph/issue-page'
import { ISSUE_PAGE_SUMMARIES } from '@podium/client-graph/issue-page-schema'
import { MISSION_SUMMARIES } from '@podium/client-graph/mission-schema'
import { relationLinks } from '@podium/client-graph/shared/links'
import { checkIssuePages, compareIssuePageSnapshots, issuePageFirstDifference } from '@podium/client-graph/diagnostics/issue-page-check'
import { LOADING } from '@podium/client-graph'
import type { SliceIssue, SliceSession } from '@podium/client-graph/shared/slice-types'
import { diffRelations } from './adapters/mobx-rebuild'
import { tracked } from './adapters/mobx-pool'
import { installMobxWarnTrap } from './mobx-trap'

installMobxWarnTrap({ errors: true })
const NOW = Date.parse('2026-10-01T12:00:00Z'), STAMP = '2026-09-01T12:00:00Z'
const pools: MobxPool[] = []
afterEach(() => { for (const pool of pools.splice(0)) pool.dispose(); vi.restoreAllMocks() })
type PageInput = SliceIssue & { description?: string | { value: string }; notes?: string | { value: string } }
const task = (id: string, patch: Partial<PageInput> = {}): PageInput => ({
  id, seq: 1, title: 'Synthetic task', stage: 'backlog', repoId: 'R', repoPath: '/synthetic',
  description: '', createdAt: STAMP, updatedAt: STAMP, ...patch,
})
const seat = (sessionId: string, issueId: string | null, patch: Partial<SliceSession> = {}): SliceSession => ({
  sessionId, issueId, status: 'live', cwd: '/synthetic', createdAt: STAMP, lastActiveAt: STAMP, agentKind: 'codex', ...patch,
})
const summaries = { issue: [...new Set([...ISSUE_PAGE_SUMMARIES.issue, ...MISSION_SUMMARIES.issue])],
  session: [...new Set([...ISSUE_PAGE_SUMMARIES.session, ...MISSION_SUMMARIES.session])] }
function open(issues: PageInput[], seats: SliceSession[] = [], lazy = false) {
  // The kernel's canonical publication order is by opaque primary key.
  issues = [...issues].sort((a, b) => a.id.localeCompare(b.id))
  issues = issues.map(row => ({ ...row, blocked: (row.deps ?? []).some(dep => dep.type === 'blocks' &&
    issues.some(target => target.id === dep.id && target.stage !== 'done')) }))
  seats = [...seats].sort((a, b) => a.sessionId.localeCompare(b.sessionId))
  const input = new Map<string, object>([
    ...issues.map(row => [`issue:${row.id}`, row] as const), ...seats.map(row => [`session:${row.sessionId}`, row] as const),
  ])
  const load = vi.fn((kind: string, id: string) => input.get(`${kind}:${id}`))
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: NOW }, undefined,
    lazy ? { load, summaries, schedule: () => () => {} } : undefined)
  pools.push(pool)
  pool.apply({ type: 'replace', rows: [
    { kind: 'worktree', id: '/synthetic', value: { path: '/synthetic', repoId: 'R', repoPath: '/synthetic', prefix: 'T' } },
    ...seats.map(value => ({ kind: 'session' as const, id: value.sessionId, value })),
    ...issues.map(value => ({ kind: 'issue' as const, id: value.id, value })),
  ] })
  const world = () => {
    const inputs = issues.map(row => ({ ...row, prefix: 'T' }))
    const raw = seats.map(row => ({ ...row, sessionId: asSessionId(row.sessionId), issueId: row.issueId ? asIssueId(row.issueId) : null,
      phase: sessionRollupPhase(row) }))
    const views = deriveIssueViews(inputs as unknown as IssueViewInput[], raw, { now: () => NOW })
    const index = new Map(raw.map(row => [row.sessionId, row]))
    return inputs.map(row => ({ ...row, ...views.get(row.id), description: typeof row.description === 'string' ? row.description : (row.description as { value: string })?.value ?? '',
      notes: typeof row.notes === 'string' ? row.notes : row.notes?.value,
      prefix: 'T', branch: row.branch ?? null, worktreePath: row.worktreePath ?? null,
      readAt: row.readAt ?? null, tuckedAt: row.tuckedAt ?? null, pinned: row.pinned ?? false,
      deps: row.deps ?? [], ...deriveIssueRollups({ ...row, readAt: row.readAt ?? null }, views.get(row.id)!.memberSessionIds, id => index.get(id)),
    })) as unknown as IssueViewModel[]
  }
  const visible = () => dedupeSessions(seats as unknown as SessionView[])
  const patch = (kind: 'issue' | 'session', id: string, value: object | undefined) => {
    if (kind === 'issue') issues = issues.filter(row => row.id !== id).concat(value ? [value as PageInput] : []).sort((a, b) => a.id.localeCompare(b.id))
    else seats = seats.filter(row => row.sessionId !== id).concat(value ? [value as SliceSession] : []).sort((a, b) => a.sessionId.localeCompare(b.sessionId))
    if (value) input.set(`${kind}:${id}`, value); else input.delete(`${kind}:${id}`)
    pool.apply({ type: 'update', rows: [{ kind, id, value }] })
  }
  const settle = <T,>(read: () => T): T => {
    for (let round = 0; round < 64; round++) { const result = tracked(read); if (!pool.hydrate()) return result }
    throw new Error('Page load did not settle')
  }
  return { pool, views: issuePages(pool), world, visible, patch, settle, load,
    check: () => tracked(() => checkIssuePages(pool, world(), visible())) }
}

describe('declared issue page', () => {
  it('matches documents, checkout observations, custom multi-edges, raw counts and visible resume winners', () => {
    const rows = [task('root', { seq: 8, description: { value: 'Long body' }, notes: { value: 'Notes' },
      gitState: { ahead: 2, merged: false }, readAt: STAMP, pinned: true, deferUntil: '2026-10-02T12:00:00Z' }),
      task('child-b', { seq: 3, parentId: 'root', archived: true, stage: 'done' }),
      task('child-a', { seq: 2, parentId: 'root' }), task('deleted', { parentId: 'root', deletedAt: STAMP }),
      task('source', { deps: [{ id: 'root', type: 'blocks' }, { id: 'root', type: 'custom-edge' }, { id: 'child-a', type: 'related' }] })]
    const ctx = open(rows, [seat('worker', 'root', { name: 'Visible name', agentState: { phase: 'working' } }),
      seat('shell', 'root', { agentKind: 'shell' }), seat('headless', 'root', { headless: true, agentState: { phase: 'waiting' } }),
      seat('twin-a', 'root', { status: 'hibernated', resume: { kind: 'codex-thread', value: 'same' } }),
      seat('twin-b', 'root', { status: 'exited', resume: { kind: 'codex-thread', value: 'same' } }),
      seat('moved', 'child-a', { refIssueId: 'root' } as Partial<SliceSession>)])
    expect(ctx.check()).toMatchObject({ differences: 0, pending: 0 })
    const page = tracked(() => ctx.views.data('root'))
    if (!page || page === LOADING) throw new Error('Missing test page')
    expect(page.issue.sessionSummary).toEqual({ total: 4, byPhase: { waiting: 1, unknown: 2, working: 1 } })
    expect(page.children.map(row => row.id)).toEqual(['child-a', 'child-b'])
    expect(page.memberSessions.some(row => row.sessionId === 'shell')).toBe(false)
    expect(page.issue.dependents.map(row => row.type)).toEqual(['blocks', 'custom-edge'])
    expect(page.title).toBe(issueDisplayTitle(ctx.world().find(row => row.id === 'root')!, ctx.visible(), ['/synthetic']))
    expect(page.presence).toEqual(presenceNote(page.issue, ctx.visible().filter(s => s.issueId === 'root'),
      new Map(ctx.world().map(row => [row.id, row])), ctx.visible()))
  })

  it('maintains every edge target through duplicate removal, retarget, eviction and replace', () => {
    const ctx = open([task('a'), task('b'), task('owner', { deps: [
      { id: 'a', type: 'blocks' }, { id: 'a', type: 'custom' }, { id: 'b', type: 'related' },
    ] })])
    const links = relationLinks(ctx.pool.graph)
    expect(tracked(() => [...links.issue.pageDependencies.ids('owner')])).toEqual(['a', 'b'])
    const check = () => expect(runInAction(() => diffRelations(ctx.pool.graph, ctx.pool.tables))).toEqual([])
    check()
    for (const deps of [[{ id: 'a', type: 'custom' }], [{ id: 'missing', type: 'custom' }], []]) {
      ctx.patch('issue', 'owner', task('owner', { deps }))
      check(); expect(ctx.check()).toMatchObject({ differences: 0 })
      expect(tracked(() => [...links.issue.pageDependencies.ids('owner')])).toEqual(deps.map(dep => dep.id))
    }
    ctx.patch('issue', 'owner', undefined); check()
    expect(tracked(() => [...links.issue.pageDependents.ids('a')])).toEqual([])
    ctx.pool.apply({ type: 'replace', rows: [{ kind: 'issue', id: 'owner', value: task('owner', { deps: [{ id: 'a', type: 'custom' }] }) }] })
    expect(tracked(() => [...links.issue.pageDependents.ids('a')])).toEqual(['owner'])
    expect(() => tracked(() => ctx.pool.graph.one('issue', 'owner', 'pageDependencies'))).toThrow(/not a single/)
  })

  it('matches explicit, session, containment and mission destinations without a legacy lookup', () => {
    const ctx = open([task('root', { worktreePath: '/synthetic' }), task('child', { parentId: 'root', worktreePath: '/synthetic/deep', seq: 4 }),
      task('tie', { worktreePath: '/synthetic/deep', seq: 2 }), task('arch', { archived: true }),
      task('deleted', { deletedAt: STAMP }), task('draft', { isDraftVessel: true })],
      [seat('attached', 'child'), seat('loose', null), seat('archived', 'arch')])
    for (const args of [ { cwd: '/synthetic/deep/file' }, { cwd: '/synthetic/deeper' },
      { cwd: '/synthetic', sessionId: 'loose' }, { cwd: '/synthetic', sessionId: 'unknown' },
      { cwd: '/synthetic', sessionId: 'attached' }, { cwd: '/synthetic', issueId: 'arch', sessionId: 'attached' },
      { cwd: '/synthetic', issueId: 'deleted' }, { cwd: '/synthetic', sessionId: 'archived' } ]) {
      const expected = issueForPanel({ ...args, issues: ctx.world(), sessions: ctx.visible() } as Parameters<typeof issueForPanel>[0])
      const actual = tracked(() => ctx.views.panel(args))
      expect(actual && actual !== LOADING ? actual.issue.id : null).toBe(expected?.id ?? null)
    }
    for (const id of ['root', 'child', 'arch', 'deleted', 'draft', 'unknown']) {
      const expected = deckDestinationFor(ctx.world(), ctx.visible(), asIssueId(id))
      const actual = tracked(() => ctx.views.destination(id))
      expect(actual && actual !== LOADING ? actual.id : null).toBe(expected?.id ?? null)
    }
  })

  it('uses cold summaries for menus and batches page payload loads without peek', () => {
    const ctx = open([task('arch', { archived: true, deps: [{ id: 'cold', type: 'custom' }] }),
      task('cold', { archived: true, parentId: 'arch' })], [seat('old', 'arch', { archived: true, status: 'exited' })], true)
    const read = vi.spyOn(ctx.pool, 'row'), before = ctx.load.mock.calls.length
    expect(tracked(() => ctx.views.menuIssues())).not.toBe(LOADING)
    expect(ctx.load.mock.calls.length).toBe(before)
    expect(tracked(() => ctx.views.data('arch'))).toBe(LOADING)
    expect(tracked(() => ctx.views.panel({ issueId: 'arch', cwd: '/synthetic' }))).toBe(LOADING)
    expect(ctx.load.mock.calls.length).toBe(before)
    const page = ctx.settle(() => ctx.views.data('arch'))
    expect(page && page !== LOADING ? page.issue.id : null).toBe('arch')
    expect(ctx.check()).toMatchObject({ differences: 0, pending: 0 })
    expect(read.mock.calls.some(call => String(call[2]) === 'peek')).toBe(false)
    expect(new Set(ctx.load.mock.calls.slice(before).map(call => `${call[0]}:${call[1]}`)).size).toBe(ctx.load.mock.calls.length - before)
  })

  it('updates markers, fields, raw membership and relations without stale derived values', () => {
    const ctx = open([task('root'), task('other'), task('child', { parentId: 'root' })], [seat('worker', 'root')])
    const stop = reaction(() => ctx.views.data('root'), () => {}, { fireImmediately: true })
    try {
      ctx.patch('issue', 'root', task('root', { title: 'New title', readAt: '2026-10-01T12:00:00Z', pinned: true }))
      ctx.patch('issue', 'child', task('child', { parentId: 'root', stage: 'done' }))
      ctx.patch('issue', 'other', task('other', { deps: [{ id: 'root', type: 'relates' }] }))
      ctx.patch('session', 'worker', seat('worker', 'other', { agentState: { phase: 'waiting' } }))
      expect(ctx.check()).toMatchObject({ differences: 0, pending: 0 })
      const value = tracked(() => ctx.views.issue('root'))
      expect(value).toMatchObject({ title: 'New title', pinned: true, unread: false, childDoneCount: 1,
        memberSessionIds: [], dependents: [{ id: 'other', type: 'relates' }], sessionSummary: { total: 0 } })
    } finally { stop() }
    ctx.pool.dispose()
    expect(tracked(() => ctx.views.data('root'))).toBe(LOADING)
  })
})

describe('issue page diagnostic locations', () => {
  it('reports missing, duplicated, reordered and nested differences while another page loads, without authored values', () => {
    const children = [{ title: 'private one' }, { title: 'private two' }]
    const expected = [{ id: 'opaque-a', value: { children, labels: ['private label'] } }, { id: 'opaque-b', value: { fields: {} } }]
    const reported: unknown[] = []
    const result = compareIssuePageSnapshots(expected, [{ id: 'opaque-a', value: { children: [...children].reverse(), labels: ['secret'] } },
      { id: 'opaque-a', value: { children: [...children].reverse() } },
      { id: 'opaque-b', value: LOADING }, { id: 'opaque-c', value: {} }], diff => reported.push(diff))
    expect(result).toMatchObject({ differences: 3, pending: 1, first: { issueId: 'opaque-a', field: 'duplicateIssue' } })
    expect(reported).toContainEqual({ issueId: 'opaque-a', position: 0, field: 'children.0.title' })
    expect(JSON.stringify({ result, reported })).not.toMatch(/private|secret/)
    expect(issuePageFirstDifference({ body: undefined }, {})).toBe('body')
    expect(compareIssuePageSnapshots(expected, expected)).toMatchObject({ differences: 0, pending: 0 })
  })
})
