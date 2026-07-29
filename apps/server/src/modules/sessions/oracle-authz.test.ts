/**
 * ORACLE — authorization of session writes (POD-379 for POD-312).
 *
 * ## READ THIS BEFORE USING THESE TESTS AS AN AUTHZ BASELINE
 *
 * Podium has exactly ONE human today. Authentication is a single shared
 * password and it resolves to `OPERATOR = { role: 'admin', scope: { kind:
 * 'all' } }` (packages/domain/src/issue-authz.ts); `client_sessions` has no
 * user column (apps/server/src/migrations/schema.ts), so a client session is a
 * DEVICE, not a person (docs/multi-user-readiness.md §3.2).
 *
 * Consequence, and the reason every authz-denied characterization below is
 * tagged will-change: what is being characterized is the AGENT-CAPABILITY path
 * — a relayed agent's constrained `Capability` against a target session's issue
 * subtree. There is NO human-vs-human path to characterize, so nothing here can
 * serve as a baseline for one. POD-1075 introduces the user principal and
 * POD-1073 the human-vs-human policy; when they land, these tests describe
 * what the OLD world did, not what the new one must do.
 *
 * The one non-obvious structural fact worth pinning: the presence-class writes
 * (rename / archive / read / snooze / pins / tab order / work state / issue
 * attachment) have NO agent path at all. They are operator-only by ABSENCE from
 * the relay allowlist, not by a check. A migration that routes them through a
 * uniform command plane must reproduce the absence deliberately.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { OPERATOR } from '../../issue-authz'
import { disposeOracles, MUST_NOT_CHANGE, makeOracle, willChange } from './oracle-support'

afterEach(() => disposeOracles())

const AGENT_ONLY = willChange(
  'POD-1073',
  'agent-capability path only — there is no human-vs-human authz today',
)
const NO_USER_PRINCIPAL = willChange('POD-1075', 'one shared password ⇒ OPERATOR admin/all')

/** An oracle with two issues and one agent session living inside issue A. */
async function twoIssueOracle() {
  const o = makeOracle()
  const a = o.reg.issues.create({ repoPath: '/r', title: 'issue A', startNow: false })
  o.reg.issues.update(a.id, { worktreePath: '/r/.worktrees/a' })
  const b = o.reg.issues.create({ repoPath: '/r', title: 'issue B', startNow: false })
  o.reg.issues.update(b.id, { worktreePath: '/r/.worktrees/b' })
  // The AGENT: a session inside A's worktree ⇒ capability scoped to A's subtree.
  const agent = o.reg.modules.sessions.createSession({ agentKind: 'shell', cwd: '/r/.worktrees/a' })
  return { o, a, b, agentSessionId: agent.sessionId }
}

describe('oracle: the operator seam has no authorization to characterize', () => {
  it(`${NO_USER_PRINCIPAL}: every tRPC session write runs as OPERATOR (admin/all) — the capability is not derived from any caller identity`, async () => {
    const o = makeOracle()
    // The context capability the router is constructed with IS the constant.
    expect(OPERATOR).toEqual({ role: 'admin', scope: { kind: 'all' } })
    // And it writes sessions it has no relationship to whatsoever.
    const foreign = o.reg.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/somebody/elses/tree',
      spawnedBy: 'session:someone-else',
    })

    await o.call.sessions.rename({ sessionId: foreign.sessionId, name: 'taken over' })

    expect(o.meta(foreign.sessionId)).toMatchObject({ name: 'taken over', nameSource: 'user' })
  })
})

describe('oracle: presence writes have no agent path (absence, not a check)', () => {
  const presenceProcs = [
    'rename',
    'setArchived',
    'markRead',
    'markUnread',
    'setWorkState',
    'setIssueId',
  ]

  for (const proc of presenceProcs) {
    it(`${AGENT_ONLY}: sessions.${proc} is refused via the relay with the allowlist's exact rejection`, async () => {
      const { o, agentSessionId } = await twoIssueOracle()

      const reply = await o.relay({
        requestId: `deny-${proc}`,
        sessionId: agentSessionId,
        router: 'sessions',
        proc,
        input: {
          sessionId: agentSessionId,
          name: 'x',
          archived: true,
          workState: null,
          issueId: null,
        },
      })

      expect(reply.ok).toBe(false)
      expect(reply.error).toBe(`sessions.${proc} is not permitted via relay`)
    })
  }

  for (const [router, proc] of [
    ['pins', 'set'],
    ['snoozes', 'set'],
    ['snoozes', 'clear'],
    ['tabs', 'setOrder'],
  ] as const) {
    it(`${AGENT_ONLY}: the ${router} router is not reachable via the relay at all (${router}.${proc})`, async () => {
      const { o, agentSessionId } = await twoIssueOracle()

      const reply = await o.relay({
        requestId: `deny-${router}-${proc}`,
        sessionId: agentSessionId,
        router,
        proc,
        input: {},
      })

      expect(reply.ok).toBe(false)
      expect(reply.error).toBe(`${router}.${proc} is not permitted via relay`)
    })
  }
})

