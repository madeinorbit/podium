import { autorun, runInAction } from 'mobx'
import { describe, expect, it } from 'vitest'
import { createHeaderRepositoryRelations } from './header-repositories'
import type { HeaderRows } from './header-schema'
import { createIssueQuestions } from './shared/issue-questions'
import { createReaderIndex } from './shared/reader-questions'
import { createRelationIndex } from './shared/relation-index'
import { longestPrefixPath, prefixCandidates, SCHEMA } from './shared/schema'
import { createSessionActivityIndex } from './shared/session-activity'
import { createSessionQuestions } from './shared/session-questions'
import { repoLabelOf } from './worklist/groups'
import { unstarted } from './worklist/sidebar-row'

const cases = [
  ['/Repo', '/Repo', '/Repo/wt', '/Repo/wt/src'],
  [String.raw`C:\Src\Podium`, 'c:/src/podium', String.raw`C:\Src\Podium\wt`, 'c:/SRC/podium/wt/src'],
] as const
const at = '2026-10-06T12:00:00Z'

describe.each(cases)('machine paths: current client graph under %s', (root, alias, wt, cwd) => {
  it('keeps original roots while linking sessions and issues through canonical path buckets', () => {
    const relations = createRelationIndex(SCHEMA)
    relations.begin()
    relations.changed('worktree', root, false, { path: root })
    relations.changed('issue', 'issue', false, { id: 'issue', worktreePath: wt, repoPath: root, seq: 1 })
    relations.changed('session', 'session', false, { sessionId: 'session', cwd, agentKind: 'codex', status: 'live' })
    relations.flush()
    expect(relations.forward('session', 'session', 'worktree')).toBe(wt)
    expect([...relations.members('worktree', cwd.slice(0, -4), 'issues')]).toEqual(['issue'])
    expect([...relations.members('worktree', wt, 'sessions')]).toEqual(['session'])
    expect(longestPrefixPath(cwd, [root, wt])).toBe(wt)
    relations.begin()
    relations.changed('session', 'session', true, { sessionId: 'session', cwd: '/outside' })
    relations.flush()
    expect([...relations.members('worktree', wt, 'sessions')]).toEqual([])
  })

  it('answers containing issue and indexed query questions from alternate Windows spelling', () => {
    const row = { id: 'issue', repoPath: root, worktreePath: wt, seq: 1, stage: 'in_progress' }
    const issues = createIssueQuestions()
    issues.set('issue', row)
    expect(issues.containingIssueId(cwd)).toBe('issue')
    expect(issues.containingIssueId(alias + 'ish')).toBeUndefined()
    const index = createReaderIndex()
    index.apply({ type: 'replace', rows: [{ kind: 'issue', id: 'issue', value: row }] } as never)
    expect([...index.ids({ kind: 'containingIssues', cwd })]).toEqual(['issue'])
    expect([...index.ids({ kind: 'spawnIssues', repoPath: alias })]).toEqual(['issue'])
  })

  it('indexes ancestor activity and presence with matching read keys', () => {
    const questions = createSessionQuestions(() => false)
    questions.set('session', { sessionId: 'session', cwd, agentKind: 'codex', lastActiveAt: at })
    expect(questions.hasWithin(alias)).toBe(true)
    expect(questions.hasWithin(alias + 'ish')).toBe(false)
    expect(questions.activity({ kind: 'commandRootActivity', roots: [alias] })).toBe(Date.parse(at))
    questions.set('session', undefined)
    expect(questions.hasWithin(alias)).toBe(false)
    const activity = createSessionActivityIndex(() => false)
    activity.set('session', { cwd, lastActiveAt: at })
    expect(activity.answer({ kind: 'commandRootActivity', roots: [alias] })).toBe(Date.parse(at))
  })

  it('keeps display and shipping paths while matching repository aliases', () => {
    const repos = createHeaderRepositoryRelations()
    runInAction(() => {
      repos.set('repo', { path: root, machineId: 'machine', worktrees: [{ path: wt }] } as HeaderRows['repository'])
      repos.flush()
    })
    const seen: unknown[] = []
    const stop = autorun(() => seen.push(repos.shippingScope(cwd, 'machine')))
    try {
      expect(repos.group(alias)).toEqual(['repo'])
      expect(seen[0]).toMatchObject({ repoPath: root, handoff: { repoPath: root, worktreePath: wt } })
      expect(repoLabelOf(root)).toBe(root === '/Repo' ? 'Repo' : 'Podium')
    } finally { stop() }
  })
})


it('keeps POSIX root prefix scans consistent with indexed prefix candidates', () => {
  expect(longestPrefixPath('/x', ['/'])).toBeNull()
  expect([...prefixCandidates('/x')]).not.toContain('/')
  expect(longestPrefixPath('/', ['/'])).toBe('/')
  expect(longestPrefixPath('/x/y', ['/', '/x'])).toBe('/x')
  expect(longestPrefixPath(String.raw`C:\x`, ['C:\\'])).toBe('C:\\')
  expect(unstarted({ cwd: '/', title: '/', agentKind: 'codex' } as never)).toBe(false)
})
it('does not crash graph indexes or labels on malformed Windows paths', () => {
  const root = String.raw`C:\repo\...`
  const cwd = root + String.raw`\src\a.ts`
  const relations = createRelationIndex(SCHEMA)
  relations.begin()
  relations.changed('worktree', root, false, { path: root })
  relations.changed('session', 'bad', false, { sessionId: 'bad', cwd, agentKind: 'codex', status: 'live' })
  relations.flush()
  expect(relations.forward('session', 'bad', 'worktree')).toBeNull()
  expect(repoLabelOf(root)).toBe('...')
  const questions = createSessionQuestions(() => false)
  questions.set('bad', { sessionId: 'bad', cwd, agentKind: 'codex', lastActiveAt: at })
  expect(questions.hasWithin(String.raw`C:\repo`)).toBe(false)
  expect(longestPrefixPath(cwd, [String.raw`C:\repo`])).toBeNull()
})
