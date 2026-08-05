import { asIssueId, asSessionId } from '@podium/model'
import type { SessionId } from '@podium/model'
import type { ControlMessage } from '@podium/protocol'
import { sessionTitleRule } from '@podium/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionRegistry } from './relay'
import { SessionStore } from './store'

/**
 * The nudge's own opening sentence, taken from the source of truth rather than
 * pinned as a copy string [POD-743]. A bare `toContain('podium session title')`
 * cannot tell the NUDGE from a mere mention of the command: the delegation
 * guidance rides in every prime and legitimately contains that literal, which
 * made the negative assertions fire always and the positive one pass always.
 * seq only affects a later line, so 0 is a safe stand-in for the first.
 */
const TITLE_NUDGE = sessionTitleRule(0, []).split('\n')[0]

type RelayResult = Extract<ControlMessage, { type: 'agentRelayResult' }>

// Capture the agentRelayResult the registry sends back to a machine. attachDaemon registers
// a daemon's control-message send fn (confirmed in wsServer.ts); the relay reply routes to it.
function captureReply(registry: SessionRegistry, machineId: string): Promise<RelayResult> {
  return new Promise((resolve) => {
    registry.gateway.attachDaemon(machineId, (msg) => {
      if (msg.type === 'agentRelayResult') resolve(msg)
    })
  })
}

