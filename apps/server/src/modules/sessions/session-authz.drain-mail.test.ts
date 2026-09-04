/**
 * Apply-time re-authorization of a MAIL row must not re-run the issue-edit
 * scope gate (POD-3226).
 *
 * WHAT WENT WRONG. A worker's reply to its coordinator was accepted by the
 * send gate, then refused at the inbox drain: `authorizeQueuedInputAtApply`
 * ended with `assertMayCommandSession(…, 'sessions.sendText')`, which is the
 * "may this agent edit that issue" rule — a worker whose scope is its own
 * subtree gets `confirm-required` for anything on an ancestor issue, and the
 * coordinator's session always lives on the parent. The refusal only fired
 * when the target was busy or had a queued row (the idle path types straight
 * into the PTY with no re-check), so the same reply landed or died depending
 * on timing. And every refusal in that function was reported as
 * "session no longer exists", so two agents concluded their coordinator had
 * ended.
 *
 * WHAT D8 ASKS FOR is re-running the policy of the command that created the
 * row against CURRENT rights: the sender still exists and still resolves to
 * the same human, the target still exists and is visible to that human, the
 * owner/grant/machine rules still hold. The subtree scope of the target's
 * issue is a property of the tree the send gate already ruled on; a queued
 * row carries no `--outside-scope` envelope to satisfy it a second time, so
 * re-asking can only refuse what was already allowed.
 */

import {
  actorAgent,
  asAgentIdentityId,
  asMachineId,
  asSessionId,
  asUserId,
  type SessionId,
} from '@podium/model'
import { asDelegationRef } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { SessionAuthz } from './session-authz'

const USER = asUserId('user:sole')
const MACHINE = asMachineId('m1')
const PARENT_ISSUE = 'iss_parent'
const CHILD_ISSUE = 'iss_child'

interface Row {
  sessionId: SessionId
  issueId?: string
  cwd: string
  spawnedBy: string
  ownerUserId: string
  machineId: string
  status: 'live'
  agentKind: 'claude-code'
  archived: false
  resumable: false
}

const row = (id: string, issueId: string | undefined, spawnedBy: string): Row => ({
  sessionId: asSessionId(id),
  ...(issueId ? { issueId } : {}),
  cwd: `/wt/${id}`,
  spawnedBy,
  ownerUserId: USER,
  machineId: MACHINE,
  status: 'live',
  agentKind: 'claude-code',
  archived: false,
  resumable: false,
})

/** A coordinator on the parent issue, spawned by the human; a worker on the
 *  child issue, spawned by the coordinator; a stray agent with no issue that
 *  nobody here spawned. */
const COORDINATOR = row('coordinator', PARENT_ISSUE, 'user')
const WORKER = row('worker', CHILD_ISSUE, 'session:coordinator')
const STRAY = row('stray', undefined, 'user')
const ROWS = [COORDINATOR, WORKER, STRAY]

function harness() {
  const get = (sessionId: SessionId) => ROWS.find((s) => s.sessionId === sessionId)
  return new SessionAuthz({
    clientControl: {},
    deps: {
      issueAccess: {
        has: (id: string) => id === PARENT_ISSUE || id === CHILD_ISSUE,
        ancestorIds: (id: string) => (id === CHILD_ISSUE ? [PARENT_ISSUE] : []),
        issueForCwd: () => null,
      },
    },
    listSessions: () => ROWS,
    sessionById: get,
    machines: { ownershipRows: () => [{ id: MACHINE, ownerUserId: USER }] },
    sessions: { get },
    store: {
      sessions: { getSession: get },
      users: { get: (id: string) => (id === USER ? { id } : undefined), roleOf: () => 'admin' },
      issues: { getIssue: () => ({ ownerUserId: USER }), getIssues: () => new Map() },
      grants: { listForResource: () => [], listForResources: () => new Map() },
    },
  } as never)
}

const agentPrincipal = (id: string) => ({
  kind: 'agent' as const,
  principalRef: id,
  delegation: asDelegationRef(id),
  attribution: { actor: actorAgent(asAgentIdentityId(id)), onBehalfOf: USER },
})

describe('drain-time authorization of mail rows [POD-3226]', () => {
  it('lets a worker reply reach the coordinator on the parent issue', () => {
    const verdict = harness().authorizeQueuedInputAtApply({
      sessionId: COORDINATOR.sessionId,
      principal: agentPrincipal('worker'),
      sourceMessageId: 'msg_reply',
    })
    expect(verdict).toEqual({ ok: true })
  })

  it('still lets the coordinator reach its worker on the child issue', () => {
    const verdict = harness().authorizeQueuedInputAtApply({
      sessionId: WORKER.sessionId,
      principal: agentPrincipal('coordinator'),
      sourceMessageId: 'msg_brief',
    })
    expect(verdict).toEqual({ ok: true })
  })

  it('names a policy refusal instead of calling a visible target gone', () => {
    // An issueless target may be commanded only by its parent or the operator.
    // The worker is neither, and it CAN see the stray session, so the sender
    // is owed the rule it tripped — not "session no longer exists".
    const verdict = harness().authorizeQueuedInputAtApply({
      sessionId: STRAY.sessionId,
      principal: agentPrincipal('worker'),
      sourceMessageId: 'msg_stray',
    })
    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.reason).not.toBe('session no longer exists')
    expect(verdict.reason).toContain('only its parent or the operator')
  })

  it('still reports a target that does not exist as gone', () => {
    const verdict = harness().authorizeQueuedInputAtApply({
      sessionId: asSessionId('nobody'),
      principal: agentPrincipal('worker'),
      sourceMessageId: 'msg_ghost',
    })
    expect(verdict).toEqual({ ok: false, reason: 'session no longer exists' })
  })
})
