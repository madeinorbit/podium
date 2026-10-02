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
 */

import { asSessionId, firstAdminMemberId } from '@podium/model'
import { actorAgent, asAgentIdentityId } from '@podium/model'
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
  await attachHostDaemon(reg, () => {})
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
  return { reg, store }
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

const AGENT_SENDER = {
  kind: 'agent',
  sessionId: asSessionId('sender-session'),
  issueId: null,
  attribution: {
    actor: actorAgent(asAgentIdentityId('sender')),
    onBehalfOf: 'user:test',
  },
  delegationRef: null,
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
})
