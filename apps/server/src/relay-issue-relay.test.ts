import type { ControlMessage } from '@podium/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionRegistry } from './relay'

type RelayResult = Extract<ControlMessage, { type: 'issueRelayResult' }>

// Capture the issueRelayResult the registry sends back to a machine. attachDaemon registers
// a daemon's control-message send fn (confirmed in wsServer.ts); the relay reply routes to it.
function captureReply(registry: SessionRegistry, machineId: string): Promise<RelayResult> {
  return new Promise((resolve) => {
    registry.modules.sessions.attachDaemon(machineId, (msg) => {
      if (msg.type === 'issueRelayResult') resolve(msg)
    })
  })
}

// P1b-server: the server end of the daemon-relayed capability seam. A relayed agent op is run
// through the capability-scoped in-process command service (so the scope gate is enforced, not
// re-implemented), gated by an allowlist, with the capability minted from the session's cwd.
describe('server issue relay handler (P1b)', () => {
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
      type: 'issueRelayRequest',
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
      type: 'issueRelayRequest',
      requestId: 'ir2',
      sessionId: sA,
      router: 'issues',
      proc: 'update',
      input: { id: B.id, patch: { notes: 'x' } },
      outsideScope: true,
    })
    expect((await reply).ok).toBe(true)
  })

  it('rejects a non-allowlisted router', async () => {
    const reply = captureReply(registry, machineId)
    registry.modules.sessions.onDaemonMessageFrom(machineId, {
      type: 'issueRelayRequest',
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
      type: 'issueRelayRequest',
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
      type: 'issueRelayRequest',
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
      type: 'issueRelayRequest',
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
      type: 'issueRelayRequest',
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
      type: 'issueRelayRequest',
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
      type: 'issueRelayRequest',
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