// P1b-server: the server end of the daemon-relayed capability seam. A relayed agent op is run
// through the capability-scoped in-process command service (so the scope gate is enforced, not
// re-implemented), gated by an allowlist, with the capability minted from the session's cwd.
describe('server agent relay handler (P1b)', () => {
  const registries: SessionRegistry[] = []
  const machineId = 'm1'
  const repoPath = '/r'
  let registry: SessionRegistry
  let store: SessionStore
  let A: { id: string; title: string }
  let B: { id: string }
  let sA: string

  beforeEach(() => {
    // Two machines with a checkout each, seeded through an injected store. Without
    // this the default fixture has a daemon SOCKET but no machines ROW, so a fleet
    // read comes back empty — and an empty array satisfies every per-row assertion
    // below without executing one of them. This seeding is what lets those fail.
    store = new SessionStore(':memory:')
    store.machines.upsertMachine({
      id: machineId,
      name: 'ludovico',
      hostname: 'ludovico.local',
      tokenHash: 'hash-1',
      ownerUserId: null,
    })
    store.machines.upsertMachine({
      id: 'm2',
      name: 'quiet-box',
      hostname: 'quiet-box.example.net',
      tokenHash: 'hash-2',
      ownerUserId: null,
    })
    store.repos.addRepo('/home/a/src/podium', machineId)
    store.repos.addRepo('/home/b/src/podium', 'm2')
    registry = new SessionRegistry(store, undefined, { instanceId: 'default' })
    registries.push(registry)
    // A is a subtree root with a worktree; a session runs INSIDE it → subtree cap rooted at A.
    // B is unrelated. (create + set worktreePath directly, as capabilityForSession's test does.)
    A = registry.issues.create({ repoPath, title: 'epic root', startNow: false })
    registry.issues.update(A.id, { worktreePath: '/r/.worktrees/issue-1-a' })
    const wtA = registry.issues.get(A.id)?.worktreePath as string
    B = registry.issues.create({ repoPath, title: 'unrelated', startNow: false })
    sA = registry.modules.sessions.createSession({ cwd: wtA, agentKind: 'shell' }).sessionId
  })

  afterEach(() => {
    for (const r of registries.splice(0)) r.dispose()
  })

  it('relays a scoped op through the capability gate (rejects a write outside the subtree)', async () => {
    const reply = captureReply(registry, machineId)
    registry.gateway.routeDaemonFrame(machineId, {
      type: 'agentRelayRequest',
      requestId: 'ir1',
      sessionId: asSessionId(sA),
      router: 'issues',
      proc: 'update',
      input: { id: B.id, patch: { notes: 'x' } },
    })
    const r = await reply
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/outside your subtree/)
  })

  /**
   * Self-reference nudge on the offer headline (POD-389). The rule ships in prime,
   * but prime is injected once per session and the headline is written at the far
   * end of a long one — so the reminder has to ride back on the write itself. It is
   * advisory: the offer is set either way, and a message that already says "this
   * issue" must come back silent (a nudge that cries wolf gets tuned out).
   */
  it('flags an offer headline that names the agent own issue, and stays silent otherwise', async () => {
    const ownRef = registry.issues.niceRef(
      registry.issues.get(A.id) as { repoPath: string; seq: number },
    )
    const setOffer = async (requestId: string, message: string) => {
      const reply = captureReply(registry, machineId)
      registry.gateway.routeDaemonFrame(machineId, {
        type: 'agentRelayRequest',
        requestId,
        sessionId: asSessionId(sA),
        router: 'offer',
        proc: 'set',
        input: { message, actions: [] },
      })
      return (await reply).result as { ok: boolean; notice?: string }
    }

    const flagged = await setOffer('ir-offer-selfref', `${ownRef} is ready for review`)
    expect(flagged.ok).toBe(true)
    expect(flagged.notice).toContain(ownRef)
    expect(flagged.notice).toContain('this issue')

    const clean = await setOffer('ir-offer-clean', 'Retry backoff is ready for review')
    expect(clean.ok).toBe(true)
    expect(clean.notice).toBeUndefined()
  })

  it('override lets a scoped op write outside its subtree', async () => {
    const reply = captureReply(registry, machineId)
    registry.gateway.routeDaemonFrame(machineId, {
      type: 'agentRelayRequest',
      requestId: 'ir2',
      sessionId: asSessionId(sA),
      router: 'issues',
      proc: 'update',
      input: { id: B.id, patch: { notes: 'x' } },
      outsideScope: true,
    })
    expect((await reply).ok).toBe(true)
  })

  it('allows a same-issue child spawn and bounded await through the relay (#475)', async () => {
    const spawnReply = captureReply(registry, machineId)
    registry.gateway.routeDaemonFrame(machineId, {
      type: 'agentRelayRequest',
      requestId: 'ir-agent-spawn',
      sessionId: asSessionId(sA),
      router: 'messages',
      proc: 'spawnAgent',
      input: { issue: A.id, harness: 'shell', prompt: 'check the relay' },
    })
    const spawned = await spawnReply
    expect(spawned.ok).toBe(true)
    expect(spawned.result).toMatchObject({ ok: true, issueId: A.id })
    const childId = (spawned.result as { sessionId: SessionId }).sessionId
    expect(registry.modules.sessions.listSessions()).toContainEqual(
      expect.objectContaining({
        sessionId: childId,
        issueId: A.id,
        spawnedBy: `session:${sA}`,
      }),
    )

    const awaitReply = captureReply(registry, machineId)
    registry.gateway.routeDaemonFrame(machineId, {
      type: 'agentRelayRequest',
      requestId: 'ir-agent-await',
      sessionId: asSessionId(sA),
      router: 'messages',
      proc: 'awaitAgent',
      input: { sessionId: childId, timeoutSeconds: 0 },
    })
    const awaited = await awaitReply
    expect(awaited.ok).toBe(true)
    expect(awaited.result).toMatchObject({ result: 'working' })
  })

  it('still scope-gates a relayed child spawn onto another issue (#475)', async () => {
    const reply = captureReply(registry, machineId)
    registry.gateway.routeDaemonFrame(machineId, {
      type: 'agentRelayRequest',
      requestId: 'ir-agent-spawn-scoped',
      sessionId: asSessionId(sA),
      router: 'messages',
      proc: 'spawnAgent',
      input: { issue: B.id, harness: 'shell', prompt: 'cross the boundary' },
    })
    const r = await reply
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/outside your subtree/)
  })

  it('rejects a non-allowlisted router', async () => {
    const reply = captureReply(registry, machineId)
    registry.gateway.routeDaemonFrame(machineId, {
      type: 'agentRelayRequest',
      requestId: 'ir3',
      sessionId: asSessionId(sA),
      router: 'sessions',
      proc: 'kill',
      input: { id: 'whatever' },
    })
    const r = await reply
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/not permitted via relay/)
  })

  /**
   * POD-1386 — an agent could not enumerate machines at all: the server had the
   * projection (`machines.list`, router.ts) but the relay refused to carry it, and
   * the missing CLI flag hid the missing allowlist entry. These pin the two
   * properties the new arm exists for.
   */
  describe('machines enumeration', () => {
    it('relays the machine projection an agent needs to choose a host', async () => {
      const reply = captureReply(registry, machineId)
      registry.gateway.routeDaemonFrame(machineId, {
        type: 'agentRelayRequest',
        requestId: 'ir-machines-list',
        sessionId: asSessionId(sA),
        router: 'machines',
        proc: 'list',
      })
      const result = await reply
      expect(result.ok).toBe(true)
      // Shape, not identity: the rows are whatever the machines table holds, and
      // the point is that every one carries what a placement decision reads —
      // liveness and this principal's `use` verdict. The scoping itself is pinned
      // where it can be watched refusing (command-plane.test.ts, three machines).
      const rows = result.result as { id: string; online: boolean; use?: string }[]
      expect(Array.isArray(rows)).toBe(true)
      expect(rows.length).toBeGreaterThan(0)
      for (const row of rows) {
        expect(typeof row.id).toBe('string')
        expect(typeof row.online).toBe('boolean')
        expect(row.use).toBe('granted')
      }
    })

    it('joins registered repos onto the machines this caller may USE', async () => {
      const reply = captureReply(registry, machineId)
      registry.gateway.routeDaemonFrame(machineId, {
        type: 'agentRelayRequest',
        requestId: 'ir-machines-fleet',
        sessionId: asSessionId(sA),
        router: 'machines',
        proc: 'listWithRepos',
      })
      const result = await reply
      expect(result.ok).toBe(true)
      const view = result.result as {
        machines: { id: string }[]
        repos: { machineId: string; path: string }[]
      }
      expect(view.machines.length).toBeGreaterThan(0)
      // Every repo row belongs to a machine present in the projection — the guard
      // against `repos.listDetailed`'s unscoped cross-machine disclosure.
      const visible = new Set(view.machines.map((machine) => machine.id))
      expect(view.repos.every((repo) => visible.has(repo.machineId))).toBe(true)
    })

    it('still refuses every other machines proc', async () => {
      // The allowlist grants reach to two READS, not to the router: rename and
      // revoke stay operator-side.
      for (const proc of ['rename', 'revoke', 'pairingCode']) {
        const reply = captureReply(registry, machineId)
        registry.gateway.routeDaemonFrame(machineId, {
          type: 'agentRelayRequest',
          requestId: `ir-machines-${proc}`,
          sessionId: asSessionId(sA),
          router: 'machines',
          proc,
          input: {},
        })
        const r = await reply
        expect(r.ok).toBe(false)
        expect(r.error).toMatch(/not permitted via relay/)
      }
    })
  })

  it('relays the read-only multi-machine quota summary used by the panel', async () => {
    const reply = new Promise<RelayResult>((resolve) => {
      registry.gateway.attachDaemon(machineId, (msg) => {
        if (msg.type === 'agentQuotaRequest') {
          registry.gateway.routeDaemonFrame(machineId, {
            type: 'agentQuotaResult',
            requestId: msg.requestId,
            hostname: 'devbox',
            agents: [
              {
                agent: 'codex',
                status: 'ok',
                account: { email: 'codex@example.com', plan: 'plus' },
                windows: [
                  {
                    key: '5h',
                    label: '5-hour',
                    usedPercent: 37,
                    resetsAt: '2026-07-29T18:00:00.000Z',
                    windowMinutes: 300,
                  },
                ],
                fetchedAt: '2026-07-29T16:00:00.000Z',
              },
            ],
          })
        }
        if (msg.type === 'agentRelayResult') resolve(msg)
      })
    })
    registry.gateway.routeDaemonFrame(machineId, {
      type: 'agentRelayRequest',
      requestId: 'ir-quota-summary',
      sessionId: asSessionId(sA),
      router: 'quota',
      proc: 'summary',
    })

    const result = await reply
    expect(result.ok).toBe(true)
    expect(result.result).toEqual([
      expect.objectContaining({
        machineId,
        hostname: 'devbox',
        agents: [
          expect.objectContaining({
            agent: 'codex',
            status: 'ok',
            windows: [expect.objectContaining({ key: '5h', usedPercent: 37 })],
          }),
        ],
      }),
    ])
  })

  it('scope-gates direct messages to a session on another issue', async () => {
    const target = registry.modules.sessions.createSession({
      cwd: '/r/other',
      agentKind: 'shell',
      issueId: asIssueId(B.id),
    }).sessionId
    const reply = captureReply(registry, machineId)
    registry.gateway.routeDaemonFrame(machineId, {
      type: 'agentRelayRequest',
      requestId: 'ir-send-scoped',
      sessionId: asSessionId(sA),
      router: 'sessions',
      proc: 'resumeAndSend',
      input: { sessionId: target, text: 'continue' },
    })
    const r = await reply
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/outside your subtree/)
  })

  it('delivers an explicitly overridden direct session message', async () => {
    const target = registry.modules.sessions.createSession({
      cwd: '/r/other',
      agentKind: 'shell',
      issueId: asIssueId(B.id),
    }).sessionId
    const reply = captureReply(registry, machineId)
    registry.gateway.routeDaemonFrame(machineId, {
      type: 'agentRelayRequest',
      requestId: 'ir-send-override',
      sessionId: asSessionId(sA),
      router: 'sessions',
      proc: 'resumeAndSend',
      input: { sessionId: target, text: 'continue' },
      outsideScope: true,
    })
    const r = await reply
    expect(r.ok).toBe(true)
    expect(r.result).toMatchObject({ ok: true })
  })

  it('rejects a message to an ISSUELESS target session from a non-parent (#237)', async () => {
    // No issue to gate on must not mean no gate: only the operator or the
    // target's own parent (spawnedBy) may message an issueless session.
    const target = registry.modules.sessions.createSession({
      cwd: '/nowhere/unrelated',
      agentKind: 'shell',
    }).sessionId
    const reply = captureReply(registry, machineId)
    registry.gateway.routeDaemonFrame(machineId, {
      type: 'agentRelayRequest',
      requestId: 'ir-issueless',
      sessionId: asSessionId(sA),
      router: 'sessions',
      proc: 'sendText',
      input: { sessionId: target, text: 'hi' },
      outsideScope: true, // scope-crossing confirmation never substitutes for the gate
    })
    const r = await reply
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/only its parent or the operator/)
  })

  it('lets the PARENT message its issueless child session (#237)', async () => {
    const target = registry.modules.sessions.createSession({
      cwd: '/nowhere/unrelated',
      agentKind: 'shell',
      spawnedBy: `session:${sA}`,
    }).sessionId
    const reply = captureReply(registry, machineId)
    registry.gateway.routeDaemonFrame(machineId, {
      type: 'agentRelayRequest',
      requestId: 'ir-issueless-parent',
      sessionId: asSessionId(sA),
      router: 'sessions',
      proc: 'sendText',
      input: { sessionId: target, text: 'hi child' },
    })
    const r = await reply
    expect(r.ok).toBe(true)
  })

  it('rejects a prototype-key router without throwing (constructor)', async () => {
    // RELAY_ALLOWED is a plain object, so a router like 'constructor'/'__proto__'
    // would index an INHERITED value and blow up on `.has(...)` — the guard must
    // treat non-own keys as simply not-permitted, not a confusing TypeError.
    const reply = captureReply(registry, machineId)
    registry.gateway.routeDaemonFrame(machineId, {
      type: 'agentRelayRequest',
      requestId: 'ir5',
      sessionId: asSessionId(sA),
      router: 'constructor',
      proc: 'x',
      input: {},
    })
    const r = await reply
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/not permitted via relay/)
    expect(r.error).not.toMatch(/is not a function/)
  })

  it('relays prime bound to the session capability', async () => {
    const reply = captureReply(registry, machineId)
    registry.gateway.routeDaemonFrame(machineId, {
      type: 'agentRelayRequest',
      requestId: 'ir4',
      sessionId: asSessionId(sA),
      router: 'issues',
      proc: 'prime',
      input: { repoPath },
    })
    const r = await reply
    expect(r.ok).toBe(true)
    expect(String(r.result)).toContain(A.title)
  })
})

