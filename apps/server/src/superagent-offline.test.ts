import { attachTestClient } from './test-support/client-transport'
// Superagent offline-machine refusal (POD-4806): a turn on a thread whose
// headless session lives on a machine with no daemon must refuse fast with
// "<machine> is offline", keep the user's message plus a visible failure, and
// never leak the internal SessionBinding spawn error. The headless spawn must
// also carry the server-minted binding, or every new headless session fails
// on a real daemon.
import {
  asSessionId,
  asThreadId,
  BUILTIN_HARNESS_KINDS,
  firstAdminMemberId,
} from '@podium/model'
import type { ControlMessage } from '@podium/protocol/daemon'
import { afterEach, describe, expect, it } from 'vitest'
import { SuperagentService, TURN_FAILED_MARKER } from './modules/superagent'
import { SessionRegistry } from './relay'
import { RepoRegistry } from './repo-registry'
import { assignHostMachine } from './test-support/host-daemon'

const registries: SessionRegistry[] = []
afterEach(async () => {
  for (const r of registries.splice(0)) await r.dispose()
})

async function offlineHarness() {
  const registry = await SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
  registries.push(registry)
  const host = registry.sessionStore.hostMachineId
  await assignHostMachine(registry.sessionStore)
  await (registry.sessionStore as unknown as { machines: { setServiceAssignment(id: unknown, a: unknown): Promise<void> } }).machines.setServiceAssignment(host, { server: true, agentExecution: true })
  const spawns: Extract<ControlMessage, { type: 'spawn' }>[] = []
  const turnReqs: { requestId: string; turnId: string; sessionId: string }[] = []
  const epochs = new Map<string, number>()
  const peer = (m: ControlMessage) => {
    if (m.type === 'spawn') spawns.push(m)
    if (m.type === 'runtimeSendRequest' || m.type === 'runtimeDurableSendRequest') {
      const epoch = (epochs.get(m.sessionId) ?? 0) + 1
      epochs.set(m.sessionId, epoch)
      turnReqs.push({ requestId: (m as { requestId: string }).requestId, turnId: (m as { turnId: string }).turnId, sessionId: m.sessionId })
    }
    if (m.type === 'runtimeSnapshotRequest') {
      const req = m as { requestId: string; sessionId: string }
      queueMicrotask(() =>
        registry.gateway.routeDaemonFrame(host, {
          type: 'runtimeSnapshotResult',
          requestId: req.requestId,
          sessionId: req.sessionId as never,
          result: {
            snapshot: {
              binding: {
                sessionId: req.sessionId as never,
                driver: 'headless',
                family: 'server',
                harness: 'claude-code',
                workdir: '/r',
                resume: null,
                process: { key: 'test' },
                bindingVersion: 1,
              },
              state: {},
              cursor: { segmentId: 's', components: {} },
              observerGeneration: 1,
              turnEpoch: epochs.get(req.sessionId) ?? 1,
              interactions: [],
              at: new Date().toISOString(),
            },
          },
        }),
      )
    }
    if (m.type === 'transcriptRead') {
      const req = m as { requestId: string; sessionId: string }
      queueMicrotask(() =>
        registry.gateway.routeDaemonFrame(host, {
          type: 'transcriptReadResult',
          requestId: req.requestId,
          sessionId: req.sessionId as never,
          items: [],
          hasMore: false,
        }),
      )
    }
  }
  await registry.gateway.attachDaemon(host, peer)
  registry.gateway.routeDaemonFrame(host, {
    type: 'inventoryReport',
    machineId: host,
    inventory: {
      os: 'linux',
      arch: 'x64',
      agents: BUILTIN_HARNESS_KINDS.map((kind) => ({
        kind,
        installed: true,
        login: { state: 'in' as const },
      })),
      tools: [],
    },
  })
  const repos = new RepoRegistry(registry, registry.sessionStore)
  await repos.add('/r', host)
  const sa = await SuperagentService.create(registry.modules, repos, registry.sessionStore)
  attachTestClient(registry.clientGateway, () => {})
  const settle = () => new Promise((r) => setTimeout(r))
  const waitForIdle = async (timeoutMs = 10_000) => {
    const start = Date.now()
    for (;;) {
      const pending = await registry.sessionStore.superagent.listPendingTurns()
      if (pending.length === 0) return
      if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for pending turns to drain')
      await new Promise((r) => setTimeout(r, 10))
    }
  }
  const resolveTurn = async (req: { requestId: string; turnId: string; sessionId: string }) => {
    const epoch = epochs.get(req.sessionId) ?? 1
    await registry.gateway.routeDaemonFrame(host, {
      type: 'runtimeSendResult',
      requestId: req.requestId,
      sessionId: req.sessionId as never,
      receipt: { outcome: 'accepted', turnEpoch: epoch, deliveredAs: 'when-ready', provenBy: 'protocol-ack', at: new Date().toISOString() },
    })
    const at = new Date().toISOString()
    const gateway = registry.modules.sessions.runtimeGateway
    await gateway.record(host, {
      sessionId: req.sessionId as never,
      event: { t: 'turn', ev: { ev: 'started', turnEpoch: epoch, origin: 'system' }, cursor: { segmentId: 's', components: { seq: epoch * 2 - 1 } }, observerGeneration: 1, turnEpoch: epoch, provenance: 'live', at } as never,
    })
    await gateway.record(host, {
      sessionId: req.sessionId as never,
      event: { t: 'turn', ev: { ev: 'completed', turnEpoch: epoch, verdict: 'done' }, cursor: { segmentId: 's', components: { seq: epoch * 2 } }, observerGeneration: 1, turnEpoch: epoch, provenance: 'live', at } as never,
    })
  }
  return { registry, repos, sa, spawns, turnReqs, peer, host, settle, waitForIdle, resolveTurn }
}

