import { asMutationId, asSessionId, firstAdminMemberId, type MachineId } from '@podium/model'
import type { ApprovalEffectInput } from '@podium/protocol'
import type { ControlMessage } from '@podium/protocol/daemon'
import { nativeAccountId } from '@podium/runtime'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { userCommandPrincipal } from './command-principal'
import { SessionRegistry } from './relay'
import { fixtureInventory } from './test-support/daemon-inventory'
import { attachHostDaemon } from './test-support/host-daemon'

/**
 * Approval broker end-to-end through the real registry [spec:SP-edbb] (#410):
 * agent relay request → gate → an `approval` effect record → the person's
 * decision (`records.effect.edit`, POD-6674) → exec frame to the owning daemon →
 * result lands. Mirrors relay-agent-relay.test.ts's harness.
 */

type RelayResult = Extract<ControlMessage, { type: 'agentRelayResult' }>

describe('approval broker relay e2e (#410)', () => {
  const registries: SessionRegistry[] = []
  let machineId: MachineId
  let registry: SessionRegistry
  let sA: string
  let daemonInbox: ControlMessage[]
  let relayReplies: Map<string, (reply: RelayResult) => void>

  beforeEach(async () => {
    registry = await SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
    registries.push(registry)
    machineId = registry.sessionStore.hostMachineId
    daemonInbox = []
    relayReplies = new Map()
    // Enroll a reporting machine and finish its inventory handshake before placement.
    await attachHostDaemon(
      registry,
      (msg) => {
        daemonInbox.push(msg)
        if (msg.type === 'agentRelayResult') {
          const resolve = relayReplies.get(msg.requestId)
          relayReplies.delete(msg.requestId)
          resolve?.(msg)
        }
      },
      { repos: ['/r'] },
    )
    await registry.modules.machines.recordInventory(machineId, fixtureInventory())
    const A = await registry.issues.crud.create(registry.issues.reports.store.serverWriter, { repoPath: '/r', title: 'epic', startNow: false })
    await registry.issues.crud.update(registry.issues.reports.store.serverWriter, A.id, { worktreePath: '/r/.worktrees/issue-1-a' })
    const wtA = (await registry.issues.reports.get(A.id))?.worktreePath as string
    sA = (await registry.modules.sessions.createSession({ cwd: wtA, agentKind: 'shell' })).sessionId
  })

  afterEach(async () => {
    for (const r of registries.splice(0)) await r.dispose()
  })

  const relay = (proc: string, input: unknown): Promise<RelayResult> => {
    const requestId = `ir${daemonInbox.length}`
    // The agent relay port dispatches without returning its handler promise.
    // Register before dispatch and resolve only from the correlated daemon reply.
    return new Promise((resolve) => {
      relayReplies.set(requestId, resolve)
      void registry.gateway.routeDaemonFrame(machineId, {
        type: 'agentRelayRequest',
        requestId,
        sessionId: asSessionId(sA),
        router: 'approvals',
        proc,
        input,
      })
    })
  }

  /** The approval records waiting for a person. */
  const pending = async () =>
    (await registry.sessionStore.effects.listAwaiting('approval', 500)).map((row) => ({
      id: row.id,
      ...(row.input as ApprovalEffectInput),
    }))

  /** The session owner approves, as the app does, and the trigger runs it. */
  const approve = async (id: string) => {
    const row = await registry.sessionStore.effects.get(id)
    const reply = await registry.modules.syncWrite.submit(
      {
        mutationId: asMutationId(`m-approve-${id}`),
        command: 'records.effect.edit',
        version: 1,
        input: { id, patch: { decision: 'approve' }, expectedRevision: row?.revision },
      },
      userCommandPrincipal(firstAdminMemberId(), 'admin'),
      'trpc',
    )
    expect(reply).toMatchObject({ outcome: 'applied' })
    await registry.modules.effects?.runner.idle()
    return (await relay('get', { id })).result
  }

  it('request → pending → approve → daemon exec → result → succeeded', async () => {
    const r = await relay('request', { op: { kind: 'update' } })
    expect(r.ok).toBe(true)
    const { id } = r.result as { id: string }
    expect(await pending()).toHaveLength(1)

    await approve(id)
    const exec = daemonInbox.find((m) => m.type === 'approvalExecRequest')
    expect(exec).toMatchObject({ requestId: id, op: { kind: 'update' } })

    // Await the real handler completion: routing alone does not finish the store write.
    await registry.gateway.routeDaemonFrame(machineId, {
      type: 'approvalExecResult',
      requestId: id,
      ok: true,
      exitCode: 0,
      output: 'updated 0.1.0 -> 0.1.1',
    })
    const status = await relay('get', { id })
    expect(status.ok).toBe(true)
    expect(status.result).toMatchObject({ status: 'succeeded' })
    expect(await pending()).toHaveLength(0)
  })

  it('approved current-session schedule creates an armed server-owned one-off', async () => {
    const runAt = '2099-07-17T02:00:00.000Z'
    const r = await relay('request', {
      op: {
        kind: 'automation-schedule',
        name: 'Overnight continuation',
        runAt,
        prompt: 'Continue during the quota window.',
        target: { kind: 'current' },
      },
    })
    expect(r.ok).toBe(true)
    const { id } = r.result as { id: string }

    const approved = await approve(id)
    expect(approved).toMatchObject({ status: 'succeeded' })
    expect(daemonInbox.some((message) => message.type === 'approvalExecRequest')).toBe(false)
    expect(await registry.modules.automations.list()).toEqual([
      expect.objectContaining({
        name: 'Overnight continuation',
        scheduleKind: 'once',
        runAt,
        nextRunAt: runAt,
        targetSessionId: sA,
        sessionMode: 'resume',
        enabled: true,
      }),
    ])
  })

  it('[POD-1107] a fresh schedule with no agent gets the configured default, not codex', async () => {
    const owner = firstAdminMemberId()
    // Enrollment seeds a personal superagent choice. Round-trip the owner's
    // resolved settings, or instance defaults remove that unrelated choice.
    const settings = await registry.modules.settings.getSettingsFor(owner)
    expect(settings.roles.superagent.harness).toBeDefined()
    expect((await registry.modules.settings.getSettings()).roles.superagent.harness).toBeUndefined()
    const saved = await registry.modules.settings.setSettingsFor(owner, {
      ...settings,
      roles: {
        ...settings.roles,
        coding: {
          ...settings.roles.coding,
          accountId: nativeAccountId('grok'),
          model: 'grok-4',
          effort: 'high',
        },
      },
    })
    expect(saved.roles.superagent).toEqual(settings.roles.superagent)
    const runAt = '2099-07-17T02:00:00.000Z'
    const r = await relay('request', {
      op: {
        kind: 'automation-schedule',
        name: 'Overnight sweep',
        runAt,
        prompt: 'Sweep the repo.',
        target: { kind: 'fresh', repoPath: '/r' },
      },
    })
    expect(r.ok).toBe(true)

    await approve((r.result as { id: string }).id)
    expect(await registry.modules.automations.list()).toEqual([
      expect.objectContaining({
        name: 'Overnight sweep',
        repoPath: '/r',
        // The operator's configured harness — the hardcoded 'codex'/'auto' that
        // stood here ignored it entirely.
        agentKind: 'grok',
        model: 'grok-4',
        effort: 'high',
      }),
    ])
  })

  it('the relay cannot approve/deny — only request and get are reachable', async () => {
    const r = await relay('approve', { id: 'apr_x' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/not permitted/)
  })

  it('a forged sessionId/machineId in the input is overwritten by the relay context', async () => {
    const r = await relay('request', {
      op: { kind: 'stop' },
      sessionId: asSessionId('someone-else'),
      machineId: 'evil',
    })
    expect(r.ok).toBe(true)
    expect((await pending())[0]).toMatchObject({ sessionId: sA, machineId })
  })
})
