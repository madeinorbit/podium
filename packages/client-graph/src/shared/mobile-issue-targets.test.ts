import { describe, expect, it } from 'vitest'
import { createReaderIndex, type ReaderQuestion } from './reader-questions'
import type { RowRecord } from './source'

const question = (
  query = '',
  limit = 14,
): Extract<ReaderQuestion, { kind: 'mobileIssueTargets' }> => ({
  kind: 'mobileIssueTargets',
  repoPath: '/phone',
  excludeId: 'owner',
  query,
  limit,
  prefixes: { phone: 'POD' },
})
const issue = (id: string, seq: number, extra: object = {}): RowRecord => ({
  kind: 'issue',
  id,
  value: {
    id,
    seq,
    repoPath: '/phone',
    repoId: 'phone',
    displayRef: `POD-${seq}`,
    title: `Candidate ${seq}`,
    stage: 'done',
    archived: true,
    ...extra,
  } as RowRecord['value'],
})

describe('mobile target identity question', () => {
  it('visits only the requested ordered window at 1x and 4x', () => {
    const cells: { scale: number; visits: number; neighbours: number }[] = []
    for (const scale of [1, 4]) {
      const index = createReaderIndex()
      index.apply({
        type: 'replace',
        rows: [
          ...Array.from({ length: 1_200 * scale }, (_, at) => issue(`history-${at}`, at)),
          issue('owner', 99_999),
          issue('deleted', 99_998, { deletedAt: '2026-10-03' }),
          issue('other-repo', 99_997, { repoPath: '/other' }),
        ],
      })
      const before = index.targetCounts.visits
      const ids = index.ids(question())
      expect(ids).toEqual(
        Array.from({ length: 14 }, (_, at) => `history-${1_200 * scale - 1 - at}`),
      )
      cells.push({ scale, visits: index.targetCounts.visits - before, neighbours: ids.length })
    }
    console.info('[source target window visits]', JSON.stringify(cells))
    expect(cells[1]!.visits).toBeLessThanOrEqual(
      (cells[0]!.visits * cells[1]!.neighbours) / cells[0]!.neighbours,
    )
  })

  it('preserves safe title/ref substring matching, case and whitespace', () => {
    const index = createReaderIndex()
    index.apply({
      type: 'replace',
      rows: [
        issue('title', 417),
        issue('ref', 599),
        issue('display-fallback', 71, { displayRef: undefined, title: 'Fallback' }),
        issue('both', 700, { title: 'Candidate 700', displayRef: 'Candidate-700' }),
        issue('false-gram-match', 701, { title: 'abc---bcd' }),
      ],
    })
    expect(index.ids(question('  CANDIDATE 417  '))).toEqual(['title'])
    expect(index.ids(question('#599'))).toEqual(['ref'])
    expect(index.ids(question('pod 417'))).toEqual(['title'])
    expect(index.ids(question('#71'))).toEqual(['display-fallback'])
    expect(index.ids(question('candidate 700'))).toEqual(['both'])
    expect(index.ids(question('abcd'))).toEqual([])
    expect(index.ids(question('pod'))).toEqual([])
  })

  it('does not visit the whole catalog for a cold, specific title or reference', () => {
    const cells: number[] = []
    for (const scale of [1, 4]) {
      const index = createReaderIndex()
      index.apply({
        type: 'replace',
        rows: Array.from({ length: 1_200 * scale }, (_, at) =>
          issue(`history-${at}`, at, at === 71 ? { title: 'Unique phone target' } : {}),
        ),
      })
      const before = index.targetCounts.visits
      expect(index.ids(question('unique phone target'))).toEqual(['history-71'])
      expect(index.ids(question('pod 71'))).toEqual([
        'history-719',
        'history-718',
        'history-717',
        'history-716',
        'history-715',
        'history-714',
        'history-713',
        'history-712',
        'history-711',
        'history-710',
        'history-71',
      ])
      cells.push(index.targetCounts.visits - before)
    }
    console.info('[source target search visits]', JSON.stringify(cells))
    expect(cells[1]).toBeLessThanOrEqual(cells[0]!)
  })

  it('updates order and matching from effective publications, then evicts every facet', () => {
    const index = createReaderIndex()
    index.apply({ type: 'replace', rows: [issue('a', 1), issue('b', 2)] })
    expect(index.repoIds('/phone')).toEqual(['phone'])
    const first = index.revision(question())
    index.apply({ type: 'update', rows: [issue('a', 3, { title: 'Renamed target' })] })
    expect(index.revision(question())).toBeGreaterThan(first)
    expect(index.ids(question())).toEqual(['a', 'b'])
    expect(index.ids(question('renamed'))).toEqual(['a'])
    expect(index.ids(question('candidate 1'))).toEqual([])
    index.apply({
      type: 'update',
      rows: [issue('a', 3, { repoPath: '/other', title: 'Renamed target' })],
    })
    expect(index.ids(question('renamed'))).toEqual([])
    index.apply({ type: 'update', rows: [{ kind: 'issue', id: 'b', value: undefined }] })
    expect(index.ids(question())).toEqual([])
    expect(index.repoIds('/phone')).toEqual([])
    index.apply({ type: 'replace', rows: [issue('principal-b', 8)] })
    expect(index.ids(question())).toEqual(['principal-b'])
    expect(index.ids(question('renamed'))).toEqual([])
  })

  it('uses the same joined prefix as visible rows, including two repositories at one path', () => {
    const index = createReaderIndex()
    index.apply({
      type: 'replace',
      rows: [
        issue('phone', 17, { displayRef: undefined }),
        issue('sibling', 17, { repoId: 'sibling', displayRef: undefined }),
        issue('deleted-repo', 18, { repoId: 'deleted-repo', deletedAt: '2026-10-03' }),
      ],
    })
    expect(index.repoIds('/phone')).toEqual(['phone', 'sibling'])
    expect(
      index.ids({ ...question('pod 17'), prefixes: { phone: 'POD', sibling: 'OTHER' } }),
    ).toEqual(['phone'])
    expect(
      index.ids({ ...question('other 17'), prefixes: { phone: 'POD', sibling: 'OTHER' } }),
    ).toEqual(['sibling'])
    expect(index.ids({ ...question('#17'), prefixes: {} })).toEqual(['phone', 'sibling'])
  })
})
