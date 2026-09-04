import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { effectiveAssignment, fallbackAssignment, loadSupervisorState } from './machine-supervisor'

const dirs: string[] = []

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'podium-machine-supervisor-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('supervisor credential ownership', () => {
  it('imports the exact enrolled daemon identity once without changing the legacy copy', () => {
    const dir = stateDir()
    const legacy = {
      machineId: 'm_legacy',
      token: 'machine-token',
      updatePubkey: 'pinned-update-key',
    }
    writeFileSync(join(dir, 'daemon.json'), JSON.stringify(legacy))

    expect(loadSupervisorState(dir)).toEqual(legacy)
    expect(JSON.parse(readFileSync(join(dir, 'supervisor.json'), 'utf8'))).toEqual(legacy)
    expect(JSON.parse(readFileSync(join(dir, 'daemon.json'), 'utf8'))).toEqual(legacy)
    expect(statSync(join(dir, 'supervisor.json')).mode & 0o777).toBe(0o600)
  })

  it('never re-imports a legacy credential after supervisor state exists', () => {
    const dir = stateDir()
    writeFileSync(
      join(dir, 'supervisor.json'),
      JSON.stringify({ machineId: 'm_current', token: 'current-token' }),
    )
    writeFileSync(
      join(dir, 'daemon.json'),
      JSON.stringify({ machineId: 'm_legacy', token: 'legacy-token' }),
    )

    expect(loadSupervisorState(dir)).toMatchObject({
      machineId: 'm_current',
      token: 'current-token',
    })
  })
})

describe('supervisor service assignment', () => {
  it('preserves every supported local startup topology as the no-cache fallback', () => {
    expect(fallbackAssignment('server')).toEqual({ server: true, agentExecution: false })
    expect(fallbackAssignment('daemon')).toEqual({ server: false, agentExecution: true })
    expect(fallbackAssignment('all-in-one')).toEqual({ server: true, agentExecution: true })
    expect(fallbackAssignment('supervisor')).toEqual({ server: false, agentExecution: false })
  })

  it('lets the local lockout subtract agents but never add or remove the server', () => {
    expect(
      effectiveAssignment({
        configured: { server: true, agentExecution: true },
        agentExecutionLockout: true,
      }),
    ).toEqual({ server: true, agentExecution: false })
    expect(
      effectiveAssignment({
        configured: { server: false, agentExecution: false },
        agentExecutionLockout: false,
      }),
    ).toEqual({ server: false, agentExecution: false })
  })
})
