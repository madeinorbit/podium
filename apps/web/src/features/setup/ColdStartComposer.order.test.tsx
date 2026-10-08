import { indexedRepoUsageAt, reposToViews } from '@podium/client-core/values'
import { machinePathKey, type GitRepositoryWire } from '@podium/model/browser'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { useFirstTaskRepositoryPicker } from './ColdStartComposer'

afterEach(cleanup)
const repo = (path: string, extra = {}): GitRepositoryWire => ({
  path, kind: 'repository', worktrees: [], ...extra,
} as GitRepositoryWire)

// Frozen old recency formula on the same checkout fixtures.
function oldOrder(repos: GitRepositoryWire[], usage: ReadonlyMap<string, number>) {
  const times = new Map(repos.map(repo => [repo.path, indexedRepoUsageAt(repo, usage)]))
  const at = (view: ReturnType<typeof reposToViews>[number]) => Math.max(times.get(view.path) ?? 0,
    ...(view.machines ?? []).map(({ path }) => times.get(path) ?? 0))
  return reposToViews(repos).sort((a, b) => at(b) - at(a) ||
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
}

it('matches the old order on open, keeps identities still through usage and labels, and refreshes on reopen', () => {
  let repos = [repo('/work/alpha', { repoId: 'alpha' }), repo('/work/beta', { repoId: 'beta' })]
  let usage = new Map([[machinePathKey('/work/alpha'), 10], [machinePathKey('/work/beta'), 20]])
  const hook = renderHook(() => useFirstTaskRepositoryPicker(repos, usage))
  act(() => hook.result.current.onOpenChange(true))
  expect(hook.result.current.repoChoices).toEqual(oldOrder(repos, usage))
  const ids = () => hook.result.current.repoChoices.map(repo => repo.repoId)
  const opening = ids()
  usage = new Map([[machinePathKey('/work/alpha'), 50], [machinePathKey('/work/beta'), 20]])
  hook.rerender()
  expect(ids()).toEqual(opening)
  expect(ids()).not.toEqual(oldOrder(repos, usage).map(repo => repo.repoId))
  repos = [repo('/work/alpha', { repoId: 'alpha', originUrl: 'https://example.com/team/renamed.git' }), repos[1]!]
  hook.rerender()
  expect(ids()).toEqual(opening)
  expect(hook.result.current.repoChoices.find(repo => repo.repoId === 'alpha')?.name).toBe('renamed')
  act(() => hook.result.current.onOpenChange(false))
  act(() => hook.result.current.onOpenChange(true))
  expect(hook.result.current.repoChoices).toEqual(oldOrder(repos, usage))
})
