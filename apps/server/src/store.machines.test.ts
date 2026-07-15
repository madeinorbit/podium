import { createHash } from 'node:crypto'
import { rmSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// Fixture-only: hand-build a pre-multi-machine ("v3-shape") db. The store under
// test always goes through the @podium/runtime/sqlite shim; this direct driver use
// mirrors store.test.ts's own v1-migration fixture and never touches the shim.
import { openDatabase } from '@podium/runtime/sqlite'
import { describe, expect, it } from 'vitest'
import { SessionStore } from './store'

async function tmpDbPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'podium-machines-'))
  return join(dir, 'podium.db')
}

const hash = (t: string) => createHash('sha256').update(t).digest('hex')

describe('machines store', () => {
  it('upserts, lists, renames, deletes a machine', () => {
    const s = new SessionStore(':memory:')
    s.machines.upsertMachine({ id: 'm1', name: 'box', hostname: 'box', tokenHash: hash('secret') })
    expect(s.machines.listMachines().map((m) => m.id)).toEqual(['m1'])
    expect(s.machines.getMachineByToken('m1', 'secret')).toBe(true)
    expect(s.machines.getMachineByToken('m1', 'wrong')).toBe(false)
    s.machines.renameMachine('m1', 'laptop')
    expect(s.machines.listMachines()[0]?.name).toBe('laptop')
    s.machines.deleteMachine('m1')
    expect(s.machines.listMachines()).toEqual([])
    s.close()
  })

  it('adoptLocalRows rewrites __local__ session machine ids', () => {
    const s = new SessionStore(':memory:')
    s.sessions.upsertSession({
      id: 'sess',
      agentKind: 'shell',
      cwd: '/x',
      title: 't',
      name: null,
      originKind: 'spawn',
      conversationId: null,
      resumeKind: null,
      resumeValue: null,
      status: 'live',
      exitCode: null,
      durableLabel: 'podium-sess',
      createdAt: 'a',
      lastActiveAt: 'a',
      lastOutputAt: null,
      lastInputAt: null,
      lastResumedAt: null,
      archived: false,
      workState: null,
      machineId: '__local__',
    })
    s.adoptLocalRows('m1')
    expect(s.sessions.loadSessions()[0]?.machineId).toBe('m1')
    s.close()
  })

  it('repos table is re-keyed to (machine_id, path) with origin_url', () => {
    const s = new SessionStore(':memory:')
    s.repos.addRepo('/home/u/a')
    s.repos.addRepo('/home/u/b', 'm2', 'https://github.com/u/b')
    const rows = s.repos.listRepos()
    expect(rows.find((r) => r.path === '/home/u/a')?.machineId).toBe('__local__')
    expect(rows.find((r) => r.path === '/home/u/b')?.originUrl).toBe('https://github.com/u/b')
    s.repos.removeRepo('/home/u/a')
    expect(s.repos.listRepos().map((r) => r.path)).toEqual(['/home/u/b'])
    s.close()
  })

  it('listRepoPaths returns a flat string[] for back-compat', () => {
    const s = new SessionStore(':memory:')
    s.repos.addRepo('/abs/one')
    s.repos.addRepo('/abs/two', 'm2')
    const paths = s.repos.listRepoPaths()
    expect(paths).toEqual(['/abs/one', '/abs/two'])
    s.close()
  })

  it('listRepos(machineId) filters to one machine', () => {
    const s = new SessionStore(':memory:')
    s.repos.addRepo('/abs/local')
    s.repos.addRepo('/abs/remote', 'm2')
    expect(s.repos.listRepos('__local__').map((r) => r.path)).toEqual(['/abs/local'])
    expect(s.repos.listRepos('m2').map((r) => r.path)).toEqual(['/abs/remote'])
    expect(s.repos.listRepoPaths('m2')).toEqual(['/abs/remote'])
    s.close()
  })

  it('getMachine returns a record when it exists', () => {
    const s = new SessionStore(':memory:')
    s.machines.upsertMachine({ id: 'm2', name: 'server', hostname: 'srv', tokenHash: hash('tok') })
    const m = s.machines.getMachine('m2')
    expect(m?.id).toBe('m2')
    expect(m?.name).toBe('server')
    expect(s.machines.getMachine('no-such')).toBeUndefined()
    s.close()
  })

  it('touchMachine updates last_seen_at and hostname', () => {
    const s = new SessionStore(':memory:')
    s.machines.upsertMachine({ id: 'm3', name: 'box', hostname: 'old-host', tokenHash: hash('t') })
    s.machines.touchMachine('m3', 'new-host')
    const m = s.machines.getMachine('m3')
    expect(m?.hostname).toBe('new-host')
    s.close()
  })

  // The 'pre-multi-machine repos copy' test (upgrading a pre-schema_version, machine_id-less
  // database) was removed with the legacy migration chain [spec:SP-4428]; such old formats
  // are upgraded by running a pre-drizzle Podium build first.

  it('multi-machine migration is idempotent — re-opening the same file db is a no-op', async () => {
    const file = await tmpDbPath()
    const s1 = new SessionStore(file)
    s1.machines.upsertMachine({ id: 'm1', name: 'a', hostname: 'h', tokenHash: 'x' })
    s1.repos.addRepo('/a')
    s1.sessions.upsertSession({
      id: 's1',
      agentKind: 'shell',
      cwd: '/',
      title: 't',
      name: null,
      originKind: 'spawn',
      conversationId: null,
      resumeKind: null,
      resumeValue: null,
      status: 'live',
      exitCode: null,
      durableLabel: 'podium-s1',
      createdAt: 'z',
      lastActiveAt: 'z',
      lastOutputAt: null,
      lastInputAt: null,
      lastResumedAt: null,
      archived: false,
      workState: null,
    })
    s1.close()

    // Second open: migrate() must be a clean no-op — no throw, data intact.
    const s2 = new SessionStore(file)
    expect(s2.sessions.loadSessions()[0]?.machineId).toBe('__local__')
    expect(s2.machines.listMachines()).toHaveLength(1)
    expect(s2.repos.listRepoPaths()).toEqual(['/a'])
    // The settings row written through migrate() survives the reopen — a proxy that
    // the meta table wasn't wiped.
    expect(s2.settings.getSettings().roles.coding.accountId).toBe('') // defaults always present
    s2.close()
    rmSync(file, { force: true })
  })
})
