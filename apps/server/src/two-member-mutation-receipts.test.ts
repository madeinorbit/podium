import { asMutationId, asSessionId, mintDeviceId } from '@podium/model'
import { afterAll, beforeAll, expect, it } from 'vitest'
import {
  MEMBERS,
  startTwoMemberInstance,
  type TwoMemberInstance,
} from './test-support/two-member-instance'

let f: TwoMemberInstance
beforeAll(async () => {
  f = await startTwoMemberInstance()
}, 60_000)
afterAll(async () => await f?.close())

it('a create mutation id belongs to its caller: another member creates and replays their own session', async () => {
  const mutationId = asMutationId(mintDeviceId('mut_'))
  const create = async (member: 'alice' | 'bob') =>
    await (await f.as(member)).trpc.sessions.create.mutate({
      mutationId,
      machineId: f.machines[member],
      agentKind: 'shell',
      cwd: `/wt/${member}-receipt`,
    })

  const alice = await create('alice')
  const bob = await create('bob')
  expect(bob.sessionId).not.toBe(alice.sessionId)
  for (const [member, created] of [['alice', alice], ['bob', bob]] as const) {
    const row = await f.handle.registry.sessionStore.sessions.getSession(asSessionId(created.sessionId))
    expect(row).toMatchObject({ ownerUserId: MEMBERS[member].id, machineId: f.machines[member] })
    expect((await create(member)).sessionId).toBe(created.sessionId)
    expect(
      f.daemonFrames(f.machines[member]).filter(
        (frame) => frame.type === 'spawn' && frame.sessionId === created.sessionId,
      ),
    ).toHaveLength(1)
  }
})
