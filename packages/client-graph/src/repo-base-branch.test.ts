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
