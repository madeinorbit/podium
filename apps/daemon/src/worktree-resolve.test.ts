import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createCwdResolver, createSessionCwdTracker, gitToplevel } from './worktree-resolve'

describe('createCwdResolver', () => {
  it('resolves a cwd to its git toplevel', async () => {
    const resolver = createCwdResolver({
      toplevel: async (cwd) => (cwd.startsWith('/repo') ? '/repo' : null),
    })
    expect(await resolver.resolve('/repo/packages/web')).toBe('/repo')
  })

  it('falls back to the raw cwd outside any git worktree', async () => {
    const resolver = createCwdResolver({ toplevel: async () => null })
    expect(await resolver.resolve('/tmp/scratch')).toBe('/tmp/scratch')
  })

  it('falls back to the raw cwd when toplevel lookup throws', async () => {
    const resolver = createCwdResolver({
      toplevel: async () => {
        throw new Error('git exploded')
      },
    })
    expect(await resolver.resolve('/somewhere')).toBe('/somewhere')
  })

  it('caches: one toplevel call per distinct cwd', async () => {
    const calls: string[] = []
    const resolver = createCwdResolver({
      toplevel: async (cwd) => {
        calls.push(cwd)
        return '/repo'
      },
    })
    await resolver.resolve('/repo/a')
    await resolver.resolve('/repo/a')
    await resolver.resolve('/repo/b')
    expect(calls).toEqual(['/repo/a', '/repo/b'])
  })
})

describe('gitToplevel (real git)', () => {
  const base = mkdtempSync(join(tmpdir(), 'podium-wt-resolve-'))
  afterAll(() => rmSync(base, { recursive: true, force: true }))

  it('returns the worktree root from a subdirectory and null outside git', async () => {
    const repo = join(base, 'repo')
    mkdirSync(join(repo, 'sub'), { recursive: true })
    execFileSync('git', ['-C', repo, 'init', '-q'])
    expect(await gitToplevel(join(repo, 'sub'))).toBe(repo)

    const plain = join(base, 'plain')
    mkdirSync(plain)
    expect(await gitToplevel(plain)).toBeNull()
  })
})

