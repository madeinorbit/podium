/**
 * POD-5284: send to stopping session leaves a dispatched row orphaned.
 *
 * Repro from prod (machine ludovico):
 * - msg_a496c10c dispatched to 11dfae83 at 17:00:12Z, session stopped parent
 *   at 17:00:46Z (no resume ref), daemon queued (prompt_queued) but never
 *   delivered. A day later the row is still `dispatched` with its durable
 *   `queued_messages` row present.
 *
 * Expected: stopping a session that can never resume (exited, no resume ref)
 * fails its pending messages and drops their queue rows — like kill does —
 * instead of leaving them `dispatched` forever. The sweep never retries
 * `dispatched` (only `stored`), and teardown abandonment skips durable rows
 * for the next owner that will never come.
 *
 * Hibernated sessions are the other half (msg_57ee6766 → 7d1541b0, still
 * `dispatched` with 7 queued rows): the queue is kept for resume on purpose,
 * and the next bind re-forwards each row as a recovery the daemon settles
 * without retyping (`unknown`), so nothing is lost — it just waits for the
 * resume. The second test pins that half.
 */

import { asSessionId, firstAdminMemberId } from '@podium/model'
import { actorAgent, asAgentIdentityId } from '@podium/model'
import type { ControlMessage } from '@podium/protocol/daemon'
import { describe, expect, it, afterEach, vi } from 'vitest'
import { SessionRegistry } from '../../relay'
import { openTestStore } from '../../test-support/open-test-store'
import { attachHostDaemon } from '../../test-support/host-daemon'

const registries: SessionRegistry[] = []

afterEach(async () => {
  for (const r of registries.splice(0)) await r.dispose()
})

async function makeRegistry() {
  const store = await openTestStore(':memory:')
  await store.machines.upsertMachine({
    id: store.hostMachineId,
    name: 'test-host',
    hostname: 'test-host',
    tokenHash: 'test',
    ownerUserId: await firstAdminMemberId(store),
    assignment: { server: true, agentExecution: true },
  })
  const reg = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
  registries.push(reg)
  const toDaemon: ControlMessage[] = []
  await attachHostDaemon(reg, (m) => toDaemon.push(m))
  await reg.sessionStore.repos.addRepo('/r', reg.sessionStore.hostMachineId, 'git@github.com:example/r.git')
  const rpc = (reg.modules.sessions as unknown as {
    rpc: {
      repoOp: (...args: unknown[]) => Promise<{ ok: boolean; output: string }>
      runtimeLifecycle: (input: { sessionId: string; verb: string }, machineId: string) => Promise<{ sessionId: string; result: { ok: true; retirement?: 'confirmed' } }>
    }
  }).rpc
  rpc.repoOp = async () => ({ ok: true, output: '' })
  rpc.runtimeLifecycle = async (input) => {
    return { sessionId: input.sessionId, result: { ok: true, retirement: 'confirmed' } }
  }
  return { reg, store, toDaemon }
}

async function bindLiveNoResume(reg: SessionRegistry, sessionId: string) {
  await reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
    type: 'bind',
    sessionId: asSessionId(sessionId),
    cmd: 'claude',
    cwd: '/r',
    agentKind: 'claude-code',
    geometry: { cols: 80, rows: 24 },
  })
  // No sessionResumeRef: this session can never resume, so a stop parks it
  // as `exited` — the prod shape of 11dfae83 (stop_reason=parent, no resume).
}

async function bindLiveResumable(reg: SessionRegistry, sessionId: string) {
  await reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
    type: 'bind',
    sessionId: asSessionId(sessionId),
    cmd: 'claude',
    cwd: '/r',
    agentKind: 'claude-code',
    geometry: { cols: 80, rows: 24 },
  })
  await reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
    type: 'sessionResumeRef',
    sessionId: asSessionId(sessionId),
    resume: { kind: 'claude-session', value: 'native-1' },
  })
}

type DurableSendRequest = Extract<ControlMessage, { type: 'runtimeDurableSendRequest' }>

function durableSends(toDaemon: ControlMessage[], sessionId: string): DurableSendRequest[] {
  return toDaemon.filter(
    (m): m is DurableSendRequest =>
      m.type === 'runtimeDurableSendRequest' && m.sessionId === sessionId,
  )
}

const AGENT_SENDER = {
  kind: 'superagent',
  attribution: {
    actor: actorAgent(asAgentIdentityId('superagent')),
    onBehalfOf: firstAdminMemberId() as unknown as string,
  },
  delegationRef: 'superagent',
} as const

