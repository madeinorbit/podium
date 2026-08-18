import { asMachineId } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '../../trpc'
import { repoCreateFolderHandler, repoCreateRepoHandler, repoRenameFolderHandler } from './handlers'

/**
 * The picker's write path (POD-1295), at the ONE layer that is the server's own
 * business. Validation and containment live on the daemon — it is the only side
 * that can see the filesystem — so what is asserted here is what only the server
 * knows: which refusals are its own, and when a created folder becomes a repo row.
 */

const MACHINE = asMachineId('m1')

function context(options: {
  dirOp: ReturnType<typeof vi.fn>
  repos?: string[]
  add?: ReturnType<typeof vi.fn>
}): Context {
  const registered = options.repos ?? []
  return {
    modules: { rpc: { dirOp: options.dirOp } },
    repos: {
      list: () => registered,
      add: options.add ?? vi.fn(async () => undefined),
    },
  } as unknown as Context
}

const ports = {} as never

describe('repos.createRepo', () => {
  it('registers what the daemon created', async () => {
    const dirOp = vi.fn(async () => ({ path: '/home/ada/planner' }))
    const add = vi.fn(async () => undefined)
    const result = await repoCreateRepoHandler({
      ctx: context({ dirOp, add }),
      input: { machineId: MACHINE, parentPath: '/home/ada', name: 'planner' },
      ports,
    })

    expect(dirOp).toHaveBeenCalledWith('createRepo', MACHINE, {
      parentPath: '/home/ada',
      name: 'planner',
    })
    expect(add).toHaveBeenCalledWith('/home/ada/planner', MACHINE)
    expect(result.path).toBe('/home/ada/planner')
  })

  /**
   * The case that makes `path` and `error` both meaningful: git could not run,
   * so the folder exists and is NOT a repository. Registering it would hand the
   * user a row that breaks on the first `git worktree add`.
   */
  it('refuses to register a folder git could not initialise', async () => {
    const dirOp = vi.fn(async () => ({
      path: '/home/ada/planner',
      error: 'git is not installed on ada-laptop',
    }))
    const add = vi.fn(async () => undefined)
    await expect(
      repoCreateRepoHandler({
        ctx: context({ dirOp, add }),
        input: { machineId: MACHINE, parentPath: '/home/ada', name: 'planner' },
        ports,
      }),
    ).rejects.toThrow('git is not installed on ada-laptop')
    expect(add).not.toHaveBeenCalled()
  })
})

describe('repos.createFolder', () => {
  it('creates without registering anything', async () => {
    const dirOp = vi.fn(async () => ({ path: '/home/ada/projects' }))
    const add = vi.fn(async () => undefined)
    const result = await repoCreateFolderHandler({
      ctx: context({ dirOp, add }),
      input: { machineId: MACHINE, parentPath: '/home/ada', name: 'projects' },
      ports,
    })
    expect(result.path).toBe('/home/ada/projects')
    expect(add).not.toHaveBeenCalled()
  })

  it('passes the daemon refusal through as the message', async () => {
    const dirOp = vi.fn(async () => ({ error: '"projects" is already here' }))
    await expect(
      repoCreateFolderHandler({
        ctx: context({ dirOp }),
        input: { machineId: MACHINE, parentPath: '/home/ada', name: 'projects' },
        ports,
      }),
    ).rejects.toThrow('already here')
  })
})

describe('repos.renameFolder', () => {
  it('renames a folder Podium has never heard of', async () => {
    const dirOp = vi.fn(async () => ({ path: '/home/ada/sources' }))
    const result = await repoRenameFolderHandler({
      ctx: context({ dirOp, repos: ['/home/ada/other'] }),
      input: { machineId: MACHINE, parentPath: '/home/ada', currentName: 'src', name: 'sources' },
      ports,
    })
    expect(result.path).toBe('/home/ada/sources')
    expect(dirOp).toHaveBeenCalledWith('renameFolder', MACHINE, {
      parentPath: '/home/ada',
      name: 'sources',
      currentName: 'src',
    })
  })

  /**
   * Repo rows are keyed `(machine_id, path)`. A rename Podium cannot follow
   * leaves them pointing at a path that no longer exists, with no event to tell
   * anyone — so the rename is refused BEFORE the daemon is asked to do it.
   */
  it('refuses a registered repo root, without asking the machine', async () => {
    const dirOp = vi.fn(async () => ({ path: '/home/ada/renamed' }))
    await expect(
      repoRenameFolderHandler({
        ctx: context({ dirOp, repos: ['/home/ada/myrepo'] }),
        input: {
          machineId: MACHINE,
          parentPath: '/home/ada',
          currentName: 'myrepo',
          name: 'renamed',
        },
        ports,
      }),
    ).rejects.toThrow('registered in Podium')
    expect(dirOp).not.toHaveBeenCalled()
  })

  it('refuses a folder that merely CONTAINS a registered repo', async () => {
    const dirOp = vi.fn(async () => ({ path: '/home/ada/renamed' }))
    await expect(
      repoRenameFolderHandler({
        ctx: context({ dirOp, repos: ['/home/ada/code/myrepo'] }),
        input: { machineId: MACHINE, parentPath: '/home/ada', currentName: 'code', name: 'work' },
        ports,
      }),
    ).rejects.toThrow('/home/ada/code/myrepo')
    expect(dirOp).not.toHaveBeenCalled()
  })

  /** The counterfactual for the prefix check: `/home/ada/codex` is not inside
   *  `/home/ada/code`, and a naive `startsWith` would say it was. */
  it('does not mistake a sibling with a shared prefix for a child', async () => {
    const dirOp = vi.fn(async () => ({ path: '/home/ada/work' }))
    await repoRenameFolderHandler({
      ctx: context({ dirOp, repos: ['/home/ada/codex'] }),
      input: { machineId: MACHINE, parentPath: '/home/ada', currentName: 'code', name: 'work' },
      ports,
    })
    expect(dirOp).toHaveBeenCalled()
  })
})
