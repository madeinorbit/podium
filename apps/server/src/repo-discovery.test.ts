import { describe, expect, it, vi } from 'vitest'
import type { ScanReposResult } from './relay'
import {
  adjacentRootsFor,
  homeRelativePath,
  MachineRepoDiscovery,
  probeRootsFor,
} from './repo-discovery'

// [spec:SP-3701] POD-787 — tiered per-machine repo discovery.

const row = (machineId: string, path: string, originUrl: string | null = null) => ({
  machineId,
  path,
  originUrl,
})

describe('homeRelativePath', () => {
  it('translates linux and mac homes to ~ and leaves the rest alone', () => {
    expect(homeRelativePath('/home/mgw/src/other/podium')).toBe('~/src/other/podium')
    expect(homeRelativePath('/Users/mike/src/podium')).toBe('~/src/podium')
    expect(homeRelativePath('/srv/repos/podium')).toBeUndefined()
    expect(homeRelativePath('/home/mgw')).toBeUndefined()
  })
})

describe('probeRootsFor', () => {
  it('derives raw + home-translated probes from other machines, skipping registered', () => {
    const rows = [
      row('hub', '/home/mgw/src/other/podium'),
      row('hub', '/srv/deploy/tools'),
      row('mac', '/Users/mike/src/registered'),
    ]
    expect(probeRootsFor('mac', rows)).toEqual([
      '/home/mgw/src/other/podium',
      '~/src/other/podium',
      '/srv/deploy/tools',
    ])
  })

  it('dedupes probes across machines', () => {
    const rows = [row('a', '/home/u/src/x'), row('b', '/home/u/src/x')]
    expect(probeRootsFor('mac', rows)).toEqual(['/home/u/src/x', '~/src/x'])
  })
})

describe('adjacentRootsFor', () => {
  it('collects parents, skips / and bare homes, and collapses nested parents', () => {
    expect(
      adjacentRootsFor([
        '/Users/mike/src/podium', // parent ~/src — kept
        '/Users/mike/lonely', // parent = bare home — dropped (deep sweep owns it)
        '/opt/single', // parent /opt — kept
        '/Users/mike/src/nested/deep', // parent inside /Users/mike/src? no — /Users/mike/src/nested kept unless contained
      ]),
    ).toEqual(['/Users/mike/src', '/opt'])
  })
})

function scanResult(
  repos: Array<{ path: string; originUrl?: string; kind?: 'repository' | 'worktree' }>,
): ScanReposResult {
  return {
    repositories: repos.map((r) => ({
      path: r.path,
      kind: r.kind ?? 'repository',
      ...(r.originUrl ? { originUrl: r.originUrl } : {}),
      worktrees: [],
    })),
    diagnostics: [],
  }
}

function makeService(overrides: Partial<ConstructorParameters<typeof MachineRepoDiscovery>[0]>) {
  const added: Array<{ path: string; machineId: string; originUrl?: string }> = []
  const svc = new MachineRepoDiscovery({
    listRepos: () => [],
    addRepo: (path, machineId, originUrl) => {
      added.push({ path, machineId, ...(originUrl ? { originUrl } : {}) })
    },
    scanRepos: async () => scanResult([]),
    machineName: (id) => `name:${id}`,
    localMachineId: 'local',
    ...overrides,
  })
  return { svc, added }
}

