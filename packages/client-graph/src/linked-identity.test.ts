import { parseSessionRef } from '@podium/protocol'
import { referenceKey } from './shared/session-reference'
import { autorun, runInAction } from 'mobx'
import { expect, it, vi } from 'vitest'
import { insideReader, measureWork } from '../../../tests/worklist/harness/src/work-meter'
import { MobxPool } from './pool'
import { SHELL_SUMMARIES } from './shell-schema'
import { shellViews } from './shell-views'
import { createColdIndex } from './shared/cold-index'
import { SCHEMA } from './shared/schema'
import type { RowRecord, RowSourceEvent } from './shared/source'

const old = '2020-01-01T00:00:00Z'
const issue = (id: string, seq = 1, patch: object = {}): RowRecord => ({ kind: 'issue', id, value: {
  id, seq, title: id, description: '', stage: 'done', archived: true, repoId: 'repo',
  repoPath: '/fixture', audience: 'human', labels: [], deps: [], priority: 2,
  createdAt: old, updatedAt: old, ...patch,
} } as RowRecord)
const session = (id: string, patch: object = {}): RowRecord => {
  const { displayRef, ...own } = patch as { displayRef?: string }
  const ref = parseSessionRef(displayRef ?? 'POD-1-A')!
  return { kind: 'session', id, value: {
    sessionId: id, refRepoId: 'repo', refSeq: ref.seq, refLetter: ref.letter, refDraft: ref.draft,
    title: id, cwd: '/fixture', agentKind: 'codex', status: 'exited', archived: true,
    createdAt: old, lastActiveAt: old, ...own,
  } } as RowRecord
}

const repo = (id = 'repo', prefix: string | undefined = 'POD'): RowRecord =>
  ({ kind: 'worktree', id, value: { prefix } } as unknown as RowRecord)
const lane = (path: string, id = 'repo', prefix: string | undefined = 'POD'): RowRecord =>
  ({ kind: 'worktree', id: path, value: { path, repoId: id, prefix, repoPath: '/fixture', repoName: 'Fixture' } } as RowRecord)
function fixture(rows: RowRecord[]) {
  if (rows.some(row => row.kind === 'session') && !rows.some(row => row.kind === 'worktree')) rows = [repo(), ...rows]
  let source = createColdIndex(SCHEMA, SHELL_SUMMARIES)
  source.apply({ type: 'replace', rows })
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse('2026-10-05') }, undefined, {
    cold: () => source, summaries: SHELL_SUMMARIES, worklist: 'demand', schedule: () => () => {},
    load: () => undefined,
  })
  pool.apply({ type: 'replace', rows })
  return { pool, source: () => source,
    publish(event: RowSourceEvent) { source.apply(event); pool.apply(event) },
    fresh(rows: RowRecord[]) {
      source = createColdIndex(SCHEMA, SHELL_SUMMARIES)
      source.apply({ type: 'replace', rows }); pool.apply({ type: 'replace', rows })
    },
  }
}

it('resolves raw IDs, exact aliases and parsed refs without normalizing bare zero padding', () => {
  const f = fixture([repo(), issue('target'), issue('bare', 7, { repoId: null }),
    issue('POD-1', 9), issue('deleted', 8, { deletedAt: old }),
  ])
  try {
    expect(f.pool.queries.linkedIssueId('target')).toBe('target')
    expect(f.pool.queries.linkedIssueId(' target ')).toBeUndefined()
    expect(f.pool.queries.linkedIssueId('POD-1')).toBe('POD-1')
    expect(f.pool.queries.linkedIssueId(' POD-1 ')).toBe('target')
    expect(f.pool.queries.linkedIssueId('POD-001')).toBe('target')
    expect(f.pool.queries.linkedIssueId('#7')).toBe('bare')
    expect(f.pool.queries.linkedIssueId('#007')).toBeUndefined()
    expect(f.pool.queries.linkedIssueId('POD-8')).toBe('deleted')
  } finally { f.pool.dispose() }
})

