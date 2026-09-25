import type { MachineId, RepoId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import type { UnifiedWorkGroup } from './folds'
import type { RepoNavView, SidebarSections } from './nav'
import {
  mergeVisibleProjectOrder,
  orderedSidebarProjects,
  orderProjectGroups,
  orderProjectItems,
} from './project-order'

const repo = (path: string, repoId?: string, otherPath?: string): RepoNavView => ({
  path,
  name: path.split('/').pop() ?? path,
  worktrees: [],
  ...(repoId ? { repoId: repoId as RepoId } : {}),
  ...(otherPath ? { machines: [{ machineId: 'machine-2' as MachineId, path: otherPath }] } : {}),
})

const sections = (...repos: RepoNavView[]): SidebarSections => ({
  pinnedWorktrees: [],
  pinnedRepos: [],
  repos,
})

const group = (key: string): UnifiedWorkGroup => ({
  key,
  label: key,
  rows: [],
  snoozedRows: [],
  closedRows: [],
})

describe('project order', () => {
  it('keeps a project in place when its first task arrives', () => {
    const nav = sections(repo('/a'), repo('/b'))
    const groups = [group('/b'), group('/a')]
    const projects = orderedSidebarProjects(nav, groups, [])
    expect(orderProjectGroups(groups, projects).map((item) => item.key)).toEqual(['/a', '/b'])
    expect(
      orderProjectItems(
        [
          { key: '/b', kind: 'group' },
          { key: '/a', kind: 'empty' },
        ],
        projects,
        (item) => item.key,
      ).map((item) => item.key),
    ).toEqual(['/a', '/b'])
  })

  it('applies saved order by repo identity and appends newly registered projects', () => {
    const nav = sections(
      repo('/a', 'repo-a', '/other/a'),
      repo('/b', 'repo-b'),
      repo('/c', 'repo-c'),
    )
    const projects = orderedSidebarProjects(nav, [group('/other/a'), group('repo-b')], ['/b', '/a'])
    expect(projects.map((project) => project.key)).toEqual(['repo-b', 'repo-a', 'repo-c'])
    expect(
      orderProjectGroups([group('repo-a'), group('repo-b')], projects).map((item) => item.key),
    ).toEqual(['repo-b', 'repo-a'])
  })

  it('gives unregistered project groups a deterministic place', () => {
    const projects = orderedSidebarProjects(
      sections(repo('/registered')),
      [group('/z'), group('/a')],
      [],
    )
    expect(projects.map((project) => project.key)).toEqual(['/registered', '/a', '/z'])
  })

  it('keeps hidden saved projects in place while visible projects are reordered', () => {
    const projects = orderedSidebarProjects(
      sections(repo('/a', 'repo-a'), repo('/b', 'repo-b')),
      [],
      [],
    )
    expect(mergeVisibleProjectOrder([...projects].reverse(), ['/a', 'hidden', 'repo-b'])).toEqual([
      'repo-b',
      'hidden',
      'repo-a',
    ])
  })
})
