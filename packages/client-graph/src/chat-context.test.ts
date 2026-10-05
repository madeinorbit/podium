import { afterEach, expect, it, vi } from 'vitest'
import { chatContextReadStats, createChatContextReader, chatMentionMatches } from './chat-context'
import { CHAT_CONTEXT_SUMMARIES } from './chat-context-schema'
import { MobxPool } from './pool'
import { LOADING } from './worklist/rollup'

const pools: MobxPool[] = []
afterEach(() => {
  for (const pool of pools.splice(0)) pool.dispose()
  vi.restoreAllMocks()
})

function fixture() {
  const issues = ['first', 'second', 'deleted'].map((id, index) => ({
    id, seq: index + 1, title: 'Matching task', repoId: 'repo', repoPath: '/synthetic',
    stage: 'done', archived: true, deletedAt: id === 'deleted' ? '2020-01-01T00:00:00Z' : undefined,
    closedAt: '2020-01-01T00:00:00Z', createdAt: '2020-01-01T00:00:00Z', updatedAt: '2020-01-01T00:00:00Z',
  }))
  const sessions = ['first-session', 'second-session'].map((sessionId, index) => ({
    sessionId, issueId: issues[index]!.id, cwd: '/synthetic', title: sessionId,
    agentKind: 'codex', status: 'exited', archived: true, headless: false,
    lastActiveAt: '2020-01-01T00:00:00Z', stoppedAt: '2020-01-01T00:00:00Z',
  }))
  const load = vi.fn((entity: string, id: string) => entity === 'issue'
    ? issues.find(row => row.id === id) : sessions.find(row => row.sessionId === id))
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse('2026-10-03T00:00:00Z') }, undefined, {
    load, summaries: CHAT_CONTEXT_SUMMARIES, schedule: () => () => {},
  })
  pools.push(pool)
  pool.apply({ type: 'replace', rows: [
    { kind: 'worktree', id: '/synthetic', value: {
      path: '/synthetic', repoId: 'repo', repoPath: '/synthetic', repoName: 'Synthetic', prefix: 'POD',
    } },
    ...issues.map(value => ({ kind: 'issue' as const, id: value.id, value })),
    ...sessions.map(value => ({ kind: 'session' as const, id: value.sessionId, value })),
  ] })
  pool.sources.register(['chatIssueOrder', 'chatSessionOrder'], {
    read: entity => ({ ids: entity === 'chatIssueOrder'
      ? ['second', 'first', 'deleted'] : ['second-session', 'first-session'] }),
    dispose() {},
  })
  return { pool, load }
}

it('constructs no mention candidates until demand, then preserves candidates and replica order using fields only', () => {
  const { pool, load } = fixture()
  const row = vi.spyOn(pool, 'row'), summary = vi.spyOn(pool.residency!, 'summary')
  const reader = createChatContextReader(pool)
  pool.sources.register(['chatContextReader'], { read: () => reader, dispose() {} })
  expect(row).not.toHaveBeenCalled()
  expect(chatContextReadStats(pool)).toEqual({
    mentionBuilds: 0, mentionIssueReads: 0, referenceBuilds: 0, referenceSessionReads: 0,
  })
  const mentions = reader.mentions()
  expect(mentions.pending).toBe(0)
  expect(mentions.issues.map(({ id, seq, title, archived, displayRef }) => ({ id, seq, title, archived, displayRef }))).toEqual([
    { id: 'second', seq: 2, title: 'Matching task', archived: true, displayRef: 'POD-2' },
    { id: 'first', seq: 1, title: 'Matching task', archived: true, displayRef: 'POD-1' },
  ])
  expect(reader.sessions()).toMatchObject({ pending: 0, sessions: [
    { sessionId: 'second-session' }, { sessionId: 'first-session' },
  ] })
  expect(chatContextReadStats(pool)).toMatchObject({
    mentionBuilds: 1, mentionIssueReads: 3, referenceBuilds: 1, referenceSessionReads: 2,
  })
  expect(summary.mock.calls.length).toBeGreaterThan(0)
  expect(summary.mock.calls.every(([, , decorate]) => decorate === false)).toBe(true)
  expect(row.mock.calls.filter(([entity]) => entity === 'issue' || entity === 'session')
    .every(([, , purpose]) => purpose === 'summary-fields')).toBe(true)
  expect(pool.tables.issue.size).toBe(0)
  expect(pool.tables.session.size).toBe(0)
  expect(pool.hydrate()).toBe(0)
  expect(load).not.toHaveBeenCalled()
})

it('keeps a known missing mention summary pending and coalesces its batched load', () => {
  const { pool, load } = fixture()
  const reader = createChatContextReader(pool)
  const summary = pool.residency!.summary.bind(pool.residency!)
  vi.spyOn(pool.residency!, 'summary').mockImplementation((entity, id, decorate) =>
    entity === 'issue' && id === 'first' ? undefined : summary(entity, id, decorate))
  expect(reader.issue('first')).toBe(LOADING)
  expect(reader.mentions()).toMatchObject({ pending: 1, issues: [{ id: 'second' }] })
  expect(reader.mentions().pending).toBe(1)
  expect(load).not.toHaveBeenCalled()
  expect(pool.hydrate()).toBe(1)
  expect(load).toHaveBeenCalledTimes(1)
  expect(reader.mentions()).toMatchObject({ pending: 0, issues: [{ id: 'second' }, { id: 'first' }] })
})


it('reads at most five source-ranked mention summaries on first/repeated 1x/4x histories, with no order catalog', () => {
  const work: number[] = []
  for (const size of [64, 256]) {
    const stamp = '2026-10-05T00:00:00Z', pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) })
    pools.push(pool)
    pool.apply({ type: 'replace', rows: Array.from({ length: size + 8 }, (_, i) => ({ kind: 'issue' as const, id: `issue-${i}`,
      value: { id: `issue-${i}`, seq: i, stage: 'in_progress', title: i < 8 ? 'Unique result' : 'Unrelated issue', repoPath: '/synthetic',
        createdAt: stamp, updatedAt: i < 8 ? stamp : '2020-01-01T00:00:00Z' },
    })) })
    const rows = vi.spyOn(pool, 'row')
    for (let n = 0; n < 2; n++) {
      rows.mockClear()
      const result = chatMentionMatches(pool, 'unique')
      expect(result.pending).toBe(0)
      expect(result.issues.map(issue => issue.seq)).toEqual([7, 6, 5, 4, 3])
      expect(rows.mock.calls.some(([kind]) => kind === 'chatIssueOrder')).toBe(false)
      const summaries = rows.mock.calls.filter(([kind]) => kind === 'issue')
      expect(summaries).toHaveLength(5)
      expect(summaries.every(([, , purpose]) => purpose === 'summary-fields')).toBe(true)
      work.push(summaries.length)
    }
  }
  expect(work).toEqual([5, 5, 5, 5])
  console.info('POD-5569 mention summary reads [1x first,repeat;4x first,repeat]', work)
})
