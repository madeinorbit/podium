/**
 * findRepoOnMachine: identity, and a NO it can still say (POD-1571).
 *
 * The paths that run after a start — add-session, worktree recreate — must locate the
 * repository the target already has (two machines, two layouts) WITHOUT creating it.
 * A resolver that clones on absence would leave requireMachineForRepo unable to refuse
 * a machine that genuinely lacks the repository, which is worse than the bug.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionRegistry } from '../../relay'
import { SessionStore } from '../../store'

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

function rig() {
  const store = new SessionStore(':memory:')
  store.machines.upsertMachine({ id: 'src', name: 'src', hostname: 'src', tokenHash: 'x' })
  store.machines.upsertMachine({ id: 'tgt', name: 'tgt', hostname: 'tgt', tokenHash: 'y' })
  const reg = new SessionRegistry(store)
  return { store, sessions: reg.modules.sessions }
}

describe('SessionsService.findRepoOnMachine', () => {
  it('matches by origin identity across differing layouts', () => {
    const { store, sessions } = rig()
    store.repos.addRepo(SOURCE, 'src', ORIGIN)
    store.repos.addRepo(TARGET, 'tgt', ORIGIN)
    // The live refusal: SOURCE is not registered on tgt, but the repository is.
    expect(sessions.findRepoOnMachine(SOURCE, 'tgt')).toBe(TARGET)
  })

  it('says NO when the target has a DIFFERENT repository — nothing is created', () => {
    const { store, sessions } = rig()
    store.repos.addRepo(SOURCE, 'src', ORIGIN)
    store.repos.addRepo('/home/mgw/src/elsewhere', 'tgt', 'https://example.test/other.git')
    expect(sessions.findRepoOnMachine(SOURCE, 'tgt')).toBeNull()
    // and it did not register anything on the target while looking.
    expect(store.repos.listRepos('tgt').map((r) => r.path)).toEqual(['/home/mgw/src/elsewhere'])
  })

  it('says NO when the target has no repositories at all', () => {
    const { store, sessions } = rig()
    store.repos.addRepo(SOURCE, 'src', ORIGIN)
    expect(sessions.findRepoOnMachine(SOURCE, 'tgt')).toBeNull()
  })

  it('does not treat two unidentified checkouts as the same repository', () => {
    const { store, sessions } = rig()
    // No origin ⇒ no origin-derived identity. Matching on a null repoId would make
    // every unidentified checkout match every other one.
    store.repos.addRepo(SOURCE, 'src')
    store.repos.addRepo(TARGET, 'tgt')
    expect(sessions.findRepoOnMachine(SOURCE, 'tgt')).toBeNull()
  })

  it('returns the source path unchanged when the pin IS the source machine', () => {
    const { store, sessions } = rig()
    store.repos.addRepo(SOURCE, 'src', ORIGIN)
    expect(sessions.findRepoOnMachine(SOURCE, 'src')).toBe(SOURCE)
  })

  it('says NO for a path that is not a registered repository', () => {
    const { sessions } = rig()
    expect(sessions.findRepoOnMachine('/not/a/repo', 'tgt')).toBeNull()
  })
})
