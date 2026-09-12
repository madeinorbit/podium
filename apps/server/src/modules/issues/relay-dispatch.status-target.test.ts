/**
 * THE RELAY'S `sessions.status` ARM ANSWERS ABOUT THE SESSION IT GATED [POD-3899].
 *
 * WHAT THIS IS, STATED PLAINLY: a BEHAVIOURAL test, not a consistency assertion.
 * It fails against the unfixed line and passes after it, for the reason it names.
 * That distinction was a condition of this commit being worth anything, so it is
 * written at the top rather than left for a reader to infer.
 *
 * WHAT IT IS NOT. It is NOT a privilege-escalation test, and no such test belongs
 * here, because the escalation does not exist on this path. The arm gates on the
 * RESOLVED TARGET'S ISSUE, and `resolveTarget` over an issue ref only ever selects
 * a member of that same issue — so both resolutions land inside the issue the
 * caller was already granted, and a test asserting "a stranger cannot read across
 * the relay" would pass before the fix as well as after. That is the inert guard
 * this file deliberately does not write. The tRPC arm was different precisely
 * because its subject was the SESSION, and two members of one issue can have
 * different owners; that case is covered by `queries.status-authz.test.ts`.
 *
 * THE DEFECT IS THEREFORE A CORRECTNESS ONE, and it is still real: the arm
 * resolved the ref to gate it, then handed the RAW REF to `readToolkit.status`,
 * which resolved it a second time. Between the two, the issue's live member can
 * change — resolution prefers whichever member is live — so the arm could gate one
 * session and then describe another. Its two neighbours in the same block, `recap`
 * and `read`, already passed `target.sessionId`; `status` was the odd one out.
 *
 * THE FIXTURE MOVES THE FLEET BETWEEN THE TWO READS, which is the only way the
 * two resolutions can disagree. Both sessions carry NO explicit issueId, so they
 * are members of the issue by cwd containment (`isIssueMember`), and
 * `issueForCwd` answers null — which routes the gate down its operator arm and
 * keeps this test about the resolution, not about `checkIssueAccess`.
 */

import {
  asSessionId,
  type Capability,
  asUserId,
  type SessionId,
  type SessionMeta,
  type SessionMetaInput,
} from '@podium/model'
import { describe, expect, it } from 'vitest'
import { resolvePrincipalAsync } from '../../command-principal'
import { metasAsFacts } from '../../test-support/session-facts'
import type { IssueService } from '../issues/service'
import type { MessageDeliveryService } from '../messages/service'
import type { SessionLifecycle } from '../sessions/lifecycle'
import { SessionReadToolkit } from '../sessions/read-toolkit'
import { type AgentRelayDispatchDeps, makeAgentRelayDispatch } from './relay-dispatch'

/** The one person in this fixture, and the OWNER of both sessions below.
 *
 *  THE OPERATOR CAPABILITY USED TO CARRY NO IDENTITY AT ALL, and both sessions
 *  used to carry no owner. That was fine while the arm asked only about the
 *  issue; POD-3900 made it ask who owns the target, and an attribution-less
 *  caller reading an unowned session is now refused — correctly, and for a
 *  reason this file is not about. So the fixture states an owner and a reader
 *  who IS that owner, which is the legitimate version of the situation it was
 *  always describing. Nothing about what it measures has moved: the assertion
 *  below is still about WHICH session a single resolution names. */
const OPERATOR_USER = asUserId('u_operator')

/** Gated first, because it is live when the arm resolves for its gate. */
const GATED = asSessionId('s_gated')
/** Live by the time a SECOND resolution would run. Never gated. */
const USURPER = asSessionId('s_usurper')

const ISSUE = {
  id: 'iss_a',
  seq: 228,
  stage: 'in_progress',
  title: 'The issue',
  worktreePath: '/wt/a',
  panel: { todos: [], artifacts: [], deferred: [] },
}

/** No `issueId`: membership is decided by cwd containment, which is what lets
 *  `issueForCwd` answer null and keep the gate on its operator arm. */
