import { asMachineId, asSessionId, asUserId } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import {
  currentReadScope,
  inExplicitReadScope,
  readScopeSlot,
} from '../../store/executor/read-scope'
import { EventBus } from '../bus'
import { NativeLoginService } from './native-login'

const SESSION = asSessionId('login-session')
const MACHINE = asMachineId('machine-a')
const OWNER = asUserId('user:operator')

function fixture(opts?: {
  authorizerFor?: () => (machineId: typeof MACHINE) => string | undefined
}) {
  const bus = new EventBus()
  let login: 'in' | 'out' = 'out'
  const machine = () => ({
    id: MACHINE,
    name: 'Alpha',
    online: true,
    inventory: {
      os: 'linux',
      arch: 'x64',
      tools: [],
      agents: [
        { kind: 'codex', installed: true, login: { state: login } },
        { kind: 'claude-code', installed: true, login: { state: login } },
      ],
    },
  })
  const toMachine = vi.fn()
  const createSession = vi.fn(() => ({
    sessionId: SESSION,
    agentId: SESSION,
    harness: 'shell',
    model: null,
    effort: null,
    machine: 'Alpha',
    machineId: 'machine-a',
    accountId: null,
  }))
  const service = new NativeLoginService({
    bus,
    machines: { listMachines: () => [machine()], toMachine } as never,
    sessions: { createSession } as never,
    // SETUP ONLY (POD-3257 / spec rule 18): `authorize` became `authorizerFor`,
    // which resolves the owner once and returns the per-machine check.
    authorizerFor: opts?.authorizerFor ?? (() => () => undefined),
    cwdForMachine: () => '/repo',
  })
  return {
    bus,
    service,
    createSession,
    toMachine,
    setLogin: (state: 'in' | 'out') => (login = state),
  }
}

describe('NativeLoginService', () => {
  it('holds one grant snapshot for a login pass and re-reads on the next pass', () => {
    let granted = true
    const grantSnapshot = readScopeSlot(() => granted)
    const f = fixture({
      authorizerFor: () => () => {
        const allowed = inExplicitReadScope() ? currentReadScope().slot(grantSnapshot) : granted
        granted = false
        return allowed ? undefined : 'fresh grant snapshot taken mid-pass'
      },
    })

    expect(() =>
      f.service.start({
        harness: 'codex',
        ownerUserId: OWNER,
      }),
    ).not.toThrow()
    expect(() =>
      f.service.start({
        harness: 'claude-code',
        machineId: MACHINE,
        ownerUserId: OWNER,
      }),
    ).toThrow('fresh grant snapshot taken mid-pass')
    expect(f.createSession).toHaveBeenCalledTimes(1)
  })

  it('starts one purpose-labelled shell PTY from the harness manifest lane', () => {
    const f = fixture()
    const attempt = f.service.start({
      harness: 'codex',
      machineId: MACHINE,
      ownerUserId: OWNER,
    })

    expect(attempt).toMatchObject({ sessionId: SESSION, machineName: 'Alpha', status: 'running' })
    expect(f.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        agentKind: 'shell',
        loginHarness: 'codex',
        cwd: '/repo',
        title: 'codex login',
        machineId: 'machine-a',
      }),
    )
  })

  it('refreshes inventory on exit and reports the observed login result', () => {
    const f = fixture()
    f.service.start({ harness: 'codex', ownerUserId: OWNER })

    f.bus.emit('session.exited', { sessionId: SESSION, code: 0 })
    expect(f.toMachine).toHaveBeenCalledWith('machine-a', { type: 'inventoryRequest' })
    expect(f.service.attempt('codex')?.status).toBe('refreshing')

    f.bus.emit('machine.metadataChanged', { machineId: asMachineId('machine-a') })
    expect(f.service.attempt('codex')?.status).toBe('refreshing')

    f.setLogin('in')
    f.bus.emit('machine.metadataChanged', { machineId: asMachineId('machine-a'), inventory: true })
    expect(f.service.attempt('codex')?.status).toBe('succeeded')
  })
})
