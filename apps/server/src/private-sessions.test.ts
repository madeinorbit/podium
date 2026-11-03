/**
 * MU-07: SESSIONS ARE PRIVATE TO THEIR OWN HUMAN (POD-6283; design §2.3, §4.1).
 *
 * On the two-member fixture (POD-6282): Bob's agent `bobOnAliceTask` runs on
 * ALICE's task. It is Bob's. Alice owns the task and is the instance admin, and
 * neither gives her anything on it: she cannot read it, drive it, resume it,
 * answer it, stop it or queue input into it, on any path, and neither can an
 * agent acting for her. Bob can, although the task is not his. A legacy session
 * grant changes nothing.
 *
 * Every refusal here answers exactly as for a session that does not exist, and
 * answers at once (POD-6282 saw admin Alice's `sessions.status` on Bob's session
 * run for over a minute while it probed his machine).
 *
 * Alice holds a `use` grant on Bob's machine throughout, so every refusal below
 * is the session gate's, not the machine gate's.
 *
 * Approval decisions are POD-6284's (approvals module), not this file's.
 * The paths run least destructive first; the kill and stop refusals run last.
 */

import { asSessionId, type SessionId } from '@podium/model'
import type { ServerMessage } from '@podium/protocol'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { userCommandPrincipal } from './command-principal'
import { inboxPrincipalFromCommand } from './modules/sessions/inbox'
import { attachTestClient } from './test-support/client-transport'
import {
  MEMBERS,
  snapshotIds,
  startTwoMemberInstance,
  type TwoMemberInstance,
} from './test-support/two-member-instance'

let f: TwoMemberInstance
beforeAll(async () => {
  f = await startTwoMemberInstance()
  // Bob lets Alice run agents on his machine (design §2.4 allows a `use` grant).
  // Without it, the machine gate alone would refuse Alice on most drive paths
  // and these tests could not tell that the SESSION gate holds: a `use` grant
  // never gives access to another person's sessions.
  await f.handle.registry.modules.machines.shareMachine(f.machines.bob, MEMBERS.alice.id, 'use', {
    actor: MEMBERS.bob.id,
    onBehalfOf: MEMBERS.bob.id,
  })
}, 60_000)
afterAll(async () => {
  await f?.close()
})

const sessions = () => f.handle.registry.modules.sessions
// The tRPC client is typed per procedure; these tests address many of them by
// the same shape, so they go through one loosely typed handle.
// biome-ignore lint/suspicious/noExplicitAny: see above
const trpc = async (who: 'alice' | 'bob'): Promise<any> => (await f.as(who)).trpc
const target = () => f.sessions.bobOnAliceTask
/** A refusal must come back at once, not after a machine probe times out. */
const prompt = async <T>(run: () => Promise<T>): Promise<T> => {
  const started = Date.now()
  try {
    return await run()
  } finally {
    expect(Date.now() - started).toBeLessThan(3_000)
  }
}

describe('MU-07: Bob’s agent on Alice’s task belongs to Bob', () => {
  it('is stored as Bob’s, and its agent acts for Bob', async () => {
    const row = await f.handle.registry.sessionStore.sessions.getSession(target())
    expect(row?.ownerUserId).toBe(MEMBERS.bob.id)
    expect(row?.createdBy?.onBehalfOf).toBe(MEMBERS.bob.id)
    const capability = await sessions().capabilityForSession(target())
    expect(capability.onBehalfOf).toBe(MEMBERS.bob.id)
    // Its agent reaches Bob's sessions, and not Alice's.
    expect(await sessions().mayReachSession(capability, f.sessions.bob)).toBe(true)
    expect(await sessions().mayReachSession(capability, f.sessions.alice)).toBe(false)
  })

  it('a session Bob starts on Alice’s task over tRPC is his', async () => {
    const created = (await (await trpc('bob')).sessions.create.mutate({
      agentKind: 'shell',
      cwd: '/wt/bob-on-alice-shell',
      machineId: f.machines.bob,
      issueId: f.tasks.alice,
    })) as { sessionId: SessionId }
    expect((await sessions().sessionOwner(created.sessionId))?.owner).toBe(MEMBERS.bob.id)
  })
})

