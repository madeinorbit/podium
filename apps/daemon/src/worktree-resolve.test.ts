import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createCwdResolver,
  createSessionCwdTracker,
  gitBranch,
  gitWorktree,
  type SessionCwdUpdate,
  type WorktreeInfo,
} from './worktree-resolve'

describe('createCwdResolver', () => {
  it('resolves a cwd to its git worktree', async () => {
    const resolver = createCwdResolver({
      lookup: async (cwd) => (cwd.startsWith('/repo') ? { root: '/repo', kind: 'main' } : null),
    })
    expect(await resolver.resolve('/repo/packages/web')).toEqual({ root: '/repo', kind: 'main' })
  })

  it('falls back to the raw cwd outside any git worktree', async () => {
    const resolver = createCwdResolver({ lookup: async () => null })
    expect(await resolver.resolve('/tmp/scratch')).toEqual({ root: '/tmp/scratch', kind: 'none' })
  })

  it('falls back to the raw cwd when the lookup throws', async () => {
    const resolver = createCwdResolver({
      lookup: async () => {
        throw new Error('git exploded')
      },
    })
    expect(await resolver.resolve('/somewhere')).toEqual({ root: '/somewhere', kind: 'none' })
  })

  it('caches: one lookup per distinct cwd', async () => {
    const calls: string[] = []
    const resolver = createCwdResolver({
      lookup: async (cwd) => {
        calls.push(cwd)
        return { root: '/repo', kind: 'main' }
      },
    })
    await resolver.resolve('/repo/a')
    await resolver.resolve('/repo/a')
    await resolver.resolve('/repo/b')
    expect(calls).toEqual(['/repo/a', '/repo/b'])
  })
})

describe('gitWorktree (real git)', () => {
  const base = mkdtempSync(join(tmpdir(), 'podium-wt-resolve-'))
  afterAll(() => rmSync(base, { recursive: true, force: true }))

  const repo = join(base, 'repo')
  const git = (...args: string[]): void => {
    execFileSync('git', args, { stdio: 'ignore' })
  }

  beforeAll(() => {
    mkdirSync(join(repo, 'sub'), { recursive: true })
    git('-C', repo, 'init', '-q', '-b', 'main')
    git('-C', repo, 'config', 'user.email', 'test@example.com')
    git('-C', repo, 'config', 'user.name', 'Test')
    git('-C', repo, 'commit', '-q', '--allow-empty', '-m', 'init')
  })

  it('classifies the primary checkout as main, from its root and from a subdirectory', async () => {
    // Both must agree: git prints `.git` from the root but `../.git` from a
    // subdirectory, so a naive string compare would call the subdirectory a worktree.
    expect(await gitWorktree(repo)).toEqual({ root: repo, kind: 'main', repoRoot: repo })
    expect(await gitWorktree(join(repo, 'sub'))).toEqual({
      root: repo,
      kind: 'main',
      repoRoot: repo,
    })
  })

  it('classifies a linked worktree as a worktree, and names the repo it belongs to', async () => {
    const wt = join(base, 'feat')
    git('-C', repo, 'worktree', 'add', '-q', '-b', 'feat', wt)
    mkdirSync(join(wt, 'deep'), { recursive: true })
    expect(await gitWorktree(wt)).toEqual({ root: wt, kind: 'worktree', repoRoot: repo })
    expect(await gitWorktree(join(wt, 'deep'))).toEqual({
      root: wt,
      kind: 'worktree',
      repoRoot: repo,
    })
  })

  it('returns null outside any git worktree', async () => {
    const plain = join(base, 'plain')
    mkdirSync(plain)
    expect(await gitWorktree(plain)).toBeNull()
  })

  it('reads the branch of a worktree, and null when detached or not git', async () => {
    expect(await gitBranch(repo)).toBe('main')
    expect(await gitBranch(join(base, 'feat'))).toBe('feat')
    const head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD']).toString().trim()
    git('-C', repo, 'checkout', '-q', '--detach', head)
    expect(await gitBranch(repo)).toBeNull()
    git('-C', repo, 'checkout', '-q', 'main')
    expect(await gitBranch(join(base, 'plain'))).toBeNull()
  })
})