it('keeps cold first-ID precedence through resident edits, eviction and same/fresh-index replacement', () => {
  const f = fixture([issue('a', 1, { repoId: null }), issue('z', 1, { repoId: null })])
  let value: string | undefined, runs = 0
  const stop = autorun(() => { runs++; value = f.pool.queries.linkedIssueId('#1') })
  try {
    runInAction(() => f.pool.tables.issue.set('z', issue('z', 1, { repoId: null }).value as never))
    expect(value).toBe('a'); expect(runs).toBe(1)
    runInAction(() => f.pool.tables.issue.set('a', issue('a', 2, { repoId: null }).value as never))
    expect(value).toBe('z')
    expect(f.source().forkIssueIdentities().resolve('#1')).toBe('a')
    runInAction(() => f.pool.tables.issue.delete('a'))
    expect(value).toBe('a')
    f.publish({ type: 'replace', rows: [issue('fresh', 1, { repoId: null })] })
    expect(value).toBe('fresh')
    expect(f.pool.queries.linkedIssueId('a')).toBeUndefined()
    f.fresh([issue('next', 1, { repoId: null })])
    expect(value).toBe('next')
    runInAction(() => f.pool.tables.issue.set('local', issue('local', 4, { repoId: null }).value as never))
    expect(f.pool.queries.linkedIssueId('#4')).toBe('local')
  } finally { stop(); f.pool.dispose() }
})

it('keeps the first optimistic identity in a pool with no prior source publication', () => {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse('2026-10-05') }, undefined, { load: () => undefined, worklist: 'demand', schedule: () => () => {} })
  try {
    runInAction(() => pool.tables.issue.set('first', issue('first', 3, { repoId: null }).value as never))
    expect(pool.queries.linkedIssueId('first')).toBe('first')
    expect(pool.queries.linkedIssueId('#3')).toBe('first')
  } finally { pool.dispose() }
})

it('composes prefix swaps and holder takeover without making a surviving repo prefixless', () => {
  const f = fixture([repo('left', 'POD'), repo('right', 'APP'),
    issue('left-issue', 1, { repoId: 'left' }), issue('right-issue', 1, { repoId: 'right' }),
  ])
  try {
    f.publish({ type: 'update', rows: [repo('left', 'APP'), repo('right', 'POD')] })
    expect(f.pool.queries.linkedIssueId('POD-1')).toBe('right-issue')
    expect(f.pool.queries.linkedIssueId('APP-1')).toBe('left-issue')
    f.publish({ type: 'update', rows: [lane('/a', 'left', 'APP'), lane('/b', 'left', 'APP')] })
    f.publish({ type: 'update', rows: [{ kind: 'worktree', id: '/b', value: undefined }] })
    expect(f.pool.queries.linkedIssueId('APP-1')).toBe('left-issue')
    expect(f.pool.queries.linkedIssueId('#1')).toBeUndefined()
    f.publish({ type: 'update', rows: [{ kind: 'worktree', id: '/a', value: undefined }] })
    expect(f.pool.queries.linkedIssueId('APP-1')).toBeUndefined()
    expect(f.pool.queries.linkedIssueId('#1')).toBe('left-issue')
  } finally { f.pool.dispose() }
})