describe('POD-5284: stopping an unresumable session settles its dispatched mail', () => {
  it('a dispatched wake message to a no-resume session fails on parent stop', async () => {
    const { reg, store } = await makeRegistry()
    const { sessionId } = await reg.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/r',
    })
    await bindLiveNoResume(reg, sessionId)

    const sent = await reg.modules.messages.send(AGENT_SENDER as never, {
      to: { kind: 'session', id: sessionId },
      body: 'Start now: read your newest message from the coordinator',
      urgency: 'next-turn',
      lifecycle: 'wake',
    })
    expect(sent.ok).toBe(true)
    const before = await store.messages.getMessage(sent.message.id)
    expect(before?.deliveryStatus).toBe('dispatched')
    expect(before?.deliveredTo).toBe(sessionId)
    const queuedBefore = await store.sync.listQueuedMessages(asSessionId(sessionId))
    expect(queuedBefore.map((q) => q.sourceMessageId)).toContain(sent.message.id)

    const stopped = await reg.modules.issueSessionLifecycle.stopSession({ sessionId })
    expect(stopped.ok).toBe(true)
    const parked = await reg.modules.sessions.sessionById(sessionId)
    expect(parked?.status).toBe('exited')

    // The bug: this stays `dispatched` with its queue row present, reading as
    // sent a day later. An unresumable stop must end it like a removal does.
    const after = await store.messages.getMessage(sent.message.id)
    expect(after?.deliveryStatus).toBe('failed')
    const queuedAfter = await store.sync.listQueuedMessages(asSessionId(sessionId))
    expect(queuedAfter.map((q) => q.sourceMessageId)).not.toContain(sent.message.id)
  })

  it('a hibernated session keeps its dispatched mail, and resume re-forwards it as a recovery', async () => {
    const { reg, store, toDaemon } = await makeRegistry()
    const { sessionId } = await reg.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/r',
    })
    await bindLiveResumable(reg, sessionId)

    const sent = await reg.modules.messages.send(AGENT_SENDER as never, {
      to: { kind: 'session', id: sessionId },
      body: 'hibernated mail waits for resume',
      urgency: 'fyi',
    })
    expect(sent.ok).toBe(true)
    await vi.waitFor(() => expect(durableSends(toDaemon, sessionId)).toHaveLength(1))
    expect(durableSends(toDaemon, sessionId)[0]).toMatchObject({
      rowId: sent.message.id,
      deliveryRecovery: false,
    })

    const stopped = await reg.modules.issueSessionLifecycle.stopSession({ sessionId })
    expect(stopped.ok).toBe(true)
    expect((await reg.modules.sessions.sessionById(sessionId))?.status).toBe('hibernated')

    // Resumable parks keep the queue: the row must survive for the resume.
    // Prod shape of msg_57ee6766 → 7d1541b0 (still `dispatched`, queue kept).
    expect((await store.messages.getMessage(sent.message.id))?.deliveryStatus).toBe('dispatched')
    expect(await reg.modules.sessions.hasQueuedMessage(sessionId, sent.message.id)).toBe(true)

    // The resume re-forwards the same row as a recovery — never a fresh write.
    // (A bare rebind cannot revive a hibernated session — markLive only
    // returns starting/reconnecting/exited to live — so this drives the real
    // resume: resurrect spawns, the daemon binds, the bind-time drain forwards.)
    // The daemon settles a recovery without retyping (possible-write rule,
    // harness delivery-queue.ts), so this is where `dispatched` ends.
    const resurrected = await reg.modules.issueSessionLifecycle.resurrectSession({ sessionId })
    expect(resurrected.ok).toBe(true)
    await reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
      type: 'bind',
      sessionId: asSessionId(sessionId),
      cmd: 'claude',
      cwd: '/r',
      agentKind: 'claude-code',
      geometry: { cols: 80, rows: 24 },
    })
    await vi.waitFor(() => expect(durableSends(toDaemon, sessionId)).toHaveLength(2))
    expect(durableSends(toDaemon, sessionId)[1]).toMatchObject({
      rowId: sent.message.id,
      deliveryRecovery: true,
    })

    // What the real daemon files for that recovery (unverified write): the
    // row settles `unknown`, honestly, instead of reading as sent forever.
    await reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
      type: 'runtimeEvent',
      sessionId,
      deliveryId: `delivery-${sent.message.id}`,
      event: {
        t: 'delivery',
        rowId: sent.message.id,
        outcome: 'failed',
        cause: 'unconfirmed',
        reason: "the agent's machine could not confirm delivery",
        at: new Date().toISOString(),
        provenance: 'live',
        cursor: { segmentId: `delivery-${sessionId}`, components: { seq: 1 } },
        observerGeneration: 1,
        turnEpoch: 0,
      },
    })
    await vi.waitFor(async () =>
      expect((await store.messages.getMessage(sent.message.id))?.deliveryStatus).toBe('unknown'),
    )
    expect(await reg.modules.sessions.hasQueuedMessage(sessionId, sent.message.id)).toBe(false)
  })
})
