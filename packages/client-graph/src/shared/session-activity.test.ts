import { describe, expect, it, vi } from 'vitest'
import { createColdIndex } from './cold-index'
import { SCHEMA } from './schema'
import type { SessionActivityQuestion } from './session-activity'
import type { RowRecord } from './source'

const iso = (year: number) => `${year}-01-01T00:00:00Z`
const session = (id: string, cwd: string, at: string, extra: object = {}): RowRecord => ({
  kind: 'session',
  id,
  value: { sessionId: id, cwd, lastActiveAt: at, stoppedAt: iso(2020), status: 'exited', ...extra },
})

function fixture(rows: RowRecord[]) {
  const index = createColdIndex(SCHEMA)
  index.apply({ type: 'replace', rows })
  const expected = (question: SessionActivityQuestion) =>
    Math.max(
      0,
      ...rows.flatMap((record) => {
        const row = record.value as { cwd: string; lastActiveAt: string }
        if ([...(question.excluded ?? [])].includes(record.id)) return []
        if (
          !question.roots.some(
            (root) =>
              row.cwd === root || (question.match !== 'exact' && row.cwd.startsWith(`${root}/`)),
          )
        )
          return []
        return [Date.parse(row.lastActiveAt) || 0]
      }),
    )
  return { index, expected }
}

describe('declared command root activity', () => {
  it('uses a maintained exclusion set without copying all resident identities', () => {
    const f = fixture([
      session('winner', '/repo', iso(2025)),
      session('runner', '/repo', iso(2024)),
    ])
    const excluded = new Set(['winner'])
    const iterate = vi.spyOn(excluded, Symbol.iterator)
    const question: SessionActivityQuestion = {
      kind: 'commandRootActivity',
      roots: ['/repo'],
      excluded,
    }
    try {
      expect(f.index.readerActivity(question)).toBe(Date.parse(iso(2024)))
      excluded.add('runner')
      expect(f.index.readerActivity(question)).toBe(0)
      expect(iterate).not.toHaveBeenCalled()
    } finally {
      iterate.mockRestore()
    }
  })

  it.each([
    1, 4,
  ])('matches the old maximum with %ix history, path boundaries and resident exclusions', (scale) => {
    const rows = [
      session('root', '/repo', iso(2022)),
      session('nested', '/repo/child', iso(2025)),
      session('similar', '/repository', iso(2028)),
      session('slash', '/repo/', iso(2023)),
      session('double', '/repo//child', iso(2024)),
      session('empty', '', iso(2026)),
      session('relative', 'relative/path', iso(2027)),
      session('invalid', '/repo/invalid', 'invalid'),
      session('negative', '/repo/negative', iso(1960)),
      ...Array.from({ length: 256 * scale }, (_, n) =>
        session(`noise-${n}`, `/elsewhere/${n}`, iso(2020)),
      ),
    ]
    const f = fixture(rows)
    for (const roots of [
      ['/repo'],
      ['/repo/'],
      ['/'],
      [''],
      ['relative'],
      ['/missing'],
      ['/repo', '/repository'],
      [],
    ])
      for (const match of ['within', 'exact'] as const)
        for (const excluded of [[], ['nested'], ['nested', 'double', 'slash']]) {
          const question: SessionActivityQuestion = {
            kind: 'commandRootActivity',
            roots,
            match,
            excluded,
          }
          const before = f.index.readerActivityVisits
          expect(f.index.readerActivity(question)).toBe(f.expected(question))
          expect(f.index.readerActivityVisits - before).toBeLessThanOrEqual(
            roots.length * (excluded.length + 1),
          )
        }
    const question: SessionActivityQuestion = { kind: 'commandRootActivity', roots: ['/repo'] }
    expect(f.expected(question)).toBeGreaterThan(0)
    const fault = vi.spyOn(f.index, 'readerActivity').mockReturnValue(0)
    expect(f.index.readerActivity(question)).not.toBe(f.expected(question))
    fault.mockRestore()
  })

  it('updates only the filed roots, removes a moved maximum and replaces the source', () => {
    const original = session('winner', '/repo/child', iso(2025)),
      runner = session('runner', '/repo', iso(2024))
    const f = fixture([original, runner])
    const question: SessionActivityQuestion = { kind: 'commandRootActivity', roots: ['/repo'] }
    const revision = f.index.readerActivityRevision(question)
    f.index.apply({ type: 'update', rows: [session('elsewhere', '/other', iso(2030))] })
    expect(f.index.readerActivityRevision(question)).toBe(revision)
    f.index.apply({
      type: 'update',
      rows: [{ ...original, value: { ...original.value, title: 'renamed' } } as RowRecord],
    })
    expect(f.index.readerActivityRevision(question)).toBe(revision)
    f.index.apply({ type: 'update', rows: [session('winner', '/other', iso(2026))] })
    expect(f.index.readerActivity(question)).toBe(Date.parse(iso(2024)))
    expect(f.index.readerActivityRevision(question)).toBeGreaterThan(revision)
    f.index.apply({ type: 'update', rows: [{ kind: 'session', id: 'runner', value: undefined }] })
    expect(f.index.readerActivity(question)).toBe(0)
    f.index.apply({ type: 'replace', rows: [session('replacement', '/repo', iso(2027))] })
    expect(f.index.readerActivity(question)).toBe(Date.parse(iso(2027)))
    expect(f.index.readerActivity({ ...question, roots: ['/other'] })).toBe(0)
  })

  it('removes parked losers and restores their filed roots when the winner disappears', () => {
    const resume = { kind: 'codex-thread', value: 'activity-twins' }
    const old = session('old', '/repo/old', iso(2030), {
      resume,
      issueId: 'selected',
      agentKind: 'codex',
    })
    const winner = session('winner', '/repo/winner', iso(2021), {
      resume,
      issueId: 'selected',
      status: 'hibernated',
      agentKind: 'codex',
    })
    const f = fixture([old, winner])
    const question: SessionActivityQuestion = { kind: 'commandRootActivity', roots: ['/repo/old'] }
    expect(f.index.sessionCollapsed('old')).toBe(true)
    expect(f.index.readerActivity(question)).toBe(0)
    expect(f.index.readerIds({ kind: 'commandIssueSessions', issueId: 'selected' })).toEqual([
      'old',
      'winner',
    ])
    f.index.apply({ type: 'update', rows: [{ kind: 'session', id: 'winner', value: undefined }] })
    expect(f.index.sessionCollapsed('old')).toBe(false)
    expect(f.index.readerActivity(question)).toBe(Date.parse(iso(2030)))
    expect(f.index.readerActivity({ ...question, roots: ['/repo/winner'] })).toBe(0)
    f.index.apply({
      type: 'update',
      rows: [session('shell', '/repo', iso(2020), { issueId: 'selected', agentKind: 'shell' })],
    })
    expect(f.index.readerIds({ kind: 'commandIssueSessions', issueId: 'selected' })).toEqual([
      'old',
    ])
  })
})
