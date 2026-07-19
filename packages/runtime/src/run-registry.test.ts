import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  isAlive,
  type KillFn,
  listLive,
  liveRecord,
  readRecord,
  reclaim,
  recordPath,
  registerProcess,
  removeRecord,
  runDir,
  writeRecord,
} from './run-registry'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'podium-runreg-'))
  process.env.PODIUM_STATE_DIR = dir
})
afterEach(() => {
  delete process.env.PODIUM_STATE_DIR
  rmSync(dir, { recursive: true, force: true })
})

/** A fake `process.kill`: a set of "alive" PIDs; SIGTERM/SIGKILL remove from it, signal 0 probes. */
function fakeKill(
  alive: Set<number>,
  opts: { ignoreSigterm?: number; eperm?: number } = {},
): KillFn {
  return (pid, signal) => {
    if (opts.eperm === pid) {
      const e = new Error('EPERM') as NodeJS.ErrnoException
      e.code = 'EPERM'
      throw e
    }
    if (signal === 0) {
      if (!alive.has(pid)) {
        const e = new Error('ESRCH') as NodeJS.ErrnoException
        e.code = 'ESRCH'
        throw e
      }
      return
    }
    if (signal === 'SIGTERM' && opts.ignoreSigterm === pid) return // stubborn: ignores TERM
    if (signal === 'SIGTERM' || signal === 'SIGKILL') alive.delete(pid)
  }
}

describe('pidfile read/write', () => {
  it('recognizes the janitor as an independently managed sibling', () => {
    writeRecord({ role: 'janitor', pid: 4322, mode: 'systemd', startedAt: 'T0' })
    expect(readRecord('janitor')?.role).toBe('janitor')
  })

  it('roundtrips a record', () => {
    writeRecord({ role: 'server', pid: 4321, port: 18787, mode: 'detached', startedAt: 'T0' })
    expect(readRecord('server')).toEqual({
      role: 'server',
      pid: 4321,
      port: 18787,
      mode: 'detached',
      startedAt: 'T0',
    })
  })
  it('returns undefined for a missing pidfile', () => {
    expect(readRecord('daemon')).toBeUndefined()
  })
  it('returns undefined for a corrupt pidfile', () => {
    mkdirSync(runDir(), { recursive: true })
    writeFileSync(recordPath('server'), 'not json{')
    expect(readRecord('server')).toBeUndefined()
  })
  it('removeRecord deletes it (and is a no-op when absent)', () => {
    writeRecord({ role: 'server', pid: 1, startedAt: 'T0' })
    removeRecord('server')
    expect(readRecord('server')).toBeUndefined()
    expect(() => removeRecord('server')).not.toThrow()
  })
})

describe('liveness', () => {
  it('isAlive: real self PID is alive, an unused high PID is not', () => {
    expect(isAlive(process.pid)).toBe(true)
    expect(isAlive(2147483000)).toBe(false)
  })
  it('isAlive: EPERM counts as alive (exists but not ours)', () => {
    expect(isAlive(42, fakeKill(new Set(), { eperm: 42 }))).toBe(true)
  })
  it('liveRecord returns the record only when the PID is alive', () => {
    writeRecord({ role: 'daemon', pid: 500, startedAt: 'T0' })
    expect(liveRecord('daemon', fakeKill(new Set([500])))?.pid).toBe(500)
    expect(liveRecord('daemon', fakeKill(new Set()))).toBeUndefined() // stale
  })
  it('listLive reports every role with a live process', () => {
    writeRecord({ role: 'server', pid: 10, startedAt: 'T0' })
    writeRecord({ role: 'daemon', pid: 20, startedAt: 'T0' })
    const live = listLive(fakeKill(new Set([10]))) // only server alive
    expect(live.map((r) => r.role)).toEqual(['server'])
  })
})

describe('reclaim', () => {
  const immediate = async (): Promise<void> => {}

  it('no live holder → reclaimed:false', async () => {
    expect(await reclaim('server', { kill: fakeKill(new Set()) })).toEqual({ reclaimed: false })
  })

  it('graceful: SIGTERM kills the holder, pidfile removed', async () => {
    writeRecord({ role: 'server', pid: 700, startedAt: 'T0' })
    const alive = new Set([700])
    const res = await reclaim('server', { kill: fakeKill(alive), sleepFn: immediate })
    expect(res).toEqual({ reclaimed: true, pid: 700 })
    expect(alive.has(700)).toBe(false)
    expect(readRecord('server')).toBeUndefined()
  })

  it('stubborn holder ignores SIGTERM → escalates to SIGKILL', async () => {
    writeRecord({ role: 'daemon', pid: 800, startedAt: 'T0' })
    const alive = new Set([800])
    const res = await reclaim('daemon', {
      kill: fakeKill(alive, { ignoreSigterm: 800 }),
      graceMs: 30,
      pollMs: 10,
      sleepFn: immediate,
    })
    expect(res.reclaimed).toBe(true)
    expect(alive.has(800)).toBe(false) // SIGKILL got it
  })

  it('unkillable holder (EPERM) throws rather than allow a double-run', async () => {
    writeRecord({ role: 'server', pid: 900, startedAt: 'T0' })
    await expect(
      reclaim('server', { kill: fakeKill(new Set([900]), { eperm: 900 }) }),
    ).rejects.toThrow(/not killable/)
  })
})

describe('registerProcess', () => {
  it('reclaims a stale holder and writes our own record', async () => {
    writeRecord({ role: 'server', pid: 111, startedAt: 'T0' }) // stale (dead)
    const cleanup = await registerProcess('server', {
      port: 18787,
      mode: 'detached',
      kill: fakeKill(new Set()), // 111 not alive → stale
      nowIso: () => 'NOW',
    })
    const rec = readRecord('server')
    expect(rec?.pid).toBe(process.pid)
    expect(rec?.port).toBe(18787)
    expect(rec?.startedAt).toBe('NOW')
    cleanup()
    expect(readRecord('server')).toBeUndefined()
  })

  it('cleanup does NOT remove a successor record (different pid)', async () => {
    const cleanup = await registerProcess('daemon', { kill: fakeKill(new Set()) })
    // A successor reclaimed us and wrote its own pidfile:
    writeRecord({ role: 'daemon', pid: process.pid + 1, startedAt: 'T1' })
    cleanup()
    expect(readRecord('daemon')?.pid).toBe(process.pid + 1) // untouched
  })

  it('creates the run dir on demand', async () => {
    rmSync(runDir(), { recursive: true, force: true })
    await registerProcess('all-in-one', { kill: fakeKill(new Set()) })
    expect(readRecord('all-in-one')?.role).toBe('all-in-one')
  })
})
