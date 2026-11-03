/**
 * MACHINES AND DELEGATION WITH TWO PEOPLE (POD-6286; design §2.4, gaps 8 and 9,
 * MU-10).
 *
 * On the two-member fixture (POD-6282): Alice (admin) holds custody of
 * `machine-alice`, Bob (member) of `machine-bob`. Bob's agent `bobOnAliceTask`
 * runs on Alice's task, on Bob's machine.
 *
 * - At connect a daemon names the sessions it holds and the server answers with
 *   their facts. Alice's machine learns nothing about Bob's sessions by naming
 *   them, unless one is placed on her machine (it runs there already).
 * - Every session Bob's agents author acts for Bob: a child his agent spawns on
 *   Alice's task, on Alice's machine, is Bob's.
 * - MU-10: task access never grants machine use; a `use` grant never grants
 *   session access; an unowned machine runs nothing; an admin taking custody is
 *   audited as a takeover.
 *
 * The tests run in order and build on each other: Bob gets `use` on Alice's
 * machine only after the "task access grants no machine use" tests, and admin
 * Alice takes Bob's machine last.
 */

import { randomUUID } from 'node:crypto'
import { asMachineId, type MachineId, type SessionId } from '@podium/model'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { userCommandPrincipal } from './command-principal'
import { sha256 } from './modules/machines/enrollment'
import { inboxPrincipalFromCommand } from './modules/sessions/inbox'
import { attachDaemonWithInventory } from './test-support/daemon-inventory'
import {
  MEMBERS,
  REPO_PATH,
  startTwoMemberInstance,
  type TwoMemberInstance,
} from './test-support/two-member-instance'

let f: TwoMemberInstance
/** A machine no one holds custody of, with a daemon attached and the repo reported. */
const ORPHAN = asMachineId('machine-orphan')

beforeAll(async () => {
  f = await startTwoMemberInstance()
  const store = f.handle.registry.sessionStore
  // A hello credential for each machine, so a test can connect as it.
  for (const machineId of [f.machines.alice, f.machines.bob]) {
    await store.machines.upsertMachine({
      id: machineId,
      name: machineId,
      hostname: machineId,
      tokenHash: sha256(tokenOf(machineId)),
      ownerUserId: null,
      assignment: { server: false, agentExecution: true },
    })
  }
  await store.machines.upsertMachine({
    id: ORPHAN,
    name: ORPHAN,
    hostname: ORPHAN,
    tokenHash: sha256(tokenOf(ORPHAN)),
    ownerUserId: null,
    assignment: { server: false, agentExecution: true },
  })
  await store.repos.addRepo(REPO_PATH, ORPHAN)
  await attachDaemonWithInventory(f.handle.registry, ORPHAN)
}, 60_000)
afterAll(async () => {
  await f?.close()
})

function tokenOf(machineId: MachineId): string {
  return `${machineId}-hello-token`
}

const machines = () => f.handle.registry.modules.machines
const sessions = () => f.handle.registry.modules.sessions
// biome-ignore lint/suspicious/noExplicitAny: tRPC procedures addressed by one loose handle
const trpc = async (who: 'alice' | 'bob'): Promise<any> => (await f.as(who)).trpc
const UNKNOWN = { owner: null, machineId: null, closed: false }
/** A run refused for want of `use`: a member who may not even see the machine is
 *  told it is unknown; an admin, who sees every machine, is told why. */
const NO_USE = /unknown machine|do not have access to run agents/

/** Connect as `machineId`'s daemon, naming `ids` as the sessions it holds. */
async function connect(machineId: MachineId, ids: readonly string[]) {
  const result = await machines().authenticateDaemon(
    { type: 'hello', machineId, token: tokenOf(machineId), hostname: machineId },
    { bindingSessionIds: ids },
  )
  if (!result.ok) throw new Error(`hello refused: ${result.reason}`)
  return result
}

describe('gap 8: the session inventory a machine gets at connect', () => {
  it('Alice’s machine never receives Bob’s session facts, even when it names them', async () => {
    const { alice, bob, bobOnAliceTask } = f.sessions
    const result = await connect(f.machines.alice, [alice, bob, bobOnAliceTask, 'no-such-session'])
    // Bob's sessions answer exactly as an id that does not exist.
    expect(result.bindingConfirmations).toEqual({
      [alice]: expect.objectContaining({ owner: MEMBERS.alice.id, machineId: f.machines.alice }),
      [bob]: UNKNOWN,
      [bobOnAliceTask]: UNKNOWN,
      'no-such-session': UNKNOWN,
    })
    expect(JSON.stringify(result)).not.toContain(MEMBERS.bob.id)
    expect(result.legacyBindingOwners).toEqual({ [alice]: MEMBERS.alice.id })
  })

  it('control: Bob’s machine receives the facts of Bob’s own sessions, delegation included', async () => {
    const { bob, bobOnAliceTask } = f.sessions
    const result = await connect(f.machines.bob, [bob, bobOnAliceTask])
    for (const id of [bob, bobOnAliceTask]) {
      expect(result.bindingConfirmations?.[id]).toMatchObject({
        owner: MEMBERS.bob.id,
        machineId: f.machines.bob,
        closed: false,
        delegation: { onBehalfOf: MEMBERS.bob.id },
      })
    }
  })

  it('an unowned machine learns only about sessions placed on it', async () => {
    const result = await connect(ORPHAN, [f.sessions.alice, f.sessions.bob])
    expect(result.bindingConfirmations).toEqual({
      [f.sessions.alice]: UNKNOWN,
      [f.sessions.bob]: UNKNOWN,
    })
  })
})

