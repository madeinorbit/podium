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

/**
 * A repository that MOVED on its machine (POD-1498).
 *
 * The stale row blocks its own replacement: auto-registration refuses to add a second
 * copy of an origin already registered on the machine, and when the repo moves, the
 * stale row is what makes that true. Nothing prunes a path that stopped existing, so
 * the server serves a dead path forever — measured on vmi3407763 after its home moved
 * till -> mgw, where every placement died with "cannot change to /home/till/src/podium".
 *
 * This is the one operation in discovery that can DESTROY a registration, so the tests
 * that matter most are the ones proving it REFUSES.
 */
describe('moved-repo heal (POD-1498)', () => {
  const ORIGIN = 'git@github.com:o/podium.git'
  const OLD = '/home/till/src/podium'
  const NEW = '/home/mgw/src/podium'

  function movedService(opts: {
    pathExists?: (path: string, machineId: string) => Promise<boolean>
    found?: Array<{ path: string; originUrl?: string }>
  }) {
    const rows = [row('vmi', OLD, ORIGIN)]
    const removed: Array<{ path: string; machineId: string }> = []
    const added: Array<{ path: string; machineId: string; originUrl?: string }> = []
    const svc = new MachineRepoDiscovery({
      listRepos: () => rows,
      addRepo: (path, machineId, originUrl) => {
        added.push({ path, machineId, ...(originUrl ? { originUrl } : {}) })
      },
      removeRepo: (path, machineId) => {
        removed.push({ path, machineId })
        const i = rows.findIndex((r) => r.path === path && r.machineId === machineId)
        if (i >= 0) rows.splice(i, 1)
      },
      ...(opts.pathExists ? { pathExists: opts.pathExists } : {}),
      scanRepos: async () => scanResult(opts.found ?? [{ path: NEW, originUrl: ORIGIN }]),
      machineName: (id) => `name:${id}`,
      localMachineId: 'local',
    })
    return { svc, added, removed, rows }
  }

  it('REFUSES to prune a registered path that is absent from the scan but STILL ON DISK', async () => {
    // The dangerous case, and the one nobody writes by default. A scan walks only a
    // machine's registered ROOTS, so "not found by the scan" also covers "moved outside
    // the roots". Pruning on that inference would deregister a healthy repo — so the
    // probe, not the scan, decides.
    const probed: string[] = []
    const { svc, added, removed } = movedService({
      pathExists: async (path) => {
        probed.push(path)
        return true // still there — the scan simply could not see it
      },
    })
    await svc.scan('vmi', { deep: false })
    expect(probed).toContain(OLD)
    expect(removed, 'a healthy repo was deregistered on scan-coverage evidence').toEqual([])
    expect(added).toEqual([])
  })

  it('replaces the row when the path is GONE and exactly one same-origin path appears', async () => {
    const { svc, added, removed } = movedService({ pathExists: async () => false })
    await svc.scan('vmi', { deep: false })
    // REPLACE, not join: resolveRepoOnMachine takes the FIRST row by rowid, so leaving
    // the old row in place would keep the dead path winning.
    expect(removed).toEqual([{ path: OLD, machineId: 'vmi' }])
    expect(added).toEqual([{ path: NEW, machineId: 'vmi', originUrl: ORIGIN }])
  })

  it('carries the origin across, so the repoId stays origin-derived and still matches', async () => {
    // A path-fallback repoId would be machine-specific and resolveRepoOnMachine could
    // never match it against the other machine's copy.
    const { svc, added } = movedService({ pathExists: async () => false })
    await svc.scan('vmi', { deep: false })
    expect(added[0]?.originUrl).toBe(ORIGIN)
  })

  it('REFUSES to move when TWO same-origin candidates appear — that is ambiguity', async () => {
    const { svc, added, removed } = movedService({
      pathExists: async () => false,
      found: [
        { path: NEW, originUrl: ORIGIN },
        { path: '/home/mgw/bak_podium', originUrl: ORIGIN },
      ],
    })
    await svc.scan('vmi', { deep: false })
    expect(removed, 'picked one of two candidates instead of asking').toEqual([])
    expect(added).toEqual([])
  })

  it('REFUSES to move when the probe cannot answer — unreachable is not gone', async () => {
    const { svc, added, removed } = movedService({
      pathExists: async () => {
        throw new Error('daemon unreachable')
      },
    })
    await svc.scan('vmi', { deep: false })
    expect(removed).toEqual([])
    expect(added).toEqual([])
  })

  it('does nothing at all when no probe is wired — the heal is opt-in', async () => {
    const rows = [row('vmi', OLD, ORIGIN)]
    const removed: Array<{ path: string }> = []
    const svc = new MachineRepoDiscovery({
      listRepos: () => rows,
      addRepo: () => {},
      removeRepo: (path) => {
        removed.push({ path })
      },
      scanRepos: async () => scanResult([{ path: NEW, originUrl: ORIGIN }]),
      machineName: (id) => `name:${id}`,
      localMachineId: 'local',
    })
    await svc.scan('vmi', { deep: false })
    expect(removed).toEqual([])
  })

  it('never probes a repo the scan DID find — the probe is a round trip', async () => {
    const probed: string[] = []
    const rows = [row('vmi', NEW, ORIGIN)]
    const svc = new MachineRepoDiscovery({
      listRepos: () => rows,
      addRepo: () => {},
      removeRepo: () => {},
      pathExists: async (path) => {
        probed.push(path)
        return true
      },
      scanRepos: async () => scanResult([{ path: NEW, originUrl: ORIGIN }]),
      machineName: (id) => `name:${id}`,
      localMachineId: 'local',
    })
    await svc.scan('vmi', { deep: false })
    expect(probed).toEqual([])
  })
})
