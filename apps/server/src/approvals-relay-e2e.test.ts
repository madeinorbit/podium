import { firstAdminMemberId, asSessionId, asUserId, type SessionId } from '@podium/model'
import type { ControlMessage } from '@podium/protocol/daemon'
import { nativeAccountId } from '@podium/runtime'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionRegistry } from './relay'

/**
 * Approval broker end-to-end through the real registry [spec:SP-edbb] (#410):
 * agent relay request → gate → service → operator decision → exec frame to the
 * owning daemon → result lands. Mirrors relay-agent-relay.test.ts's harness.
 */

type RelayResult = Extract<ControlMessage, { type: 'agentRelayResult' }>

describe('approval broker relay e2e (#410)', () => {
  const registries: SessionRegistry[] = []
  const machineId = 'm1'
  let registry: SessionRegistry
  let sA: string
  /** The issue worktree both sessions below run in. */
  let wtA: string
  let daemonInbox: ControlMessage[]

  beforeEach(async () => {
    registry = await SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
    registries.push(registry)
    const A = await registry.issues.create({ repoPath: '/r', title: 'epic', startNow: false })
    await registry.issues.update(A.id, { worktreePath: '/r/.worktrees/issue-1-a' })
    wtA = (await registry.issues.get(A.id))?.worktreePath as string
    sA = (await registry.modules.sessions.createSession({ cwd: wtA, agentKind: 'shell' })).sessionId
    daemonInbox = []
    registry.gateway.attachDaemon(machineId, (msg) => daemonInbox.push(msg))
  })

  afterEach(async () => {
    for (const r of registries.splice(0)) await r.dispose()
  })

  /** A relay frame from an arbitrary session — the daemon's `/agent/<sessionId>`
   *  path is what the gate reads, so this is the only thing that distinguishes
   *  one agent caller from another on this transport. */
  const relayFrom = async (
    sessionId: SessionId,
    proc: string,
    input: unknown,
  ): Promise<RelayResult> => {
    const before = daemonInbox.length
    registry.gateway.routeDaemonFrame(machineId, {
      type: 'agentRelayRequest',
      requestId: `ir${before}`,
      sessionId,
      router: 'approvals',
      proc,
      input,
    })
    // the gate replies asynchronously (await inside run()); flush microtasks
    for (
      let i = 0;
      i < 10 && !daemonInbox.slice(before).some((m) => m.type === 'agentRelayResult');
      i++
    ) {
      await new Promise((r) => setTimeout(r, 1))
    }
    const reply = daemonInbox.find(
      (m): m is RelayResult => m.type === 'agentRelayResult' && m.requestId === `ir${before}`,
    )
    if (!reply) throw new Error('no relay reply')
    return reply
  }

  const relay = (proc: string, input: unknown): Promise<RelayResult> =>
    relayFrom(asSessionId(sA), proc, input)

  it('request → pending → approve → daemon exec → result → succeeded', async () => {
    const r = await relay('request', { op: { kind: 'update' } })
    expect(r.ok).toBe(true)
    const { id } = r.result as { id: string }
    expect(await registry.modules.approvals.listPending(firstAdminMemberId())).toHaveLength(1)

    await registry.modules.approvals.approve(id, firstAdminMemberId())
    const exec = daemonInbox.find((m) => m.type === 'approvalExecRequest')
    expect(exec).toMatchObject({ requestId: id, op: { kind: 'update' } })

    // AWAITED, and that is the assertion below's whole basis (PDM-292). This
    // frame is not request/reply: nothing comes back for `relayFrom`'s poll to
    // wait on, and the `get` that follows is a DIFFERENT frame whose reply says
    // nothing about whether this one finished. Dropped, the read raced
    // `onExecResult`'s `executing → succeeded` store write and lost every time,
    // reading the pre-result row. `routeDaemonFrame` returns the catch-handled
    // completion precisely so a test can observe handler effects without timers
    // or polling — see `gateway/daemon-mux.ts`. Production ingress is the one
    // that deliberately does not wait.
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
    expect(await registry.modules.approvals.listPending(firstAdminMemberId())).toHaveLength(0)
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

    const approved = await registry.modules.approvals.approve(id, firstAdminMemberId())
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
    await registry.modules.settings.setSettingsFor(firstAdminMemberId(), {
      ...await registry.modules.settings.getSettings(),
      roles: {
        ...(await registry.modules.settings.getSettings()).roles,
        coding: {
          ...(await registry.modules.settings.getSettings()).roles.coding,
          accountId: nativeAccountId('grok'),
          model: 'grok-4',
          effort: 'high',
        },
      },
    })
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

    await registry.modules.approvals.approve((r.result as { id: string }).id, firstAdminMemberId())
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
    const pending = await registry.modules.approvals.listPending(firstAdminMemberId())
    expect(pending[0]).toMatchObject({ sessionId: sA, machineId })
  })

  /**
   * THE RELAY ARM PASSES THE CALLER (PDM-278) — the transport half of the fix.
   *
   * `relay-dispatch.ts`'s `approvals.get` arm handed the service a caller-supplied
   * id and nothing else, so this frame returned another human's machine, session,
   * issue and operation to whoever sent it. The service could not refuse it: there
   * was nothing to refuse on.
   *
   * WHAT THIS TEST IS FOR, since it is not the discriminating one. Whether a
   * DIFFERENT HUMAN is told apart from the same one is decided in
   * `modules/approvals/service.test.ts`, which runs in the store shard and
   * therefore in every lane; this file is in no `test-shards.json` entry and the
   * unit lane excludes it by its `e2e` filename, so it runs only in the root
   * integration lane. What belongs HERE is the thing only this lane can
   * show: that the capability's two identity halves actually reach the service
   * across the real gate, rather than the arm passing an empty caller — which
   * would refuse everybody, or, gated on the payload instead, admit anybody.
   *
   * THE SECOND SESSION HAS A REAL SECOND OWNER, not no owner. An unowned session
   * is refused too, by the other arm of the gate, so a fixture built that way
   * would pass with the cross-human check deleted (false-green catalogue 14).
   */
  it("another human's agent is refused the same id this one may read", async () => {
    const r = await relay('request', { op: { kind: 'update' } })
    expect(r.ok).toBe(true)
    const { id } = r.result as { id: string }

    // `createSession` defaults the owner to the first admin, so sA is theirs.
    const store = registry.sessionStore
    const stranger = asUserId('mem_2ZZZZZZZZZZZZZZZZZZZZZZZZZZ')
    await store.users.create(
      {
        id: stranger,
        displayName: 'Second member',
        role: 'member',
        createdAt: '2026-09-13T00:00:00.000Z',
        disabledAt: null,
      },
      'scrypt:hash',
    )
    const sB = (
      await registry.modules.sessions.createSession({
        cwd: wtA,
        agentKind: 'shell',
        ownerUserId: stranger,
      })
    ).sessionId

    const refused = await relayFrom(asSessionId(sB), 'get', { id })
    expect(refused.ok).toBe(false)
    // The same words an id that does not exist gets: a distinct refusal would
    // confirm the row exists and name a session this caller cannot see.
    expect(refused.error).toBe(`unknown approval request: ${id}`)

    // Not "the id stopped working": the session that filed it still reads it,
    // over the same transport, in the same test. This is the `actorSessionId`
    // half — drop it from the arm and this refuses.
    const mine = await relay('get', { id })
    expect(mine.ok).toBe(true)
    expect(mine.result).toMatchObject({ id, status: 'pending' })

    // And the `onBehalfOf` half, which nothing above would catch: a DIFFERENT
    // session of the SAME human. It is not the row's session, so only the
    // capability's human can admit it — pass just `actorSessionId` from the arm
    // and this one refuses while every other assertion here still passes.
    const sC = (
      await registry.modules.sessions.createSession({ cwd: wtA, agentKind: 'shell' })
    ).sessionId
    const sibling = await relayFrom(asSessionId(sC), 'get', { id })
    expect(sibling.ok).toBe(true)
    expect(sibling.result).toMatchObject({ id, status: 'pending' })
  })
})