describe('MU-10: task access never grants machine use', () => {
  beforeAll(async () => {
    // Bob may read and edit Alice's task. Until member-wide task access lands
    // (POD-6288) that takes a task grant, the strongest task access there is.
    for (const verb of ['read', 'write'] as const) {
      await f.handle.registry.sessionStore.grants.upsert({
        resourceKind: 'issue',
        resourceId: f.tasks.alice,
        grantee: MEMBERS.bob.id,
        verb,
        owner: MEMBERS.alice.id,
        visibility: 'personal',
        createdAt: new Date().toISOString(),
        actorKind: 'user',
        actorId: MEMBERS.alice.id,
        onBehalfOf: MEMBERS.alice.id,
      })
    }
  })

  it('Bob’s agent on Alice’s task cannot run an agent on Alice’s machine', async () => {
    // Alice's task is homed on her machine, so a delegate spawned on it lands there.
    // biome-ignore lint/suspicious/noExplicitAny: the relay client is typed for issue procedures
    const agent = f.agent(f.sessions.bobOnAliceTask).client as any
    await expect(
      agent.messages.spawnAgent.mutate({
        requestId: randomUUID(),
        prompt: 'run on Alice’s machine',
        issue: f.tasks.alice,
        harness: 'shell',
      }),
    ).rejects.toThrow(`not allowed to run agents on machine ${f.machines.alice}`)
  })

  it('Bob cannot start a session on Alice’s machine for Alice’s task', async () => {
    const bob = await trpc('bob')
    await expect(
      bob.sessions.create.mutate({
        agentKind: 'shell',
        cwd: '/wt/alice-task',
        machineId: f.machines.alice,
        issueId: f.tasks.alice,
      }),
    ).rejects.toThrow(NO_USE)
  })
})

describe('MU-10: an unowned machine runs nothing', () => {
  it.each(['alice', 'bob'] as const)('%s cannot start a session there', async (who) => {
    const client = await trpc(who)
    await expect(
      client.sessions.create.mutate({ agentKind: 'shell', cwd: '/wt/orphan', machineId: ORPHAN }),
    ).rejects.toThrow(NO_USE)
  })
})

