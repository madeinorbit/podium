import { describe, expect, it, vi } from 'vitest'
import { createReaderIndex, type ReaderQuestion } from './reader-questions'
import type { RowRecord } from './source'
import type { SliceIssue } from './slice-types'

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
  it('never builds title, gram or sequence-prefix facets, buckets or postings', () => {
    const index = createReaderIndex()
    // Exhaustive so a new reader must join this check. Map keys expose both
    // membership and revision entries; Set.add also catches per-row facets.
    const readers: Record<ReaderQuestion['kind'], ReaderQuestion> = {
      residentIssues: { kind: 'residentIssues' },
      commandIssues: { kind: 'commandIssues' },
      mentionIssues: { kind: 'mentionIssues' },
      issueMentionMatches: { kind: 'issueMentionMatches', query: 'candidate 17', limit: 5, prefixes: { phone: 'POD' } },
      pageIssues: { kind: 'pageIssues' },
      shellIssues: { kind: 'shellIssues' },
      missionIssues: { kind: 'missionIssues' },
      boardCatalog: { kind: 'boardCatalog' },
      boardCounts: { kind: 'boardCounts' },
      proposedIssues: { kind: 'proposedIssues' },
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
      spawnIssues: { kind: 'spawnIssues', repoPath: '/phone', repoId: 'phone' },
      mobileIssueTargets: question('candidate 17'),
      boardIssues: { kind: 'boardIssues', projectPaths: ['/phone'], priority: 2, stage: 'done' },
    }
    const writes = vi.spyOn(Map.prototype, 'set')
    const reads = vi.spyOn(Map.prototype, 'get')
    const facets = vi.spyOn(Set.prototype, 'add')
    const isTitle = ([key]: [unknown, ...unknown[]]) =>
      typeof key === 'string' && key.startsWith('issue:targetTitle:')
    const isText = ([key]: [unknown, ...unknown[]]) =>
      typeof key === 'string' &&
      (key.startsWith('issue:targetGram:') || key.startsWith('issue:targetSequenceStart:'))
    let titleWrites: unknown[] = [], titleReads: unknown[] = []
    let textRevisionWrites: unknown[] = [], textRevisionReads: unknown[] = []
    let textMembershipWrites: [unknown, ...unknown[]][] = []
    let textPostingWrites: [unknown, ...unknown[]][] = []
    let textFacets: unknown[] = []
    let revisionMap: unknown
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
      index.apply({ type: 'update', rows: [issue('b', 19, { repoPath: '/other' })] })
      for (const reader of Object.values(readers)) {
        index.ids(reader)
        index.revision(reader)
      }
      titleWrites = writes.mock.calls.filter(isTitle)
      titleReads = reads.mock.calls.filter(isTitle)
      revisionMap = writes.mock.contexts[
        writes.mock.calls.findIndex(([key]) => key === 'mobileTargets:issue:path:/phone')
      ]
      textRevisionWrites = writes.mock.calls.filter(
        (call) => isText(call) && typeof call[1] === 'number',
      )
      textRevisionReads = reads.mock.calls.filter(
        (call, at) => isText(call) && reads.mock.contexts[at] === revisionMap,
      )
      textMembershipWrites = writes.mock.calls.filter(
        (call) => isText(call) && call[1] instanceof Set,
      )
      textPostingWrites = writes.mock.calls.filter(
        (call) => isText(call) && Array.isArray(call[1]),
      )
      textFacets = facets.mock.calls.filter((call) => isTitle(call) || isText(call))
    } finally {
      writes.mockRestore()
      reads.mockRestore()
      facets.mockRestore()
    }
    expect(titleWrites).toEqual([])
    expect(titleReads).toEqual([])
    expect(revisionMap).toBeInstanceOf(Map)
    expect(textRevisionWrites).toEqual([])
    expect(textRevisionReads).toEqual([])
    expect(textMembershipWrites).toEqual([])
    expect(textPostingWrites).toEqual([])
    expect(textFacets).toEqual([])
  })

  it('preserves the publication clock while text edits invalidate only their target path', () => {
    const index = createReaderIndex()
    const search = question('x')
    const other = { ...search, repoPath: '/other' }
    index.apply({ type: 'replace', rows: [issue('a', 7, { title: 'x' })] })
    const before = index.version
    const otherRevision = index.revision(other)
    const board = { kind: 'boardIssues', projectPaths: ['/phone'] } as const
    const boardRevision = index.revision(board)
    expect(index.ids(search)).toEqual(['a'])
    index.apply({ type: 'update', rows: [issue('a', 7, { title: 'y' })] })
    // The path publication is now the only text change; there are no grams.
    expect(index.version).toBe(before + 1)
    expect(index.revision(search)).toBe(before + 1)
    expect(index.revision(other)).toBe(otherRevision)
    expect(index.revision(board)).toBe(boardRevision)
    expect(index.ids(search)).toEqual([])
    expect(index.ids(question('y'))).toEqual(['a'])

    const renamed = index.version
    index.apply({ type: 'update', rows: [issue('a', 8, { title: 'y' })] })
    expect(index.version).toBe(renamed + 1)
    expect(index.revision(search)).toBe(renamed + 1)
    expect(index.revision(other)).toBe(otherRevision)
    expect(index.ids(question('POD-7'))).toEqual([])
    expect(index.ids(question('POD-8'))).toEqual(['a'])

    const edited = index.version
    index.apply({ type: 'update', rows: [issue('a', 8, { title: 'y' })] })
    expect(index.version).toBe(edited)
  })

  it('invalidates title-only renames with identical distinct grams', () => {
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

  it('scans only the queried path for text, without revisiting publication rows', () => {
    const cells: number[] = []
    for (const scale of [1, 4]) {
      const index = createReaderIndex()
      let reads = 0
      const source = Array.from({ length: 1_200 * scale }, (_, at) =>
        issue(`history-${at}`, at, at === 71 ? { title: 'Unique phone target' } : {}),
      )
      index.apply({
        type: 'replace',
        rows: [...source, ...source.map((row) => issue(`other-${row.id}`, 99_999, { repoPath: '/other' }))]
          .map((row) => ({ ...row, value: new Proxy(row.value!, {
            get(target, key, receiver) {
              reads++
              return Reflect.get(target, key, receiver)
            },
          }) })),
      })
      reads = 0
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
      expect(reads).toBe(0)
      expect(cells.at(-1)).toBe(2 * 1_200 * scale)
    }
    console.info('[source target search visits]', JSON.stringify(cells))
    expect(cells).toEqual([2_400, 9_600])
  })

  it('updates order and matching from effective publications, then evicts every facet', () => {
    const index = createReaderIndex()
    const other = { ...question('renamed'), repoPath: '/other', prefixes: { other: 'OTHER' } }
    index.apply({ type: 'replace', rows: [issue('a', 1), issue('b', 2)] })
    expect(index.repoIds('/phone')).toEqual(['phone'])
    const first = index.revision(question())
    index.apply({ type: 'update', rows: [issue('unrelated', 99, { repoPath: '/other', repoId: 'other' })] })
    expect(index.revision(question())).toBe(first)
    index.apply({ type: 'update', rows: [issue('a', 3, { title: 'Renamed target' })] })
    expect(index.revision(question())).toBeGreaterThan(first)
    expect(index.ids(question())).toEqual(['a', 'b'])
    expect(index.ids(question('renamed'))).toEqual(['a'])
    expect(index.ids(question('candidate 1'))).toEqual([])
    const beforeMove = index.revision(question())
    const otherBeforeMove = index.revision(other)
    index.apply({
      type: 'update',
      rows: [issue('a', 3, { repoPath: '/other', repoId: 'other', title: 'Renamed target' })],
    })
    expect(index.revision(question())).toBeGreaterThan(beforeMove)
    expect(index.revision(other)).toBeGreaterThan(otherBeforeMove)
    expect(index.ids(question('renamed'))).toEqual([])
    expect(index.ids(other)).toEqual(['a'])
    expect(index.ids({ ...other, query: 'OTHER-3' })).toEqual(['a'])
    expect(index.ids(question('POD-3'))).toEqual([])
    const beforeRemove = index.revision(question())
    const otherBeforeRemove = index.revision(other)
    index.apply({ type: 'update', rows: [{ kind: 'issue', id: 'b', value: undefined }] })
    expect(index.revision(question())).toBeGreaterThan(beforeRemove)
    expect(index.revision(other)).toBe(otherBeforeRemove)
    expect(index.ids(question())).toEqual([])
    expect(index.repoIds('/phone')).toEqual([])
    const beforeReplace = index.version
    index.apply({ type: 'replace', rows: [issue('principal-b', 8)] })
    expect(index.revision(question())).toBeGreaterThan(beforeReplace)
    expect(index.revision(other)).toBeGreaterThan(beforeReplace)
    expect(index.ids(question())).toEqual(['principal-b'])
    expect(index.ids(question('renamed'))).toEqual([])
    expect(index.ids(other)).toEqual([])
    expect(index.repoIds('/other')).toEqual([])
    const beforeClear = index.version
    index.apply({ type: 'replace', rows: [] })
    expect(index.version).toBe(beforeClear + 1)
    expect(index.revision(question())).toBe(index.version)
    expect(index.revision(other)).toBe(index.version)
    expect(index.ids(question())).toEqual([])
    expect(index.repoIds()).toEqual([])
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

  it('preserves ordered title, gram and reference matches across prefixes, limits and publications', () => {
    const index = createReaderIndex()
    let rows = Array.from({ length: 640 }, (_, at) => issue(`row-${at}`, at % 173, {
      repoId: ['phone', 'sibling', 'digits', 'missing'][at % 4],
      repoPath: at % 11 === 0 ? '/other' : '/phone',
      title: ['abc---bcd', 'abcd', 'AAAAA', 'Résumé 71', 'Title: a-b', '17 endings', ''] [at % 7],
      deletedAt: at % 19 === 0 ? '2026-10-04' : undefined,
      archived: at % 3 === 0,
    }))
    const queries = [
      '', ' ', 'a', 'ab', 'abc', 'bcd', 'abcd', 'aaaa', 'aaaaa',
      'résumé', 'RÉSUMÉ 71', 'title: a-b', 'endings', '#', '17', '#17',
      'pod', 'POD-17', 'pod 1', 'OD17', 'OTHER17', '3X-1', 'x1', '23', 'no match',
    ]
    const prefixes = { phone: 'POD', sibling: 'OTHER', digits: '23X' }
    const oracle = (search: ReturnType<typeof question>) => {
      const needle = search.query.trim().toLocaleLowerCase()
      const refNeedle = needle.replace(/[^a-z0-9]/g, '')
      const reference = /\d/.test(refNeedle)
      const limit = Math.max(0, Math.trunc(search.limit))
      if (!(limit > 0)) return []
      return rows.map((row) => row.value as SliceIssue)
        .filter((row) => row.repoPath === search.repoPath && !row.deletedAt && row.id !== search.excludeId)
        .sort((a, b) => b.seq - a.seq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .filter((row) => !needle || row.title.toLocaleLowerCase().includes(needle) || (
          reference && `${search.prefixes[row.repoId ?? ''] ?? ''}${row.seq}`
            .toLocaleLowerCase().replace(/[^a-z0-9]/g, '').includes(refNeedle)
        ))
        .slice(0, limit).map((row) => row.id)
    }
    const compare = () => {
      for (const repoPath of ['/phone', '/other'])
        for (const query of queries)
          for (const limit of [0, -1, 1, 14, 70, 1.9, NaN, Infinity]) {
            const search = { ...question(query, limit), repoPath, excludeId: 'row-17', prefixes }
            expect(index.ids(search), `${repoPath} ${query} ${limit}`).toEqual(oracle(search))
          }
    }
    index.apply({ type: 'replace', rows })
    compare()
    const edited = issue('row-17', 9_999, { title: 'AAAAAA', repoId: 'digits' })
    const moved = issue('row-19', 9_998, { title: 'abcd', repoPath: '/other', repoId: 'sibling' })
    rows = rows.filter((row) => !['row-17', 'row-19', 'row-23'].includes(row.id)).concat(edited, moved)
    index.apply({ type: 'update', rows: [edited, moved, { kind: 'issue', id: 'row-23', value: undefined }] })
    compare()
    rows = [issue('principal-switch', 17, { title: 'abcd' })]
    index.apply({ type: 'replace', rows })
    compare()
  })

  it('preserves command roster insertion order for every archive and shell filter', () => {
    const index = createReaderIndex()
    const session = (id: string, extra: object = {}): RowRecord => ({
      kind: 'session', id,
      value: { sessionId: id, issueId: 'owner', agentKind: 'codex', archived: false, ...extra } as RowRecord['value'],
    })
    index.apply({ type: 'replace', rows: [
      session('z'), session('a'), session('shell', { agentKind: 'shell' }),
      session('archived', { archived: true }), session('unrelated', { issueId: 'other' }),
    ] })
    const roster = (archived?: boolean, includeShells?: boolean) =>
      index.ids({ kind: 'commandIssueSessions', issueId: 'owner', archived, includeShells })
    for (const archived of [undefined, true, false])
      for (const includeShells of [undefined, true, false])
        expect(roster(archived, includeShells)).toEqual([
          'z', 'a', ...(includeShells ? ['shell'] : []), ...(archived !== false ? ['archived'] : []),
        ])
    index.apply({ type: 'update', rows: [session('z', { archived: true, agentKind: 'shell' }), session('archived')] })
    expect(roster()).toEqual(['a', 'archived'])
    expect(roster(false, true)).toEqual(['a', 'shell', 'archived'])
    expect(roster(true, true)).toEqual(['z', 'a', 'shell', 'archived'])
    index.apply({ type: 'update', rows: [{ kind: 'session', id: 'a', value: undefined }] })
    expect(roster(false, true)).toEqual(['shell', 'archived'])
    index.apply({ type: 'replace', rows: [session('next-principal')] })
    expect(roster(false, true)).toEqual(['next-principal'])
  })
})
