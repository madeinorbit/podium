import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// The daemon's REAL binding gate, imported the way
// apps/server/src/store/terminal-answer-contract.test.ts imports daemon code:
// the server's actual headless frames go through the real `sessionHandlers`
// authority check plus a real `BindingStore` transition — never a stubbed
// "applied". Red at ff50a99a0 (no binding on the frames), armed.
import { MISSING_SESSION_BINDING_MESSAGE, sessionHandlers } from '../../daemon/src/control/session'
import type { DaemonContext } from '../../daemon/src/control/context'
import { BindingStore } from '../../daemon/src/binding-store'
import { SessionBinding } from '../../daemon/src/session-binding'
import { testSessions } from '../../daemon/src/session/testing.js'
import { asMachineId, asThreadId, BUILTIN_HARNESS_KINDS, firstAdminMemberId } from '@podium/model'
import type { ControlMessage, DaemonMessage } from '@podium/protocol/daemon'
import { afterEach, describe, expect, it } from 'vitest'
import { SuperagentService } from './modules/superagent'
import { SessionRegistry } from './relay'
import { RepoRegistry } from './repo-registry'
import { assignHostMachine } from './test-support/host-daemon'

const registries: SessionRegistry[] = []
afterEach(async () => {
  for (const r of registries.splice(0)) await r.dispose()
})

/** Server registry with a tap recording every headless establish frame. */
async function gateHarness() {
  const registry = await SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
  registries.push(registry)
  const host = registry.sessionStore.hostMachineId
  await assignHostMachine(registry.sessionStore)
  await (registry.sessionStore as unknown as { machines: { setServiceAssignment(id: unknown, a: unknown): Promise<void> } }).machines.setServiceAssignment(host, { server: true, agentExecution: true })
  const frames: ControlMessage[] = []
  await registry.gateway.attachDaemon(host, (m: ControlMessage) => {
    if (m.type === 'spawn' || m.type === 'reattach') frames.push(m)
  })
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
  return { registry, sa, frames, host }
}

/** A daemon control context whose binding service is the REAL store. Past the
 *  authority check the launch arms fail deterministically (no agent runtime
 *  composed here) — which is exactly what distinguishes "gate passed" (a
 *  launch-path error) from "gate refused" (the MISSING instruction error). */
async function gateContext() {
  const dir = mkdtempSync(join(tmpdir(), 'podium-4806-binding-gate-'))
  const store = await BindingStore.open({ dir })
  const sent: DaemonMessage[] = []
  const ctx = {
    send: (message: DaemonMessage) => sent.push(message),
    sessionBinding: new SessionBinding(store),
    machineId: asMachineId('gate-machine'),
    durableLabelFor: (id: string) => `gate-${id}`,
    harnessLoginState: () => 'in',
    sessions: testSessions(),
  } as unknown as DaemonContext
  const missing = () =>
    sent.filter(
      (m) =>
        (m.type === 'spawnError' && (m as { message?: string }).message === MISSING_SESSION_BINDING_MESSAGE) ||
        (m.type === 'reattachFailed' && (m as { reason?: string }).reason === MISSING_SESSION_BINDING_MESSAGE),
    )
  return { ctx, sent, store, missing }
}

describe('headless frames through the daemon binding gate (POD-4806 review)', () => {
  it('the actual headless spawn passes the real gate and records a binding', async () => {
    const h = await gateHarness()
    const { sessionId } = await h.registry.modules.sessions.headless.createHeadlessSession({
      agentKind: 'codex',
      cwd: '/r',
      ownerUserId: firstAdminMemberId(),
    })
    const spawn = h.frames.find((m) => m.type === 'spawn' && m.sessionId === sessionId)
    expect(spawn?.type).toBe('spawn')
    const g = await gateContext()
    await sessionHandlers.spawn(g.ctx, spawn as never)
    // The gate passed: no missing-instruction refusal, and the REAL store
    // transition recorded the binding the frame minted.
    expect(g.missing()).toHaveLength(0)
    const record = await g.store.read(sessionId)
    expect(record?.delegation?.onBehalfOf).toBe(firstAdminMemberId())
    expect(record?.transitionHistory.some((entry) => entry.event === 'spawn')).toBe(true)
  })

  it('two actual headless reattaches each mint their own transition (no constant-id dedup)', async () => {
    const h = await gateHarness()
    const { sessionId } = await h.registry.modules.sessions.headless.createHeadlessSession({
      agentKind: 'codex',
      cwd: '/r',
      ownerUserId: firstAdminMemberId(),
    })
    const g = await gateContext()
    await sessionHandlers.spawn(g.ctx, h.frames.find((m) => m.type === 'spawn') as never)
    expect(g.missing()).toHaveLength(0)

    await h.registry.modules.sessions.headless.headlessBind({
      sessionId,
      agentKind: 'codex',
      cwd: '/r',
      resumeValue: 'harness-1',
    })
    await h.registry.modules.sessions.headless.headlessBind({
      sessionId,
      agentKind: 'codex',
      cwd: '/r',
      resumeValue: 'harness-1',
    })
    const reattaches = h.frames.filter((m) => m.type === 'reattach')
    expect(reattaches).toHaveLength(2)
    // Distinct transition ids: a constant `reattach:<id>:1` would collapse
    // the second frame into the first (unchanged) instead of applying it.
    const ids = reattaches.map((m) => (m.type === 'reattach' ? m.binding?.transitionId : undefined))
    expect(new Set(ids).size).toBe(2)
    for (const frame of reattaches) {
      await sessionHandlers.reattach(g.ctx, frame as never)
    }
    expect(g.missing()).toHaveLength(0)
    const record = await g.store.read(sessionId)
    expect(record?.transitionHistory.filter((entry) => entry.event === 'reattach')).toHaveLength(2)
  })

  it('a superagent first turn establishes through the same mint (end to end)', async () => {
    const h = await gateHarness()
    const ack = await h.sa.sendTurn({
      ownerUserId: firstAdminMemberId(),
      threadId: asThreadId('global'),
      text: 'hello',
    })
    const spawn = h.frames.find((m) => m.type === 'spawn' && m.sessionId === ack.podiumSessionId)
    expect(spawn?.type).toBe('spawn')
    const g = await gateContext()
    await sessionHandlers.spawn(g.ctx, spawn as never)
    expect(g.missing()).toHaveLength(0)
    expect(await g.store.read(ack.podiumSessionId)).not.toBeNull()
  })
})