// [spec:SP-9904] sessions.stop authz + after-reply self-kill
describe('sessions.stop relay authz [spec:SP-9904]', () => {
  const registries: SessionRegistry[] = []
  const machineId = 'm1'
  const repoPath = '/r'
  let registry: SessionRegistry
  let A: { id: string }
  let B: { id: string }
  let sA: string
  let wtA: string

  beforeEach(() => {
    registry = new SessionRegistry(undefined, undefined, { instanceId: 'default' })
    registries.push(registry)
    A = registry.issues.create({ repoPath, title: 'stop root', startNow: false })
    registry.issues.update(A.id, { worktreePath: '/r/.worktrees/issue-stop-a' })
    wtA = registry.issues.get(A.id)?.worktreePath as string
    B = registry.issues.create({ repoPath, title: 'unrelated stop', startNow: false })
    registry.issues.update(B.id, { worktreePath: '/r/.worktrees/issue-stop-b' })
    sA = registry.modules.sessions.createSession({
      cwd: wtA,
      agentKind: 'shell',
      issueId: asIssueId(A.id),
    }).sessionId
    // stop free/unsaved paths call rpc.repoOp — stub clean so tests stay hermetic.
    const rpc = (
      registry.modules.sessions as unknown as {
        rpc: {
          repoOp: (
            op: string,
            cwd: string,
            args?: Record<string, string>,
            machineId?: string,
          ) => Promise<{ ok: boolean; output: string }>
        }
      }
    ).rpc
    rpc.repoOp = async () => ({ ok: true, output: '## clean\n' })
  })

  afterEach(() => {
    for (const r of registries.splice(0)) r.dispose()
  })

  it('self-stop is free and reports deferredKill for after-reply arming', async () => {
    registry.gateway.attachDaemon(machineId, () => {})
    registry.gateway.routeDaemonFrame(machineId, {
      type: 'bind',
      sessionId: asSessionId(sA),
      cmd: 'sh',
      cwd: wtA,
      agentKind: 'shell',
      geometry: { cols: 80, rows: 24 },
    })
    const reply = captureReply(registry, machineId)
    registry.gateway.routeDaemonFrame(machineId, {
      type: 'agentRelayRequest',
      requestId: 'stop-self',
      sessionId: asSessionId(sA),
      router: 'sessions',
      proc: 'stop',
      input: {},
    })
    const r = await reply
    expect(r.ok).toBe(true)
    // Self-stop must not kill inside stopSession; the gate arms kill only after
    // this agentRelayResult is sent (finalizeDeferredStopKill).
    expect(r.result).toMatchObject({ ok: true, deferredKill: true })
    expect(
      registry.modules.sessions.listSessions().find((s) => s.sessionId === sA)?.status,
    ).toMatch(/hibernated|exited/)
  })

  it('same-issue sibling stop is free (no outside-scope)', async () => {
    const sibling = registry.modules.sessions.createSession({
      cwd: wtA,
      agentKind: 'shell',
      issueId: asIssueId(A.id),
    }).sessionId
    const reply = captureReply(registry, machineId)
    registry.gateway.routeDaemonFrame(machineId, {
      type: 'agentRelayRequest',
      requestId: 'stop-sib',
      sessionId: asSessionId(sA),
      router: 'sessions',
      proc: 'stop',
      input: { sessionId: sibling },
    })
    const r = await reply
    expect(r.ok).toBe(true)
  })

  it('unrelated issue session stop is rejected without --outside-scope', async () => {
    const wtB = registry.issues.get(B.id)?.worktreePath as string
    const target = registry.modules.sessions.createSession({
      cwd: wtB,
      agentKind: 'shell',
      issueId: asIssueId(B.id),
    }).sessionId
    const reply = captureReply(registry, machineId)
    registry.gateway.routeDaemonFrame(machineId, {
      type: 'agentRelayRequest',
      requestId: 'stop-out',
      sessionId: asSessionId(sA),
      router: 'sessions',
      proc: 'stop',
      input: { sessionId: target },
    })
    const r = await reply
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/outside your subtree/)
  })

  it('unrelated issue session stop succeeds with --outside-scope', async () => {
    const wtB = registry.issues.get(B.id)?.worktreePath as string
    const target = registry.modules.sessions.createSession({
      cwd: wtB,
      agentKind: 'shell',
      issueId: asIssueId(B.id),
    }).sessionId
    const reply = captureReply(registry, machineId)
    registry.gateway.routeDaemonFrame(machineId, {
      type: 'agentRelayRequest',
      requestId: 'stop-out-ok',
      sessionId: asSessionId(sA),
      router: 'sessions',
      proc: 'stop',
      input: { sessionId: target },
      outsideScope: true,
    })
    expect((await reply).ok).toBe(true)
  })

  it('issueless unrelated stop needs --outside-scope; succeeds with it', async () => {
    const target = registry.modules.sessions.createSession({
      cwd: '/nowhere',
      agentKind: 'shell',
    }).sessionId
    const blocked = captureReply(registry, machineId)
    registry.gateway.routeDaemonFrame(machineId, {
      type: 'agentRelayRequest',
      requestId: 'stop-issueless-block',
      sessionId: asSessionId(sA),
      router: 'sessions',
      proc: 'stop',
      input: { sessionId: target },
    })
    const blockedR = await blocked
    expect(blockedR.ok).toBe(false)
    expect(blockedR.error).toMatch(/outside-scope/)

    const allowed = captureReply(registry, machineId)
    registry.gateway.routeDaemonFrame(machineId, {
      type: 'agentRelayRequest',
      requestId: 'stop-issueless-ok',
      sessionId: asSessionId(sA),
      router: 'sessions',
      proc: 'stop',
      input: { sessionId: target },
      outsideScope: true,
    })
    expect((await allowed).ok).toBe(true)
  })
})

