import { describe, expect, it, vi } from 'vitest'
import { ISSUE_BOARD_SUMMARIES } from '../issue-board-schema'
import { createIssueBoardSource } from '../issue-board-source'
import { MobxPool } from '../pool'
import type { RowRecord } from './source'
import {
  createReaderIndex,
  matchIssueTitleRef,
  normalizeIssueRef,
} from './reader-questions'

const now = Date.parse('2026-10-03T12:00:00Z')
const old = '2026-01-01T00:00:00Z'

describe('matchIssueTitleRef (one shared predicate, POD-5561)', () => {
  it('matches title substring and ref, with ref gated on a digit', () => {
    // Callers pass an already-lowercased needle (one lowercase per keystroke,
    // never per issue); case-insensitivity is proven at the feed level below.
    expect(matchIssueTitleRef('login bug', 'pod1234', 'login', 'login')).toBe(true)
    expect(matchIssueTitleRef('login bug', 'pod1234', 'pod-1234', 'pod1234')).toBe(true)
    expect(matchIssueTitleRef('login bug', 'pod1234', 'pod1234', 'pod1234')).toBe(true)
    expect(matchIssueTitleRef('login bug', 'pod1234', '1234', '1234')).toBe(true)
    expect(matchIssueTitleRef('login bug', 'pod1234', 'pod', 'pod')).toBe(false)
    expect(matchIssueTitleRef('abc---bcd', 'pod701', 'abcd', 'abcd')).toBe(false)
    expect(matchIssueTitleRef('anything', 'pod7', '', '')).toBe(true)
  })
  it('never reads descriptions', () => {
    expect(normalizeIssueRef('POD-1234')).toBe('pod1234')
    // Description-only tokens must not match even when present on the row;
    // the predicate takes title + ref only, so there is no slot for a body.
    expect(matchIssueTitleRef('login bug', 'pod1234', 'searchable body', 'searchablebody')).toBe(
      false,
    )
  })
})

const feedIssue = (id: string, seq: number, extra: object = {}): RowRecord => ({
  kind: 'issue',
  id,
  value: {
    id,
    seq,
    repoPath: '/phone',
    repoId: 'phone',
    title: `Candidate ${seq}`,
    stage: 'in_progress',
    createdAt: old,
    updatedAt: old,
    archived: false,
    ...extra,
  } as RowRecord['value'],
})

describe('feed local text id set (targetDetails, no facts, no descriptions)', () => {
  it('returns title/ref parity on the seed corpus and ignores bodies', () => {
    const index = createReaderIndex()
    const rows = Array.from({ length: 640 }, (_, at) =>
      feedIssue(`row-${at}`, at % 173, {
        title: ['Alpha login', 'Beta dark mode', 'Gamma sync', 'Delta minimap'][at % 4],
        // Every body carries a unique token that must never match locally.
        description: `body-token-${at}`,
      }),
    )
    index.apply({
      type: 'replace',
      rows: [
        { kind: 'repo', id: 'phone', value: { repoPath: '/phone', prefix: 'POD' } } as RowRecord,
        ...rows,
      ],
    })
    const oracle = (query: string) => {
      const needle = query.trim().toLocaleLowerCase()
      const refNeedle = normalizeIssueRef(needle)
      return rows
        .map((row) => row.value as { id: string; title: string; seq: number })
        .filter(
          (row) =>
            !needle ||
            row.title.toLocaleLowerCase().includes(needle) ||
            (/\d/.test(refNeedle) && normalizeIssueRef(`POD${row.seq}`).includes(refNeedle)),
        )
        .map((row) => row.id)
        .sort()
    }
    for (const query of ['', 'login', 'DARK', 'pod-17', '17', 'pod', 'minimap', 'no match']) {
      expect([...index.localTextIds(query)].sort(), query).toEqual(oracle(query))
    }
    // Description-only tokens never match locally (server FTS is POD-5617).
    expect(index.localTextIds('body-token-7').size).toBe(0)
    expect(index.localTextIds('body-token').size).toBe(0)
  })

  it('scans the short strings once, with no row reads, flat at 1x/4x', () => {
    const cells: { scale: number; visits: number; size: number }[] = []
    for (const scale of [1, 4]) {
      const index = createReaderIndex()
      let reads = 0
      const source = Array.from({ length: 1_200 * scale }, (_, at) =>
        feedIssue(`history-${at}`, at, at === 71 ? { title: 'Unique phone target' } : {}),
      )
      index.apply({
        type: 'replace',
        rows: [
          { kind: 'repo', id: 'phone', value: { repoPath: '/phone', prefix: 'POD' } } as RowRecord,
          ...source.map((row) => ({
            ...row,
            value: new Proxy(row.value!, {
              get(target, key, receiver) {
                reads++
                return Reflect.get(target, key, receiver)
              },
            }),
          })),
        ],
      })
      reads = 0
      const before = index.targetCounts.visits
      // One pass over every short string: the whole feed, not per-issue grams.
      const ids = index.localTextIds('unique phone target')
      expect([...ids]).toEqual(['history-71'])
      expect(reads).toBe(0)
      const visits = index.targetCounts.visits - before
      cells.push({ scale, visits, size: 1_200 * scale })
    }
    expect(cells[0]!.visits).toBe(cells[0]!.size)
    expect(cells[1]!.visits).toBe(cells[1]!.size)
    expect(cells[1]!.visits).toBe(cells[0]!.visits * 4)
  })
})