describe('superagent offline machine (POD-4806)', () => {
  it('mints the server-minted binding on the headless spawn', async () => {
    const h = await offlineHarness()
    await h.sa.sendTurn({
      ownerUserId: firstAdminMemberId(),
      threadId: asThreadId('global'),
      text: 'hello',
    })
    expect(h.spawns).toHaveLength(1)
    const spawn = h.spawns[0]!
    expect(spawn.requestedDriverId).toBe('headless')
    // Cause 2: the establish frame must carry the server-minted instruction
    // or a real daemon refuses with "server-minted SessionBinding ... required".
    expect(spawn.binding).toMatchObject({
      transitionId: `spawn:${spawn.sessionId}`,
      machineAccess: 'allowed',
      principal: { kind: 'user', userId: firstAdminMemberId() },
    })
  })

  it('refuses fast with "<machine> is offline" and keeps the message plus a visible failure', async () => {
    const h = await offlineHarness()
    // First turn online so the thread binds its headless session to the host.
    const ack = await h.sa.sendTurn({
      ownerUserId: firstAdminMemberId(),
      threadId: asThreadId('global'),
      text: 'first',
    })
    // Complete the first turn so the thread is idle but still bound.
    expect(h.turnReqs).toHaveLength(1)
    await h.resolveTurn(h.turnReqs[0]!)
    await h.waitForIdle()
    // Take the machine offline: the bound session's host has no daemon now.
    h.registry.gateway.detachDaemon(h.host, h.peer)
    expect(h.registry.modules.machines.hasDaemon(h.host)).toBe(false)

    const err = await h.sa
      .sendTurn({
        ownerUserId: firstAdminMemberId(),
        threadId: asThreadId('global'),
        text: 'Reply with exactly the word PONG-SUPER.',
      })
      .then(
        () => null,
        (e: unknown) => (e instanceof Error ? e.message : String(e)),
      )
    expect(err).toContain('is offline')
    expect(err).not.toContain('SessionBinding')
    // The user's message and a visible failure survive a reload (history).
    const history = await h.sa.history(firstAdminMemberId(), asThreadId('global'))
    const contents = history.map((m) => m.content)
    expect(contents).toContain('Reply with exactly the word PONG-SUPER.')
    const failure = history.find((m) => m.content.includes(TURN_FAILED_MARKER))
    expect(failure?.content).toContain('is offline')
    expect(failure?.content).not.toContain('SessionBinding')
    // The first turn's session is untouched; the failed turn never dispatched.
    expect((await h.registry.sessionStore.superagent.getSuperagentThread('global'))?.podiumSessionId).toBe(
      ack.podiumSessionId,
    )
  })

  it('a turn that fails after dispatch keeps the message and never leaks internals', async () => {
    const h = await offlineHarness()
    await h.sa.sendTurn({
      ownerUserId: firstAdminMemberId(),
      threadId: asThreadId('global'),
      text: 'run it',
    })
    // Fail the dispatched turn at the harness (provider error while online).
    const req = h.turnReqs[0]!
    const epoch = 1
    await h.registry.gateway.routeDaemonFrame(h.host, {
      type: 'runtimeSendResult',
      requestId: req.requestId,
      sessionId: req.sessionId as never,
      receipt: { outcome: 'accepted', turnEpoch: epoch, deliveredAs: 'when-ready', provenBy: 'protocol-ack', at: new Date().toISOString() },
    })
    const at = new Date().toISOString()
    const gateway = h.registry.modules.sessions.runtimeGateway
    await gateway.record(h.host, {
      sessionId: req.sessionId as never,
      event: { t: 'turn', ev: { ev: 'started', turnEpoch: epoch, origin: 'system' }, cursor: { segmentId: 's', components: { seq: 1 } }, observerGeneration: 1, turnEpoch: epoch, provenance: 'live', at } as never,
    })
    await gateway.record(h.host, {
      sessionId: req.sessionId as never,
      event: { t: 'turn', ev: { ev: 'failed', turnEpoch: epoch, reason: 'provider-error', disposition: 'fatal', detail: 'boom' }, cursor: { segmentId: 's', components: { seq: 2 } }, observerGeneration: 1, turnEpoch: epoch, provenance: 'live', at } as never,
    })
    await h.waitForIdle()
    const history = await h.sa.history(firstAdminMemberId(), asThreadId('global'))
    for (const m of history) {
      expect(m.content).not.toContain('server-minted SessionBinding instruction is required')
    }
    expect(history.some((m) => m.content.includes(TURN_FAILED_MARKER))).toBe(true)
    expect(history.some((m) => m.role === 'user' && m.content === 'run it')).toBe(true)
  })
})
