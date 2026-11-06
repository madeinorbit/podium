import { afterEach, describe, expect, it, vi } from 'vitest'
import { disposeOracles, makeOracle, type Oracle } from '../sessions/oracle-support'
import { strandedRefusal } from './folder-effects'

/**
 * The picker's write path (POD-1295), at the ONE layer that is the server's own
 * business. Validation and containment live on the daemon — it is the only side
 * that can see the filesystem — so what is asserted here is what only the server
 * knows: which refusals are its own, and when a created folder becomes a repo row.
 *
 * Each write is an effect record since POD-6417 (`folder-effects.ts`): driven
 * here through the real routes of the composed server, which create the record
 * and answer its result.
 */

afterEach(() => disposeOracles())

async function oracle(): Promise<{ o: Oracle; machineId: Oracle['store']['hostMachineId'] }> {
  const o = await makeOracle()
  return { o, machineId: o.store.hostMachineId }
}

const dirOpAnswering = (o: Oracle, answer: { path?: string; error?: string }) =>
  vi.spyOn(o.reg.modules.rpc, 'dirOp').mockResolvedValue(answer as never)

describe('the capability guard in front of every dir op', () => {
  it('refuses before touching the daemon when the machine runs none', async () => {
    const { o, machineId } = await oracle()
    const dirOp = dirOpAnswering(o, { path: '/home/ada/planner' })
    vi.spyOn(o.reg.modules.machines, 'requireCapability').mockImplementation(() => {
      throw new Error("machine 'source' runs no Podium daemon and cannot host repositories")
    })
    await expect(
      o.call.repos.createRepo({ machineId, parentPath: '/home/ada', name: 'planner' }),
    ).rejects.toThrow(/runs no Podium daemon/)
    // THE POINT OF GUARDING HERE rather than letting the round trip fail: with
    // no daemon there is nobody to answer, so the call would sit in a queue
    // until the 35s timeout and come back as a generic failure.
    expect(dirOp).not.toHaveBeenCalled()
  })
})

describe('repos.createRepo', () => {
  it('registers what the daemon created', async () => {
    const { o, machineId } = await oracle()
    const dirOp = dirOpAnswering(o, { path: '/home/ada/planner' })
    const result = await o.call.repos.createRepo({
      machineId,
      parentPath: '/home/ada',
      name: 'planner',
    })

    expect(dirOp).toHaveBeenCalledWith('createRepo', machineId, {
      parentPath: '/home/ada',
      name: 'planner',
    })
    expect(await o.store.repos.listRepoPaths(machineId)).toContain('/home/ada/planner')
    expect(result.path).toBe('/home/ada/planner')
  })

  /**
   * The case that makes `path` and `error` both meaningful: git could not run,
   * so the folder exists and is NOT a repository. Registering it would hand the
   * user a row that breaks on the first `git worktree add`.
   */
  it('refuses to register a folder git could not initialise', async () => {
    const { o, machineId } = await oracle()
    dirOpAnswering(o, { path: '/home/ada/planner', error: 'git is not installed on ada-laptop' })
    await expect(
      o.call.repos.createRepo({ machineId, parentPath: '/home/ada', name: 'planner' }),
    ).rejects.toThrow('git is not installed on ada-laptop')
    expect(await o.store.repos.listRepoPaths(machineId)).not.toContain('/home/ada/planner')
  })
})

describe('repos.createFolder', () => {
  it('creates without registering anything', async () => {
    const { o, machineId } = await oracle()
    dirOpAnswering(o, { path: '/home/ada/projects' })
    const before = await o.store.repos.listRepoPaths(machineId)
    const result = await o.call.repos.createFolder({
      machineId,
      parentPath: '/home/ada',
      name: 'projects',
    })
    expect(result.path).toBe('/home/ada/projects')
    expect(await o.store.repos.listRepoPaths(machineId)).toEqual(before)
  })

  it('passes the daemon refusal through as the message, as a bad request', async () => {
    const { o, machineId } = await oracle()
    dirOpAnswering(o, { error: '"projects" is already here' })
    const error = await o.call.repos
      .createFolder({ machineId, parentPath: '/home/ada', name: 'projects' })
      .catch((e: unknown) => e)
    expect((error as Error).message).toContain('already here')
    expect((error as { code?: string }).code).toBe('BAD_REQUEST')
  })
})

describe('repos.renameFolder', () => {
  it('renames a folder Podium has never heard of', async () => {
    const { o, machineId } = await oracle()
    await o.store.repos.addRepo('/home/ada/other', machineId)
    const dirOp = dirOpAnswering(o, { path: '/home/ada/sources' })
    const result = await o.call.repos.renameFolder({
      machineId,
      parentPath: '/home/ada',
      currentName: 'src',
      name: 'sources',
    })
    expect(result.path).toBe('/home/ada/sources')
    expect(dirOp).toHaveBeenCalledWith('renameFolder', machineId, {
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
    const { o, machineId } = await oracle()
    await o.store.repos.addRepo('/home/ada/myrepo', machineId)
    const dirOp = dirOpAnswering(o, { path: '/home/ada/renamed' })
    await expect(
      o.call.repos.renameFolder({
        machineId,
        parentPath: '/home/ada',
        currentName: 'myrepo',
        name: 'renamed',
      }),
    ).rejects.toThrow('registered in Podium')
    expect(dirOp).not.toHaveBeenCalled()
  })

  it('refuses a folder that merely CONTAINS a registered repo', async () => {
    const { o, machineId } = await oracle()
    await o.store.repos.addRepo('/home/ada/code/myrepo', machineId)
    const dirOp = dirOpAnswering(o, { path: '/home/ada/renamed' })
    await expect(
      o.call.repos.renameFolder({
        machineId,
        parentPath: '/home/ada',
        currentName: 'code',
        name: 'work',
      }),
    ).rejects.toThrow('/home/ada/code/myrepo')
    expect(dirOp).not.toHaveBeenCalled()
  })
})

describe('the stranded-registration rule', () => {
  /** The counterfactual for the prefix check: `/home/ada/codex` is not inside
   *  `/home/ada/code`, and a naive `startsWith` would say it was. */
  it('does not mistake a sibling with a shared prefix for a child', () => {
    expect(strandedRefusal(['/home/ada/codex'], '/home/ada', 'code')).toBeUndefined()
  })

  it.each([
    ['/home/ada', '/home/ada/myrepo', '/home/ada/myrepo/nested'],
    ['C:\\Users\\Ada', 'c:/USERS/ada/myrepo', 'C:\\Users\\Ada\\myrepo\\nested'],
  ])('machine paths: folder rename protects repo registrations under %s', (parentPath, root, child) => {
    for (const registered of [root, child]) {
      expect(strandedRefusal([registered], parentPath, 'myrepo')).toMatch(/registered/)
    }
  })
})
