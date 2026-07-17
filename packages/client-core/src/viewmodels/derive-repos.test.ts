import type { GitRepositoryWire } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { reposToViews } from './derive'

function repo(over: Partial<GitRepositoryWire> & { path: string }): GitRepositoryWire {
  return { kind: 'repository', worktrees: [], ...over }
}

describe('reposToViews naming', () => {
  it('names a repo by its origin, not the folder it sits in', () => {
    // The reported bug: the sidebar read "New claude in bak_podium" because a
    // backup clone was named after its directory.
    const [view] = reposToViews([
      repo({ path: '/Users/mgw/bak_podium', originUrl: 'https://github.com/lumenfall/podium.git' }),
    ])
    expect(view?.name).toBe('podium')
    expect(view?.path).toBe('/Users/mgw/bak_podium')
  })

  it('reads scp-style and https remotes alike', () => {
    const [view] = reposToViews([
      repo({ path: '/srv/checkout-2', originUrl: 'git@github.com:lumenfall/podium.git' }),
    ])
    expect(view?.name).toBe('podium')
  })

  it('falls back to the folder name for a repo with no remote', () => {
    const [view] = reposToViews([repo({ path: '/Users/mgw/scratch' })])
    expect(view?.name).toBe('scratch')
  })

  it('keeps naming the grouped repo by origin when copies live on several machines', () => {
    // Two clones of one repo at different paths group into a single view; the
    // group's name must not depend on which copy happens to sort first.
    const views = reposToViews([
      repo({
        path: '/Users/mgw/bak_podium',
        originUrl: 'https://github.com/lumenfall/podium.git',
        machineId: 'mac',
      }),
      repo({
        path: '/home/mgw/src/podium',
        originUrl: 'https://github.com/lumenfall/podium.git',
        machineId: 'linux',
      }),
    ])
    expect(views).toHaveLength(1)
    expect(views[0]?.name).toBe('podium')
  })
})