function session(over: Partial<SessionMetaInput>): SessionMeta {
  return {
    cwd: '/wt/a',
    agentKind: 'claude-code',
    createdAt: 't',
    machineId: 'm1',
    agentState: { phase: 'working', since: 't', nativeSubagentCount: 0 },
    ...over,
  } as SessionMeta
}

function harness() {
  /** Which session ids were actually PROJECTED — i.e. whose status was built. */
  const projected: SessionId[] = []

  const before = [
    session({ sessionId: GATED, status: 'live', lastActiveAt: '2' }),
    session({ sessionId: USURPER, status: 'hibernated', lastActiveAt: '1' }),
  ]
  const after = [
    session({ sessionId: GATED, status: 'hibernated', lastActiveAt: '2' }),
    session({ sessionId: USURPER, status: 'live', lastActiveAt: '3' }),
  ]
  let factsReads = 0
  const fleetNow = (): SessionMeta[] => (factsReads++ === 0 ? before : after)
  const everySession = (): SessionMeta[] => [...before, ...after]

  const readToolkit = new SessionReadToolkit({
    sessionFacts: () => metasAsFacts(fleetNow()),
    sessionById: async (sessionId: SessionId) => {
      projected.push(sessionId)
      return everySession().find((s) => s.sessionId === sessionId)
    },
    sessionsById: async (sessionIds: Iterable<SessionId>) => {
      const wanted = new Set(sessionIds)
      return everySession().filter((s) => wanted.has(s.sessionId))
    },
    issues: {
      resolveRef: (ref: string) => {
        if (ref === '#228' || ref === ISSUE.id) return ISSUE.id
        throw new Error(`unknown ref ${ref}`)
      },
      getMeta: (id: string) => (id === ISSUE.id ? ISSUE : undefined),
      get: (id: string) => (id === ISSUE.id ? ISSUE : undefined),
      // Null keeps the arm on its operator branch, so this test measures the
      // resolution rather than checkIssueAccess.
      issueForCwd: () => null,
    } as unknown as IssueService,
    messages: { deliveredUnacked: () => [] } as unknown as MessageDeliveryService,
    events: { appendEvent: async () => 1 },
    repoOp: async (op: string) => ({ ok: true, output: op === 'log' ? 'c1 subject' : '## branch' }),
    readTranscript: async () => ({ items: [], hasMore: false }),
    watermarks: { get: async () => undefined, set: async () => undefined },
  } as never)

  const dispatch = makeAgentRelayDispatch({
    readToolkit,
    issues: {
      issueForCwd: () => null,
    } as unknown as IssueService,
    sessionsSvc: {
      sessionOwner: async () => ({ owner: OPERATOR_USER, grants: [] as string[] }),
    } as unknown as SessionLifecycle,
    principalForCapability: (capability: Capability) =>
      resolvePrincipalAsync(capability, { parentSessionOf: async () => undefined }),
  } as unknown as AgentRelayDispatchDeps)

  return { dispatch, projected }
}

/** An operator capability: `scope.kind === 'all'` is what the arm's issue-less
 *  branch accepts, and it carries no actor session. */
const OPERATOR = {
  role: 'admin',
  scope: { kind: 'all' },
  actorSessionId: undefined,
  // ADR 3 D17's attribution pair, which a human capability must carry for its
  // principal to resolve at all — the same pair the operator channel stamps.
  actorUser: OPERATOR_USER,
  onBehalfOf: OPERATOR_USER,
} as never

describe('relay sessions.status', () => {
  it('describes the session it gated, even when the live member changes mid-read', async () => {
    const h = harness()
    const result = (await h.dispatch(OPERATOR, false, 'sessions', 'status', {
      ref: '#228',
    })) as { sessionId: SessionId }

    // The arm resolved GATED to gate it, so GATED is what it may describe. A
    // second resolution answers with USURPER, which was never gated.
    expect(result.sessionId).toBe(GATED)
    expect(h.projected).toEqual([GATED])
  })
})
