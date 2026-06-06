import type { ConversationSummaryWire, GitRepositoryWire, SessionMeta } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import {
  mergeResumable,
  panelLabel,
  reposToViews,
  resumableForRepoFallback,
  resumableForWorktree,
  sessionsForWorktree,
} from '../src/derive'

const repo: GitRepositoryWire = {
  path: '/src/app',
  kind: 'repository',
  branch: 'main',
  worktrees: [{ path: '/src/app-feat', branch: 'feat' }],
}

const session = (cwd: string): SessionMeta => ({
  sessionId: `s-${cwd}`,
  agentKind: 'claude-code',
  title: 't',
  cwd,
  status: 'live',
  controllerId: null,
  geometry: { cols: 80, rows: 24 },
  epoch: 0,
  clientCount: 0,
  createdAt: '2026-06-03T00:00:00.000Z',
  origin: { kind: 'spawn' },
})

const conv = (projectPath: string, id: string): ConversationSummaryWire => ({
  id,
  agentKind: 'claude-code',
  providerId: 'p',
  projectPath,
  resume: { kind: 'claude-session', value: id },
})

describe('reposToViews', () => {
  it('lists the repo checkout as main plus linked worktrees', () => {
    const [view] = reposToViews([repo])
    expect(view.name).toBe('app')
    expect(view.worktrees).toEqual([
      { path: '/src/app', branch: 'main', repoPath: '/src/app', isMain: true },
      { path: '/src/app-feat', branch: 'feat', repoPath: '/src/app', isMain: false },
    ])
  })

  it('dedupes worktrees that also appear as standalone repo entries', () => {
    const parent: GitRepositoryWire = {
      path: '/src/app',
      kind: 'repository',
      branch: 'main',
      worktrees: [{ path: '/src/app-feat', branch: 'feat' }],
    }
    const standalone: GitRepositoryWire = {
      path: '/src/app-feat',
      kind: 'worktree',
      branch: 'feat',
      worktrees: [],
    }
    const views = reposToViews([parent, standalone])
    expect(views.map((v) => v.path)).toEqual(['/src/app'])
    expect(views[0].worktrees.map((w) => w.path)).toEqual(['/src/app', '/src/app-feat'])
  })
})

describe('sessionsForWorktree', () => {
  it('matches by exact cwd', () => {
    const all = [session('/src/app'), session('/src/app-feat')]
    expect(sessionsForWorktree(all, '/src/app-feat')).toHaveLength(1)
    expect(sessionsForWorktree(all, '/src/app-feat')[0].cwd).toBe('/src/app-feat')
  })
})

describe('resumable matching', () => {
  it('worktree gets exact projectPath matches', () => {
    const all = [conv('/src/app-feat', 'a'), conv('/src/app', 'b')]
    expect(resumableForWorktree(all, '/src/app-feat').map((c) => c.id)).toEqual(['a'])
  })
  it('repo fallback gets under-repo convs not matched to any worktree', () => {
    const all = [conv('/src/app', 'b'), conv('/src/app-feat', 'a'), conv('/src/other', 'z')]
    const wtPaths = ['/src/app', '/src/app-feat']
    expect(resumableForRepoFallback(all, '/src/app', wtPaths).map((c) => c.id)).toEqual([])
    const all2 = [conv('/src/app/sub', 'c')]
    expect(resumableForRepoFallback(all2, '/src/app', wtPaths).map((c) => c.id)).toEqual(['c'])
  })

  it('excludes conversations without a resume ref', () => {
    const noResume: ConversationSummaryWire = {
      id: 'n',
      agentKind: 'claude-code',
      providerId: 'p',
      projectPath: '/src/app',
    }
    expect(resumableForWorktree([noResume], '/src/app')).toEqual([])
    expect(resumableForRepoFallback([noResume], '/src/app', [])).toEqual([])
  })

  it('does not match a sibling path as under the repo', () => {
    const sibling = conv('/src/application', 's')
    expect(resumableForRepoFallback([sibling], '/src/app', []).map((c) => c.id)).toEqual([])
  })
})

describe('mergeResumable', () => {
  it('dedupes conversations that appear in both exact and fallback lists', () => {
    const shared = conv('/src/app', 'facaab0d-326c-4915-9018-c1fd8f4a4e5b')
    expect(mergeResumable([shared], [shared])).toEqual([shared])
  })
})

describe('panelLabel', () => {
  it('maps agent kinds to display names', () => {
    expect(panelLabel('claude-code')).toBe('Claude')
    expect(panelLabel('codex')).toBe('Codex')
    expect(panelLabel('shell')).toBe('Shell')
  })
})
