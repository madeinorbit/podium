/**
 * MU-11: ACCESS CHANGES TAKE EFFECT AT THEIR COMMIT (POD-6293; design §2.1,
 * §4.5, acceptance matrix MU-11).
 *
 * Disabling Bob, demoting Alice, signing Bob out and ending a delegation each
 * close or rescope the person's live connections from the commit of the change
 * itself, and work queued before the change is refused when it is dispatched.
 * Bob's daemon reconnecting after Bob is disabled gets none of the work queued
 * for him while it was away.
 *
 * Each test boots its own instance: these tests change who may act.
 */

import { asDelegationRef } from '@podium/protocol'
import {
  actorAgent,
  actorUser,
  agentIdentityFromSessionId,
  asSessionId,
  type SessionId,
  type UserId,
} from '@podium/model'
import { afterEach, expect, it } from 'vitest'
import type { ClientConn } from './gateway/client-registry'
import type { InboxPrincipalReference } from './modules/sessions/inbox'
import { startTwoMemberInstance, type TwoMemberInstance } from './test-support/two-member-instance'

const instances: TwoMemberInstance[] = []
afterEach(async () => {
  for (const instance of instances.splice(0)) await instance.close()
})
async function boot(): Promise<TwoMemberInstance> {
  const instance = await startTwoMemberInstance()
  instances.push(instance)
  return instance
}

/** Every `/client` connection the server holds for this member, right now. */
const connectionsOf = (inst: TwoMemberInstance, member: UserId): ClientConn[] =>
  [...inst.handle.registry.clientGateway.registry.values()].filter(
    (conn) => conn.principal.user === member,
  )

/** Input a member queued into their own session, as the inbox stores it. */
const queuedBy = (member: UserId): InboxPrincipalReference => ({
  kind: 'user',
  principalRef: member,
  delegation: null,
  attribution: { actor: actorUser(member), onBehalfOf: member },
})

/** The dispatch gate every queued row passes before it reaches the daemon. */
const dispatch = (
  inst: TwoMemberInstance,
  sessionId: SessionId,
  principal: InboxPrincipalReference,
  queuedAt: number,
) =>
  inst.handle.registry.modules.sessions.authorizeQueuedInputAtApply({
    sessionId,
    principal,
    sourceMessageId: null,
    queuedAt,
  })

const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

it('disabling Bob closes his live feed in the commit and refuses what he queued', async () => {
  const inst = await boot()
  const { alice, bob } = inst.members
  const feed = await (await inst.as('bob')).feed()
  expect(connectionsOf(inst, bob.id)).toHaveLength(1)
  const queuedAt = Date.now()
  expect(await dispatch(inst, inst.sessions.bob, queuedBy(bob.id), queuedAt)).toEqual({ ok: true })
  await tick()

  await inst.handle.registry.sessionStore.users.disable(bob.id, new Date().toISOString(), alice.id)

  // Gone by the time the disable returns: the commit's own publication closed
  // it, not the next heartbeat (15 s) or credential sweep.
  expect(connectionsOf(inst, bob.id)).toEqual([])
  await feed.until(() => feed.closed(), 2000)
  // Queued before the disable: refused at dispatch, and it stays refused when
  // Bob is enabled again, because it was authorized under rights that changed.
  expect(await dispatch(inst, inst.sessions.bob, queuedBy(bob.id), queuedAt)).toMatchObject({
    ok: false,
  })
  await inst.handle.registry.sessionStore.users.enable(bob.id, new Date().toISOString(), alice.id)
  expect(await dispatch(inst, inst.sessions.bob, queuedBy(bob.id), queuedAt)).toEqual({
    ok: false,
    reason: 'access changed after this was queued',
  })
  // Work Bob queues after he is back goes through.
  await tick()
  expect(await dispatch(inst, inst.sessions.bob, queuedBy(bob.id), Date.now())).toEqual({
    ok: true,
  })
  // His old cookie went with the disable, so the socket cannot come back.
  await expect(inst.feedWith((await inst.as('bob')).cookie)).rejects.toThrow()
})

it('demoting Alice rescopes her open connection and refuses what she queued as admin', async () => {
  const inst = await boot()
  const { alice, bob } = inst.members
  const users = inst.handle.registry.sessionStore.users
  // The last admin cannot be demoted, so Bob becomes the second one first.
  await expect(users.setRole(alice.id, 'member', alice.id)).rejects.toThrow(
    'The last administrator cannot be demoted',
  )
  await users.setRole(bob.id, 'admin', alice.id)

  const feed = await (await inst.as('alice')).feed()
  const listings = () =>
    feed.frames.flatMap((frame) =>
      frame.type === 'machinesChanged' ? [frame.machines.map((machine) => machine.id).sort()] : [],
    )
  await feed.until(() => listings().length > 0)
  // As an admin, Alice sees every machine.
  expect(listings().at(-1)).toEqual([inst.machines.alice, inst.machines.bob].sort())
  const queuedAt = Date.now()
  await tick()
  const seen = listings().length

  await users.setRole(alice.id, 'member', bob.id)

  // The same connection, still open, now carries Alice's member role.
  const [conn] = connectionsOf(inst, alice.id)
  expect(conn?.principal.role).toBe('member')
  expect(feed.closed()).toBe(false)
  // Her machine listing is re-sent under the new role: only her own machine.
  await feed.until(() => listings().length > seen)
  expect(listings().at(-1)).toEqual([inst.machines.alice])
  // What she queued while she was an admin is refused at dispatch.
  expect(await dispatch(inst, inst.sessions.alice, queuedBy(alice.id), queuedAt)).toEqual({
    ok: false,
    reason: 'access changed after this was queued',
  })
  await tick()
  expect(await dispatch(inst, inst.sessions.alice, queuedBy(alice.id), Date.now())).toEqual({
    ok: true,
  })
})

