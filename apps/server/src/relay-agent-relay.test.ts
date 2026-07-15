import type { ControlMessage } from '@podium/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionRegistry } from './relay'

type RelayResult = Extract<ControlMessage, { type: 'agentRelayResult' }>

// Capture the agentRelayResult the registry sends back to a machine. attachDaemon registers
// a daemon's control-message send fn (confirmed in wsServer.ts); the relay reply routes to it.
function captureReply(registry: SessionRegistry, machineId: string): Promise<RelayResult> {
  return new Promise((resolve) => {
    registry.modules.sessions.attachDaemon(machineId, (msg) => {
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
  let A: { id: string; title: string }
  let B: { id: string }
  let sA: string

  beforeEach(() => {
    registry = new SessionRegistry()
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
    registry.modules.sessions.onDaemonMessageFrom(machineId, {
      type: 'agentRelayRequest',
      requestId: 'ir1',
      sessionId: sA,
      router: 'issues',
      proc: 'update',
      input: { id: B.id, patch: { notes: 'x' } },
    })
    const r = await reply
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/outside your subtree/)
  })

  it('override lets a scoped op write outside its subtree', async () => {
    const reply = captureReply(registry, machineId)
    registry.modules.sessions.onDaemonMessageFrom(machineId, {
      type: 'agentRelayRequest',
      requestId: 'ir2',
      sessionId: sA,
      router: 'issues',
      proc: 'update',
      input: { id: B.id, patch: { notes: 'x' } },
      outsideScope: true,
    })
    expect((await reply).ok).toBe(true)
  })

  it('allows a same-issue child spawn and bounded await through the relay (#475)', async () => {
    const spawnReply = captureReply(registry, machineId)
    registry.modules.sessions.onDaemonMessageFrom(machineId, {
      type: 'agentRelayRequest',
      requestId: 'ir-agent-spawn',
      sessionId: sA,
      router: 'messages',
      proc: 'spawnAgent',
      input: { issue: A.id, harness: 'shell', prompt: 'check the relay' },
    })
    const spawned = await spawnReply
    expect(spawned.ok).toBe(true)
    expect(spawned.result).toMatchObject({ ok: true, issueId: A.id })
    const childId = (spawned.result as { sessionId: string }).sessionId
    expect(registry.modules.sessions.listSessions()).toContainEqual(
      expect.objectContaining({
        sessionId: childId,
        issueId: A.id,
        spawnedBy: `session:${sA}`,
      }),
    )

    const awaitReply = captureReply(registry, machineId)
    registry.modules.sessions.onDaemonMessageFrom(machineId, {
      type: 'agentRelayRequest',
      requestId: 'ir-agent-await',
      sessionId: sA,
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
    registry.modules.sessions.onDaemonMessageFrom(machineId, {
      type: 'agentRelayRequest',
      requestId: 'ir-agent-spawn-scoped',
      sessionId: sA,
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
    registry.modules.sessions.onDaemonMessageFrom(machineId, {
      type: 'agentRelayRequest',
      requestId: 'ir3',
      sessionId: sA,
      router: 'sessions',
      proc: 'kill',
      input: { id: 'whatever' },
    })
    const r = await reply
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/not permitted via relay/)
  })

  it('scope-gates direct messages to a session on another issue', async () => {
    const target = registry.modules.sessions.createSession({
      cwd: '/r/other',
      agentKind: 'shell',
      issueId: B.id,
    }).sessionId
    const reply = captureReply(registry, machineId)
    registry.modules.sessions.onDaemonMessageFrom(machineId, {
      type: 'agentRelayRequest',
      requestId: 'ir-send-scoped',
      sessionId: sA,
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
      issueId: B.id,
    }).sessionId
    const reply = captureReply(registry, machineId)
    registry.modules.sessions.onDaemonMessageFrom(machineId, {
      type: 'agentRelayRequest',
      requestId: 'ir-send-override',
      sessionId: sA,
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
    registry.modules.sessions.onDaemonMessageFrom(machineId, {
      type: 'agentRelayRequest',
      requestId: 'ir-issueless',
      sessionId: sA,
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
    registry.modules.sessions.onDaemonMessageFrom(machineId, {
      type: 'agentRelayRequest',
      requestId: 'ir-issueless-parent',
      sessionId: sA,
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
    registry.modules.sessions.onDaemonMessageFrom(machineId, {
      type: 'agentRelayRequest',
      requestId: 'ir5',
      sessionId: sA,
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
    registry.modules.sessions.onDaemonMessageFrom(machineId, {
      type: 'agentRelayRequest',
      requestId: 'ir4',
      sessionId: sA,
      router: 'issues',
      proc: 'prime',
      input: { repoPath },
    })
    const r = await reply
    expect(r.ok).toBe(true)
    expect(String(r.result)).toContain(A.title)
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
    sessionId: string,
    router: string,
    proc: string,
    input: unknown,
  ): Promise<RelayResult> => {
    const reply = captureReply(registry, machineId)
    registry.modules.sessions.onDaemonMessageFrom(machineId, {
      type: 'agentRelayRequest',
      requestId: `t${++requestSeq}`,
      sessionId,
      router,
      proc,
      input,
    })
    return reply
  }

  const nameOf = (sessionId: string): string | undefined =>
    registry.modules.sessions.listSessions().find((s) => s.sessionId === sessionId)?.name

  beforeEach(() => {
    registry = new SessionRegistry()
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
    const first = await relay(sA, 'sessions', 'title', { name: 'Migration runner backfill' })
    expect(first.ok).toBe(true)
    expect(first.result).toMatchObject({ ok: true, name: 'Migration runner backfill' })
    expect(nameOf(sA)).toBe('Migration runner backfill')

    // Its OWN earlier name is not sovereign — an agent re-titles itself freely.
    const second = await relay(sA, 'sessions', 'title', { name: 'Session name source column' })
    expect(second.ok).toBe(true)
    expect(nameOf(sA)).toBe('Session name source column')
    // And it never touched its sibling.
    expect(nameOf(sB)).toBeUndefined()
  })

  it('REFUSES to overwrite a name the user set — with a reason, not a throw', async () => {
    registry.modules.sessions.renameSession({ sessionId: sA, name: 'Mike’s pet session' })

    const r = await relay(sA, 'sessions', 'title', { name: 'Something the agent prefers' })
    // The relay call SUCCEEDS (no exception on the wire); the refusal is in the result,
    // so the agent reads it and carries on rather than treating it as a crash.
    expect(r.ok).toBe(true)
    expect(r.result).toMatchObject({ ok: false })
    expect((r.result as { reason: string }).reason).toMatch(/named by the user/i)
    expect(nameOf(sA)).toBe('Mike’s pet session')
  })

  it('targets the CALLER — an input sessionId cannot redirect it at a neighbour', async () => {
    const r = await relay(sA, 'sessions', 'title', { sessionId: sB, name: 'Hijacked' })
    expect(r.ok).toBe(true)
    expect(nameOf(sA)).toBe('Hijacked')
    expect(nameOf(sB)).toBeUndefined()
  })

  it('rejects an empty title', async () => {
    const r = await relay(sA, 'sessions', 'title', { name: '   ' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/name is required/)
  })

  it('primes an UNNAMED session to title itself, listing its siblings', async () => {
    registry.modules.sessions.renameSession({ sessionId: sB, name: 'Merge lock lease expiry' })

    const r = await relay(sA, 'issues', 'prime', { repoPath })
    expect(r.ok).toBe(true)
    const prime = String(r.result)
    expect(prime).toContain('podium session title')
    expect(prime).toContain(`under #${A.seq}`)
    // The sibling's display name is quoted so the agent can avoid duplicating it.
    expect(prime).toContain('Merge lock lease expiry')
  })

  it('says nothing about titles once the session HAS a name', async () => {
    registry.modules.sessions.renameSession({ sessionId: sA, name: 'Already named' })

    const prime = String((await relay(sA, 'issues', 'prime', { repoPath })).result)
    expect(prime).not.toContain('podium session title')
    // The issue prime itself is unaffected.
    expect(prime).toContain(A.title)
  })

  it('says nothing about titles when the session has no issue to sit under', async () => {
    const loose = registry.modules.sessions.createSession({
      cwd: '/elsewhere',
      agentKind: 'shell',
    }).sessionId
    const prime = String((await relay(loose, 'issues', 'prime', { repoPath })).result)
    expect(prime).not.toContain('podium session title')
  })
})
