/**
 * "UNINSTALL PODIUM" AS A machine.uninstall RECORD (managed installs §12 item 14).
 *
 * Through the composed server: the route creates the record, the executor asks
 * the machine's daemon through its RPC (stubbed here: the one boundary these
 * tests do not cross), and the machine is removed only once its daemon answered.
 */

import { asMachineId } from '@podium/model'
import { CAP_MACHINE_UNINSTALL } from '@podium/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { disposeOracles, makeOracle, type Oracle } from '../sessions/oracle-support'
import { MACHINE_UNINSTALL_KIND } from './uninstall-effect'

afterEach(() => {
  vi.restoreAllMocks()
  return disposeOracles()
})

const OTHER = asMachineId('build-box')

async function oracle(): Promise<Oracle> {
  return await makeOracle({ offlineMachines: [{ id: OTHER, name: 'build box' }] })
}

/** The other machine's daemon is connected and offers `caps`. */
function connected(o: Oracle, caps: readonly string[] = [CAP_MACHINE_UNINSTALL]) {
  vi.spyOn(o.reg.modules.machines, 'daemonSupports').mockImplementation(
    (id, cap) => id === OTHER && caps.includes(cap),
  )
}

async function revokedAt(o: Oracle, id: string) {
  return (await o.reg.modules.machines.listMachines()).find((machine) => machine.id === id)
    ?.revokedAt
}

describe('machines.uninstall', () => {
  it('asks the daemon, answers its outcomes, then removes the machine', async () => {
    const o = await oracle()
    connected(o)
    const outcomes = [
      { harness: 'claude', file: '/home/me/.claude.json', status: 'restored' as const },
    ]
    const ask = vi
      .spyOn(o.reg.modules.rpc, 'machineUninstall')
      .mockResolvedValue({ ok: true, outcomes, removesState: true })
    const answer = await o.call.machines.uninstall({ id: OTHER })
    expect(ask).toHaveBeenCalledWith(OTHER, {})
    expect(answer).toMatchObject({ outcomes, removesState: true })
    expect(await revokedAt(o, OTHER)).toBeTruthy()
    const record = await o.store.effects.newestOnTarget(
      MACHINE_UNINSTALL_KIND,
      { kind: 'machine', id: OTHER },
      'succeeded',
    )
    expect(record?.status).toBe('succeeded')
  })

  it('passes force on', async () => {
    const o = await oracle()
    connected(o)
    const ask = vi
      .spyOn(o.reg.modules.rpc, 'machineUninstall')
      .mockResolvedValue({ ok: true, outcomes: [], removesState: true })
    await o.call.machines.uninstall({ id: OTHER, force: true })
    expect(ask).toHaveBeenCalledWith(OTHER, { force: true })
  })

  it('keeps the machine when its daemon refuses', async () => {
    const o = await oracle()
    connected(o)
    vi.spyOn(o.reg.modules.rpc, 'machineUninstall').mockResolvedValue({
      ok: false,
      error: 'The Podium app runs Podium on this machine.',
    })
    await expect(o.call.machines.uninstall({ id: OTHER })).rejects.toThrow('Podium app')
    expect(await revokedAt(o, OTHER)).toBeFalsy()
  })

  it('refuses an offline or too-old daemon without asking it', async () => {
    const o = await oracle()
    connected(o, [])
    const ask = vi.spyOn(o.reg.modules.rpc, 'machineUninstall')
    await expect(o.call.machines.uninstall({ id: OTHER })).rejects.toThrow('podium uninstall')
    expect(ask).not.toHaveBeenCalled()
    expect(await revokedAt(o, OTHER)).toBeFalsy()
  })

  it('never uninstalls the machine this server runs on', async () => {
    const o = await oracle()
    const host = o.store.hostMachineId
    vi.spyOn(o.reg.modules.machines, 'daemonSupports').mockReturnValue(true)
    const ask = vi.spyOn(o.reg.modules.rpc, 'machineUninstall')
    await expect(o.call.machines.uninstall({ id: host })).rejects.toThrow('runs the server')
    expect(ask).not.toHaveBeenCalled()
  })
})
