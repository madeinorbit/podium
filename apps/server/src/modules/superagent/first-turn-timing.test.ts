// Minimal timing probe for POD-4872: first turn on an ONLINE machine must
// ack + emit its establish/turn frames within 10s (not 271s). No prior
// in-flight turn — Clear resets the thread, so a fresh send measures the
// dispatch path the phone's "sending…" waits on.
import type { SessionId } from '@podium/model'
import {
  asThreadId,
  BUILTIN_HARNESS_KINDS,
  firstAdminMemberId,
} from '@podium/model'
import type { ControlMessage } from '@podium/protocol/daemon'
import { afterEach, describe, expect, it } from 'vitest'
import { SuperagentService } from './service'
import { SessionRegistry } from '../../relay'
import { RepoRegistry } from '../../repo-registry'
import { assignHostMachine } from '../../test-support/host-daemon'

const registries: SessionRegistry[] = []
afterEach(async () => {
  for (const r of registries.splice(0)) await r.dispose()
})

async function waitFor(cond: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (cond()) return
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

async function onlineHarness() {
  const registry = await SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
  registries.push(registry)
  const host = registry.sessionStore.hostMachineId
  await assignHostMachine(registry.sessionStore)
  await (
    registry.sessionStore as unknown as {
      machines: { setServiceAssignment(id: unknown, a: unknown): Promise<void> }
    }
  ).machines.setServiceAssignment(host, { server: true, agentExecution: true })
  const frames: ControlMessage[] = []
  const peer = (m: ControlMessage) => {
    frames.push(m)
    if (m.type === 'transcriptRead') {
      const req = m as { requestId: string; sessionId: SessionId }
      queueMicrotask(() =>
        registry.gateway.routeDaemonFrame(host, {
          type: 'transcriptReadResult',
          requestId: req.requestId,
          sessionId: req.sessionId,
          items: [],
          hasMore: false,
        }),
      )
    }
    if (m.type === 'runtimeSnapshotRequest') {
      const req = m as { requestId: string; sessionId: SessionId }
      queueMicrotask(() =>
        registry.gateway.routeDaemonFrame(host, {
          type: 'runtimeSnapshotResult',
          requestId: req.requestId,
          sessionId: req.sessionId,
          result: {
            snapshot: {
              binding: {
                sessionId: req.sessionId,
                driver: 'headless',
                family: 'server',
                harness: 'codex',
                workdir: '/tmp',
                resume: { kind: 'codex-thread', value: 'harness-1' },
                process: { key: 'test' },
                bindingVersion: 1,
              },
              state: {},
              cursor: { segmentId: 's', components: {} },
              observerGeneration: 1,
              turnEpoch: 1,
              interactions: [],
              at: new Date().toISOString(),
            },
          },
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
        login: {
          state: 'in' as const,
          ...(kind === 'codex' ? { identity: { fingerprint: 'FP1' } } : {}),
        },
      })),
      tools: [],
    },
  })
  const repos = new RepoRegistry(registry, registry.sessionStore)
  await repos.add('/r', host)
  const sa = await SuperagentService.create(registry.modules, repos, registry.sessionStore)
  return { registry, repos, sa, frames, host, peer }
}

describe('POD-4872: first turn on an online machine', () => {
  it('acks + emits establish/turn frames within 10s of the send', async () => {
    const h = await onlineHarness()
    const sendStart = Date.now()
    const ack = await h.sa.sendTurn({
      ownerUserId: firstAdminMemberId(),
      threadId: asThreadId('global'),
      text: 'Reply with exactly the word PONG-SUPER.',
      agentKind: 'codex',
    })
    const ackMs = Date.now() - sendStart
    // eslint-disable-next-line no-console
    console.log(`[pod4872-timing] sendTurn ack=${ackMs}ms session=${ack.podiumSessionId}`)
    await waitFor(
      () =>
        h.frames.some((m) => m.type === 'spawn' && m.sessionId === ack.podiumSessionId) &&
        h.frames.some(
          (m) =>
            (m.type === 'runtimeSendRequest' || m.type === 'runtimeDurableSendRequest') &&
            m.sessionId === ack.podiumSessionId,
        ),
      'spawn + turn frames for the new session',
      10_000,
    )
    const totalMs = Date.now() - sendStart
    // eslint-disable-next-line no-console
    console.log(`[pod4872-timing] send->frames total=${totalMs}ms`)
    expect(ackMs).toBeLessThan(10_000)
    expect(totalMs).toBeLessThan(10_000)
  })

  it('the offline refusal carries no TRPCError prefix', async () => {
    const h = await onlineHarness()
    // Bind (no turn) so the offline send below refuses on the bound session.
    await h.sa.ensureSession({
      ownerUserId: firstAdminMemberId(),
      threadId: asThreadId('global'),
    })
    h.registry.gateway.detachDaemon(h.host, h.peer)
    const err = await h.sa
      .sendTurn({
        ownerUserId: firstAdminMemberId(),
        threadId: asThreadId('global'),
        text: 'second',
        agentKind: 'codex',
      })
      .then(
        () => null,
        (e: unknown) => (e instanceof Error ? e.message : String(e)),
      )
    expect(err).toContain('is offline')
    expect(err).not.toContain('TRPCError')
    const failure = await h.sa.latestTurnFailure(firstAdminMemberId(), asThreadId('global'))
    expect(failure?.error).toContain('is offline')
    expect(failure?.error).not.toContain('TRPCError')
  })

  it('the global seed reuses fetched issues instead of re-listing per live session', async () => {
    const h = await onlineHarness()
    // One issue, three live headed sessions bound to it: the seed must resolve
    // all three from the single repo fetch, not one fetch per session.
    const issue = await h.registry.issues.crud.create({
      repoPath: '/r',
      title: 'Fix the thing',
      startNow: false,
    })
    for (let i = 0; i < 3; i++) {
      await h.registry.modules.sessions.createSession({
        agentKind: 'claude-code',
        cwd: '/r',
        issueId: issue.id,
      })
    }
    const inner = h.registry.modules.issues.reports as unknown as {
      list: (...args: unknown[]) => Promise<unknown[]>
    }
    const origList = inner.list.bind(inner)
    let calls = 0
    inner.list = (async (...args: unknown[]) => {
      calls += 1
      return await origList(...args)
    }) as typeof inner.list
    try {
      await h.sa.sendTurn({
        ownerUserId: firstAdminMemberId(),
        threadId: asThreadId('global'),
        text: 'hello',
        agentKind: 'codex',
      })
    } finally {
      inner.list = origList as typeof inner.list
    }
    // One repo → one fetch. At the tip each live session re-listed per repo
    // (1 + 3 = 4), stalling the first turn for minutes on a real database.
    expect(calls).toBe(1)
  })
})