describe('createSessionCwdTracker', () => {
  const make = (lookup: (cwd: string) => Promise<WorktreeInfo | null>) => {
    const sent: Array<{ sessionId: string; cwd: string }> = []
    const tracker = createSessionCwdTracker({
      resolver: createCwdResolver({ lookup }),
      branch: async (root) => (root.endsWith('feat') ? 'feat' : 'other'),
      send: ({ sessionId, cwd }) => sent.push({ sessionId, cwd }),
    })
    return { sent, tracker }
  }
  const FEAT = '/repo/.worktrees/feat'
  const OTHER = '/repo/.worktrees/other'
  /** `/repo` is the repo's MAIN checkout; it holds two linked worktrees. */
  const inRepo = async (cwd: string): Promise<WorktreeInfo | null> => {
    if (cwd !== '/repo' && !cwd.startsWith('/repo/')) return null
    for (const wt of [FEAT, OTHER]) {
      if (cwd === wt || cwd.startsWith(`${wt}/`)) {
        return { root: wt, kind: 'worktree', repoRoot: '/repo' }
      }
    }
    return { root: '/repo', kind: 'main', repoRoot: '/repo' }
  }

  it('sends the resolved worktree root, not the raw cwd', async () => {
    const { sent, tracker } = make(inRepo)
    await tracker.onHookCwd('s1', `${FEAT}/packages/web`)
    expect(sent).toEqual([{ sessionId: 's1', cwd: FEAT }])
  })

  it('a cd within the same worktree does not re-send', async () => {
    const { sent, tracker } = make(inRepo)
    await tracker.onHookCwd('s1', FEAT)
    await tracker.onHookCwd('s1', `${FEAT}/packages/web`)
    await tracker.onHookCwd('s1', `${FEAT}/apps/server`)
    expect(sent).toEqual([{ sessionId: 's1', cwd: FEAT }])
  })

  it('a move into a different worktree sends the new root', async () => {
    const { sent, tracker } = make(inRepo)
    await tracker.onHookCwd('s1', FEAT)
    await tracker.onHookCwd('s1', `${OTHER}/apps/web`)
    expect(sent).toEqual([
      { sessionId: 's1', cwd: FEAT },
      { sessionId: 's1', cwd: OTHER },
    ])
  })

  it('non-git cwd sends the raw path (legacy behavior)', async () => {
    const { sent, tracker } = make(inRepo)
    await tracker.onHookCwd('s1', '/tmp/scratch')
    expect(sent).toEqual([{ sessionId: 's1', cwd: '/tmp/scratch' }])
  })

  // ---- main never captures [spec:SP-4ef9] ----

  it('a hook cwd in the repo MAIN checkout never re-homes a session', async () => {
    const { sent, tracker } = make(inRepo)
    await tracker.onHookCwd('s1', FEAT)
    // `cd /repo && git fetch` — transient command-running, not a move.
    await tracker.onHookCwd('s1', '/repo')
    await tracker.onHookCwd('s1', '/repo/packages/web')
    expect(sent).toEqual([{ sessionId: 's1', cwd: FEAT }])
  })

  it('main never captures a session that has no worktree yet either', async () => {
    const { sent, tracker } = make(inRepo)
    await tracker.onHookCwd('s1', '/repo/apps/server')
    expect(sent).toEqual([])
  })

  it('after a trip through main, a move into a real worktree still lands', async () => {
    const { sent, tracker } = make(inRepo)
    await tracker.onHookCwd('s1', '/repo')
    await tracker.onHookCwd('s1', FEAT)
    expect(sent).toEqual([{ sessionId: 's1', cwd: FEAT }])
  })

  it('returning from main to the worktree it came from stays quiet', async () => {
    const { sent, tracker } = make(inRepo)
    await tracker.onHookCwd('s1', FEAT)
    await tracker.onHookCwd('s1', '/repo')
    await tracker.onHookCwd('s1', `${FEAT}/apps`)
    expect(sent).toEqual([{ sessionId: 's1', cwd: FEAT }])
  })

  // ---- born pinned (POD-665) ----

  it('a session launched in a worktree is born pinned: later cd wandering cannot re-home it', async () => {
    const { sent, tracker } = make(inRepo)
    await tracker.setLaunchCwd('s1', FEAT)
    await tracker.onHookCwd('s1', OTHER)
    await tracker.onHookCwd('s1', '/repo')
    expect(sent).toEqual([])
  })

  it('the launch pin sends nothing: the server chose the cwd, so it already has it', async () => {
    const { sent, tracker } = make(inRepo)
    await tracker.setLaunchCwd('s1', `${FEAT}/apps`)
    expect(sent).toEqual([])
  })

  it('a session launched in MAIN is not pinned, so it can still adopt a worktree the harness makes', async () => {
    const { sent, tracker } = make(inRepo)
    await tracker.setLaunchCwd('s1', '/repo')
    // Claude's EnterWorktree: the harness built its own workspace (POD-664).
    await tracker.onHookCwd('s1', OTHER)
    expect(sent).toEqual([{ sessionId: 's1', cwd: OTHER }])
  })

  it('a session launched outside git is not pinned', async () => {
    const { sent, tracker } = make(inRepo)
    await tracker.setLaunchCwd('s1', '/tmp/scratch')
    await tracker.onHookCwd('s1', FEAT)
    expect(sent).toEqual([{ sessionId: 's1', cwd: FEAT }])
  })

  it('a hook from the worktree it was born in stays quiet', async () => {
    const { sent, tracker } = make(inRepo)
    await tracker.setLaunchCwd('s1', FEAT)
    await tracker.onHookCwd('s1', `${FEAT}/apps/web`)
    expect(sent).toEqual([])
  })

  it('clear() drops the birth pin so a respawn starts over', async () => {
    const { sent, tracker } = make(inRepo)
    await tracker.setLaunchCwd('s1', FEAT)
    tracker.clear('s1')
    await tracker.onHookCwd('s1', OTHER)
    expect(sent).toEqual([{ sessionId: 's1', cwd: OTHER }])
  })

  it('an explicit declaration still moves a born-pinned session', async () => {
    const { sent, tracker } = make(inRepo)
    await tracker.setLaunchCwd('s1', FEAT)
    await tracker.setExplicit('s1', OTHER)
    expect(sent).toEqual([{ sessionId: 's1', cwd: OTHER }])
  })

  it('reports what the daemon knows about the worktree: kind, branch and owning repo', async () => {
    const sent: SessionCwdUpdate[] = []
    const tracker = createSessionCwdTracker({
      resolver: createCwdResolver({ lookup: inRepo }),
      branch: async () => 'issue/665-born-pinned',
      send: (update) => sent.push(update),
    })
    await tracker.onHookCwd('s1', `${FEAT}/apps`)
    expect(sent).toEqual([
      {
        sessionId: 's1',
        cwd: FEAT,
        kind: 'worktree',
        branch: 'issue/665-born-pinned',
        repoRoot: '/repo',
      },
    ])
  })

  it('omits the branch for a detached worktree rather than sending a stale one', async () => {
    const sent: SessionCwdUpdate[] = []
    const tracker = createSessionCwdTracker({
      resolver: createCwdResolver({ lookup: inRepo }),
      branch: async () => null,
      send: (update) => sent.push(update),
    })
    await tracker.onHookCwd('s1', FEAT)
    expect(sent).toEqual([{ sessionId: 's1', cwd: FEAT, kind: 'worktree', repoRoot: '/repo' }])
  })

  it('never looks up a branch for a directory outside git', async () => {
    let lookups = 0
    const sent: SessionCwdUpdate[] = []
    const tracker = createSessionCwdTracker({
      resolver: createCwdResolver({ lookup: inRepo }),
      branch: async () => {
        lookups++
        return 'nope'
      },
      send: (update) => sent.push(update),
    })
    await tracker.onHookCwd('s1', '/tmp/scratch')
    expect(sent).toEqual([{ sessionId: 's1', cwd: '/tmp/scratch', kind: 'none' }])
    expect(lookups).toBe(0)
  })

  it('a failed branch lookup still reports the move', async () => {
    const sent: SessionCwdUpdate[] = []
    const tracker = createSessionCwdTracker({
      resolver: createCwdResolver({ lookup: inRepo }),
      branch: async () => {
        throw new Error('git exploded')
      },
      send: (update) => sent.push(update),
    })
    await tracker.onHookCwd('s1', FEAT)
    expect(sent).toEqual([{ sessionId: 's1', cwd: FEAT, kind: 'worktree', repoRoot: '/repo' }])
  })

  // ---- ordering / dedup ----

  it('drops a stale slow resolution that finishes after a newer one', async () => {
    let releaseFirst: (() => void) | undefined
    const sent: Array<{ sessionId: string; cwd: string }> = []
    const tracker = createSessionCwdTracker({
      resolver: createCwdResolver({
        lookup: (cwd) =>
          cwd === '/slow/sub'
            ? new Promise((resolve) => {
                releaseFirst = () => resolve({ root: '/slow', kind: 'worktree' })
              })
            : Promise.resolve({ root: '/fast', kind: 'worktree' }),
      }),
      branch: async () => null,
      send: ({ sessionId, cwd }) => sent.push({ sessionId, cwd }),
    })
    const first = tracker.onHookCwd('s1', '/slow/sub')
    await tracker.onHookCwd('s1', '/fast/sub')
    releaseFirst?.()
    await first
    expect(sent).toEqual([{ sessionId: 's1', cwd: '/fast' }])
  })

  it('drops a stale resolution whose BRANCH lookup finishes after a newer cwd', async () => {
    let releaseBranch: ((b: string | null) => void) | undefined
    const sent: Array<{ sessionId: string; cwd: string }> = []
    const tracker = createSessionCwdTracker({
      resolver: createCwdResolver({ lookup: inRepo }),
      branch: (root) =>
        root === FEAT
          ? new Promise((resolve) => {
              releaseBranch = resolve
            })
          : Promise.resolve('other'),
      send: ({ sessionId, cwd }) => sent.push({ sessionId, cwd }),
    })
    const first = tracker.onHookCwd('s1', FEAT)
    await tracker.onHookCwd('s1', OTHER)
    releaseBranch?.('feat')
    await first
    expect(sent).toEqual([{ sessionId: 's1', cwd: OTHER }])
  })

  it('dedupes repeated raw cwds without re-resolving', async () => {
    const calls: string[] = []
    const tracker = createSessionCwdTracker({
      resolver: createCwdResolver({
        lookup: async (cwd) => {
          calls.push(cwd)
          return { root: FEAT, kind: 'worktree' }
        },
      }),
      branch: async () => null,
      send: () => {},
    })
    await tracker.onHookCwd('s1', `${FEAT}/a`)
    await tracker.onHookCwd('s1', `${FEAT}/a`)
    expect(calls).toEqual([`${FEAT}/a`])
  })

  it('clear() forgets a session so the same cwd sends again', async () => {
    const { sent, tracker } = make(inRepo)
    await tracker.onHookCwd('s1', FEAT)
    tracker.clear('s1')
    await tracker.onHookCwd('s1', FEAT)
    expect(sent).toEqual([
      { sessionId: 's1', cwd: FEAT },
      { sessionId: 's1', cwd: FEAT },
    ])
  })

  // ---- explicit declaration (`podium worktree`) ----

  it('setExplicit resolves, sends, and returns the root', async () => {
    const { sent, tracker } = make(inRepo)
    const root = await tracker.setExplicit('s1', `${FEAT}/apps`)
    expect(root).toBe(FEAT)
    expect(sent).toEqual([{ sessionId: 's1', cwd: FEAT }])
  })

  it('after setExplicit, a hook cwd resolving to the same root stays quiet', async () => {
    const { sent, tracker } = make(inRepo)
    await tracker.setExplicit('s1', FEAT)
    await tracker.onHookCwd('s1', `${FEAT}/apps/web`)
    expect(sent).toEqual([{ sessionId: 's1', cwd: FEAT }])
  })

  it('the explicit pin is STICKY: a hook cwd in ANOTHER checkout does not re-home', async () => {
    const { sent, tracker } = make(inRepo)
    await tracker.setExplicit('s1', FEAT)
    // e.g. `cd <main checkout> && git merge …` during a deploy — must not move.
    await tracker.onHookCwd('s1', '/repo')
    await tracker.onHookCwd('s1', OTHER)
    expect(sent).toEqual([{ sessionId: 's1', cwd: FEAT }])
  })

  it('a second setExplicit still moves a pinned session', async () => {
    const { sent, tracker } = make(inRepo)
    await tracker.setExplicit('s1', FEAT)
    await tracker.setExplicit('s1', OTHER)
    expect(sent).toEqual([
      { sessionId: 's1', cwd: FEAT },
      { sessionId: 's1', cwd: OTHER },
    ])
  })

  it('clear() drops the pin: hook cwds re-home again after a respawn', async () => {
    const { sent, tracker } = make(inRepo)
    await tracker.setExplicit('s1', FEAT)
    tracker.clear('s1')
    await tracker.onHookCwd('s1', OTHER)
    expect(sent).toEqual([
      { sessionId: 's1', cwd: FEAT },
      { sessionId: 's1', cwd: OTHER },
    ])
  })

  it('pins are per-session: another session still follows its hooks', async () => {
    const { sent, tracker } = make(inRepo)
    await tracker.setExplicit('s1', FEAT)
    await tracker.onHookCwd('s2', OTHER)
    expect(sent).toEqual([
      { sessionId: 's1', cwd: FEAT },
      { sessionId: 's2', cwd: OTHER },
    ])
  })

  it('setExplicit supersedes an in-flight hook resolution', async () => {
    let releaseHook: (() => void) | undefined
    const sent: Array<{ sessionId: string; cwd: string }> = []
    const tracker = createSessionCwdTracker({
      resolver: createCwdResolver({
        lookup: (cwd) =>
          cwd === '/slow/sub'
            ? new Promise((resolve) => {
                releaseHook = () => resolve({ root: '/slow', kind: 'worktree' })
              })
            : Promise.resolve({ root: '/explicit', kind: 'worktree' }),
      }),
      branch: async () => null,
      send: ({ sessionId, cwd }) => sent.push({ sessionId, cwd }),
    })
    const hook = tracker.onHookCwd('s1', '/slow/sub')
    await tracker.setExplicit('s1', '/explicit/dir')
    releaseHook?.()
    await hook
    expect(sent).toEqual([{ sessionId: 's1', cwd: '/explicit' }])
  })

  it('setExplicit marks its send explicit and re-sends even for an unchanged root', async () => {
    const sent: Array<{ sessionId: string; cwd: string; explicit?: boolean }> = []
    const tracker = createSessionCwdTracker({
      resolver: createCwdResolver({ lookup: inRepo }),
      branch: async () => null,
      send: ({ sessionId, cwd, explicit }) =>
        sent.push({ sessionId, cwd, ...(explicit ? { explicit } : {}) }),
    })
    // Hook already grouped the session under the root; the explicit declaration
    // must STILL send (the server stamps the attached issue's worktree from it).
    await tracker.onHookCwd('s1', `${FEAT}/apps`)
    await tracker.setExplicit('s1', FEAT)
    expect(sent).toEqual([
      { sessionId: 's1', cwd: FEAT },
      { sessionId: 's1', cwd: FEAT, explicit: true },
    ])
  })

  it('tracks sessions independently', async () => {
    const { sent, tracker } = make(inRepo)
    await tracker.onHookCwd('s1', FEAT)
    await tracker.onHookCwd('s2', FEAT)
    expect(sent).toEqual([
      { sessionId: 's1', cwd: FEAT },
      { sessionId: 's2', cwd: FEAT },
    ])
  })
})
