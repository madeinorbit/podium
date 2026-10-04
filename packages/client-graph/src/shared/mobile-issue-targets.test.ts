import { describe, expect, it, vi } from 'vitest'
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
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    archived: true,
    ...extra,
  } as RowRecord['value'],
})

describe('mobile target identity question', () => {
  it('never stores or reads full-title membership or revision entries', () => {
    const index = createReaderIndex()
    // Exhaustive so a new reader must join this check. Map keys expose both
    // membership and revision entries; filed retains titles inside Set values.
    const readers: Record<ReaderQuestion['kind'], ReaderQuestion> = {
      residentIssues: { kind: 'residentIssues' },
      commandIssues: { kind: 'commandIssues' },
      mentionIssues: { kind: 'mentionIssues' },
      pageIssues: { kind: 'pageIssues' },
      shellIssues: { kind: 'shellIssues' },
      missionIssues: { kind: 'missionIssues' },
      boardCatalog: { kind: 'boardCatalog' },
      boardCounts: { kind: 'boardCounts' },
      proposedIssues: { kind: 'proposedIssues' },
      reclaimIssues: { kind: 'reclaimIssues' },
      commandSessions: { kind: 'commandSessions' },
      inboxSessions: { kind: 'inboxSessions' },
      setupSessions: { kind: 'setupSessions' },
      referenceSessions: { kind: 'referenceSessions' },
      explorerSessions: { kind: 'explorerSessions' },
      shellSessions: { kind: 'shellSessions' },
      headerSessions: { kind: 'headerSessions' },
      headerOccupancy: { kind: 'headerOccupancy' },
      headerRecentSession: { kind: 'headerRecentSession' },
      sessionReference: { kind: 'sessionReference', ref: 'POD-17-A' },
      commandIssueSessions: { kind: 'commandIssueSessions', issueId: 'a' },
      containingIssues: { kind: 'containingIssues', cwd: '/phone/worktree' },
      mobileIssueTargets: question('candidate 17'),
      boardIssues: { kind: 'boardIssues', projectPaths: ['/phone'], priority: 2, stage: 'done' },
    }
    const writes = vi.spyOn(Map.prototype, 'set')
    const reads = vi.spyOn(Map.prototype, 'get')
    const isTitle = ([key]: [unknown, ...unknown[]]) =>
      typeof key === 'string' && key.startsWith('issue:targetTitle:')
    let titleWrites: unknown[] = [], titleReads: unknown[] = []
    try {
      index.apply({ type: 'replace', rows: [issue('a', 17)] })
      for (const reader of Object.values(readers)) {
        index.ids(reader)
        index.revision(reader)
      }
      index.apply({ type: 'update', rows: [issue('a', 17, { title: 'Renamed target' })] })
      index.ids(question('renamed target'))
      index.apply({ type: 'update', rows: [{ kind: 'issue', id: 'a', value: undefined }] })
      index.apply({ type: 'replace', rows: [issue('b', 18)] })
      titleWrites = writes.mock.calls.filter(isTitle)
      titleReads = reads.mock.calls.filter(isTitle)
    } finally {
      writes.mockRestore()
      reads.mockRestore()
    }
    expect(titleWrites).toEqual([])
    expect(titleReads).toEqual([])
  })

  it('invalidates title-only renames even when every gram posting stays the same', () => {
    const index = createReaderIndex()
    const search = question('aaaaa')
    index.apply({ type: 'replace', rows: [issue('a', 17, { title: 'aaaa' })] })
    const before = index.revision(search)
    expect(index.ids(search)).toEqual([])
    index.apply({ type: 'update', rows: [issue('a', 17, { title: 'aaaaa' })] })
    expect(index.revision(search)).toBeGreaterThan(before)
    expect(index.ids(search)).toEqual(['a'])
    const renamed = index.revision(search)
    index.apply({ type: 'update', rows: [issue('a', 17, { title: 'aaaaa' })] })
    expect(index.revision(search)).toBe(renamed)
    index.apply({ type: 'update', rows: [issue('a', 17, { title: 'aaaa' })] })
    expect(index.revision(search)).toBeGreaterThan(renamed)
    expect(index.ids(search)).toEqual([])
    expect(index.ids(question('POD-17'))).toEqual(['a'])
    index.apply({
      type: 'update',
      rows: [issue('a', 17, { title: 'aaaaa', deletedAt: '2026-10-04' })],
    })
    expect(index.ids(search)).toEqual([])
    expect(index.ids(question('POD-17'))).toEqual([])
    index.apply({ type: 'update', rows: [issue('a', 17, { title: 'aaaaa' })] })
    expect(index.ids(search)).toEqual(['a'])
    index.apply({ type: 'replace', rows: [issue('b', 18, { title: 'aaaaa' })] })
    expect(index.ids(search)).toEqual(['b'])
    expect(index.ids(question('POD-17'))).toEqual([])
  })

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
    index.apply({ type: 'update', rows: [issue('unrelated', 99, { repoPath: '/other' })] })
    expect(index.revision(question())).toBe(first)
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
