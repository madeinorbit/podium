import { asMachineId, asRepoId } from '@podium/model/browser'
import { autorun } from 'mobx'
import { expect, it } from 'vitest'
import { headerEntities } from './header-entities'
import { MobxPool } from './pool'
import {
  baseBranchChoices,
  newTaskBase,
  podiumDefaultLabel,
  repositoryScanOf,
} from './repo-base-branch'
import { SettingsRepositories } from './settings-repositories'
import { type SidebarSections, sidebarView } from './worklist/sidebar'

it('resolves a new task base as repository base, then Podium default, then auto-detect', () => {
  expect(newTaskBase('release', 'tf.dev')).toEqual({ branch: 'release', source: 'repo' })
  expect(newTaskBase(null, 'tf.dev')).toEqual({ branch: 'tf.dev', source: 'podium' })
  expect(newTaskBase('  ', ' tf.dev ')).toEqual({ branch: 'tf.dev', source: 'podium' })
  expect(newTaskBase(undefined, '')).toEqual({ branch: null, source: 'auto' })
  expect(podiumDefaultLabel('tf.dev')).toBe('tf.dev')
  expect(podiumDefaultLabel(' ')).toBe('auto-detect')
  expect(podiumDefaultLabel(undefined)).toBe('auto-detect')
})

it('offers the stored base, the checkout branch and non-task worktree branches, sorted and deduplicated', () => {
  const scan = {
    branch: 'main',
    worktrees: [
      { path: '/r/a', branch: 'issue/12-thing' },
      { path: '/r/b', branch: 'tf.dev' },
      { path: '/r/c', branch: 'main' },
      { path: '/r/d' },
    ],
  }
  expect(baseBranchChoices(scan, 'release')).toEqual(['main', 'release', 'tf.dev'])
  expect(baseBranchChoices(undefined, null)).toEqual([])
  // A stacked task's parent is a task branch: the stored value stays listed.
  expect(baseBranchChoices(scan, 'issue/12-thing')).toEqual(['issue/12-thing', 'main', 'tf.dev'])
})

it('finds the checkout a base-branch write goes through and follows a remote base change', () => {
  const p = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  const machineId = asMachineId('host'),
    repoId = asRepoId('project')
  try {
    p.apply({
      type: 'update',
      rows: [
        {
          kind: 'repo',
          id: repoId,
          value: { id: repoId, prefix: 'POD', defaultParentBranch: null, path: '/repo' } as never,
        },
      ],
    })
    headerEntities(p).apply([
      {
        kind: 'repository',
        id: 'other',
        value: { kind: 'repository', machineId, path: '/elsewhere', worktrees: [] },
      },
      {
        kind: 'repository',
        id: 'scan',
        value: {
          kind: 'repository',
          machineId,
          path: '/repo',
          repoId,
          branch: 'main',
          worktrees: [],
        },
      },
    ])
    expect(repositoryScanOf(p, repoId, '/repo')?.machineId).toBe(machineId)
    // Another checkout of the same repo answers when the path differs; a path alone never does.
    expect(repositoryScanOf(p, repoId, '/moved')?.path).toBe('/repo')
    expect(repositoryScanOf(p, asRepoId('unknown'), '/elsewhere')).toBeUndefined()

    const row = new SettingsRepositories(p).rows.find((r) => r.path === '/repo')!
    const seen: (string | null)[] = []
    const stop = autorun(() => seen.push(row.defaultParentBranch))
    p.apply({
      type: 'update',
      rows: [
        {
          kind: 'repo',
          id: repoId,
          value: {
            id: repoId,
            prefix: 'POD',
            defaultParentBranch: 'release',
            path: '/repo',
          } as never,
        },
      ],
    })
    expect(seen).toEqual([null, 'release'])
    stop()
  } finally {
    p.dispose()
  }
})

