import type { ControlMessage } from '@podium/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionRegistry } from './relay'

/**
 * Approval broker end-to-end through the real registry [spec:SP-edbb] (#410):
 * agent relay request → gate → service → operator decision → exec frame to the
 * owning daemon → result lands. Mirrors relay-issue-relay.test.ts's harness.
 */

type RelayResult = Extract<ControlMessage, { type: 'issueRelayResult' }>

describe('approval broker relay e2e (#410)', () => {
  const registries: SessionRegistry[] = []
  const machineId = 'm1'
  let registry: SessionRegistry
  let sA: string
  let daemonInbox: ControlMessage[]

  beforeEach(() => {
    registry = new SessionRegistry()
    registries.push(registry)
    const A = registry.issues.create({ repoPath: '/r', title: 'epic', startNow: false })
    registry.issues.update(A.id, { worktreePath: '/r/.worktrees/issue-1-a' })
    const wtA = registry.issues.get(A.id)?.worktreePath as string
    sA = registry.modules.sessions.createSession({ cwd: wtA, agentKind: 'shell' }).sessionId
    daemonInbox = []
    registry.modules.sessions.attachDaemon(machineId, (msg) => daemonInbox.push(msg))
  })

  afterEach(() => {
    for (const r of registries.splice(0)) r.dispose()
  })

  const relay = async (proc: string, input: unknown): Promise<RelayResult> => {
    const before = daemonInbox.length
    registry.modules.sessions.onDaemonMessageFrom(machineId, {
      type: 'issueRelayRequest',
      requestId: `ir${before}`,
      sessionId: sA,
      router: 'approvals',
      proc,
      input,
    })
    // the gate replies asynchronously (await inside run()); flush microtasks
    for (
      let i = 0;
      i < 10 && !daemonInbox.slice(before).some((m) => m.type === 'issueRelayResult');
      i++
    ) {
      await new Promise((r) => setTimeout(r, 1))
    }
    const reply = daemonInbox.find(
      (m): m is RelayResult => m.type === 'issueRelayResult' && m.requestId === `ir${before}`,
    )
    if (!reply) throw new Error('no relay reply')
    return reply
  }

  it('request → pending → approve → daemon exec → result → succeeded', async () => {
    const r = await relay('request', { op: { kind: 'update' } })
    expect(r.ok).toBe(true)
    const { id } = r.result as { id: string }
    expect(registry.modules.approvals.listPending()).toHaveLength(1)

    registry.modules.approvals.approve(id)
    const exec = daemonInbox.find((m) => m.type === 'approvalExecRequest')
    expect(exec).toMatchObject({ requestId: id, op: { kind: 'update' } })

    registry.modules.sessions.onDaemonMessageFrom(machineId, {
      type: 'approvalExecResult',
      requestId: id,
      ok: true,
      exitCode: 0,
      output: 'updated 0.1.0 -> 0.1.1',
    })
    const status = await relay('get', { id })
    expect(status.ok).toBe(true)
    expect(status.result).toMatchObject({ status: 'succeeded' })
    expect(registry.modules.approvals.listPending()).toHaveLength(0)
  })

  it('the relay cannot approve/deny — only request and get are reachable', async () => {
    const r = await relay('approve', { id: 'apr_x' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/not permitted/)
  })

  it('a forged sessionId/machineId in the input is overwritten by the relay context', async () => {
    const r = await relay('request', {
      op: { kind: 'stop' },
      sessionId: 'someone-else',
      machineId: 'evil',
    })
    expect(r.ok).toBe(true)
    const pending = registry.modules.approvals.listPending()
    expect(pending[0]).toMatchObject({ sessionId: sA, machineId })
  })
})
