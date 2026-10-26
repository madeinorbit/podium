/**
 * A REPOSITORY'S BASE BRANCH, AS THE WEB SHOWS IT [POD-2065].
 *
 * The server cuts a new task from, in order: the task's explicit parent, the
 * repository's base branch (`repo.defaultParentBranch`), the Podium-wide
 * `gitWorkflow.defaultParentBranch`, and — only when that is empty — whatever
 * it detects (main, master, or the checked-out branch). These helpers answer the
 * same order for the screens that show or edit it, so the sidebar picker, the
 * repositories settings and the new-task dialog never disagree with the server.
 */
import './requested-models'
import type { GitRepositoryWire } from '@podium/model'
import { here } from './lookup'
import type { MobxPool } from './pool'
import type { RepositoryModel } from './requested-models'

/** Where a new task's parent branch comes from when none is given. */
export type BaseBranchSource = 'repo' | 'podium' | 'auto'

export interface NewTaskBase {
  /** `null` when the server will detect it at create time. */
  readonly branch: string | null
  readonly source: BaseBranchSource
}

const named = (value: string | null | undefined): string | null => value?.trim() || null

/** The branch a new task in a repository will be cut from. */
export function newTaskBase(
  repoBase: string | null | undefined,
  podiumDefault: string | null | undefined,
): NewTaskBase {
  const repo = named(repoBase)
  if (repo) return { branch: repo, source: 'repo' }
  const podium = named(podiumDefault)
  if (podium) return { branch: podium, source: 'podium' }
  return { branch: null, source: 'auto' }
}

/** What "the Podium default" means right now: the configured name, or auto-detect. */
export const podiumDefaultLabel = (podiumDefault: string | null | undefined): string =>
  named(podiumDefault) ?? 'auto-detect'

/**
 * Branch names the picker can offer without asking the machine: the stored base,
 * the root checkout's branch and the branches its non-task worktrees have out.
 * Task branches (`issue/…`) are left out — a repository is never based on one
 * task's branch. The list is a convenience; the setter checks the name exists.
 */
export function baseBranchChoices(
  scan: Pick<GitRepositoryWire, 'branch' | 'worktrees'> | undefined,
  current: string | null | undefined,
): string[] {
  const names = new Set<string>()
  const add = (name: string | null | undefined) => {
    const value = named(name)
    if (value && !value.startsWith('issue/')) names.add(value)
  }
  add(current)
  add(scan?.branch)
  for (const worktree of scan?.worktrees ?? []) add(worktree.branch)
  return [...names].sort((a, b) => a.localeCompare(b))
}

/**
 * The per-machine checkout a base-branch write goes through: the scan of the
 * logical repo `repoId` at `path`, else another scan of that repo, else any scan
 * at `path`. `undefined` while no machine has reported it; the write then goes
 * out without a machine and the server picks one.
 */
export function repositoryScanOf(
  pool: MobxPool,
  repoId: string | null | undefined,
  path: string,
): RepositoryModel | undefined {
  const scans = [...pool.tables.repository.keys()].flatMap((id) => {
    const scan = here(pool.model('repository', id))
    return scan ? [scan] : []
  })
  const sameRepo = (scan: RepositoryModel) => Boolean(repoId) && scan.repoId === repoId
  return (
    scans.find((scan) => sameRepo(scan) && scan.path === path) ??
    scans.find(sameRepo) ??
    scans.find((scan) => scan.path === path)
  )
}