describe('MU-10: a `use` grant never grants session access', () => {
  let bobOnAliceMachine: SessionId
  beforeAll(async () => {
    // Alice lets Bob run agents on her machine (design §2.4, Q1).
    await (await trpc('alice')).machines.share.mutate({
      id: f.machines.alice,
      grantee: MEMBERS.bob.id,
      verb: 'use',
    })
  })

  it('control: with the grant, Bob runs a session of his own on Alice’s machine', async () => {
    const created = (await (
      await trpc('bob')
    ).sessions.create.mutate({
      agentKind: 'shell',
      cwd: '/wt/bob-on-alice-machine',
      machineId: f.machines.alice,
    })) as { sessionId: SessionId }
    bobOnAliceMachine = created.sessionId
    expect((await sessions().sessionOwner(bobOnAliceMachine))?.owner).toBe(MEMBERS.bob.id)
  })

  it('Bob still cannot read Alice’s session on that machine', async () => {
    const bob = await trpc('bob')
    await expect(bob.sessions.status.query({ ref: f.sessions.alice })).rejects.toThrow(
      `no session found for ${f.sessions.alice}`,
    )
    await expect(
      bob.sessions.transcriptRead.query({
        sessionId: f.sessions.alice,
        direction: 'before',
        limit: 5,
      }),
    ).rejects.toThrow('NOT_FOUND')
  })

  it('and Alice cannot read Bob’s session on her own machine', async () => {
    const alice = await trpc('alice')
    await expect(alice.sessions.status.query({ ref: bobOnAliceMachine })).rejects.toThrow(
      `no session found for ${bobOnAliceMachine}`,
    )
  })

  it('Alice’s machine is told about Bob’s session placed on it, and nothing else of Bob’s', async () => {
    const result = await connect(f.machines.alice, [bobOnAliceMachine, f.sessions.bob])
    expect(result.bindingConfirmations).toEqual({
      [bobOnAliceMachine]: expect.objectContaining({
        owner: MEMBERS.bob.id,
        machineId: f.machines.alice,
        delegation: expect.objectContaining({ onBehalfOf: MEMBERS.bob.id }),
      }),
      [f.sessions.bob]: UNKNOWN,
    })
  })

  it('gap 9: a child Bob’s agent spawns on Alice’s task, on Alice’s machine, is Bob’s', async () => {
    // The child lands on the task's home, Alice's machine, which Bob may now
    // use. Neither the task nor the machine makes it Alice's.
    // biome-ignore lint/suspicious/noExplicitAny: the relay client is typed for issue procedures
    const agent = f.agent(f.sessions.bobOnAliceTask).client as any
    const spawned = (await agent.messages.spawnAgent.mutate({
      requestId: randomUUID(),
      prompt: 'child of Bob’s agent',
      issue: f.tasks.alice,
      harness: 'shell',
    })) as { sessionId: SessionId }
    const row = await f.handle.registry.sessionStore.sessions.getSession(spawned.sessionId)
    expect(row?.machineId).toBe(f.machines.alice)
    expect(row?.ownerUserId).toBe(MEMBERS.bob.id)
    expect(row?.delegation?.onBehalfOf).toBe(MEMBERS.bob.id)
    expect(row?.createdBy?.onBehalfOf).toBe(MEMBERS.bob.id)
    expect((await sessions().capabilityForSession(spawned.sessionId)).onBehalfOf).toBe(
      MEMBERS.bob.id,
    )
  })

  it('queued input is judged at dispatch as the human its agent acts for, never as claimed', async () => {
    // The queue row stores WHO queued it; dispatch resolves that live. The
    // target is Bob's session on his own task: outside both agents' task scope
    // alike, so the only difference between them is whose human they act for.
    const agentRow = async (sessionId: SessionId, claimedHuman = MEMBERS.bob.id) =>
      await sessions().authorizeQueuedInputAtApply({
        sessionId: f.sessions.bob,
        principal: inboxPrincipalFromCommand({
          kind: 'agent',
          agentSessionId: sessionId,
          onBehalfOf: claimedHuman,
          capability: await sessions().capabilityForSession(sessionId),
          chain: [],
        }),
        sourceMessageId: null,
      })
    // Bob's agent (on Alice's task) into Bob's session: his own human's.
    expect(await agentRow(f.sessions.bobOnAliceTask)).toEqual({ ok: true })
    // Alice's agent is refused, whether it names its own human or claims to act
    // for Bob.
    expect(await agentRow(f.sessions.alice, MEMBERS.alice.id)).toMatchObject({ ok: false })
    expect(await agentRow(f.sessions.alice)).toMatchObject({ ok: false })
  })

  it('Bob’s queued input is refused at dispatch once Alice takes his use grant away', async () => {
    const bobRow = async () =>
      await sessions().authorizeQueuedInputAtApply({
        sessionId: bobOnAliceMachine,
        principal: inboxPrincipalFromCommand(userCommandPrincipal(MEMBERS.bob.id, 'member')),
        sourceMessageId: null,
      })
    expect(await bobRow()).toEqual({ ok: true })
    await (await trpc('alice')).machines.unshare.mutate({
      id: f.machines.alice,
      grantee: MEMBERS.bob.id,
      verb: 'use',
    })
    expect(await bobRow()).toMatchObject({ ok: false })
  })
})

describe('MU-10: an admin taking custody is audited as a takeover', () => {
  const audit = async () => await f.handle.registry.sessionStore.settingsAudit.list(500)

  it('adopting an unowned machine for herself is a takeover', async () => {
    const alice = await trpc('alice')
    await alice.machines.adopt.mutate({ id: ORPHAN, newOwnerUserId: MEMBERS.alice.id })
    expect(await audit()).toContainEqual(
      expect.objectContaining({
        command: 'takeover',
        actorId: MEMBERS.alice.id,
        detail: expect.objectContaining({ machineId: ORPHAN, previousOwnerUserId: null }),
      }),
    )
  })

  it('admin Alice taking Bob’s machine from him is a takeover, and gives her no session of his', async () => {
    const alice = await trpc('alice')
    await alice.machines.transferOwnership.mutate({
      id: f.machines.bob,
      newOwnerUserId: MEMBERS.alice.id,
    })
    expect(await audit()).toContainEqual(
      expect.objectContaining({
        command: 'takeover',
        actorId: MEMBERS.alice.id,
        detail: expect.objectContaining({
          machineId: f.machines.bob,
          previousOwnerUserId: MEMBERS.bob.id,
          newOwnerUserId: MEMBERS.alice.id,
        }),
      }),
    )
    // Custody of the machine is not access to the sessions on it.
    await expect(alice.sessions.status.query({ ref: f.sessions.bob })).rejects.toThrow(
      `no session found for ${f.sessions.bob}`,
    )
  })
})