describe('MU-07: admin Alice, who owns the task, cannot read Bob’s session', () => {
  it.each(['status', 'read', 'transcriptRead', 'recap'] as const)(
    'sessions.%s answers NOT_FOUND at once',
    async (proc) => {
      const alice = await trpc('alice')
      const input =
        proc === 'status'
          ? { ref: target() }
          : proc === 'transcriptRead'
            ? { sessionId: target(), direction: 'before', limit: 5 }
            : { sessionId: target() }
      await prompt(async () => await expect(alice.sessions[proc].query(input)).rejects.toThrow('NOT_FOUND'))
    },
  )

  it('control: Bob reads his own session’s transcript', async () => {
    const bob = await trpc('bob')
    expect(
      await bob.sessions.transcriptRead.query({ sessionId: target(), direction: 'before', limit: 5 }),
    ).toMatchObject({ items: [] })
  })

  it('cannot subscribe to its transcript or attach its terminal; Bob can', async () => {
    const registry = f.handle.registry
    const aliceFrames: ServerMessage[] = []
    const bobFrames: ServerMessage[] = []
    const alice = attachTestClient(registry.clientGateway, {
      userId: MEMBERS.alice.id,
      userRole: 'admin',
      send: (m) => aliceFrames.push(m),
    })
    const bob = attachTestClient(registry.clientGateway, {
      userId: MEMBERS.bob.id,
      userRole: 'member',
      send: (m) => bobFrames.push(m),
    })
    await registry.clientGateway.routeClientFrame(alice, { type: 'attach', sessionId: target() })
    await registry.clientGateway.routeClientFrame(alice, { type: 'requestControl', sessionId: target() })
    expect(aliceFrames).toContainEqual({ type: 'terminalOutcome', sessionId: target(), outcome: 'unauthorized' })
    expect(aliceFrames.some((m) => m.type === 'attached')).toBe(false)
    const terminal = sessions().sessions.get(target())?.terminal
    expect(terminal?.controllerIdentity).not.toEqual({ kind: 'user', user: MEMBERS.alice.id })

    await registry.clientGateway.routeClientFrame(bob, { type: 'attach', sessionId: target() })
    expect(bobFrames.some((m) => m.type === 'attached')).toBe(true)
    expect(terminal?.controllerIdentity).toEqual({ kind: 'user', user: MEMBERS.bob.id })
  })

  it('does not get it in her feed, even with a legacy session grant', async () => {
    await f.handle.registry.sessionStore.grants.upsert({
      resourceKind: 'session',
      resourceId: target(),
      grantee: MEMBERS.alice.id,
      verb: 'write',
      owner: MEMBERS.bob.id,
      visibility: 'personal',
      createdAt: new Date().toISOString(),
      actorKind: 'user',
      actorId: MEMBERS.bob.id,
      onBehalfOf: MEMBERS.bob.id,
    })
    const feed = snapshotIds(await (await (await f.as('alice')).feed()).bootstrap())
    expect(feed.sessions).not.toContain(target())
    await expect((await trpc('alice')).sessions.read.query({ sessionId: target() })).rejects.toThrow('NOT_FOUND')
    await expect(
      (await trpc('alice')).sessions.rename.mutate({ sessionId: target(), name: 'granted rename' }),
    ).rejects.toThrow(/command refused/)
  })
})