describe('createSessionCwdTracker', () => {
  const make = (toplevel: (cwd: string) => Promise<string | null>) => {
    const sent: Array<{ sessionId: string; cwd: string }> = []
    const tracker = createSessionCwdTracker({
      resolver: createCwdResolver({ toplevel }),
      send: (sessionId, cwd) => sent.push({ sessionId, cwd }),
    })
    return { sent, tracker }
  }
  const inRepo = async (cwd: string): Promise<string | null> =>
    cwd === '/repo' || cwd.startsWith('/repo/')
      ? cwd.startsWith('/repo/.worktrees/feat')
        ? '/repo/.worktrees/feat'
        : '/repo'
      : null

  it('sends the resolved worktree root, not the raw cwd', async () => {
    const { sent, tracker } = make(inRepo)
    await tracker.onHookCwd('s1', '/repo/packages/web')
    expect(sent).toEqual([{ sessionId: 's1', cwd: '/repo' }])
  })

  it('a cd within the same worktree does not re-send', async () => {
    const { sent, tracker } = make(inRepo)
    await tracker.onHookCwd('s1', '/repo')
    await tracker.onHookCwd('s1', '/repo/packages/web')
    await tracker.onHookCwd('s1', '/repo/apps/server')
    expect(sent).toEqual([{ sessionId: 's1', cwd: '/repo' }])
  })

  it('a move into a different worktree sends the new root', async () => {
    const { sent, tracker } = make(inRepo)
    await tracker.onHookCwd('s1', '/repo')
    await tracker.onHookCwd('s1', '/repo/.worktrees/feat/apps/web')
    expect(sent).toEqual([
      { sessionId: 's1', cwd: '/repo' },
      { sessionId: 's1', cwd: '/repo/.worktrees/feat' },
    ])
  })

  it('non-git cwd sends the raw path (legacy behavior)', async () => {
    const { sent, tracker } = make(inRepo)
    await tracker.onHookCwd('s1', '/tmp/scratch')
    expect(sent).toEqual([{ sessionId: 's1', cwd: '/tmp/scratch' }])
  })

  it('drops a stale slow resolution that finishes after a newer one', async () => {
    let releaseFirst: (() => void) | undefined
    const sent: Array<{ sessionId: string; cwd: string }> = []
    const tracker = createSessionCwdTracker({
      resolver: createCwdResolver({
        toplevel: (cwd) =>
          cwd === '/slow/sub'
            ? new Promise((resolve) => {
                releaseFirst = () => resolve('/slow')
              })
            : Promise.resolve('/fast'),
      }),
      send: (sessionId, cwd) => sent.push({ sessionId, cwd }),
    })
    const first = tracker.onHookCwd('s1', '/slow/sub')
    await tracker.onHookCwd('s1', '/fast/sub')
    releaseFirst?.()
    await first
    expect(sent).toEqual([{ sessionId: 's1', cwd: '/fast' }])
  })

  it('dedupes repeated raw cwds without re-resolving', async () => {
    const calls: string[] = []
    const tracker = createSessionCwdTracker({
      resolver: createCwdResolver({
        toplevel: async (cwd) => {
          calls.push(cwd)
          return '/repo'
        },
      }),
      send: () => {},
    })
    await tracker.onHookCwd('s1', '/repo/a')
    await tracker.onHookCwd('s1', '/repo/a')
    expect(calls).toEqual(['/repo/a'])
  })

  it('clear() forgets a session so the same cwd sends again', async () => {
    const { sent, tracker } = make(inRepo)
    await tracker.onHookCwd('s1', '/repo')
    tracker.clear('s1')
    await tracker.onHookCwd('s1', '/repo')
    expect(sent).toEqual([
      { sessionId: 's1', cwd: '/repo' },
      { sessionId: 's1', cwd: '/repo' },
    ])
  })

  it('setExplicit resolves, sends, and returns the root', async () => {
    const { sent, tracker } = make(inRepo)
    const root = await tracker.setExplicit('s1', '/repo/.worktrees/feat/apps')
    expect(root).toBe('/repo/.worktrees/feat')
    expect(sent).toEqual([{ sessionId: 's1', cwd: '/repo/.worktrees/feat' }])
  })

  it('after setExplicit, a hook cwd resolving to the same root stays quiet', async () => {
    const { sent, tracker } = make(inRepo)
    await tracker.setExplicit('s1', '/repo/.worktrees/feat')
    await tracker.onHookCwd('s1', '/repo/.worktrees/feat/apps/web')
    expect(sent).toEqual([{ sessionId: 's1', cwd: '/repo/.worktrees/feat' }])
  })

  it('the explicit pin is STICKY: a hook cwd in ANOTHER checkout does not re-home', async () => {
    const { sent, tracker } = make(inRepo)
    await tracker.setExplicit('s1', '/repo/.worktrees/feat')
    // e.g. `cd <main checkout> && git merge …` during a deploy — must not move.
    await tracker.onHookCwd('s1', '/repo')
    await tracker.onHookCwd('s1', '/repo/packages/web')
    expect(sent).toEqual([{ sessionId: 's1', cwd: '/repo/.worktrees/feat' }])
  })

  it('a second setExplicit still moves a pinned session', async () => {
    const { sent, tracker } = make(inRepo)
    await tracker.setExplicit('s1', '/repo/.worktrees/feat')
    await tracker.setExplicit('s1', '/repo')
    expect(sent).toEqual([
      { sessionId: 's1', cwd: '/repo/.worktrees/feat' },
      { sessionId: 's1', cwd: '/repo' },
    ])
  })

  it('clear() drops the pin: hook cwds re-home again after a respawn', async () => {
    const { sent, tracker } = make(inRepo)
    await tracker.setExplicit('s1', '/repo/.worktrees/feat')
    tracker.clear('s1')
    await tracker.onHookCwd('s1', '/repo')
    expect(sent).toEqual([
      { sessionId: 's1', cwd: '/repo/.worktrees/feat' },
      { sessionId: 's1', cwd: '/repo' },
    ])
  })

  it('pins are per-session: another session still follows its hooks', async () => {
    const { sent, tracker } = make(inRepo)
    await tracker.setExplicit('s1', '/repo/.worktrees/feat')
    await tracker.onHookCwd('s2', '/repo')
    expect(sent).toEqual([
      { sessionId: 's1', cwd: '/repo/.worktrees/feat' },
      { sessionId: 's2', cwd: '/repo' },
    ])
  })

  it('setExplicit supersedes an in-flight hook resolution', async () => {
    let releaseHook: (() => void) | undefined
    const sent: Array<{ sessionId: string; cwd: string }> = []
    const tracker = createSessionCwdTracker({
      resolver: createCwdResolver({
        toplevel: (cwd) =>
          cwd === '/slow/sub'
            ? new Promise((resolve) => {
                releaseHook = () => resolve('/slow')
              })
            : Promise.resolve('/explicit'),
      }),
      send: (sessionId, cwd) => sent.push({ sessionId, cwd }),
    })
    const hook = tracker.onHookCwd('s1', '/slow/sub')
    await tracker.setExplicit('s1', '/explicit/dir')
    releaseHook?.()
    await hook
    expect(sent).toEqual([{ sessionId: 's1', cwd: '/explicit' }])
  })

  it('tracks sessions independently', async () => {
    const { sent, tracker } = make(inRepo)
    await tracker.onHookCwd('s1', '/repo')
    await tracker.onHookCwd('s2', '/repo')
    expect(sent).toEqual([
      { sessionId: 's1', cwd: '/repo' },
      { sessionId: 's2', cwd: '/repo' },
    ])
  })
})
