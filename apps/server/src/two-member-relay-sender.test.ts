/**
 * A real authenticated /daemon socket must not borrow another machine's session
 * authority. The two-member fixture supplies the real server and durable rows;
 * both relay senders below authenticate over WebSocket with their own credential.
 * No agent/provider process runs: the only command is an own-task brief write.
 */
import { asSessionId, type IssueId, type MachineId, type SessionId } from '@podium/model'
import { createHandshakeDialer } from '@podium/protocol'
import {
  type ControlMessage,
  type DaemonMessage,
  encodeDaemonMessage,
} from '@podium/protocol/daemon'
import { fixtureWriteScope } from '@podium/sync/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { IssueCommandDispatcher } from './modules/issues/dispatcher'
import { sha256 } from './modules/machines/enrollment'
import { SessionAuthz } from './modules/sessions/session-authz'
import { fixtureInventory } from './test-support/daemon-inventory'
import { startTwoMemberInstance, type TwoMemberInstance } from './test-support/two-member-instance'

type RelayRequest = Extract<DaemonMessage, { type: 'agentRelayRequest' }>
type RelayResult = Extract<ControlMessage, { type: 'agentRelayResult' }>

let f: TwoMemberInstance
const sockets: WebSocket[] = []
const peers = new Map<
  MachineId,
  {
    ws: WebSocket
    pending: Map<string, (result: RelayResult) => void>
  }
>()
let sharedSession: SessionId
let nextRequest = 0

async function connect(machineId: MachineId, owner: 'alice' | 'bob'): Promise<void> {
  const registry = f.handle.registry
  const token = `${machineId}-relay-boundary-token`
  await registry.sessionStore.machines.upsertMachine({
    id: machineId,
    name: machineId,
    hostname: machineId,
    tokenHash: sha256(token),
    ownerUserId: f.members[owner].id,
    assignment: { server: false, agentExecution: true },
  })
  registry.gateway.detachDaemon(machineId)
  const attached = vi.spyOn(registry.gateway, 'attachDaemon')
  const ws = new WebSocket(`ws://127.0.0.1:${f.handle.port}/daemon`)
  const send = (message: DaemonMessage): void => ws.send(encodeDaemonMessage(message))
  sockets.push(ws)
  const pending = new Map<string, (result: RelayResult) => void>()
  const dialer = createHandshakeDialer({
    peerRole: 'machine',
    credential: { kind: 'machineToken', token, machineHint: machineId },
    claims: { machineId, hostname: machineId },
  })
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('daemon authentication timed out')), 10_000)
    ws.on('error', reject)
    ws.on('open', () => ws.send(JSON.stringify(dialer.hello())))
    ws.on('message', (raw) => {
      if (dialer.state !== 'established') {
        const step = dialer.receive(raw.toString())
        if (step.action !== 'established') {
          clearTimeout(timeout)
          reject(new Error(`daemon handshake: ${step.action}`))
          return
        }
        clearTimeout(timeout)
        peers.set(machineId, { ws, pending })
        resolve()
        return
      }
      const msg = JSON.parse(raw.toString()) as ControlMessage
      if (msg.type === 'agentRelayResult') pending.get(msg.requestId)?.(msg)
      if (msg.type === 'inventoryRequest') {
        send({ type: 'inventoryReport', machineId, inventory: fixtureInventory() })
      }
      if (msg.type === 'runtimeLifecycleRequest') {
        send({
          type: 'runtimeLifecycleResult',
          requestId: msg.requestId,
          sessionId: msg.sessionId,
          result: { ok: true, retirement: 'confirmed' },
        })
      }
    })
  })
  // helloOk intentionally precedes server attach. Wait for that real attach
  // before the first inventory; otherwise it can reset an early report to pending.
  try {
    expect(attached).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'machine', machine: machineId }),
      expect.anything(),
      expect.any(Array),
    )
    await Promise.all(attached.mock.results.map((call) => call.value))
  } finally {
    attached.mockRestore()
  }
  send({ type: 'inventoryReport', machineId, inventory: fixtureInventory() })
  await registry.modules.machines.waitForInventory(machineId)
}

beforeAll(async () => {
  f = await startTwoMemberInstance()
  await connect(f.machines.alice, 'alice')
  await connect(f.machines.bob, 'bob')
  // Q1: Bob shares execution with Alice, but Alice remains her session's human.
  await f.handle.registry.modules.machines.shareMachine(f.machines.bob, f.members.alice.id, 'use', {
    actor: f.members.bob.id,
    onBehalfOf: f.members.bob.id,
    acknowledgeSharedMachine: true,
  })
  sharedSession = (
    await f.handle.registry.modules.sessions.createSession({
      ownerUserId: f.members.alice.id,
      // A shell needs no provider account on its custodian's machine. This keeps
      // Q1 about session authority, without provisioning or executing a provider.
      agentKind: 'shell',
      cwd: '/wt/alice-shared-machine',
      title: 'Alice on Bob machine',
      machineId: f.machines.bob,
      issueId: f.tasks.alice,
      binding: { principal: { kind: 'user', userId: f.members.alice.id } },
    })
  ).sessionId
}, 60_000)

afterAll(async () => {
  for (const ws of sockets) ws.terminate()
  vi.restoreAllMocks()
  // Restore the fixture's process-retirement acknowledgements for disposal.
  if (f) {
    await f.reconnectDaemon(f.machines.alice)
    await f.reconnectDaemon(f.machines.bob)
  }
  await f?.close()
})

/** Capture the real ingress principal, authority result, dispatcher and durable
 * write. A refusal before the frame reaches the server cannot pass this helper. */
