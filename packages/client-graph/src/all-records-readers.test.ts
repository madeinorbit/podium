/**
 * POD-7088 acceptance 1: no reader enumerates all records of a kind.
 *
 * The device holds the policy's collections, not history (design POD-7059),
 * so a question answered by "every issue" or "every session" on the device
 * is a smaller number in disguise. Two checks hold that:
 *
 *  1. Which question kinds ARE all-records questions is asked of the real
 *     reader index, not written down by hand: a kind whose answer is every
 *     row of its entity, over rows that differ in every field a bucket
 *     reads, enumerates all records. That set must equal `ALL_RECORDS`
 *     below, so a new all-records kind fails here until it is named.
 *  2. No production file asks an all-records kind except the ones in
 *     `ALLOWED`, each with the issue that moves it. The table only shrinks.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createReaderIndex, type ReaderQuestion } from './shared/reader-questions'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))

/** Every question kind, one instance each (the type makes the list complete). */
const QUESTIONS: Record<ReaderQuestion['kind'], ReaderQuestion> = {
  residentIssues: { kind: 'residentIssues' },
  commandIssues: { kind: 'commandIssues' },
  mentionIssues: { kind: 'mentionIssues' },
  issueMentionMatches: { kind: 'issueMentionMatches', query: 'zzz', limit: 5, prefixes: {} },
  pageIssues: { kind: 'pageIssues' },
  proposedIssues: { kind: 'proposedIssues' },
  commandSessions: { kind: 'commandSessions' },
  referenceSessions: { kind: 'referenceSessions' },
  headerSessions: { kind: 'headerSessions' },
  headerOccupancy: { kind: 'headerOccupancy' },
  pausedSessions: { kind: 'pausedSessions' },
  headerRecentSession: { kind: 'headerRecentSession', excluded: ['s0', 's1', 's2'] },
  sessionReference: { kind: 'sessionReference', ref: 'NONE-1-A' },
  commandIssueSessions: { kind: 'commandIssueSessions', issueId: 'nope' },
  containingIssues: { kind: 'containingIssues', cwd: '/nowhere' },
  spawnIssues: { kind: 'spawnIssues', repoPath: '/nowhere', repoId: 'nope' },
  mobileIssueTargets: {
    kind: 'mobileIssueTargets',
    repoPath: '/nowhere',
    excludeId: '',
    query: '',
    limit: 10,
    prefixes: {},
  },
  boardIssues: { kind: 'boardIssues', priority: 4, stage: 'shipping' },
}

/** The kinds whose answer is every record of the entity on the device. */
const ALL_RECORDS = [
  'commandIssues',
  'commandSessions',
  'mentionIssues',
  'pageIssues',
  'referenceSessions',
].sort()

/**
 * Production files that still ask an all-records kind, and the issue that
 * moves each. Search surfaces belong to POD-7089 (design "Search and
 * references"); the web issue pickers read `pageIssues` until it moves them.
 * A file leaves this table when its reader moves; nothing is added.
 */
const ALLOWED: Readonly<Record<string, { kinds: readonly string[]; movedBy: string }>> = {
  'packages/client-graph/src/command-launch-source.ts': {
    kinds: ['commandIssues', 'commandSessions'],
    movedBy: 'POD-7089 (command palette)',
  },
  'packages/client-graph/src/chat-context.ts': {
    kinds: ['mentionIssues', 'referenceSessions'],
    movedBy: 'POD-7089 (chat mentions)',
  },
  'packages/client-graph/src/issue-page.ts': {
    kinds: ['pageIssues'],
    movedBy: 'POD-7089 (issue pickers: device, then server search)',
  },
}

const ISSUE_ROWS = [
  { id: 'i0', repoId: 'r0', repoPath: '/a', priority: 0, stage: 'proposed', seq: 1, title: 'one', worktreePath: '/a/w' },
  { id: 'i1', repoId: 'r1', repoPath: '/b', priority: 2, stage: 'done', closedReason: 'done', archived: true, seq: 2, title: 'two' },
  { id: 'i2', repoPath: '/c', priority: 3, stage: 'backlog', deletedAt: '2026-01-01T00:00:00Z', blocked: true, seq: 3, title: 'three' },
]
const SESSION_ROWS = [
  { sessionId: 's0', status: 'live', archived: false, agentKind: 'claude', issueId: 'i0', lastActiveAt: '2026-11-01T00:00:00Z' },
  { sessionId: 's1', status: 'hibernated', archived: true, agentKind: 'shell', headless: true, lastActiveAt: '2026-10-01T00:00:00Z' },
  { sessionId: 's2', status: 'exited', archived: false, agentKind: 'codex', issueId: 'i1', lastActiveAt: '2026-09-01T00:00:00Z' },
]

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.') || name === 'dist') continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (['test', 'tests', '__tests__', '__fixtures__', 'harness', 'test-support'].includes(name)) continue
      sourceFiles(path, out)
    } else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.tsx?$|\.fixture\.ts$|\.d\.ts$/.test(name))
      out.push(path)
  }
  return out
}

describe('no reader enumerates all records of a kind (POD-7088)', () => {
  it('classifies the all-records kinds by asking the reader index', () => {
    const index = createReaderIndex()
    index.apply({
      type: 'replace',
      rows: [
        ...ISSUE_ROWS.map((value) => ({ kind: 'issue' as const, id: value.id, value: value as never })),
        ...SESSION_ROWS.map((value) => ({ kind: 'session' as const, id: value.sessionId, value: value as never })),
      ],
    })
    const all = (Object.values(QUESTIONS) as ReaderQuestion[])
      .filter((question) => {
        const ids = index.ids(question).sort()
        const entity = (question.kind.endsWith('Sessions') || question.kind.startsWith('header') ||
          question.kind === 'sessionReference' ? SESSION_ROWS.map((row) => row.sessionId) : ISSUE_ROWS.map((row) => row.id)).sort()
        return ids.length === entity.length && ids.every((id, at) => id === entity[at])
      })
      .map((question) => question.kind)
      .sort()
    expect(all).toEqual(ALL_RECORDS)
  })

  it('no production file asks an all-records kind outside the table', () => {
    const pattern = new RegExp(`kind:\\s*'(${ALL_RECORDS.join('|')})'`, 'g')
    const found: Record<string, string[]> = {}
    for (const top of ['apps', 'packages'])
      for (const file of sourceFiles(join(ROOT, top))) {
        if (file.endsWith('reader-questions.ts')) continue
        const text = readFileSync(file, 'utf8')
        const kinds = [...text.matchAll(pattern)].map((match) => match[1]!)
        if (kinds.length) found[relative(ROOT, file)] = [...new Set(kinds)].sort()
      }
    const outside = Object.entries(found).filter(
      ([file, kinds]) => !kinds.every((kind) => ALLOWED[file]?.kinds.includes(kind)),
    )
    expect(outside, 'all-records questions outside the table').toEqual([])
  })

  it('is armed: a planted all-records read outside the table is found', () => {
    const pattern = new RegExp(`kind:\\s*'(${ALL_RECORDS.join('|')})'`)
    expect(pattern.test("pool.queries.ids({ kind: 'pageIssues' })")).toBe(true)
    expect(pattern.test("pool.queries.ids({ kind: 'proposedIssues' })")).toBe(false)
    expect(ALLOWED['apps/web/src/features/issues/IssuesView.tsx']).toBeUndefined()
  })
})