it('uses maintained session-ref winners across cold collapse/order flips and resident ref edits', () => {
  const resume = { kind: 'codex-thread', value: 'twins' }
  const f = fixture([session('a', { resume }), session('z', { resume, status: 'hibernated', lastActiveAt: '2020-01-02' })])
  let value: string | undefined, runs = 0
  const stop = autorun(() => { runs++; value = f.pool.queries.linkedSessionId('POD-1-A') })
  try {
    expect(value).toBe('z')
    expect(f.pool.queries.linkedSessionId('a')).toBeUndefined()
    expect(f.pool.queries.linkedSessionId(' POD-1-A ')).toBe('z')
    f.publish({ type: 'update', rows: [session('a', { resume, status: 'live' })] })
    expect(value).toBe('a')
    f.publish({ type: 'update', rows: [session('foreign', { displayRef: 'POD-2-A' })] })
    expect(runs).toBe(2)
    runInAction(() => f.pool.tables.session.set('a', session('a', { displayRef: 'POD-3-A' }).value as never))
    expect(f.pool.queries.linkedSessionId('POD-3-A')).toBe('a')
    expect(f.source().forkSessionQuestions(id => f.source().sessionCollapsed(id), id => f.source().sessionOrderKey(id)).referenceId(referenceKey('repo', 'POD-3-A')!)).toBeUndefined()
    runInAction(() => f.pool.tables.session.delete('a'))
    expect(value).toBe('a')
  } finally { stop(); f.pool.dispose() }
})

it('keeps fresh link reads, unrelated publications and nonempty prefix renames flat at 1x/4x', async () => {
  async function measured(scale: 1 | 4) {
    const rows = [repo(), issue('target'), session('target-seat'),
      ...Array.from({ length: 128 * scale }, (_, n) => issue(`foreign-${n}`, n + 2)),
      ...Array.from({ length: 128 * scale }, (_, n) => session(`history-${n}`, { displayRef: `POD-${n + 2}-A` })),
    ]
    const f = fixture(rows), views = shellViews(f.pool)
    const ids = vi.spyOn(f.pool.queries, 'ids'), refs = vi.spyOn(f.pool.sources, 'view')
    const stops: (() => void)[] = []
    let targetRuns = 0
    try {
      const reads = await measureWork(async () => insideReader('first shell link', () => {
        expect(views.linkedIssue('POD-1')).toMatchObject({ id: 'target' })
        expect(views.linkedSession('POD-1-A')).toMatchObject({ sessionId: 'target-seat' })
      }), { pool: f.pool })
      stops.push(autorun(() => { targetRuns++; f.pool.queries.linkedIssueId('POD-1'); f.pool.queries.linkedSessionId('POD-1-A') }))
      for (let n = 0; n < 128 * scale; n++) stops.push(autorun(() => { f.pool.queries.linkedIssueId(`POD-${n + 2}`); f.pool.queries.linkedSessionId(`POD-${n + 2}-A`) }))
      const unrelated = await measureWork(async () => insideReader('unrelated linked publication', () => {
        f.publish({ type: 'update', rows: [issue('foreign-0', 2, { title: 'Renamed' }), session('history-0', { displayRef: 'POD-2-A', lastActiveAt: '2026-10-05' })] })
      }), { pool: f.pool })
      expect(targetRuns).toBe(1)
      // Release data-sized independent ref demand before the rename; renaming
      // a displayed prefix legitimately updates all displayed labels.
      for (const stop of stops.splice(1)) stop()
      const rename = await measureWork(async () => insideReader('linked prefix rename', () => {
        f.publish({ type: 'update', rows: [repo('repo', 'NEW')] })
      }), { pool: f.pool })
      expect(f.pool.queries.linkedIssueId('NEW-1')).toBe('target')
      expect(ids).not.toHaveBeenCalled(); expect(refs.mock.calls.filter(([key]) => key === 'references')).toHaveLength(0)
      return { reads: reads.work, unrelated: unrelated.work, rename: rename.work }
    } finally { for (const stop of stops) stop(); ids.mockRestore(); refs.mockRestore(); f.pool.dispose() }
  }
  const first = await measured(1), second = await measured(4)
  console.info('linked identity work 1x/4x', JSON.stringify({ first, second }))
  for (const action of ['reads', 'unrelated', 'rename'] as const)
    for (const counter of ['rows', 'derivations', 'elements', 'visits'] as const)
      expect(second[action][counter]).toBe(first[action][counter])
})
