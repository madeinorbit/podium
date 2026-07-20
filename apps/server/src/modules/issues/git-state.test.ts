import { describe, expect, test } from 'vitest'
import { countDirtyOwn, parsePorcelainStatus, probeGitState } from './git-state'

const io = (
  responses: Record<string, { ok: boolean; output: string }>,
  calls: Array<{ op: string; args?: Record<string, string> }> = [],
) => ({
  repoOp: async (op: string, _cwd: string, args?: Record<string, string>) => {
    calls.push({ op, args })
    const key = op === 'revListCount' ? `${op}:${args?.from}..${args?.to}` : op
    return responses[key] ?? { ok: false, output: '' }
  },
})

describe('parsePorcelainStatus', () => {
  test('branch header + dirty paths', () => {
    const r = parsePorcelainStatus(
      '## issue/98-viz...origin/issue/98-viz\n M apps/web/a.ts\n?? apps/web/b.ts',
    )
    expect(r.branch).toBe('issue/98-viz')
    expect(r.dirtyPaths).toEqual(['apps/web/a.ts', 'apps/web/b.ts'])
  })
  test('clean tree, plain branch', () => {
    const r = parsePorcelainStatus('## main')
    expect(r.branch).toBe('main')
    expect(r.dirtyPaths).toEqual([])
  })
  test('rename lines keep the post-rename path', () => {
    const r = parsePorcelainStatus('## main\nR  old.ts -> new.ts')
    expect(r.dirtyPaths).toEqual(['new.ts'])
  })
  test('detached HEAD → branch null', () => {
    expect(parsePorcelainStatus('## HEAD (no branch)').branch).toBeNull()
  })
  test('unborn branch → named branch', () => {
    expect(parsePorcelainStatus('## No commits yet on trunk').branch).toBe('trunk')
  })
})

describe('countDirtyOwn', () => {
  test('intersects absolute touched paths with repo-relative porcelain paths', () => {
    const touched = new Set(['/repo/apps/web/a.ts', '/repo/apps/web/c.ts'])
    expect(countDirtyOwn(['apps/web/a.ts', 'apps/web/b.ts'], touched)).toBe(1)
  })
  test('exact relative match also counts', () => {
    expect(countDirtyOwn(['a.ts'], new Set(['a.ts']))).toBe(1)
  })
  test('empty touched set → 0', () => {
    expect(countDirtyOwn(['a.ts'], new Set())).toBe(0)
  })
})

describe('probeGitState', () => {
  const now = '2026-07-20T12:00:00Z'

  test('private worktree: ahead + clean + upstream', async () => {
    const state = await probeGitState(
      io({
        statusProbe: { ok: true, output: '## issue/98-viz' },
        logHead: { ok: true, output: 'abc123\t2026-07-20T11:55:00Z' },
        'revListCount:@{u}..HEAD': { ok: true, output: '2' },
        'revListCount:main..HEAD': { ok: true, output: '3' },
      }),
      { cwd: '/wt', shared: false, parentBranch: 'main', branch: 'issue/98-viz' },
      now,
    )
    expect(state).toMatchObject({
      updatedAt: now,
      branch: 'issue/98-viz',
      shared: false,
      ahead: 3,
      dirtyFiles: 0,
      unpushed: 2,
      lastCommitAt: '2026-07-20T11:55:00Z',
    })
    expect(state.merged).toBeUndefined()
    expect(state.fallback).toBeUndefined()
  })

  test('private worktree at 0 ahead runs the merged check', async () => {
    const calls: Array<{ op: string }> = []
    const state = await probeGitState(
      io(
        {
          statusProbe: { ok: true, output: '## issue/98-viz' },
          'revListCount:main..HEAD': { ok: true, output: '0' },
          isMergedInto: { ok: true, output: '' },
        },
        calls,
      ),
      { cwd: '/wt', shared: false, parentBranch: 'main', branch: 'issue/98-viz' },
      now,
    )
    expect(state.merged).toBe(true)
    expect(calls.some((c) => c.op === 'isMergedInto')).toBe(true)
  })

  test('shared checkout: merge axis suppressed, attribution carried', async () => {
    const calls: Array<{ op: string; args?: Record<string, string> }> = []
    const state = await probeGitState(
      io(
        {
          statusProbe: { ok: true, output: '## v3\n M apps/a.ts\n M apps/b.ts\n M apps/c.ts' },
          logHead: { ok: true, output: 'abc\t2026-07-20T11:00:00Z' },
        },
        calls,
      ),
      {
        cwd: '/repo',
        shared: true,
        parentBranch: 'v3',
        branch: null,
        commits: ['abc', 'def'],
        touched: new Set(['/repo/apps/a.ts']),
      },
      now,
    )
    expect(state.shared).toBe(true)
    expect(state.ahead).toBeUndefined()
    expect(state.commits).toEqual(['abc', 'def'])
    expect(state.dirtyFiles).toBe(3)
    expect(state.dirtyOwn).toBe(1)
    expect(state.fallback).toBeUndefined()
    // No merge-axis subprocesses on shared checkouts:
    expect(calls.some((c) => c.op === 'isMergedInto')).toBe(false)
    expect(calls.some((c) => c.args?.from === 'v3')).toBe(false)
  })

  test('shared checkout without attribution → fallback disclosed', async () => {
    const state = await probeGitState(
      io({ statusProbe: { ok: true, output: '## main\n M x.ts' } }),
      { cwd: '/repo', shared: true, parentBranch: 'main', branch: null },
      now,
    )
    expect(state.fallback).toBe(true)
    expect(state.dirtyOwn).toBeUndefined()
    expect(state.dirtyFiles).toBe(1)
  })

  test('no upstream → unpushed absent, not zero', async () => {
    const state = await probeGitState(
      io({ statusProbe: { ok: true, output: '## main' } }),
      { cwd: '/repo', shared: true, parentBranch: 'main', branch: null },
      now,
    )
    expect(state.unpushed).toBeUndefined()
  })
})
