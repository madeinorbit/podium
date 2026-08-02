import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readOrCreateDaemonSecret, readOrCreateLocalMachineId } from './local-machine'

const dirs: string[] = []
const stateDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'podium-machine-id-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/**
 * The host machine's identity file (POD-318). These are the properties the rest of
 * the system is allowed to assume: the id is MINTED, it is STABLE, and two processes
 * on the same host that both start cold end up with ONE of them.
 */
describe('readOrCreateLocalMachineId', () => {
  it('mints once and reuses forever — a second boot is not a second machine', () => {
    const dir = stateDir()
    const first = readOrCreateLocalMachineId(dir)

    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(readOrCreateLocalMachineId(dir)).toBe(first)
    expect(readFileSync(join(dir, 'machine.id'), 'utf8')).toBe(first)
  })

  it('is never one of the retired sentinels', () => {
    // The counterfactual that makes "minted" mean something: the values this
    // replaced are not in the output space at all, in any state dir.
    for (let i = 0; i < 8; i++) {
      const id = readOrCreateLocalMachineId(stateDir())
      expect(id).not.toBe('local')
      expect(id).not.toBe('__local__')
    }
  })

  it('is per state dir, so two instances on one host are two machines', () => {
    expect(readOrCreateLocalMachineId(stateDir())).not.toBe(
      readOrCreateLocalMachineId(stateDir()),
    )
  })

  it('the wx loser re-reads the winner: a cold server+daemon race yields ONE identity', () => {
    // The real race is two processes calling this at the same moment. It is
    // simulated at the only point where it can diverge — the write — by planting
    // the "other process's" file after this call has already decided to mint,
    // which is exactly the state `wx` fails on.
    const dir = stateDir()
    const winner = 'e7f2b1c0-1111-4222-8333-444455556666'
    writeFileSync(join(dir, 'machine.id'), winner, { mode: 0o600 })

    expect(readOrCreateLocalMachineId(dir)).toBe(winner)
    // …and the loser did not clobber it on the way past.
    expect(readFileSync(join(dir, 'machine.id'), 'utf8')).toBe(winner)
  })

  it('creates the state dir and writes owner-only', () => {
    const dir = join(stateDir(), 'not-yet-there')
    const id = readOrCreateLocalMachineId(dir)

    expect(readFileSync(join(dir, 'machine.id'), 'utf8')).toBe(id)
    expect(statSync(join(dir, 'machine.id')).mode & 0o777).toBe(0o600)
  })

  it('lives beside the bootstrap secret without either standing in for the other', () => {
    // Split mode reads BOTH from this one dir: the id it presents, and the secret
    // it presents it WITH. Rotating the credential must not change who the host is.
    const dir = stateDir()
    const id = readOrCreateLocalMachineId(dir)
    const secret = readOrCreateDaemonSecret(dir)

    expect(secret).not.toBe(id)
    rmSync(join(dir, 'daemon.secret'))
    expect(readOrCreateDaemonSecret(dir)).not.toBe(secret)
    expect(readOrCreateLocalMachineId(dir)).toBe(id)
  })
})
