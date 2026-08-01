import {
  type Attribution,
  actorAgent,
  asAgentIdentityId,
  asSessionId,
  asUserId,
  type SessionId,
} from '@podium/model'
import { asDelegationRef } from '@podium/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClientConn } from '../../gateway/client-registry'
import { testClientPrincipal } from '../../test-support/client-principal'
import { type InboxPrincipalReference, type QueuedInboxMessage, SessionInbox } from './inbox'
import type { Session } from './session'

const SID = asSessionId('session-target')
const ALICE = asUserId('user:alice')
const AGENT = asSessionId('session-agent')

const agentPrincipal = (): InboxPrincipalReference => ({
  kind: 'agent',
  principalRef: AGENT,
  delegation: asDelegationRef(AGENT),
  attribution: {
    actor: actorAgent(asAgentIdentityId(AGENT)),
    onBehalfOf: ALICE,
  },
})

function harness(options: { owner?: typeof ALICE | null; status?: string } = {}) {
  const rows: Array<QueuedInboxMessage & { sessionId: SessionId; queuedAt: number }> = []
  const sent: unknown[] = []
  const rejected: unknown[] = []
  const answered: unknown[] = []
  let authorized = true
  const handleInput = vi.fn()
  const session = {
    sessionId: SID,
    machineId: 'machine-1',
    status: options.status ?? 'live',
    agentKind: 'codex',
    resume: { kind: 'codex', value: 'resume-1' },
    queuedMessageCount: 0,
    agentState: { phase: 'idle' },
    terminal: {
      lastOutputAtMs: 0,
      transcriptItems: () => [],
      recordInputActivity: vi.fn(),
      handleInput,
      requestControl: vi.fn(),
      handleResize: vi.fn(),
      reconcileGeometry: vi.fn(),
    },
  } as unknown as Session
  const inbox = new SessionInbox({
    getSession: (id) => (id === SID ? session : undefined),
    queue: {
      enqueue: (row) => {
        if (rows.some((existing) => existing.id === row.id)) return false
        rows.push({ ...row, attempts: 0 })
        return true
      },
      list: (id) =>
        rows.filter((row) => row.sessionId === id).sort((a, b) => a.queuedAt - b.queuedAt),
      bumpAttempts: (id) => {
        const row = rows.find((candidate) => candidate.id === id)
        if (row) row.attempts += 1
      },
      delete: (id) => {
        const index = rows.findIndex((row) => row.id === id)
        if (index >= 0) rows.splice(index, 1)
      },
    },
    daemon: { sendInput: (_machineId, message) => sent.push(message) },
    authorization: {
      authorizeAtDrain: () =>
        authorized ? ({ ok: true } as const) : ({ ok: false, reason: 'revoked' } as const),
      rejected: (input) => rejected.push(input),
    },
    attention: {
      stateChanged: vi.fn(),
      answered: (input) => answered.push(input),
    },
    now: () => Date.now(),
    persist: vi.fn(),
    broadcast: vi.fn(),
    needsSubmitVerification: (agentKind) => agentKind === 'claude-code',
    prepareSend: vi.fn(),
    ownerOf: () => (options.owner === undefined ? ALICE : options.owner),
    resurrect: async () => ({ ok: true }),
  })
  return {
    inbox,
    session,
    rows,
    sent,
    rejected,
    answered,
    handleInput,
    revoke: () => {
      authorized = false
    },
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('SessionInbox authorization and identity', () => {
  it('stores only a delegation reference and re-authorizes immediately before drain', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const h = harness()
    const principal = agentPrincipal()

    expect(
      h.inbox.queueText({
        sessionId: SID,
        text: 'queued before revocation',
        mutationId: 'queued-1',
        principal,
      }),
    ).toEqual({ ok: true, queued: true })
    expect(h.rows[0]?.principal).toEqual(principal)

    h.revoke()
    vi.advanceTimersByTime(7_000)

    expect(h.sent).toEqual([])
    expect(h.rows).toEqual([])
    expect(h.rejected).toEqual([
      expect.objectContaining({
        queueId: 'queued-1',
        principal,
        reason: 'revoked',
      }),
    ])
  })

  it('carries the browser principal through controller gating into PTY attribution', () => {
    const h = harness()
    const principal = testClientPrincipal('browser-1')
    const client = { id: 'client-1' } as ClientConn

    h.inbox.handleControllerInput(principal, client, SID, 'x')

    expect(h.handleInput).toHaveBeenCalledWith('client-1', 'x', {
      actor: { kind: 'user', id: principal.user },
      onBehalfOf: principal.user,
    })
  })

  it('fails closed when a needs-human answer has no owner', () => {
    const h = harness({ owner: null })

    expect(
      h.inbox.answerAskUserQuestion({
        sessionId: SID,
        choices: [{ optionIndices: [2] }],
        principal: agentPrincipal(),
      }),
    ).toEqual({ ok: false })
    expect(h.sent).toEqual([])
    expect(h.answered).toEqual([])
  })

  it('attributes an answer as actor plus on-behalf-of and routes it to the owner', () => {
    const h = harness()
    const principal = agentPrincipal()

    expect(
      h.inbox.answerAskUserQuestion({
        sessionId: SID,
        choices: [{ optionIndices: [2] }],
        principal,
      }),
    ).toEqual({ ok: true })

    expect(h.sent).toEqual([
      expect.objectContaining({
        type: 'input',
        attribution: principal.attribution satisfies Attribution,
      }),
    ])
    expect(h.answered).toEqual([
      {
        ownerUserId: ALICE,
        sessionId: SID,
        attribution: principal.attribution,
      },
    ])
  })
})