it("signing Bob out closes that device's connection; signing out everywhere closes all of them", async () => {
  const inst = await boot()
  const { bob } = inst.members
  const first = await inst.as('bob')
  const second = await inst.login('bob')
  const secondCookie = second.headers.get('set-cookie')!.split(';', 1)[0]!
  const firstFeed = await first.feed()
  const secondFeed = await inst.feedWith(secondCookie)
  expect(connectionsOf(inst, bob.id)).toHaveLength(2)

  // One device signs out: only its own socket closes.
  expect((await first.fetch('/auth/logout', { method: 'POST' })).status).toBe(200)
  await firstFeed.until(() => firstFeed.closed(), 2000)
  expect(secondFeed.closed()).toBe(false)
  expect(connectionsOf(inst, bob.id)).toHaveLength(1)
  const queuedAt = Date.now()
  await tick()

  // Signing out everywhere closes the rest in the commit, and what was queued
  // before it is refused at dispatch.
  await inst.handle.registry.sessionStore.users.signOutEverywhere(bob.id, bob.id)
  expect(connectionsOf(inst, bob.id)).toEqual([])
  await secondFeed.until(() => secondFeed.closed(), 2000)
  await expect(inst.feedWith(secondCookie)).rejects.toThrow()
  expect(await dispatch(inst, inst.sessions.bob, queuedBy(bob.id), queuedAt)).toEqual({
    ok: false,
    reason: 'access changed after this was queued',
  })
})

it("ending a delegation refuses its agent's calls and the work queued under it", async () => {
  const inst = await boot()
  const { bob } = inst.members
  const sessionId = inst.sessions.bob
  const agentQueued: InboxPrincipalReference = {
    kind: 'agent',
    principalRef: sessionId,
    delegation: asDelegationRef(sessionId),
    attribution: { actor: actorAgent(agentIdentityFromSessionId(sessionId)), onBehalfOf: bob.id },
  }
  const edit = (text: string) =>
    inst.agent(sessionId).client.issues.update.mutate({
      id: inst.tasks.bob,
      patch: { description: text },
    })
  // While the delegation stands, the agent acts for Bob over the relay, and
  // its queued input into Bob's other session dispatches.
  await edit('while delegated')
  expect(await dispatch(inst, inst.sessions.bobOnAliceTask, agentQueued, Date.now())).toEqual({
    ok: true,
  })

  // Bob ends the session: its binding, and the delegation with it, retires.
  await inst.handle.registry.modules.sessions.killSession({ sessionId }).catch(() => {})

  await expect(edit('after the delegation ended')).rejects.toThrow()
  expect(await dispatch(inst, inst.sessions.bobOnAliceTask, agentQueued, Date.now())).toMatchObject({
    ok: false,
  })
})

it("Bob's daemon reconnecting after Bob is disabled gets none of his queued work", async () => {
  const inst = await boot()
  const { alice, bob } = inst.members
  const machines = inst.handle.registry.modules.machines
  const marker = 'typed-while-the-daemon-was-away'
  const before = inst.daemonFrames(inst.machines.bob).length

  await inst.reconnectDaemon(inst.machines.bob, async () => {
    // While the daemon is away, Bob types into his session and a retirement is
    // queued for it; both wait for the machine.
    machines.toMachine(inst.machines.bob, {
      type: 'input',
      sessionId: inst.sessions.bob,
      data: marker,
    })
    machines.toMachine(inst.machines.bob, { type: 'kill', sessionId: asSessionId(inst.sessions.bob) })
    await tick()
    await inst.handle.registry.sessionStore.users.disable(bob.id, new Date().toISOString(), alice.id)
  })

  const sent = inst.daemonFrames(inst.machines.bob).slice(before)
  // Fenced: Bob's typing never reaches the machine; the retirement still does.
  expect(sent.some((msg) => msg.type === 'input' && msg.data === marker)).toBe(false)
  expect(sent.some((msg) => msg.type === 'kill' && msg.sessionId === inst.sessions.bob)).toBe(true)
  // The daemon is back for everyone else, but Bob's agents act for nobody.
  expect(machines.hasDaemon(inst.machines.bob)).toBe(true)
  await expect(
    inst.agent(inst.sessions.bob).client.issues.update.mutate({
      id: inst.tasks.bob,
      patch: { description: 'from a fenced daemon' },
    }),
  ).rejects.toThrow()
})