it('tells apart unrelated repos at the same path on two machines', () => {
  const p = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  const one = asMachineId('one'),
    two = asMachineId('two')
  const a = asRepoId('repo-a'),
    b = asRepoId('repo-b')
  try {
    headerEntities(p).apply([
      {
        kind: 'repository',
        id: 'a',
        value: { kind: 'repository', machineId: one, path: '/src/app', repoId: a, worktrees: [] },
      },
      {
        kind: 'repository',
        id: 'b',
        value: { kind: 'repository', machineId: two, path: '/src/app', repoId: b, worktrees: [] },
      },
    ])
    expect(repositoryScanOf(p, a, '/src/app')?.machineId).toBe(one)
    expect(repositoryScanOf(p, b, '/src/app')?.machineId).toBe(two)
  } finally {
    p.dispose()
  }
})

it('gives every same-path band its own repository, through the sidebar pipeline', () => {
  const NOW = Date.parse('2026-10-26T12:00:00Z')
  const p = new MobxPool({ selectedIssueId: null, coarseNow: NOW })
  const [a, b, c] = [asRepoId('repo-a'), asRepoId('repo-b'), asRepoId('repo-c')]
  const [one, two, three] = [asMachineId('one'), asMachineId('two'), asMachineId('three')]
  const at = new Date(NOW).toISOString()
  const issue = (id: string, repoId: string) => ({
    kind: 'issue' as const,
    id,
    value: {
      id,
      seq: id.length,
      title: id,
      repoId,
      repoPath: '/src/app',
      stage: 'in_progress',
      audience: 'human',
      createdAt: at,
      updatedAt: at,
    } as never,
  })
  try {
    p.apply({
      type: 'replace',
      rows: [
        ...[a, b, c].map((id) => ({
          kind: 'repo' as const,
          id,
          value: { id, prefix: null, defaultParentBranch: null, repoPath: '/src/app' } as never,
        })),
        // One root lane per path: only repo-a seeds a band from the scan.
        {
          kind: 'worktree',
          id: '/src/app',
          value: { path: '/src/app', repoPath: '/src/app', repoName: 'app', repoId: a } as never,
        },
        // repo-c reaches the sidebar only through a worktree roster.
        {
          kind: 'worktree',
          id: '/src/app/.wt/c',
          value: {
            path: '/src/app/.wt/c',
            repoPath: '/src/app',
            repoName: 'app',
            repoId: c,
            projectRoot: false,
          } as never,
        },
        {
          kind: 'session',
          id: 'free',
          value: {
            sessionId: 'free',
            cwd: '/src/app/.wt/c',
            issueId: null,
            agentKind: 'codex',
            status: 'live',
            lastActiveAt: at,
          } as never,
        },
        issue('task-a', a),
        issue('task-b', b),
      ],
    })
    headerEntities(p).apply([
      {
        kind: 'repository',
        id: 'sa',
        value: { kind: 'repository', machineId: one, path: '/src/app', repoId: a, worktrees: [] },
      },
      {
        kind: 'repository',
        id: 'sb',
        value: { kind: 'repository', machineId: two, path: '/src/app', repoId: b, worktrees: [] },
      },
      {
        kind: 'repository',
        id: 'sc',
        value: { kind: 'repository', machineId: three, path: '/src/app', repoId: c, worktrees: [] },
      },
    ])
    let sections!: SidebarSections
    const stop = autorun(() => {
      sections = sidebarView(p).sections()
    })
    try {
      const bands = Object.fromEntries(sections.bands.map((band) => [band.key, band]))
      for (const [repoId, machineId] of [
        [a, one],
        [b, two],
        [c, three],
      ] as const) {
        const band = bands[repoId]
        expect(band?.repoId).toBe(repoId)
        expect(repositoryScanOf(p, band!.repoId!, band!.repoPath)?.machineId).toBe(machineId)
      }
    } finally {
      stop()
    }
  } finally {
    p.dispose()
  }
})
