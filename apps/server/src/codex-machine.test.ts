import { asMachineId, asUserId, type HarnessAgent, Inventory } from '@podium/model'
import { describe, expect, it } from 'vitest'
import {
  codexAuthorizerFor,
  codexLoginMachines,
  pickCodexMachine,
  type CodexLoginMachine,
  type CodexLoginMachineSource,
} from './codex-machine'
import { LlmConfigError } from './llm-error'

const VERSION = 'test-server-version'

function source(
  id: string,
  opts: {
    login?: 'in' | 'out'
    online?: boolean
    appVersion?: string | null
    revoked?: boolean
    name?: string
    kind?: string
  } = {},
): CodexLoginMachineSource {
  return {
    id: asMachineId(id),
    name: opts.name ?? id,
    revokedAt: opts.revoked ? '2026-09-28T00:00:00.000Z' : null,
    inventory: Inventory.parse({
      os: 'linux',
      arch: 'x64',
      agents: [
        {
          kind: opts.kind ?? 'codex',
          installed: true,
          login: { state: opts.login ?? 'in' },
        },
      ],
    }),
    appVersion: opts.appVersion ?? null,
  }
}

const allowAll = () => undefined
const denyAll = (id: unknown) => `no access to ${String(id)}`

describe('codexLoginMachines', () => {
  it('excludes revoked rows and projects login/online/version', () => {
    const out = codexLoginMachines(
      [
        source('a', { login: 'in', appVersion: 'v1' }),
        source('b', { login: 'out' }),
        source('c', { revoked: true }),
      ],
      (id) => String(id) === asMachineId('a'),
      'codex' as HarnessAgent,
    )
    expect(out).toEqual([
      { id: asMachineId('a'), name: 'a', loginConnected: true, online: true, appVersion: 'v1' },
      { id: asMachineId('b'), name: 'b', loginConnected: false, online: false, appVersion: null },
    ])
  })

  it('matches the harness it is given, not a baked-in kind', () => {
    const out = codexLoginMachines(
      [source('a', { kind: 'claude-code' }), source('b', { kind: 'codex' })],
      () => true,
      'claude-code' as HarnessAgent,
    )
    expect(out.find((m) => String(m.id) === 'a')?.loginConnected).toBe(true)
    expect(out.find((m) => String(m.id) === 'b')?.loginConnected).toBe(false)
  })
})

describe('pickCodexMachine', () => {
  const machine = (
    id: string,
    opts: { online?: boolean; appVersion?: string | null; name?: string } = {},
  ): CodexLoginMachine => ({
    id: asMachineId(id),
    name: opts.name ?? id,
    loginConnected: true,
    online: opts.online ?? true,
    appVersion: opts.appVersion ?? VERSION,
  })

  it('prefers the default machine when it holds a usable login', () => {
    const picked = pickCodexMachine([machine('a'), machine('b')], {
      defaultMachineId: asMachineId('b'),
      authorize: allowAll,
    })
    expect(picked).toEqual({ machineId: asMachineId('b'), machineName: 'b' })
  })

  it('falls back deterministically by (name, id) when the default is unusable', () => {
    const picked = pickCodexMachine([machine('b'), machine('a')], {
      defaultMachineId: asMachineId('zzz'),
      authorize: allowAll,
    })
    expect(picked.machineId).toBe(asMachineId('a'))
  })

  it('does NOT pick a connected login on a machine the user may not use', () => {
    // User B's box is logged in to Codex; the requesting user is granted only
    // zzz-mine. The pick must land on zzz-mine — spending B's subscription
    // silently is the failure this guards. (aaa-b-box sorts FIRST, so without
    // the authorization filter this test picks the wrong machine.)
    const authorize = (id: { toString(): string }) =>
      String(id) === asMachineId('zzz-mine') ? undefined : 'you do not have access to use this machine'
    const picked = pickCodexMachine([machine('aaa-b-box'), machine('zzz-mine')], {
      authorize,
    })
    expect(picked).toEqual({ machineId: asMachineId('zzz-mine'), machineName: 'zzz-mine' })
  })

  it('names nothing when the only connected logins belong to other users', () => {
    let message = ''
    try {
      pickCodexMachine([machine('user-b-box')], { authorize: denyAll })
    } catch (err) {
      expect(err).toBeInstanceOf(LlmConfigError)
      message = (err as Error).message
    }
    expect(message).toMatch(/run `codex login`/)
    // The other user's machine name must not leak to the unauthorized caller.
    expect(message).not.toContain('user-b-box')
  })

  it('reports an offline picked machine by name (never a hang)', () => {
    expect(() =>
      pickCodexMachine([machine('desk', { online: false })], {
        authorize: allowAll,
      }),
    ).toThrowError(/Codex login on desk is offline/)
  })

  it('picks regardless of daemon version skew — newer and older daemons are still called', () => {
    // Deliberately NO version gate: daemons routinely update before the
    // server, and an older daemon may already have the handler. A daemon that
    // truly predates the frame is covered by the frame-guard arm and the
    // no-reply deadline, never by a pick-time refusal.
    const newer = pickCodexMachine([machine('ahead', { appVersion: 'v999-future' })], {
      authorize: allowAll,
    })
    expect(newer).toEqual({ machineId: asMachineId('ahead'), machineName: 'ahead' })
    const older = pickCodexMachine([machine('behind', { appVersion: 'v0.0.1-ancient' })], {
      authorize: allowAll,
    })
    expect(older).toEqual({ machineId: asMachineId('behind'), machineName: 'behind' })
  })

  it('proceeds when the daemon never reported a version (deadline message covers age)', () => {
    const picked = pickCodexMachine([machine('mystery', { appVersion: null })], {
      authorize: allowAll,
    })
    expect(picked).toEqual({ machineId: asMachineId('mystery'), machineName: 'mystery' })
  })
})

describe('codexAuthorizerFor', () => {
  const machines = {
    ownershipRows: async () => [{ id: asMachineId('m1'), name: 'm1', revokedAt: null, daemonAssigned: true, daemonAvailable: true }],
    grantsForMachine: async () => [],
  }

  it('refuses a non-admin outright', async () => {
    const authorize = await codexAuthorizerFor(
      { users: { get: async () => ({ role: 'member' }) as never }, machines },
      asUserId('u1'),
      'use',
    )
    expect(authorize(asMachineId('m1'))).toMatch(/admin account/)
  })

  it('names the refused action (start login vs use share one rule)', async () => {
    const admin = { get: async () => ({ role: 'admin' }) as never }
    const forLogin = await codexAuthorizerFor({ users: admin, machines }, asUserId('u1'), 'start login')
    const forUse = await codexAuthorizerFor({ users: admin, machines }, asUserId('u1'), 'use')
    // No grants: an admin owns nothing here, so both refuse — with their own noun.
    expect(forLogin(asMachineId('m1'))).toBe('you do not have access to start login on this machine')
    expect(forUse(asMachineId('m1'))).toBe('you do not have access to use on this machine')
  })
})
