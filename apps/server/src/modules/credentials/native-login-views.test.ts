import { asCredentialId, asMachineId, asUserId, type CredentialView } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import type { NativeLoginState } from './native-login-actions'
import { withNativeLoginViews } from './native-login-views'

const OWNER = asUserId('user:owner')
const fp = 'found-login-fingerprint'
const id = asMachineId
const view = (over: Partial<CredentialView> = {}): CredentialView => ({
  id: asCredentialId('cred_found'), ownerUserId: OWNER, label: 'Found Codex',
  type: 'openai.chatgpt-login', identity: { fingerprint: fp }, status: 'ok',
  access: 'owner', homes: [], allowedMachines: [], sessionCount: 0, ...over,
})
const machine = (name: string, state: 'in' | 'out' | 'unknown', fingerprint?: string, online = true) => ({
  id: id(name), name, online,
  inventory: { agents: [{ kind: 'codex', installed: true, login: { state, ...(fingerprint ? { identity: { fingerprint } } : {}) } }] },
})
function fixture(enabled = false) {
  const machines = [machine('source', 'in', fp), machine('empty', 'out'), machine('occupied', 'in', 'other'), machine('offline', 'in', fp, false), machine('shared', 'in', fp)]
  const state = {
    store: { nativeLogins: {
      optInsFor: vi.fn(async () => [{ harness: 'codex', fingerprint: fp, enabled }]),
      transfersFor: vi.fn(async () => [{ harness: 'codex', fingerprint: fp, machineId: id('occupied'), outcome: 'preserved' }, { harness: 'codex', fingerprint: fp, machineId: id('shared'), outcome: 'preserved' }]),
    } },
    machineService: { listMachines: vi.fn(async () => machines) },
    machineStanding: vi.fn(async () => new Map(machines.map((m) => [m.id, m.name === 'shared' ? 'use' : 'custody']))),
    nativeLogin: { attempt: vi.fn(), isRequired: vi.fn(() => false) },
  }
  return { state: state as unknown as NativeLoginState, machines }
}

describe('native controls on found-login credentials', () => {
  it('preserves the old tick, kept-login warning and attempt facts on the credential row', async () => {
    const { state } = fixture(true)
    const attempt = { sessionId: 'login', machineId: id('empty'), machineName: 'empty', status: 'running' as const }
    vi.mocked(state.nativeLogin.attempt).mockReturnValue(attempt)
    const [row] = await withNativeLoginViews([view()], state, OWNER)
    // The previous accounts row carried these same facts for this identity.
    const previous = { harness: 'codex', useOnMyMachines: true, keptOn: [{ id: id('occupied'), name: 'occupied' }], loginAttempt: attempt }
    const answer = { harness: row?.nativeLogin?.harness, useOnMyMachines: row?.nativeLogin?.useOnMyMachines, keptOn: row?.nativeLogin?.keptOn, loginAttempt: row?.nativeLogin?.attempt }
    expect(answer).toEqual(previous)
    expect(() => expect({ ...answer, useOnMyMachines: false }).toEqual(previous)).toThrow()
    expect(row?.nativeLogin?.machines.map((m) => m.id)).toEqual([id('source'), id('empty')])
    expect(row?.nativeLogin?.required).toBe(true)
  })
  it('does not expose controls to a use holder, manager or a revoked/key credential', async () => {
    const { state } = fixture()
    for (const row of [view({ access: 'use' }), view({ access: 'manage' }), view({ status: 'revoked' }), view({ type: 'openai.api-key' })]) {
      expect((await withNativeLoginViews([row], state, OWNER))[0]).not.toHaveProperty('nativeLogin')
    }
  })
  it('offers a signed-out repair after the original machine no longer reports an identity', async () => {
    const { state, machines } = fixture()
    machines.splice(0, machines.length, machine('empty', 'out'))
    const [row] = await withNativeLoginViews([view()], state, OWNER)
    expect(row?.nativeLogin).toMatchObject({ required: true, machines: [{ id: id('empty'), state: 'out' }] })
    expect(row?.nativeLogin).not.toHaveProperty('useOnMyMachines')
  })
  it('allows an enabled choice to be turned off when its source is offline', async () => {
    const { state, machines } = fixture(true)
    for (const machine of machines) machine.online = false
    expect((await withNativeLoginViews([view()], state, OWNER))[0]?.nativeLogin).toMatchObject({ machines: [], useOnMyMachines: true })
  })
  it('does not grow database reads with the number of credential rows', async () => {
    const { state } = fixture()
    await withNativeLoginViews(Array.from({ length: 200 }, () => view()), state, OWNER)
    expect(state.store.nativeLogins.optInsFor).toHaveBeenCalledTimes(1)
    expect(state.store.nativeLogins.transfersFor).toHaveBeenCalledTimes(1)
    expect(state.machineService.listMachines).toHaveBeenCalledTimes(1)
  })
})