async function writeFrom(machineId: MachineId, sessionId: SessionId, issueId: IssueId) {
  const registry = f.handle.registry
  const before = (await registry.issues.reports.get(issueId))?.brief
  const historyBefore = await registry.issues.crud.textRevisions(issueId, 'brief')
  const marker = `relay-boundary-${++nextRequest}`
  const msg: RelayRequest = {
    type: 'agentRelayRequest',
    requestId: marker,
    sessionId,
    router: 'issues',
    proc: 'update',
    input: { id: issueId, patch: { brief: marker } },
  }
  const ingress = vi.spyOn(registry.gateway, 'routeDaemonFrame')
  const capabilities = vi.spyOn(SessionAuthz.prototype, 'capabilityForSession')
  const dispatch = vi.spyOn(IssueCommandDispatcher.prototype, 'dispatch')
  try {
    const peer = peers.get(machineId)
    if (!peer) throw new Error('missing authenticated daemon')
    const reply = await new Promise<RelayResult>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('relay reply timed out')), 10_000)
      peer.pending.set(msg.requestId, (result) => {
        clearTimeout(timer)
        peer.pending.delete(msg.requestId)
        resolve(result)
      })
      peer.ws.send(encodeDaemonMessage(msg))
    })
    expect(ingress).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'machine',
        machine: machineId,
        device: expect.stringMatching(/^daemon-\d+$/),
      }),
      msg,
    )
    expect(reply.requestId).toBe(msg.requestId)
    const resolved = await Promise.allSettled(capabilities.mock.results.map((call) => call.value))
    const derived = resolved.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    )
    const calls = dispatch.mock.calls.map(([caller]) => caller.capability)
    const after = (await registry.issues.reports.get(issueId))?.brief
    const historyAfter = await registry.issues.crud.textRevisions(issueId, 'brief')
    const edit = historyAfter.find((revision) => revision.body === marker)
    console.info(
      'RELAY_SENDER_WITNESS',
      JSON.stringify({
        requestId: msg.requestId,
        sender: machineId,
        sessionId,
        reply,
        capabilityCalls: capabilities.mock.calls.length,
        derived,
        dispatchCalls: calls.length,
        dispatchCapabilities: calls,
        wrote: after === marker,
        edit,
      }),
    )
    return { reply, derived, calls, before, after, marker, edit, historyBefore, historyAfter }
  } finally {
    ingress.mockRestore()
    capabilities.mockRestore()
    dispatch.mockRestore()
  }
}

function allowed(
  result: Awaited<ReturnType<typeof writeFrom>>,
  sessionId: SessionId,
  owner: 'alice' | 'bob',
) {
  expect(result.reply.ok).toBe(true)
  expect(result.after).toBe(result.marker)
  expect(result.derived).toEqual([
    expect.objectContaining({
      actorSessionId: sessionId,
      onBehalfOf: f.members[owner].id,
      scope: { kind: 'subtree', rootId: f.tasks[owner] },
    }),
  ])
  expect(result.calls).toEqual(result.derived)
  expect(result.edit).toMatchObject({
    body: result.marker,
    actor: `session:${sessionId}`,
    onBehalfOf: f.members[owner].id,
  })
}

function refused(result: Awaited<ReturnType<typeof writeFrom>>) {
  // Same public response for absent and foreign sessions, with no authority
  // minted (including worker/none), no dispatcher call and no durable write.
  expect.soft(result.reply).toEqual({
    type: 'agentRelayResult',
    requestId: result.marker,
    ok: false,
    error: 'not authorized',
  })
  expect.soft(result.derived).toEqual([])
  expect.soft(result.calls).toEqual([])
  expect.soft(result.after).toBe(result.before)
  expect.soft(result.historyAfter).toEqual(result.historyBefore)
}

describe('authenticated daemon relay sender/session boundary', () => {
  it('allows Bob from his machine with Bob attribution and an own-task write', async () => {
    allowed(await writeFrom(f.machines.bob, f.sessions.bob, f.tasks.bob), f.sessions.bob, 'bob')
  })

  it('allows Alice from her machine with Alice attribution and an own-task write', async () => {
    allowed(
      await writeFrom(f.machines.alice, f.sessions.alice, f.tasks.alice),
      f.sessions.alice,
      'alice',
    )
  })

  it('refuses Bob naming Alice session before capability derivation or dispatch', async () => {
    refused(await writeFrom(f.machines.bob, f.sessions.alice, f.tasks.alice))
  })

  it('refuses the wrong sender even when its custodian is admin', async () => {
    refused(await writeFrom(f.machines.alice, f.sessions.bob, f.tasks.bob))
  })

  it('refuses an unknown session without a worker-none fallback', async () => {
    refused(await writeFrom(f.machines.bob, asSessionId('no-such-relay-session'), f.tasks.alice))
  })

  it('preserves Alice authority on Bob shared machine (Q1)', async () => {
    allowed(await writeFrom(f.machines.bob, sharedSession, f.tasks.alice), sharedSession, 'alice')
  })

  it('rejects the stale sender after a committed placement change and accepts the new one', async () => {
    const sessions = f.handle.registry.modules.sessions
    const store = f.handle.registry.sessionStore
    const row = await store.sessions.getSession(sharedSession)
    if (!row) throw new Error('missing shared session')
    // A real repository write of placement, not a mocked lookup. Deliberately
    // leave the resident object at its old placement to expose cache-based gates.
    await store.sessions.upsertSession(fixtureWriteScope(), { ...row, machineId: f.machines.alice })
    expect((await store.sessions.getSession(sharedSession))?.machineId).toBe(f.machines.alice)
    expect(sessions.sessions.get(sharedSession)?.machineId).toBe(f.machines.bob)
    refused(await writeFrom(f.machines.bob, sharedSession, f.tasks.alice))
    allowed(await writeFrom(f.machines.alice, sharedSession, f.tasks.alice), sharedSession, 'alice')
  })
})