describe('MachineRepoDiscovery.scan', () => {
  it('probes known paths first, auto-registers origin matches, keeps others as candidates', async () => {
    const rows = [row('hub', '/home/mgw/src/other/podium', 'git@github.com:o/podium.git')]
    const scanRepos = vi.fn(async (roots: string[]): Promise<ScanReposResult> => {
      // T1 probe answers with the translated path; T2 finds an unrelated neighbor.
      if (roots.includes('~/src/other/podium'))
        return scanResult([
          { path: '/Users/mike/src/other/podium', originUrl: 'git@github.com:o/podium.git' },
        ])
      return scanResult([{ path: '/Users/mike/src/other/sidecar' }])
    })
    const { svc, added } = makeService({ listRepos: () => rows, scanRepos })

    const result = await svc.scan('mac', { deep: false })

    // T1 roots include both raw and ~-translated candidate paths.
    expect(scanRepos.mock.calls[0]?.[0]).toEqual([
      '/home/mgw/src/other/podium',
      '~/src/other/podium',
    ])
    // T2 walked around the T1 hit.
    expect(scanRepos.mock.calls[1]?.[0]).toEqual(['/Users/mike/src/other'])
    expect(added).toEqual([
      {
        path: '/Users/mike/src/other/podium',
        machineId: 'mac',
        originUrl: 'git@github.com:o/podium.git',
      },
    ])
    expect(result.repos).toEqual([
      expect.objectContaining({
        path: '/Users/mike/src/other/podium',
        status: 'auto-registered',
        alsoOn: ['name:hub'],
      }),
      expect.objectContaining({ path: '/Users/mike/src/other/sidecar', status: 'candidate' }),
    ])
    // Shallow scan: exactly two RPC rounds, no home sweep.
    expect(scanRepos).toHaveBeenCalledTimes(2)
  })

  it('runs the bounded home sweep only when deep', async () => {
    const scanRepos = vi.fn(
      async (
        _roots: string[],
        _opts: { includeHome?: boolean; maxDepth?: number },
        _machineId: string,
      ): Promise<ScanReposResult> => scanResult([]),
    )
    const { svc } = makeService({ scanRepos })

    await svc.scan('mac', { deep: true })

    expect(scanRepos).toHaveBeenCalledTimes(1) // no probes/adjacent (no known repos) → sweep only
    expect(scanRepos.mock.calls[0]?.[1]).toEqual({ includeHome: true, maxDepth: 4 })
  })

  it('classifies already-registered paths without re-adding, ignores worktree rows', async () => {
    const rows = [row('mac', '/Users/mike/src/podium', 'https://github.com/o/podium')]
    const scanRepos = vi.fn(
      async (): Promise<ScanReposResult> =>
        scanResult([
          { path: '/Users/mike/src/podium', originUrl: 'https://github.com/o/podium' },
          { path: '/Users/mike/src/podium/.worktrees/x', kind: 'worktree' },
        ]),
    )
    const { svc, added } = makeService({ listRepos: () => rows, scanRepos })

    const result = await svc.scan('mac', { deep: false })

    expect(added).toEqual([])
    expect(result.repos).toEqual([
      expect.objectContaining({ path: '/Users/mike/src/podium', status: 'registered' }),
    ])
  })

  it('keeps ALL copies as candidates when the machine has several clones of one origin', async () => {
    // POD-779 feedback: a ~/bak_podium backup clone was auto-registered over the
    // real one. Multiple same-origin copies → the user picks, nothing auto-adds.
    const rows = [row('hub', '/home/mgw/src/podium', 'git@github.com:o/podium.git')]
    const scanRepos = vi.fn(
      async (): Promise<ScanReposResult> =>
        scanResult([
          { path: '/Users/mike/src/podium', originUrl: 'git@github.com:o/podium.git' },
          { path: '/Users/mike/bak_podium', originUrl: 'git@github.com:o/podium.git' },
        ]),
    )
    const { svc, added } = makeService({ listRepos: () => rows, scanRepos })

    const result = await svc.scan('mac', { deep: false })

    expect(added).toEqual([])
    expect(result.repos.map((r) => r.status)).toEqual(['candidate', 'candidate'])
  })

  it('never auto-adds a second copy when one copy of the origin is already registered', async () => {
    const rows = [
      row('hub', '/home/mgw/src/podium', 'git@github.com:o/podium.git'),
      row('mac', '/Users/mike/src/podium', 'git@github.com:o/podium.git'),
    ]
    const scanRepos = vi.fn(
      async (): Promise<ScanReposResult> =>
        scanResult([{ path: '/Users/mike/bak_podium', originUrl: 'git@github.com:o/podium.git' }]),
    )
    const { svc, added } = makeService({ listRepos: () => rows, scanRepos })

    const result = await svc.scan('mac', { deep: false })

    expect(added).toEqual([])
    expect(result.repos).toEqual([
      expect.objectContaining({ path: '/Users/mike/bak_podium', status: 'candidate' }),
    ])
  })

  it('coalesces concurrent scans and records lastResult', async () => {
    let resolveScan: (r: ScanReposResult) => void = () => {}
    const gate = new Promise<ScanReposResult>((resolve) => {
      resolveScan = resolve
    })
    const { svc } = makeService({
      listRepos: () => [row('hub', '/home/u/src/x')],
      scanRepos: () => gate,
    })

    const first = svc.scan('mac', { deep: false })
    const second = svc.scan('mac', { deep: false })
    expect(second).toBe(first)
    resolveScan(scanResult([]))
    const result = await first
    expect(svc.lastResult('mac')).toBe(result)
  })

  it('scans the browsed folder first when atPath is given (POD-855 "scan here")', async () => {
    const scanRepos = vi.fn(
      async (
        roots: string[],
        _opts: { includeHome?: boolean; maxDepth?: number },
        _machineId: string,
      ): Promise<ScanReposResult> => {
        if (roots.includes('/Users/mike/projects/app'))
          return scanResult([
            { path: '/Users/mike/projects/app', originUrl: 'git@github.com:o/app.git' },
          ])
        return scanResult([])
      },
    )
    const { svc } = makeService({ listRepos: () => [], scanRepos })

    const result = await svc.scan('mac', { deep: false, atPath: '/Users/mike/projects/app' })

    // T0 (the browsed folder) is the FIRST scan root, walked at folder-scan depth.
    expect(scanRepos.mock.calls[0]?.[0]).toEqual(['/Users/mike/projects/app'])
    expect(scanRepos.mock.calls[0]?.[1]).toMatchObject({ includeHome: false, maxDepth: 6 })
    expect(result.repos.map((r) => r.path)).toContain('/Users/mike/projects/app')
  })

  it('does not coalesce scans of different folders', async () => {
    let resolveScan: (r: ScanReposResult) => void = () => {}
    const gate = new Promise<ScanReposResult>((r) => {
      resolveScan = r
    })
    const { svc } = makeService({ listRepos: () => [], scanRepos: () => gate })

    const a = svc.scan('mac', { deep: false, atPath: '/a' })
    const b = svc.scan('mac', { deep: false, atPath: '/b' })
    expect(b).not.toBe(a) // different folders → independent scans, not a shared result
    resolveScan(scanResult([]))
    await Promise.all([a, b])
  })

  it('never fires the connect trigger for the local machine and throttles repeats', () => {
    vi.useFakeTimers()
    try {
      const scanRepos = vi.fn(
        async (
          _roots: string[],
          _opts: { includeHome?: boolean; maxDepth?: number },
          _machineId: string,
        ): Promise<ScanReposResult> => scanResult([]),
      )
      const { svc } = makeService({
        listRepos: () => [row('hub', '/home/u/src/x')],
        scanRepos,
        now: () => Date.now(),
      })

      svc.onMachineConnected('local')
      vi.advanceTimersByTime(10_000)
      expect(scanRepos).not.toHaveBeenCalled()

      svc.onMachineConnected('mac')
      svc.onMachineConnected('mac') // reconnect burst — throttled
      vi.advanceTimersByTime(10_000)
      expect(scanRepos.mock.calls.filter((c) => c[2] === 'mac').length).toBeGreaterThanOrEqual(1)
      const callsAfterFirst = scanRepos.mock.calls.length
      svc.onMachineConnected('mac')
      vi.advanceTimersByTime(10_000)
      expect(scanRepos.mock.calls.length).toBe(callsAfterFirst)
    } finally {
      vi.useRealTimers()
    }
  })
})