const boardRow = (id: string, overrides: object = {}) => ({
  id,
  seq: Number(id.replace(/\D/g, '')) || 1,
  title: id,
  description: { value: `body-token-${id}` },
  stage: 'in_progress',
  createdAt: old,
  updatedAt: old,
  priority: 2,
  type: 'task',
  labels: [],
  audience: 'human' as const,
  repoPath: '/fixture',
  repoId: 'fixture-repo',
  deps: [],
  ...overrides,
})

function setupBoard(rows: ReturnType<typeof boardRow>[]) {
  const load = vi.fn((_entity: string, id: string) => rows.find((row) => row.id === id))
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: now }, undefined, {
    load,
    summaries: ISSUE_BOARD_SUMMARIES,
    schedule: () => () => {},
  })
  pool.apply({
    type: 'replace',
    rows: [
      {
        kind: 'repo' as const,
        id: 'fixture-repo',
        value: { id: 'fixture-repo', repoPath: '/fixture', prefix: 'POD' },
      },
      ...rows.map((value) => ({ kind: 'issue' as const, id: value.id, value })),
    ],
  })
  const source = createIssueBoardSource(pool)
  return { pool, source, load, stop: () => { source.dispose(); pool.dispose() } }
}

describe('board/explorer cheap local search (POD-5561)', () => {
  it('matches title/ref parity and never searches descriptions', () => {
    const rows = [
      boardRow('alpha', { title: 'Login bug', seq: 1234 }),
      boardRow('beta', { title: 'Dark mode', seq: 7 }),
      boardRow('body-only', { title: 'Unrelated title', seq: 999 }),
    ]
    const f = setupBoard(rows)
    try {
      // Title + ref parity.
      expect(f.source.queryIds({ kind: 'board', filter: { text: 'login' } })).toEqual({
        ids: ['alpha'],
      })
      expect(f.source.queryIds({ kind: 'board', filter: { text: 'POD-1234' } })).toEqual({
        ids: ['alpha'],
      })
      expect(f.source.queryIds({ kind: 'board', filter: { text: '1234' } })).toEqual({
        ids: ['alpha'],
      })
      expect(f.source.queryIds({ kind: 'explorer', tab: 'in_progress', query: 'dark' })).toEqual({
        ids: ['beta'],
      })
      // Description-only tokens never match locally.
      expect(f.source.queryIds({ kind: 'board', filter: { text: 'body-token-beta' } })).toEqual({
        ids: [],
      })
      expect(
        f.source.queryIds({ kind: 'explorer', tab: 'in_progress', query: 'body-token-alpha' }),
      ).toEqual({ ids: [] })
    } finally {
      f.stop()
    }
  })

  it('planted red: a text keystroke visits only text-matching cold rows', async () => {
    const { issueBoardStats } = await import('@podium/client-core/perf')
    const rows = [
      boardRow('match', { title: 'Unique target title', seq: 1 }),
      ...Array.from({ length: 400 }, (_, at) =>
        boardRow(`history-${at}`, {
          seq: 1000 + at,
          archived: true,
          stage: 'done',
        }),
      ),
    ]
    const f = setupBoard(rows)
    issueBoardStats.enable()
    issueBoardStats.reset()
    try {
      const result = f.source.queryIds({
        kind: 'board',
        filter: { text: 'unique target title', archived: true },
      })
      expect(result).toEqual({ ids: ['match'] })
      // The removed loop visited every not-loaded facet id per keystroke
      // (fresh facts + lowercase title+description). The shared pass joins
      // cold only through the text id set, so cold visits stay bounded by
      // matches, not the corpus. Re-adding the uncached loop makes this 400.
      expect(issueBoardStats.read().coldSummaryVisits ?? 0).toBeLessThanOrEqual(1)
    } finally {
      issueBoardStats.disable()
      f.stop()
    }
  })

  it('keeps per-keystroke work to one shared pass (board calls it once)', () => {
    const rows = Array.from({ length: 600 }, (_, at) =>
      boardRow(`history-${at}`, { seq: at, title: at === 71 ? 'Unique board target' : `Task ${at}` }),
    )
    const f = setupBoard(rows)
    try {
      const spy = vi.spyOn(f.pool.queries, 'localTextIds')
      const result = f.source.queryIds({ kind: 'board', filter: { text: 'unique board target' } })
      expect(result).toEqual({ ids: ['history-71'] })
      // One shared pass per keystroke, not one pass per facet/bucket/cold.
      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy).toHaveBeenCalledWith('unique board target')
      spy.mockRestore()
    } finally {
      f.stop()
    }
  })
})