describe('MU-07: admin Alice cannot drive Bob’s session; Bob can', () => {
  it('a send (an offer click is one) dead-letters for Alice and queues for Bob', async () => {
    for (const proc of ['sendText', 'resumeAndSend'] as const) {
      const refused = await prompt(async () =>
        (await trpc('alice')).sessions[proc].mutate({ sessionId: target(), text: 'from alice' }),
      )
      expect(refused, proc).toMatchObject({ ok: false, disposition: 'dead_letter' })
      const sent = await (await trpc('bob')).sessions[proc].mutate({ sessionId: target(), text: 'from bob' })
      expect(sent, proc).toMatchObject({ ok: true, disposition: 'queued' })
    }
  })

  it.each([
    ['interrupt', { ok: false, reason: 'unknown session' }],
    ['resurrect', { ok: false, reason: 'unknown session' }],
    ['configure', { detail: 'unknown session' }],
    ['answerAskUserQuestion', { ok: false }],
  ] as const)('sessions.%s answers as an unknown session for Alice', async (proc, answer) => {
    const input =
      proc === 'configure'
        ? { sessionId: target(), model: 'other' }
        : proc === 'answerAskUserQuestion'
          ? { sessionId: target(), interactionId: 'ixn_x', choices: [{ optionIndices: [1] }] }
          : { sessionId: target() }
    const answered = await prompt(async () => await (await trpc('alice')).sessions[proc].mutate(input))
    // The absent shape exactly: an answer that got past the gate carries more.
    if (proc === 'configure') expect(answered).toMatchObject(answer)
    else expect(answered).toEqual(answer)
  })

  it('cannot put files into it; Bob can', async () => {
    const input = { sessionId: target(), filename: 'a.png', mimeType: 'image/png', dataBase64: 'iVBORw0KGgo=' }
    expect(await (await trpc('alice')).sessions.uploadImage.mutate(input)).toEqual({
      refusal: { reason: 'unsupported', detail: 'unknown session' },
    })
    expect(await (await trpc('bob')).sessions.uploadImage.mutate(input)).toMatchObject({
      attachment: { filename: 'a.png' },
    })
  })

  it('her per-user writes on it are refused', async () => {
    // Alice may snooze her own session (the counterfactual), not Bob's. Bob is
    // not the control here: a member's `owned` capability writes no per-user
    // row over tRPC at all today, which is a separate gap.
    const store = f.handle.registry.sessionStore.sessions
    const alice = await trpc('alice')
    await alice.snoozes.set.mutate({ sessionId: f.sessions.alice, until: null })
    await alice.snoozes.set.mutate({ sessionId: target(), until: null })
    const snoozed = await store.listSnoozes(MEMBERS.alice.id)
    expect(snoozed).toHaveProperty(f.sessions.alice)
    expect(snoozed).not.toHaveProperty(target())
  })

  it('cannot resume its conversation; Bob can', async () => {
    const resume = { kind: 'claude-session', value: `conv-${target()}` }
    await f.handle.registry.gateway.routeDaemonFrame(f.machines.bob, {
      type: 'sessionResumeRef',
      sessionId: target(),
      resume,
      confidence: 'exact',
    })
    const input = { agentKind: 'claude-code', cwd: '/wt/bob-session-bob-on-alice-task', resume, conversationId: resume.value }
    await expect((await trpc('alice')).sessions.resume.mutate(input)).rejects.toThrow('session not found')
    expect(await (await trpc('bob')).sessions.resume.mutate({ ...input, machineId: f.machines.bob })).toEqual({
      sessionId: target(),
    })
  })

  it('her input queued for it is refused when it is applied; Bob’s is admitted', async () => {
    const apply = async (who: 'alice' | 'bob') =>
      await sessions().authorizeQueuedInputAtApply({
        sessionId: target(),
        principal: inboxPrincipalFromCommand(userCommandPrincipal(MEMBERS[who].id, MEMBERS[who].role)),
        sourceMessageId: null,
      })
    expect(await apply('alice')).toMatchObject({ ok: false })
    expect(await apply('bob')).toEqual({ ok: true })
  })
})

describe('MU-07: only Bob answers his agent’s question on Alice’s task', () => {
  it('Alice and her agent are refused; Bob’s answer is delivered', async () => {
    await f.agent(target()).client.issues.setNeedsHuman.mutate({
      id: f.tasks.alice,
      question: 'Which way?',
    } as never)
    const refusal = /only the person this agent works for can answer its question/
    await expect(
      (await trpc('alice')).issues.answerQuestion.mutate({ id: f.tasks.alice, answer: 'left' }),
    ).rejects.toThrow(refusal)
    await expect(
      f.agent(f.sessions.alice).client.issues.answerQuestion.mutate({
        id: f.tasks.alice,
        answer: 'left',
      } as never),
    ).rejects.toThrow(refusal)
    expect(
      await (await trpc('bob')).issues.answerQuestion.mutate({ id: f.tasks.alice, answer: 'right' }),
    ).toMatchObject({ deliveredVia: 'text' })
  })
})

describe('MU-07: an agent acting for Alice cannot read, send to or drive Bob’s session', () => {
  const aliceAgent = () => f.agent(f.sessions.alice).client
  it('session read and status answer as a missing session', async () => {
    await expect(aliceAgent().sessions.read.query({ sessionId: target() } as never)).rejects.toThrow(
      `no session found for ${target()}`,
    )
    await expect(aliceAgent().sessions.status.query({ ref: target() } as never)).rejects.toThrow(
      `no session found for ${target()}`,
    )
  })

  it('session send and mail never reach it', async () => {
    await expect(
      aliceAgent().sessions.sendText.mutate({ sessionId: target(), text: 'x' } as never),
    ).rejects.toThrow('session not found')
    expect(await aliceAgent().messages.send.mutate({ to: target(), body: 'x' } as never)).toMatchObject({
      ok: false,
      disposition: 'dead_letter',
    })
  })

  it('cannot stop it', async () => {
    await expect(aliceAgent().sessions.stop.mutate({ sessionId: target() } as never)).rejects.toThrow(
      'session not found',
    )
  })
})

describe('MU-07: admin Alice cannot stop or kill Bob’s session (destructive, last)', () => {
  it('stop and kill leave it running', async () => {
    const alice = await trpc('alice')
    expect(await alice.sessions.stop.mutate({ sessionId: target() })).toEqual({
      ok: false,
      reason: 'unknown session',
    })
    expect(await alice.sessions.kill.mutate({ sessionId: asSessionId(target()) })).toBeUndefined()
    const row = await f.handle.registry.sessionStore.sessions.getSession(target())
    expect(row?.status).not.toBe('exited')
    expect(row?.archived).not.toBe(true)
  })
})