describe('oracle: lifecycle commands have no agent path either', () => {
  for (const proc of [
    'create',
    'resume',
    'kill',
    'hibernate',
    'resurrect',
    'handoff',
    'answerAskUserQuestion',
  ]) {
    it(`${AGENT_ONLY}: sessions.${proc} is refused via the relay — an agent can never spawn, kill or move a session`, async () => {
      const { o, agentSessionId } = await twoIssueOracle()

      const reply = await o.relay({
        requestId: `deny-life-${proc}`,
        sessionId: agentSessionId,
        router: 'sessions',
        proc,
        input: { sessionId: agentSessionId, machineId: 'local', agentKind: 'shell', cwd: '/r' },
      })

      expect(reply.ok).toBe(false)
      expect(reply.error).toBe(`sessions.${proc} is not permitted via relay`)
    })
  }
})

describe('oracle: the writes an agent CAN make, and what gates them', () => {
  it(`${AGENT_ONLY}: sendText to a session in the caller's own subtree is ACCEPTED`, async () => {
    const { o, a, agentSessionId } = await twoIssueOracle()
    const peer = o.reg.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/r/.worktrees/a',
      issueId: a.id,
    })

    const reply = await o.relay({
      requestId: 'send-in-scope',
      sessionId: agentSessionId,
      router: 'sessions',
      proc: 'sendText',
      input: { sessionId: peer.sessionId, text: 'same subtree' },
    })

    expect(reply.ok).toBe(true)
  })

  it(`${AGENT_ONLY}: sendText ACROSS issues is refused as a scope violation, overridable with --outside-scope`, async () => {
    const { o, b, agentSessionId } = await twoIssueOracle()
    const stranger = o.reg.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/r/.worktrees/b',
      issueId: b.id,
    })

    const denied = await o.relay({
      requestId: 'send-cross-scope',
      sessionId: agentSessionId,
      router: 'sessions',
      proc: 'sendText',
      input: { sessionId: stranger.sessionId, text: 'crossing' },
    })

    expect(denied.ok).toBe(false)
    expect(denied.error).toBe(
      `issue ${b.id} is outside your subtree; re-run with --outside-scope to confirm`,
    )

    const confirmed = await o.relay({
      requestId: 'send-cross-scope-ok',
      sessionId: agentSessionId,
      router: 'sessions',
      proc: 'sendText',
      input: { sessionId: stranger.sessionId, text: 'crossing' },
      outsideScope: true,
    })
    expect(confirmed.ok).toBe(true)
  })

  it(`${AGENT_ONLY}: an ISSUELESS target is parent-or-operator only, and --outside-scope does NOT substitute`, async () => {
    const { o, agentSessionId } = await twoIssueOracle()
    const orphan = o.reg.modules.sessions.createSession({ agentKind: 'shell', cwd: '/elsewhere' })

    const denied = await o.relay({
      requestId: 'send-issueless',
      sessionId: agentSessionId,
      router: 'sessions',
      proc: 'sendText',
      input: { sessionId: orphan.sessionId, text: 'hi' },
    })
    expect(denied.ok).toBe(false)
    expect(denied.error).toBe(
      'target session has no issue; only its parent or the operator may message it',
    )

    // The override confirms crossing an ISSUE boundary; it is not a general
    // escalation, so the issueless refusal is unchanged by it.
    const stillDenied = await o.relay({
      requestId: 'send-issueless-override',
      sessionId: agentSessionId,
      router: 'sessions',
      proc: 'sendText',
      input: { sessionId: orphan.sessionId, text: 'hi' },
      outsideScope: true,
    })
    expect(stillDenied.ok).toBe(false)
    expect(stillDenied.error).toBe(
      'target session has no issue; only its parent or the operator may message it',
    )
  })

  it(`${AGENT_ONLY}: the PARENT of an issueless session may message it (spawnedBy provenance is the grant)`, async () => {
    const { o, agentSessionId } = await twoIssueOracle()
    const child = o.reg.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/elsewhere',
      spawnedBy: `session:${agentSessionId}`,
    })

    const reply = await o.relay({
      requestId: 'send-to-own-child',
      sessionId: agentSessionId,
      router: 'sessions',
      proc: 'sendText',
      input: { sessionId: child.sessionId, text: 'hi child' },
    })

    expect(reply.ok).toBe(true)
  })

  it(`${MUST_NOT_CHANGE}: sessions.title targets the CALLING session — a sessionId in the payload is ignored, never honoured`, async () => {
    const { o, a, agentSessionId } = await twoIssueOracle()
    const victim = o.reg.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/r/.worktrees/a',
      issueId: a.id,
    })

    const reply = await o.relay({
      requestId: 'title-payload-spoof',
      sessionId: agentSessionId,
      router: 'sessions',
      proc: 'title',
      input: { sessionId: victim.sessionId, name: 'renamed by a stranger' },
    })

    expect(reply.ok).toBe(true)
    // The payload's sessionId is inert (ADR 3 D7): the CALLER got the name.
    expect(o.meta(agentSessionId)).toMatchObject({
      name: 'renamed by a stranger',
      nameSource: 'agent',
    })
    expect(o.meta(victim.sessionId).name).toBeUndefined()
  })

  it(`${MUST_NOT_CHANGE}: an unknown relay router is refused rather than resolving through the prototype chain`, async () => {
    const { o, agentSessionId } = await twoIssueOracle()

    for (const router of ['constructor', '__proto__', 'toString']) {
      const reply = await o.relay({
        requestId: `proto-${router}`,
        sessionId: agentSessionId,
        router,
        proc: 'set',
        input: {},
      })
      expect(reply.ok).toBe(false)
      expect(reply.error).toBe(`${router}.set is not permitted via relay`)
    }
  })
})
