import type { IssueViewInput } from '../../diagnostics/reference/issue-views'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { reaction, runInAction } from 'mobx'
import { dedupeSessions } from '../../diagnostics/reference-state'
import { type IssueViewModel } from '@podium/client-core/replica'
import { deriveIssueViews, deriveIssueRollups, sessionRollupPhase } from '../../diagnostics/reference/issue-views'
import type { SessionView } from '@podium/client-core/session-values'
import { deckDestinationFor, issueForPanel, issueDisplayTitle, presenceNote } from '@podium/client-core/values'
import { asIssueId, asSessionId } from '@podium/model/browser'
import { MobxPool } from '@podium/client-graph/pool'
import { issuePages } from '@podium/client-graph/issue-page'
import { ISSUE_PAGE_SUMMARIES } from '@podium/client-graph/issue-page-schema'
import { MISSION_SUMMARIES } from '@podium/client-graph/mission-schema'
import { relationLinks } from '@podium/client-graph/shared/links'
import { checkIssuePages, compareIssuePageSnapshots, issuePageFirstDifference } from '../../diagnostics/issue-page-check'
import { LOADING, type RowRecord } from '@podium/client-graph'
import type { SliceIssue, SliceSession } from '@podium/client-graph/shared/slice-types'
import { diffRelations } from './adapters/mobx-rebuild'
import { tracked } from './adapters/mobx-pool'
import { installMobxWarnTrap } from './mobx-trap'

installMobxWarnTrap({ errors: true })
const NOW = Date.parse('2026-10-01T12:00:00Z'), STAMP = '2026-09-01T12:00:00Z'
const pools: MobxPool[] = []
afterEach(() => { for (const pool of pools.splice(0)) pool.dispose(); vi.restoreAllMocks() })
type PageInput = SliceIssue & { description?: string | { value: string }; notes?: string | { value: string }; labels?: string[] }
const task = (id: string, patch: Partial<PageInput> = {}): PageInput => ({
  id, seq: 1, title: 'Synthetic task', stage: 'backlog', blocked: false, repoId: 'R', repoPath: '/synthetic',
  description: '', createdAt: STAMP, updatedAt: STAMP, ...patch,
})
const seat = (sessionId: string, issueId: string | null, patch: Partial<SliceSession & { refIssueId: string }> = {}): SliceSession => ({
  sessionId, issueId, status: 'live', cwd: '/synthetic', createdAt: STAMP, lastActiveAt: STAMP, agentKind: 'codex', ...patch,
})
const summaries = { issue: [...new Set([...ISSUE_PAGE_SUMMARIES.issue, ...MISSION_SUMMARIES.issue])],
  session: ISSUE_PAGE_SUMMARIES.session }
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
    { kind: 'worktree', id: '/synthetic', value: { path: '/synthetic', repoId: 'R', repoName: 'Synthetic', repoPath: '/synthetic', prefix: 'T' } },
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
    pool.apply({ type: 'update', rows: [{ kind, id, value: value as RowRecord['value'] }] })
  }
  const settle = <T,>(read: () => T): T => {
    for (let round = 0; round < 64; round++) { const result = tracked(read); if (!pool.hydrate()) return result }
    throw new Error('Page load did not settle')
  }
  return { pool, views: issuePages(pool), world, visible, patch, settle, load,
    check: () => tracked(() => checkIssuePages(pool, world(), visible())) }
}

/**
 * POD-5407: a cold row's declared summary fields that are not rule inputs
 * the cold index holds are read through the one per-row reader (`load`),
 * never kept by the pool. Every read since `from` was such a read: of cold
 * rows only, none of them installed.
 */
function expectSummaryReadsOnly(ctx: { pool: MobxPool; load: { mock: { calls: unknown[][] } } }, from = 0): void {
  for (const [kind, id] of ctx.load.mock.calls.slice(from) as ['issue' | 'session', string][]) {
    expect(tracked(() => ctx.pool.tables[kind].has(id)), `${kind}:${id} read as a summary, not installed`).toBe(false)
  }
}

