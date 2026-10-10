import type { RepoView } from '@podium/client-core/values'
import { EntityModel } from '../models'
import { here } from '../lookup'

/** Verification-only wire shape; every public field and ordering is compared. */
export function launchRepositoryFacts(repo: RepoView | undefined, project = false) {
  if (!repo) return repo
  return {
    path: repo.path, name: repo.name,
    ...(repo.originUrl !== undefined ? { originUrl: repo.originUrl } : {}),
    ...(repo.repoId !== undefined ? { repoId: repo.repoId } : {}),
    machines: repo.machines.map(machine => ({ machineId: machine.machineId, path: machine.path })),
    worktrees: repo.worktrees.map(tree => ({
      path: tree.path, repoPath: tree.repoPath, isMain: tree.isMain,
      ...(tree.branch !== undefined ? { branch: tree.branch } : {}),
      ...(tree.machineId !== undefined ? { machineId: tree.machineId } : {}),
      ...(tree.repoId !== undefined ? { repoId: tree.repoId } : {}),
      ...(project ? {
        repoName: 'repoName' in tree ? tree.repoName : undefined,
        sessions: 'sessions' in tree ? tree.sessions : undefined,
        issues: 'issues' in tree ? tree.issues : undefined,
      } : {}),
    })),
  }
}
export function machineFacts(machine: object) {
  return machine instanceof EntityModel ? here(machine.row) : machine
}
