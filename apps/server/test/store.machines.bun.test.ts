// Run ONLY under `bun test` — proves the multi-machine store + migration behave
// identically on bun:sqlite (vitest excludes *.bun.test.ts; store.machines.test.ts
// is the node:sqlite mirror of this). The pre-multi-machine fixture is built through
// the same @podium/runtime/sqlite shim (bun:sqlite here) rather than a direct driver.

import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '@podium/runtime/sqlite'
import { SessionStore } from '../src/store'

const hash = (t: string) => createHash('sha256').update(t).digest('hex')

function tmpDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'podium-machines-bun-')), 'podium.db')
}

describe('machines store [bun:sqlite]', () => {
  it('machine CRUD + timing-safe token check', () => {
    const s = new SessionStore(':memory:')
    s.upsertMachine({ id: 'm1', name: 'box', hostname: 'box', tokenHash: hash('secret') })
    expect(s.listMachines().map((m) => m.id)).toEqual(['m1'])
    expect(s.getMachineByToken('m1', 'secret')).toBe(true)
    expect(s.getMachineByToken('m1', 'wrong')).toBe(false)
    s.touchMachine('m1', 'new-host')
    expect(s.getMachine('m1')?.hostname).toBe('new-host')
    s.deleteMachine('m1')
    expect(s.listMachines()).toEqual([])
    s.close()
  })

  it('repos are re-keyed (machine_id, path) and adoptLocalRows rewrites attribution', () => {
    const s = new SessionStore(':memory:')
    s.addRepo('/home/u/a')
    s.addRepo('/home/u/b', 'm2', 'https://github.com/u/b')
    expect(s.listRepos('m2')[0]?.originUrl).toBe('https://github.com/u/b')
    s.adoptLocalRows('m1')
    expect(s.listRepos('m1').map((r) => r.path)).toEqual(['/home/u/a'])
    s.close()
  })

  it('pre-multi-machine repos rebuild under bun:sqlite preserves rows as __local__', () => {
    const file = tmpDbPath()
    // Build a pre-multi-machine repos table (path PRIMARY KEY) through the shim.
    const db = openDatabase(file)
    db.exec('CREATE TABLE repos (path TEXT PRIMARY KEY, added_at TEXT NOT NULL)')
    db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    db.prepare('INSERT INTO repos (path, added_at) VALUES (?, ?)').run(
      '/projects/alpha',
      '2026-01-01T00:00:00.000Z',
    )
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', '3')
    db.close()

    const store = new SessionStore(file)
    const rows = store.listRepos()
    expect(rows.find((r) => r.path === '/projects/alpha')?.machineId).toBe('__local__')
    expect(rows.find((r) => r.path === '/projects/alpha')?.originUrl).toBeNull()
    store.addRepo('/projects/gamma')
    expect(store.listRepoPaths()).toContain('/projects/gamma')
    store.close()
    rmSync(file, { force: true })
  })
})