describe('declared issue page', () => {
  it('reads cold menu fields without computing presence bounds', () => {
    const ctx = open(Array.from({ length: 1024 }, (_, index) => task(`cold-${index}`, {
      seq: index + 1, archived: true, labels: index === 1 ? ['initial'] : [],
      deps: index === 1 ? [{ id: 'cold-0', type: 'relates' }] : [],
    })), [], true)
    const summaryReads = vi.spyOn(ctx.pool.residency!, 'summary')
    const rowReads = vi.spyOn(ctx.pool, 'row')
    const snapshots: IssueViewModel[][] = []
    const stop = reaction(() => ctx.views.issues(), next => {
      if (!next || next === LOADING) throw new Error('Missing cold menu world')
      snapshots.push(next)
    }, { fireImmediately: true })
    try {
      expect(snapshots[0]).toHaveLength(1024)
      expect(snapshots[0]?.find(row => row.id === 'cold-0')?.dependents).toEqual([{ id: 'cold-1', type: 'relates' }])
      // Count the screen read before apply() calculates its own cold bounds.
      expect(summaryReads.mock.calls.filter(([kind, , decorate]) => kind === 'issue' && decorate !== false)).toHaveLength(0)
      expect(rowReads.mock.calls.filter(([kind]) => kind === 'repo')).toHaveLength(1)
      ctx.patch('issue', 'cold-1', task('cold-1', { seq: 2, archived: true, labels: ['changed'],
        deps: [{ id: 'cold-2', type: 'custom' }] }))
      expect(snapshots).toHaveLength(2)
      expect(snapshots[1]?.find(row => row.id === 'cold-1')?.labels).toEqual(['changed'])
      expect(snapshots[1]?.find(row => row.id === 'cold-0')?.dependents).toEqual([])
      expect(snapshots[1]?.find(row => row.id === 'cold-2')?.dependents).toEqual([{ id: 'cold-1', type: 'custom' }])
      ctx.pool.apply({ type: 'update', rows: [{ kind: 'worktree', id: '/synthetic',
        value: { path: '/synthetic', repoId: 'R', repoName: 'Synthetic', repoPath: '/synthetic', prefix: 'NEW' } }] })
      expect(snapshots).toHaveLength(3)
      expect(snapshots[2]?.every(row => row.prefix === 'NEW')).toBe(true)
      expectSummaryReadsOnly(ctx)
      expect(tracked(() => ctx.pool.row('issue', 'cold-0', 'mark'))).toBe(LOADING)
    } finally { stop() }
  })
  it('keeps the menu world quiet for body edits and reactive to labels and inverse edge changes', () => {
    const ctx = open([task('root'), task('other')])
    const snapshots: IssueViewModel[][] = []
    const stop = reaction(() => ctx.views.issues(), next => {
      if (!next || next === LOADING) throw new Error('Missing menu world')
      snapshots.push(next)
    }, { fireImmediately: true })
    try {
      ctx.patch('issue', 'other', task('other', { description: 'A changed document' }))
      expect(snapshots).toHaveLength(1)
      ctx.patch('issue', 'other', task('other', { labels: ['changed'], deps: [{ id: 'root', type: 'custom' }] }))
      expect(snapshots).toHaveLength(2)
      expect(snapshots[1]?.find(row => row.id === 'other')?.labels).toEqual(['changed'])
      expect(snapshots[1]?.find(row => row.id === 'root')?.dependents).toEqual([{ id: 'other', type: 'custom' }])
      expect(ctx.check()).toMatchObject({ differences: 0, pending: 0 })
    } finally { stop() }
  })
  it('publishes the accepted deadline change on a clock-only tick without hiding other differences', () => {
    const ctx = open([task('root', { deferUntil: new Date(NOW + 1000).toISOString() })])
    const values: boolean[][] = []
    const stop = reaction(() => {
      const row = ctx.views.issue('root')
      if (!row || row === LOADING) throw new Error('Missing clock fixture')
      return [row.deferred, row.ready]
    }, next => values.push(next), { fireImmediately: true })
    const payload = tracked(() => ctx.pool.row('issue', 'root'))
    try {
      ctx.pool.applyLocals({ selectedIssueId: null, coarseNow: NOW + 999 }, new Set(['coarseNow'] as const))
      expect(values).toEqual([[true, false]])
      ctx.pool.applyLocals({ selectedIssueId: null, coarseNow: NOW + 1000 }, new Set(['coarseNow'] as const))
      expect(values).toEqual([[true, false], [false, true]])
      expect(tracked(() => ctx.pool.row('issue', 'root'))).toBe(payload)
      expect(ctx.check()).toMatchObject({ differences: 0, acceptedDeadlineDifferences: 2 })
      const wrongTitle = ctx.world().map(row => ({ ...row, title: 'Different title' }))
      expect(tracked(() => checkIssuePages(ctx.pool, wrongTitle, ctx.visible())))
        .toMatchObject({ differences: 1, first: { field: 'fields.title' }, acceptedDeadlineDifferences: 2 })
      const ordinary = open([task('ordinary')])
      const wrongReady = ordinary.world().map(row => ({ ...row, ready: false }))
      expect(tracked(() => checkIssuePages(ordinary.pool, wrongReady, ordinary.visible())))
        .toMatchObject({ differences: 1, first: { field: 'fields.ready' }, acceptedDeadlineDifferences: 0 })
    } finally { stop() }
  })
  it('keeps a staffed continuation through every spin-off hop in the page neighbourhood', () => {
    const ctx = open([task('root', { stage: 'in_progress' }),
      task('hop', { seq: 2, stage: 'done', deps: [{ id: 'root', type: 'discovered-from' }] }),
      task('tip', { seq: 3, deps: [{ id: 'hop', type: 'discovered-from' }] }),
      task('unrelated')], [seat('worker', 'tip', { agentState: { phase: 'working' } }), seat('elsewhere', 'unrelated')])
    const page = tracked(() => ctx.views.data('root'))
    if (!page || page === LOADING) throw new Error('Missing continuation fixture page')
    const world = ctx.world(), current = world.find(row => row.id === 'root')!
    expect(page.presence).toEqual(presenceNote(current, [], new Map(world.map(row => [row.id, row])), ctx.visible()))
    expect(page.presence).toMatchObject({ text: 'Work continued in T-3' })
    expect(page.sessions.map(row => row.sessionId)).toEqual(['worker'])
  })

  it('reacts to a cursor-only mark without replacing the issue payload', () => {
    const ctx = open([task('root', { readAt: null })])
    const stop = reaction(() => ctx.views.issue('root'), () => {}, { fireImmediately: true })
    const payload = tracked(() => ctx.pool.row('issue', 'root'))
    try {
      ctx.patch('issue', 'root', task('root', { readAt: STAMP }))
      expect(tracked(() => ctx.pool.row('issue', 'root'))).toBe(payload)
      expect(tracked(() => ctx.views.issue('root'))).toMatchObject({ readAt: STAMP, unread: false })
      expect(ctx.check()).toMatchObject({ differences: 0 })
    } finally { stop() }
  })
  it('expires a defer at the exact coarse-clock deadline', () => {
    const ctx = open([task('root', { deferUntil: new Date(NOW).toISOString() })])
    expect(tracked(() => ctx.views.issue('root'))).toMatchObject({ ready: true, deferred: false })
    expect(tracked(() => ctx.views.summary('root'))).toMatchObject({ ready: true, deferred: false })
    expect(ctx.check()).toMatchObject({ differences: 0 })
  })
  it('preserves the legacy answer for non-date defers without registering an invalid deadline', () => {
    const ctx = open([task('root', { deferUntil: 'next-message' })])
    expect(tracked(() => ctx.views.issue('root'))).toMatchObject({ ready: true, deferred: false })
    expect(tracked(() => ctx.views.summary('root'))).toMatchObject({ ready: true, deferred: false })
    expect(ctx.check()).toMatchObject({ differences: 0 })
  })
  it('keeps a later resume winner in the first group slot while raw member order follows IDs', () => {
    const twin = { kind: 'codex-thread', value: 'same' }
    const ctx = open([task('root'), task('born')], [
      seat('a-first', 'root', { status: 'exited', resume: twin, refIssueId: 'born' }),
      seat('b-middle', 'root'),
      seat('c-winner', 'root', { status: 'hibernated', resume: twin, refIssueId: 'born' }),
    ])
    const stop = reaction(() => ctx.views.data('root'), () => {}, { fireImmediately: true })
    try {
      const roster = () => tracked(() => ctx.views.attachedSessions('root'))
      expect(roster()).toMatchObject([{ sessionId: 'c-winner' }, { sessionId: 'b-middle' }])
      expect(tracked(() => ctx.views.memberSessions('root'))).toMatchObject([{ sessionId: 'b-middle' }, { sessionId: 'c-winner' }])
      expect(ctx.check()).toMatchObject({ differences: 0 })
      ctx.patch('session', 'a-first', seat('a-first', 'root', { status: 'live', resume: twin, refIssueId: 'born' }))
      expect(roster()).toMatchObject([{ sessionId: 'a-first' }, { sessionId: 'b-middle' }, { sessionId: 'c-winner' }])
      expect(ctx.check()).toMatchObject({ differences: 0 })
      ctx.patch('session', 'a-first', undefined)
      expect(roster()).toMatchObject([{ sessionId: 'b-middle' }, { sessionId: 'c-winner' }])
      expect(ctx.check()).toMatchObject({ differences: 0 })
    } finally { stop() }
  })
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
    expect(tracked(() => ctx.pool.model('issue', 'owner')!.pageDependencies.ready.map(row => row.id).sort())).toEqual(['a', 'b'])
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
    expect(() => ctx.pool.graph.one('issue', 'owner', 'pageDependencies')).toThrow(/is a collection/)
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

  it('batches a cold issue payload and its raw member fields in one window', () => {
    const ctx = open([task('arch', { archived: true })],
      [seat('old', 'arch', { archived: true, status: 'exited' })], true)
    expect(tracked(() => ctx.views.issue('arch'))).toBe(LOADING)
    expect(ctx.load).not.toHaveBeenCalled()
    expect(ctx.pool.hydrate()).toBe(2)
    expect(tracked(() => ctx.views.issue('arch'))).toMatchObject({ id: 'arch', sessionSummary: { total: 1 } })
  })

  it('uses cold summaries for menus and batches page payload loads without peek', () => {
    const ctx = open([task('arch', { archived: true, deps: [{ id: 'cold', type: 'custom' }] }),
      task('cold', { archived: true, parentId: 'arch' }), task('cold-2', { archived: true, parentId: 'arch' }),
      task('remote', { archived: true })],
      [seat('old', 'arch', { archived: true, status: 'exited' }),
        seat('old-child', 'cold-2', { archived: true, status: 'exited' }),
        seat('born-a', 'remote', { refIssueId: 'arch', archived: true, status: 'exited' }),
        seat('born-b', 'remote', { refIssueId: 'arch', archived: true, status: 'exited' })], true)
    const read = vi.spyOn(ctx.pool, 'row'), before = ctx.load.mock.calls.length
    expect(tracked(() => ctx.pool.row('session', 'born-a', 'mark'))).toBe(LOADING)
    expect(tracked(() => ctx.pool.row('session', 'born-a', 'summary'))).toMatchObject({ refIssueId: 'arch' })
    expect(tracked(() => [...ctx.pool.graph.many('issue', 'arch', 'bornSessions')])).toEqual(['born-a', 'born-b'])
    expect(tracked(() => ctx.views.menuIssues())).not.toBe(LOADING)
    expectSummaryReadsOnly(ctx, before)
    expect(tracked(() => ctx.views.data('arch'))).toBe(LOADING)
    expect(tracked(() => ctx.views.panel({ issueId: 'arch', cwd: '/synthetic' }))).toBe(LOADING)
    expectSummaryReadsOnly(ctx, before)
    expect(ctx.pool.hydrate()).toBe(7)
    const page = tracked(() => ctx.views.data('arch'))
    expect(page && page !== LOADING ? page.issue.id : null).toBe('arch')
    expect(ctx.check()).toMatchObject({ differences: 0 })
    ctx.pool.hydrate()
    expect(ctx.check()).toMatchObject({ differences: 0, pending: 0 })
    expect(read.mock.calls.some(call => String(call[2]) === 'peek')).toBe(false)
    // POD-5407: a row is read at most twice: once for its declared summary
    // (the one reader, never installed) and once when the window installs it.
    const reads = new Map<string, number>()
    for (const call of ctx.load.mock.calls.slice(before)) reads.set(`${call[0]}:${call[1]}`, (reads.get(`${call[0]}:${call[1]}`) ?? 0) + 1)
    expect([...reads.values()].every(count => count <= 2), JSON.stringify([...reads])).toBe(true)
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
    expect(runInAction(() => ctx.views.data('root'))).toBe(LOADING)
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
