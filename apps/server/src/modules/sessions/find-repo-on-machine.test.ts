/**
 * findRepoOnMachine: identity, and a NO it can still say (POD-1571).
 *
 * The paths that run after a start — add-session, worktree recreate — must locate the
 * repository the target already has (two machines, two layouts) WITHOUT creating it.
 * A resolver that clones on absence would leave requireMachineForRepo unable to refuse
 * a machine that genuinely lacks the repository, which is worse than the bug.
 */

import { asMachineId } from '@podium/model'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionRegistry } from '../../relay'
import { openTestStore } from '../../test-support/open-test-store'

const ORIGIN = 'https://example.test/podium.git'
const SOURCE = '/home/mgw/src/other/podium'
const TARGET = '/home/mgw/src/podium'

let stateDir: string
let priorStateDir: string | undefined

beforeEach(() => {
  priorStateDir = process.env.PODIUM_STATE_DIR
  stateDir = mkdtempSync(join(tmpdir(), 'pod-findrepo-'))
  process.env.PODIUM_STATE_DIR = stateDir
})

afterEach(() => {
  if (priorStateDir === undefined) delete process.env.PODIUM_STATE_DIR
  else process.env.PODIUM_STATE_DIR = priorStateDir
  rmSync(stateDir, { recursive: true, force: true })
})

async function rig() {
  const store = await openTestStore(':memory:')
  const machine = { ownerUserId: null }
  await store.machines.upsertMachine({
    id: 'src',
    name: 'src',
    hostname: 'src',
    tokenHash: 'x',
    ...machine,
  })
  await store.machines.upsertMachine({
    id: 'tgt',
    name: 'tgt',
    hostname: 'tgt',
    tokenHash: 'y',
    ...machine,
  })
  const reg = SessionRegistry.create(store, undefined, { instanceId: 'default' })
  return { store, sessions: reg.modules.sessions }
}

describe('SessionWorkspace.findRepoOnMachine', () => {
  it('matches by origin identity across differing layouts', async () => {
    const { store, sessions } = await rig()
    await store.repos.addRepo(SOURCE, asMachineId('src'), ORIGIN)
    await store.repos.addRepo(TARGET, asMachineId('tgt'), ORIGIN)
    // The live refusal: SOURCE is not registered on tgt, but the repository is.
    expect(sessions.workspace.findRepoOnMachine(SOURCE, asMachineId('tgt'))).toBe(TARGET)
  })

  it('says NO when the target has a DIFFERENT repository — nothing is created', async () => {
    const { store, sessions } = await rig()
    await store.repos.addRepo(SOURCE, asMachineId('src'), ORIGIN)
    await store.repos.addRepo(
      '/home/mgw/src/elsewhere',
      asMachineId('tgt'),
      'https://example.test/other.git',
    )
    expect(sessions.workspace.findRepoOnMachine(SOURCE, asMachineId('tgt'))).toBeNull()
    // and it did not register anything on the target while looking.
    expect((await store.repos.listRepos(asMachineId('tgt'))).map((r) => r.path)).toEqual([
      '/home/mgw/src/elsewhere',
    ])
  })

  it('says NO when the target has no repositories at all', async () => {
    const { store, sessions } = await rig()
    await store.repos.addRepo(SOURCE, asMachineId('src'), ORIGIN)
    expect(sessions.workspace.findRepoOnMachine(SOURCE, asMachineId('tgt'))).toBeNull()
  })

  it('does not treat two unidentified checkouts as the same repository', async () => {
    const { store, sessions } = await rig()
    // No origin ⇒ no origin-derived identity. Matching on a null repoId would make
    // every unidentified checkout match every other one.
    await store.repos.addRepo(SOURCE, asMachineId('src'))
    await store.repos.addRepo(TARGET, asMachineId('tgt'))
    expect(sessions.workspace.findRepoOnMachine(SOURCE, asMachineId('tgt'))).toBeNull()
  })

  it('returns the source path unchanged when the pin IS the source machine', async () => {
    const { store, sessions } = await rig()
    await store.repos.addRepo(SOURCE, asMachineId('src'), ORIGIN)
    expect(sessions.workspace.findRepoOnMachine(SOURCE, asMachineId('src'))).toBe(SOURCE)
  })

  it('says NO for a path that is not a registered repository', async () => {
    const { sessions } = await rig()
    expect(sessions.workspace.findRepoOnMachine('/not/a/repo', asMachineId('tgt'))).toBeNull()
  })
})
