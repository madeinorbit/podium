/**
 * SOFTWARE UPDATE AND SERVER MOVE AS EFFECT RECORDS (ADR 12 D5 E3, POD-6358).
 *
 * The two kinds as the composed server registers them (`relay.ts`): who may ask,
 * what a record names, and that an update record waits for the server's ports
 * and then answers the old route's precondition as its own status.
 */

import { asMachineId, asMutationId, asUserId, mintDeviceId } from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import { systemPrincipal, userCommandPrincipal } from '../../command-principal'
import { SERVER_MOVE_EFFECT_KIND } from '../fleet/server-move-effect'
import { disposeOracles, makeOracle, type Oracle } from '../sessions/oracle-support'
import { appliedReply, envelope, submit } from '../sync-write/outbox-test-support'
import { updateStartPortsOf } from '../updates/trpc'
import { UPDATE_EFFECT_KIND, updateEffectTarget } from '../updates/update-effect'
import { operationIdForEffect } from './effects'

afterEach(() => disposeOracles())

const OTHER = asMachineId('other-box')

async function oracle(): Promise<Oracle> {
  return await makeOracle({ offlineMachines: [{ id: OTHER, name: 'Other box' }] })
}

const updateCreate = (o: Oracle, id: string, target = o.store.hostMachineId) =>
  envelope(
    'effects.create',
    { id, kind: UPDATE_EFFECT_KIND, target: updateEffectTarget(target), input: {} },
    `m-${crypto.randomUUID()}`,
  )

const moveCreate = (id: string) =>
  envelope(
    'effects.create',
    {
      id,
      kind: SERVER_MOVE_EFFECT_KIND,
      target: { kind: 'machine', id: OTHER },
      input: {
        targetMachineId: OTHER,
        publicUrl: 'https://podium.example.test',
        bindHost: '0.0.0.0',
        confirmation: 'TRANSFER SERVER',
      },
    },
    `m-${crypto.randomUUID()}`,
  )

async function submitAs(
  o: Oracle,
  env: ReturnType<typeof envelope>,
  principal: Parameters<Oracle['reg']['modules']['syncWrite']['submitDetailed']>[1],
) {
  return (await o.reg.modules.syncWrite.submitDetailed(env, principal, 'trpc')).reply
}

describe('the composed server registers both kinds', () => {
  it('serves server.update and server.move', async () => {
    const o = await oracle()
    const kinds = o.reg.modules.effects?.executors.kinds() ?? []
    expect(kinds).toContain(UPDATE_EFFECT_KIND)
    expect(kinds).toContain(SERVER_MOVE_EFFECT_KIND)
  })
})

describe('who may ask', () => {
  it('a server move needs an administrator who may manage the destination', async () => {
    const o = await oracle()
    const member = userCommandPrincipal(asUserId('usr_member_6358'), 'member')
    const refused = await submitAs(o, moveCreate(mintDeviceId('eff_')), member)
    expect(refused.outcome).toBe('rejected')
    const system = await submitAs(o, moveCreate(mintDeviceId('eff_')), systemPrincipal('test'))
    expect(system.outcome).toBe('rejected')
  })

  it('a server move must name its destination as its target', async () => {
    const o = await oracle()
    const env = moveCreate(mintDeviceId('eff_'))
    const input = env.input as { target: { kind: string; id: string } }
    input.target = { kind: 'machine', id: o.store.hostMachineId }
    const reply = await submit(o, env)
    expect(reply.outcome === 'rejected' && reply.refusal.kind).toBe('invalid')
  })

  it('an update is a person’s, never the system’s, and targets this server', async () => {
    const o = await oracle()
    const system = await submitAs(o, updateCreate(o, mintDeviceId('eff_')), systemPrincipal('test'))
    expect(system.outcome).toBe('rejected')
    const elsewhere = await submit(o, updateCreate(o, mintDeviceId('eff_'), OTHER))
    expect(elsewhere.outcome === 'rejected' && elsewhere.refusal.kind).toBe('invalid')
  })
})

describe('an update record', () => {
  it('waits pending for the server’s ports, then fails with the old route’s sentence when nothing is published', async () => {
    const o = await oracle()
    const effects = o.reg.modules.updateEffects
    if (effects === undefined) throw new Error('no update effects on the composed server')
    const id = mintDeviceId('eff_')
    appliedReply(await submit(o, updateCreate(o, id)))
    await o.reg.modules.effects?.runner.idle()
    // No ports yet (the server binds them at boot): it stays pending, unclaimed.
    expect((await o.store.effects.get(id))?.status).toBe('pending')
    expect((await o.store.effects.get(id))?.attempts).toBe(0)

    effects.bindPorts(
      updateStartPortsOf({
        registry: o.reg,
        modules: o.reg.modules,
        capability: { role: 'admin' },
        principal: userCommandPrincipal(asUserId('usr_admin_6358'), 'admin'),
        serverPlacement: { kind: 'fleet', machineId: o.store.hostMachineId },
      } as unknown as Parameters<typeof updateStartPortsOf>[0]),
    )
    for (let i = 0; i < 100 && (await o.store.effects.get(id))?.status === 'pending'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    await o.reg.modules.effects?.runner.idle()
    const row = await o.store.effects.get(id)
    expect(row?.status).toBe('failed')
    expect(row?.error?.code).toBe('precondition')
    expect(row?.error?.message).toMatch(/published/)
    expect(await o.reg.modules.operations.engine.get(operationIdForEffect(id))).toBeUndefined()
  })
})

describe('a mutation id is the record’s, not the operation’s', () => {
  it('a replayed create is the same record and never a second operation', async () => {
    const o = await oracle()
    const id = mintDeviceId('eff_')
    const env = { ...updateCreate(o, id), mutationId: asMutationId(`m-${id}`) }
    appliedReply(await submit(o, env))
    expect(appliedReply(await submit(o, env)).replayed).toBe(true)
  })
})

describe('the old routes answer through the records', () => {
  it('machines.moveServer starts a server.move record and answers its operation', async () => {
    const o = await oracle()
    const answer = await o.call.machines.moveServer({
      targetMachineId: OTHER,
      publicUrl: 'https://podium.example.test',
      bindHost: '0.0.0.0',
      confirmation: 'TRANSFER SERVER',
    })
    expect(answer.started).toBe(true)
    const operationId = answer.started ? answer.operationId : ''
    expect(operationId).toMatch(/^op_eff_/)
    const record = await o.store.effects.get(operationId.replace(/^op_/, ''))
    expect(record).toMatchObject({
      kind: SERVER_MOVE_EFFECT_KIND,
      target: { kind: 'machine', id: OTHER },
      result: { operationId },
    })
    expect((await o.reg.modules.operations.engine.get(operationId))?.kind).toBe('server-move')
  })
})