// #490 — the agent names its OWN session. The `name` slot is shared with the human,
// so the whole feature turns on one rule: a name the USER set is sovereign and an
// agent can never overwrite it. The rest is convenience.
describe('sessions.title — an agent names its own session (#490)', () => {
  const registries: SessionRegistry[] = []
  const machineId = 'm1'
  const repoPath = '/r'
  let registry: SessionRegistry
  let A: { id: string; seq: number; title: string }
  let sA: string
  let sB: string
  let requestSeq = 0

  /** One relayed call from session `sessionId`, resolved to its reply. */
  const relay = async (
    sessionId: SessionId,
    router: string,
    proc: string,
    input: unknown,
  ): Promise<RelayResult> => {
    const reply = captureReply(registry, machineId)
    registry.gateway.routeDaemonFrame(machineId, {
      type: 'agentRelayRequest',
      requestId: `t${++requestSeq}`,
      sessionId,
      router,
      proc,
      input,
    })
    return reply
  }

  const nameOf = (sessionId: SessionId): string | undefined =>
    registry.modules.sessions.listSessions().find((s) => s.sessionId === sessionId)?.name

  beforeEach(() => {
    registry = new SessionRegistry(undefined, undefined, { instanceId: 'default' })
    registries.push(registry)
    A = registry.issues.create({ repoPath, title: 'epic root', startNow: false }) as typeof A
    registry.issues.update(A.id, { worktreePath: '/r/.worktrees/issue-1-a' })
    const wtA = registry.issues.get(A.id)?.worktreePath as string
    // Two sessions on the SAME issue — siblings in the sidebar, which is exactly the
    // situation a session title has to disambiguate.
    sA = registry.modules.sessions.createSession({ cwd: wtA, agentKind: 'shell' }).sessionId
    sB = registry.modules.sessions.createSession({ cwd: wtA, agentKind: 'shell' }).sessionId
  })

  afterEach(() => {
    for (const r of registries.splice(0)) r.dispose()
  })

  it('names the calling session, and may re-title itself as the work clarifies', async () => {
    const first = await relay(asSessionId(sA), 'sessions', 'title', { name: 'Migration runner backfill' })
    expect(first.ok).toBe(true)
    expect(first.result).toMatchObject({ ok: true, name: 'Migration runner backfill' })
    expect(nameOf(asSessionId(sA))).toBe('Migration runner backfill')

    // Its OWN earlier name is not sovereign — an agent re-titles itself freely.
    const second = await relay(asSessionId(sA), 'sessions', 'title', { name: 'Session name source column' })
    expect(second.ok).toBe(true)
    expect(nameOf(asSessionId(sA))).toBe('Session name source column')
    // And it never touched its sibling.
    expect(nameOf(asSessionId(sB))).toBeUndefined()
  })

  it('REFUSES to overwrite a name the user set — with a reason, not a throw', async () => {
    registry.modules.sessions.renameSession({ sessionId: asSessionId(sA), name: 'Mike’s pet session' })

    const r = await relay(asSessionId(sA), 'sessions', 'title', { name: 'Something the agent prefers' })
    // The relay call SUCCEEDS (no exception on the wire); the refusal is in the result,
    // so the agent reads it and carries on rather than treating it as a crash.
    expect(r.ok).toBe(true)
    expect(r.result).toMatchObject({ ok: false })
    expect((r.result as { reason: string }).reason).toMatch(/named by the user/i)
    expect(nameOf(asSessionId(sA))).toBe('Mike’s pet session')
  })

  it('targets the CALLER — an input sessionId cannot redirect it at a neighbour', async () => {
    const r = await relay(asSessionId(sA), 'sessions', 'title', { sessionId: sB, name: 'Hijacked' })
    expect(r.ok).toBe(true)
    expect(nameOf(asSessionId(sA))).toBe('Hijacked')
    expect(nameOf(asSessionId(sB))).toBeUndefined()
  })

  it('rejects an empty title', async () => {
    const r = await relay(asSessionId(sA), 'sessions', 'title', { name: '   ' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/name is required/)
  })

  it('primes an UNNAMED session to title itself, listing its siblings', async () => {
    registry.modules.sessions.renameSession({ sessionId: asSessionId(sB), name: 'Merge lock lease expiry' })

    const r = await relay(asSessionId(sA), 'issues', 'prime', { repoPath })
    expect(r.ok).toBe(true)
    const prime = String(r.result)
    expect(prime).toContain('This session has no name')
    expect(prime).toContain(`under #${A.seq}`)
    // The sibling's display name is quoted so the agent can avoid duplicating it.
    expect(prime).toContain('Merge lock lease expiry')
  })

  it('says nothing about titles once the session HAS a name', async () => {
    registry.modules.sessions.renameSession({ sessionId: asSessionId(sA), name: 'Already named' })

    const prime = String((await relay(asSessionId(sA), 'issues', 'prime', { repoPath })).result)
    expect(prime).not.toContain('This session has no name')
    // The issue prime itself is unaffected.
    expect(prime).toContain(A.title)
  })

  it('says nothing about titles when the session has no issue to sit under', async () => {
    const loose = registry.modules.sessions.createSession({
      cwd: '/elsewhere',
      agentKind: 'shell',
    }).sessionId
    const prime = String((await relay(loose, 'issues', 'prime', { repoPath })).result)
    expect(prime).not.toContain('This session has no name')
  })
})

// Agent action offer [spec:SP-c7f1]: `podium offer` set/clear, relayed from the
// CALLING session, mirroring the sessions.title target-binding.
describe('offer.set / offer.clear — an agent offers the user next actions', () => {
  const registries: SessionRegistry[] = []
  const machineId = 'm1'
  let registry: SessionRegistry
  let sA: string
  let sB: string
  let requestSeq = 0

  const relay = async (
    sessionId: SessionId,
    router: string,
    proc: string,
    input: unknown,
  ): Promise<RelayResult> => {
    const reply = captureReply(registry, machineId)
    registry.gateway.routeDaemonFrame(machineId, {
      type: 'agentRelayRequest',
      requestId: `o${++requestSeq}`,
      sessionId,
      router,
      proc,
      input,
    })
    return reply
  }

  const offerOf = (sessionId: SessionId) =>
    registry.modules.sessions.listSessions().find((s) => s.sessionId === sessionId)?.offer

  beforeEach(() => {
    registry = new SessionRegistry(undefined, undefined, { instanceId: 'default' })
    registries.push(registry)
    sA = registry.modules.sessions.createSession({ cwd: '/r', agentKind: 'shell' }).sessionId
    sB = registry.modules.sessions.createSession({ cwd: '/r', agentKind: 'shell' }).sessionId
  })
  afterEach(() => {
    for (const r of registries.splice(0)) r.dispose()
  })

  it('sets an offer on the calling session and clears it', async () => {
    const set = await relay(asSessionId(sA), 'offer', 'set', {
      message: 'Tests are red on main',
      actions: [{ label: 'Fix them', prompt: 'Please fix the failing tests' }],
    })
    expect(set.ok).toBe(true)
    expect(set.result).toMatchObject({ ok: true })
    expect(offerOf(asSessionId(sA))?.message).toBe('Tests are red on main')
    expect(offerOf(asSessionId(sB))).toBeUndefined() // never touches a neighbour

    const clear = await relay(asSessionId(sA), 'offer', 'clear', {})
    expect(clear.ok).toBe(true)
    expect(offerOf(asSessionId(sA))).toBeUndefined()
  })

  it('rejects an empty message and an action missing its prompt', async () => {
    const noMsg = await relay(asSessionId(sA), 'offer', 'set', { message: '  ', actions: [] })
    expect(noMsg.ok).toBe(false)
    expect(noMsg.error).toMatch(/message must contain/)

    const badAction = await relay(asSessionId(sA), 'offer', 'set', {
      message: 'ok',
      actions: [{ label: 'Go' }],
    })
    expect(badAction.ok).toBe(false)
    expect(badAction.error).toMatch(/prompt must contain/)
  })

  it('rejects an unknown proc on the offer router', async () => {
    const r = await relay(asSessionId(sA), 'offer', 'bogus', {})
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/not permitted via relay/)
  })
})
